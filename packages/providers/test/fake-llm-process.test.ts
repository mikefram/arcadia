/**
 * Luồng tạo và xuất bản quy trình bằng hội thoại của `FakeLlm` (docs/DECISIONS.md, 04/10/2026): mở đầu, từng bước, tra người,
 * hỏi lại chỗ thiếu, "xong", xuất bản. Kiểm bằng lịch sử dựng tay và một "máy chủ tool" tí hon trong test; không cần mạng.
 * Phần chạy thật với vòng lặp tác tử và máy chủ giả đầy đủ nằm ở packages/ai-tools/evals (ca `cp-*`).
 */
import { describe, expect, it } from 'vitest';
import { buildFakeLlmContext, FAKE_LLM_DEFAULT_REPLY, FakeLlm, type LlmBlock, type LlmEvent, type LlmMsg, type LlmToolUsePart, PROCESS_DRAFT_SCRIPT } from '../src';

const id = (suffix: string) => `01920000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const person = (suffix: string, fullName: string, givenName: string, honorific: string) => ({ id: id(suffix), fullName, givenName, honorific, score: 1 });
const TUAN = person('a6', 'Bùi Quốc Tuấn', 'Tuấn', 'anh');
const PHUONG = person('a7', 'Đặng Mai Phương', 'Phương', 'chi');
const LAN_KD = person('a4', 'Nguyễn Thu Lan', 'Lan', 'chi');
const LAN_KT = person('a9', 'Phạm Thị Lan', 'Lan', 'chi');
const DRAFT_ID = id('d2');

type Call = { name: string; args: Record<string, unknown> };
type Spoken = { calls: Call[]; reply: string };
type Server = (name: string, args: Record<string, unknown>) => unknown;

const wrap = (name: string, value: unknown) => `<tool_result name="${name}">\n${JSON.stringify(value)}\n</tool_result>`;
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Máy chủ tool tí hon: tra người, kiểm các bước như máy chủ thật (`problems`), tạo đề xuất. Ghi đè từng tool bằng `over`. */
function miniServer(over: Record<string, (args: Record<string, unknown>) => unknown> = {}): Server {
  const base: Record<string, (args: Record<string, unknown>) => unknown> = {
    search_people: (args) => {
      const q = fold(String(args.query));
      const people = q.includes('lan kinh doanh') ? [LAN_KD] : q.includes('lan') ? [LAN_KD, LAN_KT] : q.includes('tuan') ? [TUAN] : q.includes('phuong') ? [PHUONG] : [];
      return { ok: true, result: { count: people.length, ambiguous: people.length > 1, people } };
    },
    preview_process: (args) => {
      const steps = Array.isArray(args.steps) ? args.steps.filter(isRecord) : [];
      const problems: { step: number | null; field: string; code: string }[] = [];
      if (!String(args.name ?? '').trim()) problems.push({ step: null, field: 'name', code: 'name_missing' });
      if (steps.length === 0) problems.push({ step: null, field: 'steps', code: 'no_steps' });
      steps.forEach((s, i) => {
        if (!String(s.title ?? '').trim()) problems.push({ step: i + 1, field: 'title', code: 'title_missing' });
        if (!isRecord(s.assignee) || s.assignee.kind === 'unknown') problems.push({ step: i + 1, field: 'assignee', code: 'assignee_missing' });
        if (!s.dueDays) problems.push({ step: i + 1, field: 'dueDays', code: 'due_missing' });
      });
      const lines = steps.map((s, i) => `Bước ${i + 1}: ‘${String(s.title)}’.`);
      const readFrom = typeof args.readFrom === 'number' && args.readFrom >= 1 ? args.readFrom : 1;
      const result = { name: args.name, stepCount: steps.length, steps: lines.map((text, i) => ({ n: i + 1, text })), problems, complete: problems.length === 0 };
      return problems.length > 0 ? { ok: true, result } : { ok: true, result, processReadback: { name: args.name, lines: lines.slice(readFrom - 1), total: steps.length } };
    },
    propose_create_process: (args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      return {
        ok: true,
        result: { created: 1, items: [], saved: false, skipped: [] },
        proposals: [{ proposalId: id('f1'), batchId: null, risk: 1, summary: `Tạo bản nháp quy trình “${String(args.name)}” gồm ${steps.length} bước, chưa giao việc cho ai.` }],
      };
    },
    search_templates: () => ({ ok: true, result: { count: 1, templates: [{ templateId: DRAFT_ID, name: 'Họp giao ban đầu tuần', status: 'draft_only', fields: [] }] } }),
    propose_publish_process: () => ({ ok: true, result: { created: 1, items: [], saved: false, skipped: [] }, proposals: [{ proposalId: id('f2'), batchId: null, risk: 1, summary: 'Xuất bản quy trình.' }] }),
  };
  return (name, args) => (over[name] ?? base[name] ?? (() => ({ ok: false, error: { code: 'unknown_tool', message: 'không có tool này' } })))(args);
}

/**
 * Vòng lặp tác tử tí hon của test: mỗi câu người dùng chạy `decide` tới khi trợ lý trả lời bằng chữ, hoặc tool trả `processReadback` hay
 * `proposals` (vòng lặp thật dừng ở đó và đọc câu do máy chủ dựng; ở đây câu đó là bản rút gọn). Trả lại từng lượt: các tool đã gọi và câu trả lời.
 */
function converse(llm: FakeLlm, texts: string[], opts: { server?: Server; system?: LlmBlock[] } = {}): { turns: Spoken[]; messages: LlmMsg[] } {
  const server = opts.server ?? miniServer();
  const system = opts.system ?? [];
  const messages: LlmMsg[] = [];
  const turns: Spoken[] = [];
  let seq = 0;
  for (const text of texts) {
    messages.push({ role: 'user', content: text });
    const calls: Call[] = [];
    let reply = '';
    for (let round = 0; round < 8 && !reply; round++) {
      const turn = llm.decide({ system, messages });
      if (!turn.toolCalls?.length) {
        reply = turn.reply ?? '';
        break;
      }
      const uses: LlmToolUsePart[] = turn.toolCalls.map((c) => ({ type: 'tool_use', id: `t${++seq}`, name: c.name, input: c.args }));
      const outputs = uses.map((u) => server(u.name, u.input));
      messages.push({ role: 'assistant', content: uses });
      messages.push({ role: 'user', content: uses.map((u, i) => ({ type: 'tool_result', tool_use_id: u.id, content: wrap(u.name, outputs[i]) })) });
      calls.push(...turn.toolCalls);
      for (const out of outputs) {
        if (!isRecord(out)) continue;
        if (isRecord(out.processReadback)) reply = `Dạ, trợ lý ghi lại. ${(out.processReadback.lines as string[]).join(' ')} Xin Chủ tịch đọc bước tiếp theo, hoặc nói “xong” nếu hết.`;
        const proposals = Array.isArray(out.proposals) ? out.proposals.filter(isRecord) : [];
        if (proposals.length > 0) reply = `Dạ, trợ lý hiểu như sau: ${String(proposals[0]?.summary)} Xin Chủ tịch xem trên màn hình và bấm Đồng ý nếu đúng.`;
      }
    }
    messages.push({ role: 'assistant', content: reply });
    turns.push({ calls, reply });
  }
  return { turns, messages };
}

const names = (calls: Call[]) => calls.map((c) => c.name);
const OPEN = 'tạo quy trình họp hội đồng quản trị';
const STEP1 = 'bước một, soạn tài liệu họp, anh Tuấn làm, hạn ba ngày';
const step = (title: string, over: Record<string, unknown> = {}) => ({ title, kind: 'task', assignee: { kind: 'person', personId: TUAN.id }, dueDays: 3, parallel: false, ...over });

describe('FakeLlm: tạo quy trình, mở đầu', () => {
  it('nêu tên: xác nhận tên và mời đọc bước thứ nhất, không gọi tool', () => {
    const { turns } = converse(new FakeLlm(), [OPEN]);
    expect(turns[0]).toEqual({ calls: [], reply: 'Dạ thưa Chủ tịch, quy trình mới tên là ‘Họp hội đồng quản trị’. Xin Chủ tịch đọc bước thứ nhất ạ.' });
  });

  it.each([
    ['lập một quy trình mới tên là Họp ban kiểm soát', 'Họp ban kiểm soát'],
    ['Tôi muốn tạo quy trình mới có tên “Đón khách quý”.', 'Đón khách quý'],
    ['tạo quy trình mới gọi là Mua sắm vật tư ạ', 'Mua sắm vật tư'],
    ['lập quy trình tên Duyệt ngân sách', 'Duyệt ngân sách'],
    ['tao quy trinh moi hop hoi dong', 'Hop hoi dong'],
  ])('"%s" cho tên "%s"', (text, name) => {
    const { turns } = converse(new FakeLlm(), [text]);
    expect(turns[0]?.calls).toEqual([]);
    expect(turns[0]?.reply).toBe(`Dạ thưa Chủ tịch, quy trình mới tên là ‘${name}’. Xin Chủ tịch đọc bước thứ nhất ạ.`);
  });

  it('không nêu tên: hỏi tên trước; câu kế tiếp là tên', () => {
    const { turns } = converse(new FakeLlm(), ['lập quy trình mới', 'họp ban kiểm soát']);
    expect(turns[0]).toEqual({ calls: [], reply: 'Dạ thưa Chủ tịch, quy trình mới này tên là gì ạ?' });
    expect(turns[1]).toEqual({ calls: [], reply: 'Dạ thưa Chủ tịch, quy trình mới tên là ‘Họp ban kiểm soát’. Xin Chủ tịch đọc bước thứ nhất ạ.' });
  });

  it('gọi người dùng bằng chức danh lấy từ lời nhắc hệ thống, mặc định là Chủ tịch', () => {
    const system: LlmBlock[] = [{ type: 'text', text: '# Lượt này\nNgười dùng: ông Lê Thanh Sơn, Giám đốc. Gọi người dùng là "Giám đốc".' }];
    const { turns } = converse(new FakeLlm(), [OPEN], { system });
    expect(turns[0]?.reply).toBe('Dạ thưa Giám đốc, quy trình mới tên là ‘Họp hội đồng quản trị’. Xin Giám đốc đọc bước thứ nhất ạ.');
  });
});

describe('FakeLlm: tạo quy trình, từng bước', () => {
  it('một bước có người: tra người rồi preview_process với toàn bộ bước, đủ mọi ô, readFrom là bước vừa thêm', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1]);
    expect(turns[1]?.calls).toEqual([
      { name: 'search_people', args: { query: 'anh Tuấn' } },
      { name: 'preview_process', args: { name: 'Họp hội đồng quản trị', readFrom: 1, steps: [step('Soạn tài liệu họp')] } },
    ]);
    expect(turns[1]?.reply).toContain('Bước 1: ‘Soạn tài liệu họp’');
  });

  it('bước đầu của lượt gọi tool là search_people; có kết quả mới gọi preview_process (từng bước của `decide`)', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [
      { role: 'user', content: OPEN },
      { role: 'assistant', content: 'Dạ thưa Chủ tịch, quy trình mới tên là ‘Họp hội đồng quản trị’. Xin Chủ tịch đọc bước thứ nhất ạ.' },
      { role: 'user', content: STEP1 },
    ];
    expect(llm.decide({ system: [], messages })).toEqual({ toolCalls: [{ name: 'search_people', args: { query: 'anh Tuấn' } }] });
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'search_people', input: { query: 'anh Tuấn' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: wrap('search_people', { ok: true, result: { count: 1, ambiguous: false, people: [TUAN] } }) }] },
    );
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([
      { name: 'preview_process', args: { name: 'Họp hội đồng quản trị', readFrom: 1, steps: [step('Soạn tài liệu họp')] } },
    ]);
  });

  it('người đã tra ở lượt trước thì không tra lại', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, 'bước hai, gửi thư mời, chị Phương làm, hạn hai ngày']);
    expect(turns[2]?.calls.map((c) => c.name)).toEqual(['search_people', 'preview_process']);
    expect(turns[2]?.calls[0]).toEqual({ name: 'search_people', args: { query: 'chị Phương' } });
  });

  it('nhiều người chưa tra thì tra song song, trong cùng một lượt gọi', () => {
    const first = new FakeLlm().decide({
      system: [],
      messages: [
        { role: 'user', content: 'tạo quy trình thử' },
        { role: 'assistant', content: 'Dạ thưa Chủ tịch, quy trình mới tên là ‘Thử’. Xin Chủ tịch đọc bước thứ nhất ạ.' },
        { role: 'user', content: 'bước một, soạn thư, anh Tuấn làm, hạn một ngày' },
        { role: 'assistant', content: 'Dạ, trợ lý ghi lại. Bước 1.' },
        { role: 'user', content: 'bước hai, gửi thư, chị Phương làm, hạn một ngày' },
      ],
    });
    // Cả hai người chưa được tra trong lịch sử này: hai lời gọi trong CÙNG một lượt.
    expect(first.toolCalls).toEqual([
      { name: 'search_people', args: { query: 'anh Tuấn' } },
      { name: 'search_people', args: { query: 'chị Phương' } },
    ]);
  });

  it('bước duyệt bằng chức danh: kind approval, vai director, không cần tra người', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước hai: Giám đốc duyệt tài liệu họp, hạn hai ngày']);
    expect(turns[1]?.calls).toEqual([
      {
        name: 'preview_process',
        args: { name: 'Họp hội đồng quản trị', readFrom: 1, steps: [{ title: 'Duyệt tài liệu họp', kind: 'approval', assignee: { kind: 'role', role: 'director' }, dueDays: 2, parallel: false }] },
      },
    ]);
  });

  it.each([
    ['bước ba: Văn phòng gửi thư mời, hạn hai ngày', { kind: 'role', role: 'office_admin' }, 'Gửi thư mời', 'task'],
    ['bước ba, Phó giám đốc duyệt báo cáo, hạn hai ngày', { kind: 'role', role: 'deputy' }, 'Duyệt báo cáo', 'approval'],
    ['bước ba, duyệt báo cáo, Chủ tịch duyệt, hạn hai ngày', { kind: 'role', role: 'chairman' }, 'Duyệt báo cáo', 'approval'],
    ['bước ba, in tài liệu, người giao việc làm, hạn hai ngày', { kind: 'initiator' }, 'In tài liệu', 'task'],
  ])('"%s"', (text, assignee, title, kind) => {
    const { turns } = converse(new FakeLlm(), [OPEN, text]);
    expect(turns[1]?.calls).toEqual([{ name: 'preview_process', args: { name: 'Họp hội đồng quản trị', readFrom: 1, steps: [{ title, kind, assignee, dueDays: 2, parallel: false }] } }]);
  });

  it('bước làm cùng lúc với bước trước (hoặc song song): parallel true', () => {
    for (const tail of [', làm cùng lúc với bước trước', ', song song', ' làm song song với bước trước']) {
      const { turns } = converse(new FakeLlm(), [OPEN, STEP1, `bước hai, kiểm tra phòng họp, chị Phương làm, hạn hai ngày${tail}`]);
      const preview = turns[2]?.calls.find((c) => c.name === 'preview_process');
      const steps = (preview?.args.steps ?? []) as Record<string, unknown>[];
      expect(steps.map((s) => s.parallel), tail).toEqual([false, true]);
      expect(steps[1], tail).toMatchObject({ title: 'Kiểm tra phòng họp', assignee: { kind: 'person', personId: PHUONG.id }, dueDays: 2 });
      expect(preview?.args.readFrom).toBe(2);
    }
  });

  it('số viết bằng chữ số hoặc chữ, "hạn" hoặc "trong", gõ không dấu, không dấu phẩy', () => {
    const cases: [string, number][] = [
      ['bước 1: soạn tài liệu họp, anh Tuấn làm, trong 5 ngày', 5],
      ['bước một soạn tài liệu họp anh Tuấn làm hạn mười lăm ngày làm việc', 15],
      ['buoc mot, soan tai lieu hop, anh Tuan lam, han hai muoi lam ngay', 25],
      ['bước thứ nhất, soạn tài liệu họp, anh Tuấn làm, ba mươi ngày', 30],
    ];
    for (const [text, days] of cases) {
      const { turns } = converse(new FakeLlm(), [OPEN, text]);
      const steps = (turns[1]?.calls.find((c) => c.name === 'preview_process')?.args.steps ?? []) as Record<string, unknown>[];
      expect(steps, text).toHaveLength(1);
      expect(steps[0], text).toMatchObject({ assignee: { kind: 'person', personId: TUAN.id }, dueDays: days });
      expect(String(steps[0]?.title), text).toMatch(/^Soạn tài liệu họp$|^Soan tai lieu hop$/);
    }
  });

  it('người nói liền với việc và hạn nói liền cuối câu, không dấu phẩy (nhận dạng giọng nói thường không có dấu câu)', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['bước một anh bình soạn tài liệu họp ba ngày', { title: 'Soạn tài liệu họp', who: 'anh bình', dueDays: 3 }],
      ['bước hai giám đốc duyệt tài liệu họp hạn hai ngày', { title: 'Duyệt tài liệu họp', role: 'director', dueDays: 2 }],
      ['bước ba văn phòng gửi thư mời hai ngày làm việc', { title: 'Gửi thư mời', role: 'office_admin', dueDays: 2 }],
    ];
    for (const [text, want] of cases) {
      const llm = new FakeLlm();
      const history: LlmMsg[] = [
        { role: 'user', content: OPEN },
        { role: 'assistant', content: 'Dạ thưa Chủ tịch, quy trình mới tên là ‘Họp hội đồng quản trị’. Xin Chủ tịch đọc bước thứ nhất ạ.' },
        { role: 'user', content: text },
      ];
      const first = llm.decide({ system: [], messages: history });
      if (want.who) {
        // Người là tên: tra trước; cách gọi giữ nguyên chữ người dùng nói.
        expect(first.toolCalls, text).toEqual([{ name: 'search_people', args: { query: want.who } }]);
        continue;
      }
      const step = (first.toolCalls?.[0]?.args.steps as Record<string, unknown>[] | undefined)?.[0];
      expect(step, text).toMatchObject({ title: want.title, assignee: { kind: 'role', role: want.role }, dueDays: want.dueDays });
    }
  });

  it('nhiều bước: mỗi lượt gửi lại TOÀN BỘ các bước đúng thứ tự; bước cùng số thì thay bước cũ', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, 'bước hai, gửi thư mời, chị Phương làm, hạn hai ngày', 'bước hai, gửi thư mời, Văn phòng làm, hạn bốn ngày']);
    const steps = (turns[3]?.calls.find((c) => c.name === 'preview_process')?.args.steps ?? []) as Record<string, unknown>[];
    expect(steps.map((s) => s.title)).toEqual(['Soạn tài liệu họp', 'Gửi thư mời']);
    expect(steps[1]).toMatchObject({ assignee: { kind: 'role', role: 'office_admin' }, dueDays: 4 });
    expect(turns[3]?.calls.find((c) => c.name === 'preview_process')?.args.readFrom).toBe(2);
  });
});

describe('FakeLlm: tạo quy trình, hỏi lại chỗ thiếu', () => {
  it('thiếu hạn: gửi dueDays 0, nghe `problems` rồi hỏi đúng chỗ đó bằng một câu; trả lời "ba ngày" thì điền đúng bước', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, soạn tài liệu họp, anh Tuấn làm', 'ba ngày']);
    expect(turns[1]?.calls.find((c) => c.name === 'preview_process')?.args.steps).toEqual([step('Soạn tài liệu họp', { dueDays: 0 })]);
    expect(turns[1]?.reply).toBe('Dạ thưa Chủ tịch, bước 1 hạn mấy ngày làm việc ạ?');
    expect(names(turns[1]?.calls ?? [])).not.toContain('propose_create_process');
    expect(turns[2]?.calls.find((c) => c.name === 'preview_process')?.args).toMatchObject({ readFrom: 1, steps: [step('Soạn tài liệu họp')] });
    expect(turns[2]?.reply).toContain('Bước 1');
  });

  it('thiếu người: assignee unknown, hỏi ai làm (hoặc ai duyệt); trả lời tên thì tra người rồi kiểm lại', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, soạn tài liệu họp, hạn ba ngày', 'anh Tuấn làm']);
    expect(turns[1]?.calls.find((c) => c.name === 'preview_process')?.args.steps).toEqual([step('Soạn tài liệu họp', { assignee: { kind: 'unknown' } })]);
    expect(turns[1]?.reply).toBe('Dạ thưa Chủ tịch, bước 1 ai làm ạ?');
    expect(turns[2]?.calls.map((c) => c.name)).toEqual(['search_people', 'preview_process']);
    expect(turns[2]?.calls[1]?.args.steps).toEqual([step('Soạn tài liệu họp')]);

    const approval = converse(new FakeLlm(), [OPEN, 'bước một, duyệt tài liệu họp, hạn ba ngày']);
    expect(approval.turns[1]?.reply).toBe('Dạ thưa Chủ tịch, bước 1 ai duyệt ạ?');
  });

  it('thiếu tên việc: hỏi việc gì; bước duyệt thì thêm chữ "Duyệt" vào câu trả lời', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, Giám đốc duyệt, hạn hai ngày', 'tài liệu họp']);
    expect(turns[1]?.reply).toBe('Dạ thưa Chủ tịch, bước 1 duyệt việc gì ạ?');
    expect(turns[2]?.calls[0]).toMatchObject({ name: 'preview_process', args: { steps: [{ title: 'Duyệt tài liệu họp', kind: 'approval' }] } });
  });

  it('câu trả lời không hiểu thì rơi về câu mặc định nhưng câu hỏi vẫn còn chờ: trả lời đúng ở lượt sau vẫn được', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, soạn tài liệu họp, anh Tuấn làm', 'hôm nay trời đẹp nhỉ', 'hạn ba ngày']);
    expect(turns[2]?.reply).toBe(FAKE_LLM_DEFAULT_REPLY);
    expect(turns[3]?.calls.find((c) => c.name === 'preview_process')?.args.steps).toEqual([step('Soạn tài liệu họp')]);
  });

  it('người mơ hồ: hỏi "<xưng hô tên> nào ạ?" và dừng, không gọi preview_process; chạm chọn thì tra lại rồi tiếp tục', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, gửi giấy mời, chị Lan làm, hạn hai ngày', 'Lan kinh doanh']);
    expect(turns[1]?.calls).toEqual([{ name: 'search_people', args: { query: 'chị Lan' } }]);
    expect(turns[1]?.reply).toBe('Dạ, chị Lan nào ạ?');
    expect(turns[2]?.calls).toEqual([
      { name: 'search_people', args: { query: 'Lan kinh doanh' } },
      { name: 'preview_process', args: { name: 'Họp hội đồng quản trị', readFrom: 1, steps: [step('Gửi giấy mời', { assignee: { kind: 'person', personId: LAN_KD.id }, dueDays: 2 })] } },
    ]);
  });

  it('không tìm thấy người: nói thật và xin nhắc lại tên; nhắc lại đúng thì đi tiếp', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, gửi giấy mời, anh Bình làm, hạn hai ngày', 'anh Tuấn']);
    expect(turns[1]?.calls.map((c) => c.name)).toEqual(['search_people']);
    expect(turns[1]?.reply).toBe('Dạ thưa Chủ tịch, trợ lý chưa tìm thấy ai tên như vậy. Xin Chủ tịch nói lại tên giúp trợ lý ạ.');
    expect(turns[2]?.calls.find((c) => c.name === 'preview_process')?.args.steps).toEqual([step('Gửi giấy mời', { dueDays: 2 })]);
  });

  it('tên trùng: hỏi đặt tên khác; tên mới thì kiểm lại và đọc cả quy trình (readFrom 0)', () => {
    const server = miniServer({
      preview_process: (args) => {
        const taken = fold(String(args.name)) === 'hop hoi dong quan tri';
        const result = { name: args.name, stepCount: 1, steps: [], problems: taken ? [{ step: null, field: 'name', code: 'name_taken' }] : [], complete: !taken };
        return taken ? { ok: true, result } : { ok: true, result, processReadback: { name: args.name, lines: ['Bước 1: ‘Soạn tài liệu họp’.'], total: 1 } };
      },
    });
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, 'Họp đại hội cổ đông'], { server });
    expect(turns[1]?.reply).toBe('Dạ thưa Chủ tịch, đã có quy trình tên ‘Họp hội đồng quản trị’. Chủ tịch muốn đặt tên khác là gì ạ?');
    expect(turns[2]?.calls.find((c) => c.name === 'preview_process')?.args).toMatchObject({ name: 'Họp đại hội cổ đông', readFrom: 0 });
  });

  it('mỗi câu hỏi lại là đúng một câu hỏi và không có số lạ', () => {
    const asked = converse(new FakeLlm(), [OPEN, 'bước một, soạn tài liệu họp, anh Tuấn làm', 'bước hai, Giám đốc duyệt', 'bước ba, gửi thư, hạn hai ngày']).turns;
    for (const turn of asked.slice(1)) {
      expect(turn.reply.match(/\?/g)).toHaveLength(1);
      expect(turn.reply.replace(/bước \d+/giu, '')).not.toMatch(/\d/);
    }
  });
});

describe('FakeLlm: tạo quy trình, "xong"', () => {
  const FULL = [OPEN, STEP1, 'bước hai: Giám đốc duyệt tài liệu họp, hạn hai ngày', 'bước ba: kiểm tra phòng họp, chị Phương làm, hạn hai ngày, làm cùng lúc với bước trước'];

  it('"xong": gọi propose_create_process với tên và đủ các bước đúng thứ tự, không tra hay kiểm lại', () => {
    const { turns } = converse(new FakeLlm(), [...FULL, 'xong']);
    expect(turns[4]?.calls).toEqual([
      {
        name: 'propose_create_process',
        args: {
          name: 'Họp hội đồng quản trị',
          steps: [
            step('Soạn tài liệu họp'),
            { title: 'Duyệt tài liệu họp', kind: 'approval', assignee: { kind: 'role', role: 'director' }, dueDays: 2, parallel: false },
            step('Kiểm tra phòng họp', { assignee: { kind: 'person', personId: PHUONG.id }, dueDays: 2, parallel: true }),
          ],
        },
      },
    ]);
    expect(turns[4]?.reply).toBe('Dạ, trợ lý hiểu như sau: Tạo bản nháp quy trình “Họp hội đồng quản trị” gồm 3 bước, chưa giao việc cho ai. Xin Chủ tịch xem trên màn hình và bấm Đồng ý nếu đúng.');
  });

  it.each(['xong', 'Xong rồi.', 'hết rồi', 'đã hết', 'hết', 'đó là tất cả', 'Dạ xong ạ', 'xong roi'])('"%s" là kết thúc', (text) => {
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, text]);
    expect(names(turns[2]?.calls ?? [])).toEqual(['propose_create_process']);
  });

  it('chưa có bước nào: mời đọc bước thứ nhất, không đề xuất', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'xong']);
    expect(turns[1]).toEqual({ calls: [], reply: 'Dạ thưa Chủ tịch, quy trình chưa có bước nào. Xin Chủ tịch đọc bước thứ nhất ạ.' });
  });

  it('còn bước thiếu hạn: không đề xuất, hỏi lại chỗ thiếu (kiểm bằng preview_process, đọc cả quy trình)', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, soạn tài liệu họp, anh Tuấn làm', 'xong']);
    expect(names(turns[2]?.calls ?? [])).toEqual(['preview_process']);
    expect(turns[2]?.calls[0]?.args.readFrom).toBe(0);
    expect(turns[2]?.reply).toBe('Dạ thưa Chủ tịch, bước 1 hạn mấy ngày làm việc ạ?');
  });

  it('máy chủ từ chối vì không đủ quyền: nói thật là chưa tạo được và chỉ đường, không gọi tool nào khác', () => {
    const server = miniServer({ propose_create_process: () => ({ ok: false, error: { code: 'forbidden', message: 'Không đủ quyền.' } }) });
    const system: LlmBlock[] = [{ type: 'text', text: 'Gọi người dùng là "Giám đốc".' }];
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, 'xong'], { server, system });
    expect(names(turns[2]?.calls ?? [])).toEqual(['propose_create_process']);
    expect(turns[2]?.reply).toBe(
      'Dạ thưa Giám đốc, trợ lý chưa tạo được quy trình này vì tài khoản của Giám đốc chưa có quyền soạn quy trình. Việc này làm trên trang quản trị, hoặc xin Giám đốc bấm Nhờ Văn phòng.',
    );
    expect(turns[2]?.reply).not.toMatch(/đã (tạo|soạn)/);
  });

  it('máy chủ báo thiếu thông tin ở lượt đề xuất: chưa tạo được, xin đọc lại bước còn thiếu', () => {
    const server = miniServer({ propose_create_process: () => ({ ok: false, error: { code: 'input_invalid', message: 'x Chi tiết: args.steps.0.dueDays (due_missing).' } }) });
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, 'xong'], { server });
    expect(turns[2]?.reply).toBe('Dạ thưa Chủ tịch, trợ lý chưa tạo được vì thông tin các bước chưa đủ. Xin Chủ tịch đọc lại bước còn thiếu ạ.');
  });

  it('mở quy trình mới giữa chừng thì bỏ quy trình đang dở', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, STEP1, 'lập quy trình mới tên là Đón khách', 'bước một, in thư mời, Văn phòng làm, hạn một ngày']);
    const steps = (turns[3]?.calls.find((c) => c.name === 'preview_process')?.args.steps ?? []) as Record<string, unknown>[];
    expect(steps.map((s) => s.title)).toEqual(['In thư mời']);
    expect(turns[3]?.calls[0]?.args.name).toBe('Đón khách');
  });
});

describe('FakeLlm: xuất bản quy trình', () => {
  it('chỉ xuất bản: search_templates kèm includeDrafts rồi propose_publish_process không có startRun', () => {
    const { turns } = converse(new FakeLlm(), ['xuất bản quy trình họp giao ban đầu tuần']);
    expect(turns[0]?.calls).toEqual([
      { name: 'search_templates', args: { query: 'Họp giao ban đầu tuần', includeDrafts: true } },
      { name: 'propose_publish_process', args: { templateId: DRAFT_ID } },
    ]);
    expect(turns[0]?.reply).toBe('Dạ, trợ lý hiểu như sau: Xuất bản quy trình. Xin Chủ tịch xem trên màn hình và bấm Đồng ý nếu đúng.');
  });

  it.each([
    ['xuất bản quy trình họp giao ban đầu tuần và giao việc với tên Họp giao ban 12/10', 'Họp giao ban 12/10'],
    ['xuất bản họp giao ban đầu tuần và giao việc tên Họp giao ban tuần này', 'Họp giao ban tuần này'],
    ['Xuất bản quy trình họp giao ban đầu tuần, giao việc Họp giao ban 15/10', 'Họp giao ban 15/10'],
    ['xuat ban quy trinh hop giao ban dau tuan va giao viec voi ten Hop giao ban', 'Hop giao ban'],
  ])('xuất bản kèm giao việc ngay: "%s"', (text, runTitle) => {
    const { turns } = converse(new FakeLlm(), [text]);
    expect(names(turns[0]?.calls ?? [])).toEqual(['search_templates', 'propose_publish_process']);
    expect(turns[0]?.calls[1]).toEqual({ name: 'propose_publish_process', args: { templateId: DRAFT_ID, startRun: { title: runTitle, inputs: [] } } });
  });

  it('muốn giao việc ngay mà chưa có tên lượt: hỏi tên lượt, rồi xuất bản kèm tên đó', () => {
    const { turns } = converse(new FakeLlm(), ['xuất bản quy trình họp giao ban đầu tuần và giao việc ngay', 'Họp giao ban 12/10']);
    expect(turns[0]).toEqual({ calls: [], reply: 'Dạ thưa Chủ tịch, lượt giao việc này đặt tên là gì ạ?' });
    expect(turns[1]?.calls[1]).toEqual({ name: 'propose_publish_process', args: { templateId: DRAFT_ID, startRun: { title: 'Họp giao ban 12/10', inputs: [] } } });
  });

  it('không tìm thấy bản nháp: nói thật, không đề xuất', () => {
    const server = miniServer({ search_templates: () => ({ ok: true, result: { count: 0, templates: [] } }) });
    const { turns } = converse(new FakeLlm(), ['xuất bản quy trình tuyển dụng nhân sự'], { server });
    expect(names(turns[0]?.calls ?? [])).toEqual(['search_templates']);
    expect(turns[0]?.reply).toBe(
      'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy bản nháp quy trình ‘Tuyển dụng nhân sự’. Có thể bản nháp chưa được tạo xong: xin Chủ tịch bấm Đồng ý ở đề xuất tạo quy trình rồi nói lại giúp trợ lý ạ.',
    );
  });

  it('mẫu đã xuất bản và không có bản nháp mới: nói thật, không đề xuất', () => {
    const server = miniServer({ search_templates: () => ({ ok: true, result: { count: 1, templates: [{ templateId: id('d1'), name: 'Họp giao ban đầu tuần', status: 'published' }] } }) });
    const { turns } = converse(new FakeLlm(), ['xuất bản quy trình họp giao ban đầu tuần'], { server });
    expect(names(turns[0]?.calls ?? [])).toEqual(['search_templates']);
    expect(turns[0]?.reply).toContain('đã được xuất bản');
  });

  it('nhiều bản nháp: chọn đúng bản trùng tên; không có bản trùng tên thì xin nói rõ, không chọn thay', () => {
    const two = [
      { templateId: id('d2'), name: 'Họp giao ban đầu tuần', status: 'draft_only' },
      { templateId: id('d3'), name: 'Họp giao ban cuối tuần', status: 'published_with_draft' },
    ];
    const server = miniServer({ search_templates: () => ({ ok: true, result: { count: 2, templates: two } }) });
    const exact = converse(new FakeLlm(), ['xuất bản quy trình họp giao ban cuối tuần'], { server });
    expect(exact.turns[0]?.calls[1]).toEqual({ name: 'propose_publish_process', args: { templateId: id('d3') } });
    const vague = converse(new FakeLlm(), ['xuất bản quy trình họp giao ban'], { server });
    expect(names(vague.turns[0]?.calls ?? [])).toEqual(['search_templates']);
    expect(vague.turns[0]?.reply).toContain('nhiều bản nháp');
  });

  it('máy chủ từ chối xuất bản: nói thật là chưa làm được', () => {
    const server = miniServer({ propose_publish_process: () => ({ ok: false, error: { code: 'forbidden', message: 'Không đủ quyền.' } }) });
    const { turns } = converse(new FakeLlm(), ['xuất bản quy trình họp giao ban đầu tuần'], { server });
    expect(turns[0]?.reply).toContain('chưa xuất bản được');
    expect(turns[0]?.reply).not.toMatch(/đã soạn/);
  });
});

describe('FakeLlm: câu ngoài luồng và thứ tự ưu tiên', () => {
  it('câu lạ, và các câu chỉ có nghĩa trong luồng ("xong", "bước một") khi chưa mở quy trình, vẫn ra câu mặc định', () => {
    for (const text of ['hôm nay trời đẹp nhỉ', 'xong', 'bước một, soạn tài liệu họp, anh Tuấn làm, hạn ba ngày', 'ba ngày', 'anh Tuấn']) {
      const { turns } = converse(new FakeLlm(), [text]);
      expect(turns[0], text).toEqual({ calls: [], reply: FAKE_LLM_DEFAULT_REPLY });
    }
  });

  it('câu lạ giữa luồng cũng ra câu mặc định, và không làm hỏng quy trình đang dở', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'hôm nay trời đẹp nhỉ', STEP1]);
    expect(turns[1]).toEqual({ calls: [], reply: FAKE_LLM_DEFAULT_REPLY });
    expect(turns[2]?.calls[1]).toMatchObject({ name: 'preview_process', args: { name: 'Họp hội đồng quản trị', readFrom: 1 } });
  });

  it('các luồng khác vẫn chạy: đi thúc giữa lúc đang đọc quy trình', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'đi thúc anh Tuấn']);
    expect(turns[1]?.calls[0]).toEqual({ name: 'search_people', args: { query: 'anh Tuấn' } });
  });

  it('tên việc chứa chữ của luồng đi thúc ("nhắc") vẫn là một bước, vì luồng quy trình được xét trước', () => {
    const { turns } = converse(new FakeLlm(), [OPEN, 'bước một, nhắc khách hàng, chị Phương làm, hạn hai ngày']);
    expect(turns[1]?.calls[1]).toMatchObject({ name: 'preview_process', args: { steps: [{ title: 'Nhắc khách hàng' }] } });
  });

  it('bước tự đặt của người dùng bộ giả được xét trước bộ mặc định; includeDefaults false bỏ luồng quy trình', () => {
    const custom = new FakeLlm([{ when: /^tạo quy trình/iu, reply: 'Câu riêng.' }]);
    expect(custom.decide({ system: [], messages: [{ role: 'user', content: OPEN }] })).toEqual({ reply: 'Câu riêng.' });
    const bare = new FakeLlm([], { includeDefaults: false });
    expect(bare.decide({ system: [], messages: [{ role: 'user', content: OPEN }] })).toEqual({ reply: FAKE_LLM_DEFAULT_REPLY });
    // Bộ đánh giá đặt PROCESS_DRAFT_SCRIPT lên đầu: bộ mặc định không xét lại các bước ấy lần hai.
    const evalLike = new FakeLlm([...PROCESS_DRAFT_SCRIPT]);
    expect(evalLike.decide({ system: [], messages: [{ role: 'user', content: OPEN }] }).reply).toContain('quy trình mới tên là');
  });

  it('stream phát đúng sự kiện: tool_use rồi message_stop tool_use; câu trả lời bằng chữ thì end_turn', async () => {
    const llm = new FakeLlm();
    const collect = async (messages: LlmMsg[]): Promise<LlmEvent[]> => {
      const out: LlmEvent[] = [];
      for await (const e of llm.stream({ system: [], tools: [], messages, effort: 'low' })) out.push(e);
      return out;
    };
    const asking = await collect([{ role: 'user', content: 'lập quy trình mới' }]);
    expect(asking.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toBe('Dạ thưa Chủ tịch, quy trình mới này tên là gì ạ?');
    expect(asking.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'end_turn' });

    const searching = await collect([
      { role: 'user', content: OPEN },
      { role: 'assistant', content: 'Dạ thưa Chủ tịch, quy trình mới tên là ‘Họp hội đồng quản trị’. Xin Chủ tịch đọc bước thứ nhất ạ.' },
      { role: 'user', content: STEP1 },
    ]);
    expect(searching.find((e) => e.type === 'tool_use')).toMatchObject({ name: 'search_people', input: { query: 'anh Tuấn' } });
    expect(searching.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'tool_use' });
  });
});

describe('buildFakeLlmContext: dữ liệu của cả hội thoại', () => {
  it('turns kèm câu trả lời trước mỗi câu; allToolResults gồm kết quả của mọi lượt, không chỉ lượt cuối', () => {
    const messages: LlmMsg[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_people', input: { query: 'anh Tuấn' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: wrap('search_people', { ok: true, result: { people: [TUAN] } }) }] },
      { role: 'assistant', content: 'Dạ, câu một.' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'list_runs', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: wrap('list_runs', { ok: false, error: { code: 'x', message: 'y' } }) }] },
      { role: 'user', content: '[Ghi chú hệ thống] có số lạ' },
    ];
    const ctx = buildFakeLlmContext({ system: [], messages });
    expect(ctx.turns).toEqual([
      { userText: 'a', previousAssistantText: '' },
      { userText: 'b', previousAssistantText: 'Dạ, câu một.' },
    ]);
    expect(ctx.allToolResults.map((r) => [r.name, r.args, r.isError])).toEqual([
      ['search_people', { query: 'anh Tuấn' }, false],
      ['list_runs', {}, true],
    ]);
    // `toolResults` và `last` vẫn chỉ tính từ câu người dùng cuối.
    expect(ctx.toolResults.map((r) => r.name)).toEqual(['list_runs']);
    expect(ctx.last('search_people')).toBeUndefined();
    expect(ctx.notices).toBe(1);
  });
});
