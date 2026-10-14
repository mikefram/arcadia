/**
 * Kịch bản của `FakeLlm` cho bộ đánh giá: một "trợ lý" theo luật cứng, đủ để mọi ca trong `cases/` chạy xanh
 * mà không cần mạng. Mục đích duy nhất là chứng minh trình chạy, bộ chấm và `FakeToolBackend` hoạt động đúng.
 * Nó KHÔNG đo chất lượng của trợ lý thật: câu nào không khớp luật thì rơi về câu mặc định.
 *
 * Thứ tự các bước là thứ tự ưu tiên; luồng tạo và xuất bản quy trình (PROCESS_DRAFT_SCRIPT) đứng đầu, còn bộ kịch bản mặc định của
 * kịch bản vàng (GOLDEN_B_SCRIPT) được nối sau cùng.
 */
import { stripDiacritics } from '@mihato/domain/vi-normalize';
import {
  buildFakeLlmContext,
  extractPersonQuery,
  type FakeLlmContext,
  type FakeLlmStep,
  type FakeLlmTurn,
  fakeMassNudgeFlow,
  fakeNudgeFlow,
  fakeWhoIsLateFlow,
  idOf,
  matchedPeople,
  personLabel,
  pickArray,
  PROCESS_DRAFT_SCRIPT,
} from '@mihato/providers';
import { fallbackOverviewText, readOverviewNumbers } from '../src/guard';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const fold = (s: string) => stripDiacritics(s.normalize('NFC')).toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

const NUDGE_RE = /(^|\s)(đi\s+thúc|thúc|nhắc)\s+\S+/iu;
const WORKLOAD_RE = /(đang giữ|đang làm|đang có|đang nắm).*(việc gì|những việc)|việc của (anh|chị|ông|bà) .*(thế nào|ra sao|đến đâu)/iu;
const REASSIGN_RE = /(chuyển|đổi|giao lại)\s+việc\s+(.+?)\s+(sang|cho)\s+(.+)$/iu;
const EXTEND_RE = /(dời|lùi|gia|đổi)\s+hạn\s+(?:của\s+)?việc\s+(.+?)\s+(sang|đến|tới)\s+(.+)$/iu;
const START_RE = /giao việc|khởi chạy|có đoàn/iu;
const START_QUESTION_RE = /đoàn khách này tên là gì|đoàn đến ngày nào|theo quy trình nào/u;
const WHICH_ONE_RE = /nào ạ\?$/u;

const UNITS = 'một|mốt|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|mười';
const DATE_PHRASE_RE = new RegExp(
  String.raw`((?:mười|hai mươi|ba mươi|mùng|\d{1,2})(?:\s+(?:${UNITS}))?\s+tháng\s+(?:mười một|mười hai|${UNITS}|giêng|chạp|\d{1,2}))|(thứ\s+\p{L}+\s+tuần\s+(?:sau|này|tới))|(ngày mai|ngày kia)|(\d{1,2}/\d{1,2}(?:/\d{4})?)`,
  'iu',
);
const DELEGATION_RE = /(Đoàn\s+[^,.;!?]+?)(?=\s*(?:[,.;!?]|$)|\s+ngày\s|\s+đến\s)/u;

/** Tìm một việc đang mở theo vài chữ trong tên, trong các kết quả `get_run` của lượt này. */
function findOpenStep(ctx: FakeLlmContext, phrase: string): Record<string, unknown> | undefined {
  const want = words(phrase);
  if (want.length === 0) return undefined;
  for (const detail of ctx.toolResults.filter((r) => r.name === 'get_run')) {
    const run = isRecord(detail.payload) && isRecord(detail.payload.run) ? detail.payload.run : detail.payload;
    for (const step of pickArray(run, 'steps')) {
      if (step.state !== 'ready' && step.state !== 'in_progress') continue;
      const have = new Set(words(typeof step.title === 'string' ? step.title : ''));
      if (want.every((w) => have.has(w))) return step;
    }
  }
  return undefined;
}

/** Hai bước đọc chung của đổi người và gia hạn: liệt kê lượt chạy rồi lấy chi tiết để tìm đúng việc. */
function loadRunDetails(ctx: FakeLlmContext): FakeLlmTurn | null {
  const listed = ctx.last('list_runs');
  if (!listed) return { toolCalls: [{ name: 'list_runs', args: { state: 'running' } }] };
  if (!ctx.last('get_run')) {
    const runIds = pickArray(listed.payload, 'runs', 'items')
      .map((r) => idOf(r, 'runId'))
      .filter((id): id is string => id !== undefined);
    if (runIds.length === 0) return { reply: 'Dạ thưa Chủ tịch, hiện không có đợt việc nào đang chạy.' };
    return { toolCalls: runIds.map((runId) => ({ name: 'get_run', args: { runId } })) };
  }
  return null;
}

function workloadFlow(ctx: FakeLlmContext, query: string): FakeLlmTurn {
  const found = ctx.last('search_people');
  if (!found) return { toolCalls: [{ name: 'search_people', args: { query } }] };
  const people = matchedPeople(found.payload);
  if (people.length === 0) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy ai tên như vậy. Xin Chủ tịch nói lại tên giúp trợ lý ạ.' };
  if (people.length > 1) return { reply: `Dạ, ${query} nào ạ?` };
  const person = people[0] as Record<string, unknown>;
  const load = ctx.last('get_person_workload');
  if (!load) return { toolCalls: [{ name: 'get_person_workload', args: { personId: person.id } }] };
  const p = isRecord(load.payload) ? load.payload : {};
  const open = num(p.holding ?? p.open);
  const overdue = num(p.overdue);
  if (open === 0) return { reply: `Dạ thưa Chủ tịch, ${personLabel(person)} hiện không giữ việc nào đang mở.` };
  return { reply: `Dạ thưa Chủ tịch, ${personLabel(person)} đang giữ ${open} việc, ${overdue > 0 ? `trong đó ${overdue} việc quá hạn` : 'không có việc nào quá hạn'}.` };
}

function overviewStep(when: RegExp, write: (o: NonNullable<ReturnType<typeof readOverviewNumbers>>) => string): FakeLlmStep {
  return {
    when,
    respond: (ctx) => {
      const got = ctx.last('get_overview');
      if (!got) return { toolCalls: [{ name: 'get_overview', args: { scope: 'all' } }] };
      const numbers = readOverviewNumbers(got.payload);
      if (!numbers) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa lấy được số liệu. Xin Chủ tịch xem trên màn hình Tiến độ.' };
      return { reply: write(numbers) };
    },
  };
}

/** Phần đang giao việc: các câu người dùng kể từ câu mở đầu yêu cầu giao việc gần nhất. */
function startRunTexts(ctx: FakeLlmContext): string[] {
  if (START_RE.test(ctx.userText)) return [ctx.userText];
  let from = 0;
  ctx.previousUserTexts.forEach((t, i) => {
    if (START_RE.test(t)) from = i;
  });
  return [...ctx.previousUserTexts.slice(from), ctx.userText];
}

function startRunFlow(ctx: FakeLlmContext): FakeLlmTurn {
  const texts = startRunTexts(ctx);
  const all = texts.join('. ');
  const name = [...texts].reverse().map((t) => DELEGATION_RE.exec(t)?.[1]?.trim()).find(Boolean);
  const datePhrase = [...texts].reverse().map((t) => DATE_PHRASE_RE.exec(t)?.[0]?.trim()).find(Boolean);

  const searched = ctx.last('search_templates');
  if (!searched) {
    const query = /đoàn/iu.test(all) ? 'đón đoàn' : (/quy trình\s+([^,.;!?]+)/iu.exec(all)?.[1]?.trim() ?? '');
    return {
      toolCalls: [
        { name: 'search_templates', args: { query } },
        ...(datePhrase ? [{ name: 'resolve_date', args: { phrase: datePhrase } }] : []),
      ],
    };
  }
  const template = pickArray(searched.payload, 'templates', 'items')[0];
  if (!template) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy mẫu quy trình nào như vậy. Chủ tịch muốn giao việc theo quy trình nào ạ?' };
  if (!name) return { reply: 'Dạ thưa Chủ tịch, đoàn khách này tên là gì ạ?' };
  if (!datePhrase) return { reply: 'Dạ thưa Chủ tịch, đoàn đến ngày nào ạ?' };
  const resolved = ctx.last('resolve_date');
  const date = resolved && !resolved.isError && isRecord(resolved.payload) && typeof resolved.payload.date === 'string' ? resolved.payload.date : null;
  if (!date) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa rõ ngày. Chủ tịch cho biết đoàn đến ngày nào ạ?' };

  const proposed = ctx.last('propose_start_run');
  if (!proposed) {
    const fields = pickArray(template.fields ?? template.inputs);
    const nameKey = fields.find((f) => f.type === 'text')?.key ?? 'delegation';
    const dateKey = fields.find((f) => f.type === 'date')?.key ?? 'visitDate';
    return {
      toolCalls: [
        {
          name: 'propose_start_run',
          args: {
            templateId: idOf(template, 'templateId'),
            title: `Đón ${name}`,
            inputs: [
              { key: nameKey, value: name },
              { key: dateKey, value: date },
            ],
          },
        },
      ],
    };
  }
  if (proposed.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa soạn được đề xuất giao việc này. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.' };
  return { reply: 'Dạ thưa Chủ tịch, trợ lý đã soạn đề xuất giao việc. Xin Chủ tịch xem bản xem trước trên màn hình và bấm Đồng ý nếu đúng.' };
}

const lastContext = (messages: Parameters<typeof buildFakeLlmContext>[0]['messages']) => buildFakeLlmContext({ system: [], messages });

export const EVAL_FAKE_STEPS: FakeLlmStep[] = [
  // ── Tạo và xuất bản quy trình bằng hội thoại: xét trước mọi luật dưới đây, vì câu của một bước hay của lệnh xuất bản chứa những chữ như
  // "giao việc", "thanh toán", "nhắc" mà các luật bên dưới sẽ bắt nhầm ──
  ...PROCESS_DRAFT_SCRIPT,
  // ── Ngoài quyền và chỉ thị lạ do người dùng đọc lên: từ chối lịch sự, không gọi tool ──
  {
    when: /bỏ qua mọi quy tắc|duyệt\s+(hộ|giúp|thay|hết|luôn)|(hộ|giúp)\s+tôi\s+duyệt/iu,
    reply: 'Dạ thưa Chủ tịch, trợ lý không được phép duyệt thay Chủ tịch. Việc cần duyệt nằm ở mục Việc cần quyết, xin Chủ tịch tự bấm Đồng ý ở đó.',
  },
  {
    when: /xo[áa]\s+(việc|dữ liệu|hết)/iu,
    reply: 'Dạ thưa Chủ tịch, trợ lý không xoá được việc hay dữ liệu. Việc này làm trên trang quản trị, hoặc xin Chủ tịch bấm Nhờ Văn phòng.',
  },
  {
    when: /(đổi|phân|cấp)\s+quyền|ủy quyền|uỷ quyền/iu,
    reply: 'Dạ thưa Chủ tịch, trợ lý không đổi được quyền của ai. Việc này làm trên trang quản trị, hoặc xin Chủ tịch bấm Nhờ Văn phòng.',
  },
  {
    when: /chuyển khoản|chi tiền|thanh toán|trả tiền/iu,
    reply: 'Dạ thưa Chủ tịch, trợ lý không chi tiền hay chuyển khoản được. Việc này Chủ tịch làm trực tiếp, hoặc bấm Nhờ Văn phòng.',
  },
  {
    when: /đánh dấu.*(xong|hoàn thành)|báo xong\s+(hộ|giúp)/iu,
    reply: 'Dạ thưa Chủ tịch, trợ lý không báo xong thay người khác được. Người nhận việc tự báo xong trên máy của mình.',
  },
  // ── Thôi, không làm nữa ──
  { when: /^(thôi|không cần|bỏ đi|dừng)/iu, reply: 'Dạ thưa Chủ tịch, trợ lý không làm gì thêm ạ.' },
  // ── Câu cụt, nghe không rõ: hỏi lại, không đoán ──
  { when: /^(đi\s+)?thúc[\s.!?]*$/iu, reply: 'Dạ, Chủ tịch muốn đi thúc ai ạ?' },
  { when: /^(ờ|à|ừ|ơ)(\s|,|$)|cái (kia|đó|này) ấy/iu, reply: 'Dạ, trợ lý nghe chưa rõ. Xin Chủ tịch nhắc lại giúp trợ lý ạ.' },
  { when: /(việc|cái)\s+hôm\s+(nọ|trước)/iu, reply: 'Dạ, Chủ tịch muốn nói tới việc nào ạ?' },
  // ── Giao việc mới: hỏi từng ô còn thiếu, đủ rồi mới đề xuất ──
  {
    when: (messages) => {
      const ctx = lastContext(messages);
      return START_RE.test(ctx.userText) || START_QUESTION_RE.test(ctx.previousAssistantText);
    },
    respond: startRunFlow,
  },
  // ── Đổi người ──
  {
    when: REASSIGN_RE,
    respond: (ctx) => {
      const m = REASSIGN_RE.exec(ctx.userText);
      if (!m) return { reply: 'Dạ, Chủ tịch muốn chuyển việc nào ạ?' };
      const [stepPhrase, target] = [m[2] as string, m[4] as string];
      const query = extractPersonQuery(target) || target;
      if (!ctx.last('search_people')) {
        return {
          toolCalls: [
            { name: 'search_people', args: { query } },
            { name: 'list_runs', args: { state: 'running' } },
          ],
        };
      }
      const people = matchedPeople(ctx.last('search_people')?.payload);
      if (people.length === 0) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy người nhận mới. Xin Chủ tịch nói lại tên giúp trợ lý ạ.' };
      if (people.length > 1) return { reply: `Dạ, ${query} nào ạ?` };
      const pendingRead = loadRunDetails(ctx);
      if (pendingRead) return pendingRead;
      const step = findOpenStep(ctx, stepPhrase);
      if (!step) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy việc đó. Chủ tịch muốn chuyển việc nào ạ?' };
      const proposed = ctx.last('propose_reassign');
      if (!proposed) {
        const reason = /,\s*(.+)$/u.exec(target)?.[1]?.trim() || 'Theo yêu cầu của người dùng';
        return { toolCalls: [{ name: 'propose_reassign', args: { stepRunId: idOf(step, 'stepId'), toUserId: (people[0] as Record<string, unknown>).id, reason } }] };
      }
      if (proposed.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa soạn được đề xuất đổi người này. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.' };
      return { reply: 'Dạ thưa Chủ tịch, trợ lý đã soạn đề xuất đổi người. Xin Chủ tịch xem trên màn hình và bấm Đồng ý nếu đúng.' };
    },
  },
  // ── Gia hạn ──
  {
    when: EXTEND_RE,
    respond: (ctx) => {
      const m = EXTEND_RE.exec(ctx.userText);
      if (!m) return { reply: 'Dạ, Chủ tịch muốn đổi hạn việc nào ạ?' };
      const [stepPhrase, datePhrase] = [m[2] as string, (m[4] as string).replace(/[.!?]+$/u, '').trim()];
      const resolved = ctx.last('resolve_date');
      if (!resolved) {
        return {
          toolCalls: [
            { name: 'resolve_date', args: { phrase: datePhrase } },
            { name: 'list_runs', args: { state: 'running' } },
          ],
        };
      }
      const date = !resolved.isError && isRecord(resolved.payload) && typeof resolved.payload.date === 'string' ? resolved.payload.date : null;
      if (!date) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa rõ ngày. Chủ tịch muốn đổi hạn sang ngày nào ạ?' };
      const pendingRead = loadRunDetails(ctx);
      if (pendingRead) return pendingRead;
      const step = findOpenStep(ctx, stepPhrase);
      if (!step) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy việc đó. Chủ tịch muốn đổi hạn việc nào ạ?' };
      const proposed = ctx.last('propose_extend_due');
      if (!proposed) return { toolCalls: [{ name: 'propose_extend_due', args: { stepRunId: idOf(step, 'stepId'), newDue: date, reason: 'Theo yêu cầu của người dùng' } }] };
      if (proposed.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa soạn được đề xuất đổi hạn này. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.' };
      return { reply: 'Dạ thưa Chủ tịch, trợ lý đã soạn đề xuất đổi hạn. Xin Chủ tịch xem trên màn hình và bấm Đồng ý nếu đúng.' };
    },
  },
  // ── Đi thúc mọi việc đang chậm ──
  { when: /thúc\s+(tất cả|hết|mọi)/iu, respond: fakeMassNudgeFlow },
  // ── Người dùng trả lời câu "… nào ạ?": tiếp tục đúng việc đang dở ──
  {
    when: (messages) => {
      const ctx = lastContext(messages);
      const before = ctx.previousUserTexts.at(-1) ?? '';
      return WHICH_ONE_RE.test(ctx.previousAssistantText) && (NUDGE_RE.test(before) || WORKLOAD_RE.test(before));
    },
    respond: (ctx) => (WORKLOAD_RE.test(ctx.previousUserTexts.at(-1) ?? '') ? workloadFlow(ctx, ctx.userText) : fakeNudgeFlow(ctx, ctx.userText)),
  },
  // ── Một người đang giữ việc gì ──
  { when: WORKLOAD_RE, respond: (ctx) => workloadFlow(ctx, extractPersonQuery(ctx.userText) || ctx.userText) },
  // ── Ai đang chậm ──
  { when: /ai (đang )?(chậm|trễ)|có gì chậm|(việc|cái) (nào|gì) (đang )?(chậm|quá hạn|trễ)/iu, respond: fakeWhoIsLateFlow },
  // ── Số liệu tổng quan ──
  overviewStep(/cần tôi (quyết|duyệt)|chờ tôi (quyết|duyệt)/iu, (o) =>
    (o.awaitingMyDecision ?? 0) > 0 ? `Dạ thưa Chủ tịch, có ${o.awaitingMyDecision} việc đang chờ Chủ tịch quyết.` : 'Dạ thưa Chủ tịch, hiện không có việc nào đang chờ Chủ tịch quyết.',
  ),
  overviewStep(/đến hạn/iu, (o) => {
    const today = o.dueToday > 0 ? `hôm nay có ${o.dueToday} việc đến hạn` : 'hôm nay không có việc nào đến hạn';
    const tomorrow = o.dueTomorrow > 0 ? `ngày mai có ${o.dueTomorrow} việc đến hạn` : 'ngày mai không có việc nào đến hạn';
    return `Dạ thưa Chủ tịch, ${today}, ${tomorrow}.`;
  }),
  overviewStep(/tình hình (chung|hôm nay)|hôm nay (thế nào|ra sao)/iu, (o) => fallbackOverviewText(o)),
];
