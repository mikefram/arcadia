import { describe, expect, it } from 'vitest';
import {
  buildFakeLlmContext,
  createProviders,
  FAKE_LLM_DEFAULT_REPLY,
  FakeLlm,
  FakeStt,
  FakeTts,
  LLM_SYSTEM_NOTE_PREFIX,
  parseToolResultContent,
  type LlmEvent,
  type LlmMsg,
  type LlmToolResultPart,
  type LlmToolUsePart,
  type SttEvent,
} from '../src';

const wrap = (name: string, value: unknown) => `<tool_result name="${name}">\n${JSON.stringify(value)}\n</tool_result>`;

async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const TUAN = { id: '01920000-0000-7000-8000-0000000000a6', fullName: 'Bùi Quốc Tuấn', givenName: 'Tuấn', honorific: 'anh' };
const S3 = { id: '01920000-0000-7000-8000-0000000000c3', title: 'Kiểm tra tuyến tham quan', lateWorkingDays: 1, isOverdue: true, state: 'ready', assignee: TUAN };

/** Máy chủ tool tí hon cho bài chạy mẫu: trả kết quả cố định theo tên tool. */
function fakeTool(name: string): unknown {
  if (name === 'search_people') return { ok: true, result: { people: [TUAN] } };
  if (name === 'list_overdue_steps') return { ok: true, result: { steps: [S3] } };
  if (name === 'propose_nudge') return { ok: true, proposals: [{ proposalId: '01920000-0000-7000-8000-0000000000f1', batchId: null, risk: 1, summary: 'Gửi lời nhắc tới anh Tuấn.' }] };
  return { ok: false, error: { code: 'unknown_tool', message: 'không có tool này' } };
}

describe('FakeStt', () => {
  it('phát kết quả tạm theo từng khối âm thanh rồi chốt khi close()', async () => {
    const stt = new FakeStt([{ interim: ['đi', 'đi thúc', 'đi thúc anh Tuấn'], final: 'đi thúc anh Tuấn', confidence: 0.93 }]);
    const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: ['Tuấn'], utteranceEndMs: 1300 });
    const events: SttEvent[] = [];
    session.on('interim', (e) => events.push(e));
    session.on('final', (e) => events.push(e));
    session.on('utteranceEnd', (e) => events.push(e));
    session.sendAudio(new Uint8Array(3200));
    session.keepAlive();
    await session.close();
    expect(events).toEqual([
      { type: 'interim', text: 'đi' },
      { type: 'interim', text: 'đi thúc' },
      { type: 'interim', text: 'đi thúc anh Tuấn' },
      { type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.93 },
    ]);
    expect(stt.sessions[0]).toMatchObject({ audioChunks: 1, audioBytes: 3200, keepAlives: 1, closed: true });
    expect(stt.sessions[0]?.options.keyterms).toEqual(['Tuấn']);
    expect(stt.openSessions).toBe(0);
  });

  it('tự chốt và báo utteranceEnd sau số khối đã định', async () => {
    const stt = new FakeStt([{ final: 'đồng ý', confidence: 0.99 }], { autoEndAfterChunks: 2 });
    const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    const types: string[] = [];
    session.on('final', (e) => types.push(`${e.type}:${e.text}`));
    session.on('utteranceEnd', (e) => types.push(e.type));
    session.sendAudio(new Uint8Array(10));
    expect(types).toEqual([]);
    session.sendAudio(new Uint8Array(10));
    expect(types).toEqual(['final:đồng ý', 'utteranceEnd']);
    await session.close();
    expect(types).toHaveLength(2);
  });

  it('câu rỗng và hàng đợi trống: không có sự kiện final (nhánh nghe không rõ)', async () => {
    const stt = new FakeStt([{ final: '', confidence: 0 }]);
    for (let i = 0; i < 2; i++) {
      const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
      let finals = 0;
      session.on('final', () => finals++);
      session.sendAudio(new Uint8Array(100));
      await session.close();
      expect(finals).toBe(0);
    }
  });

  it('giả lập lỗi mở phiên và lỗi giữa phiên', async () => {
    const stt = new FakeStt([{ final: 'x', confidence: 1, error: true }]);
    stt.failNextOpen = 1;
    await expect(stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 })).rejects.toThrow('stt_open_failed');
    const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    const codes: string[] = [];
    session.on('error', (e) => codes.push(e.code));
    await session.close();
    expect(codes).toEqual(['stt_fake_error']);
  });
});

describe('FakeTts', () => {
  it('trả các khối byte tất định theo độ dài văn bản và ghi lại văn bản đã đọc', async () => {
    const tts = new FakeTts();
    const read = async (text: string) => {
      const chunks: Uint8Array[] = [];
      for await (const c of tts.synthesize(text, { voice: 'giong-thu', speed: 0.9, format: 'mp3' })) chunks.push(c);
      return chunks;
    };
    const short = await read('Dạ thưa Chủ tịch.');
    const long = await read('a'.repeat(250));
    expect(short).toHaveLength(1);
    expect(long).toHaveLength(3);
    expect([short[0]?.[0], short[0]?.[1]]).toEqual([0xff, 0xfb]);
    expect(await read('Dạ thưa Chủ tịch.')).toEqual(short);
    expect(tts.spoken.map((s) => s.text)).toEqual(['Dạ thưa Chủ tịch.', 'a'.repeat(250), 'Dạ thưa Chủ tịch.']);
    expect(tts.spoken[0]).toMatchObject({ voice: 'giong-thu', speed: 0.9, format: 'mp3' });
  });

  it('từ chối đoạn dài quá 300 ký tự và giả lập lỗi', async () => {
    const tts = new FakeTts();
    const drain = async (text: string) => {
      for await (const _ of tts.synthesize(text, { voice: 'v', speed: 1, format: 'mp3' })) void _;
    };
    await expect(drain('a'.repeat(301))).rejects.toThrow(RangeError);
    tts.failNext = 1;
    await expect(drain('xin chào')).rejects.toThrow('tts_fake_error');
    await expect(drain('xin chào')).resolves.toBeUndefined();
  });

  it('dừng khi bị huỷ giữa chừng', async () => {
    const tts = new FakeTts({ chunkDelayMs: 20 });
    const controller = new AbortController();
    let n = 0;
    for await (const _ of tts.synthesize('a'.repeat(300), { voice: 'v', speed: 1, format: 'mp3', signal: controller.signal })) {
      void _;
      n++;
      controller.abort();
    }
    expect(n).toBe(1);
  });

  it('batch trả liên kết có hạn', async () => {
    const tts = new FakeTts();
    const out = await tts.synthesizeBatch('Bản tin sáng.', { voice: 'v', speed: 0.9 });
    expect(out.url).toMatch(/^https:\/\/tts\.fake\.invalid\//);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('FakeLlm', () => {
  it('câu lạ: trả câu lịch sự mặc định, không gọi tool', async () => {
    const llm = new FakeLlm();
    const events = await collect(llm.stream({ system: [], tools: [], messages: [{ role: 'user', content: 'hôm nay trời đẹp nhỉ' }], effort: 'low' }));
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(text).toBe(FAKE_LLM_DEFAULT_REPLY);
    expect(events.at(-1)).toMatchObject({ type: 'message_stop', stopReason: 'end_turn' });
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
  });

  it('bước tĩnh: gọi tool ở lượt đầu, có kết quả rồi thì trả lời', () => {
    const llm = new FakeLlm([{ when: /ai đang chậm/i, toolCalls: [{ name: 'list_overdue_steps', args: {} }], reply: 'Dạ, có 1 việc quá hạn.' }]);
    const first = llm.decide({ system: [], messages: [{ role: 'user', content: 'Ai đang chậm?' }] });
    expect(first.toolCalls).toEqual([{ name: 'list_overdue_steps', args: {} }]);
    const messages: LlmMsg[] = [
      { role: 'user', content: 'Ai đang chậm?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'list_overdue_steps', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: wrap('list_overdue_steps', { ok: true, result: { steps: [S3] } }) }] },
    ];
    expect(llm.decide({ system: [], messages })).toEqual({ reply: 'Dạ, có 1 việc quá hạn.' });
  });

  it('ngữ cảnh: bỏ qua ghi chú hệ thống khi tìm câu người dùng cuối', () => {
    const messages: LlmMsg[] = [
      { role: 'user', content: 'tình hình chung' },
      { role: 'assistant', content: 'Dạ, có 99 việc.' },
      { role: 'user', content: `${LLM_SYSTEM_NOTE_PREFIX} Câu trả lời vừa rồi có số lạ.` },
    ];
    const ctx = buildFakeLlmContext({ system: [{ type: 'text', text: 'S' }], messages });
    expect(ctx.userText).toBe('tình hình chung');
    expect(ctx.notices).toBe(1);
    expect(ctx.system).toBe('S');
  });

  it('parseToolResultContent gỡ thẻ bọc', () => {
    expect(parseToolResultContent(wrap('x', { ok: true, result: [1, 2] }))).toEqual({ ok: true, result: [1, 2] });
    expect(parseToolResultContent('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolResultContent('không phải JSON')).toBeUndefined();
  });

  it('giả lập lỗi và ghi lại yêu cầu', async () => {
    const llm = new FakeLlm();
    llm.failNext = 1;
    const events = await collect(llm.stream({ system: [], tools: [], messages: [{ role: 'user', content: 'a' }], effort: 'medium' }));
    expect(events).toEqual([{ type: 'error', code: 'unavailable', retryable: true }]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.effort).toBe('medium');
  });
});

describe('một lượt hội thoại mẫu với ba bản giả, không cần mạng (S1-05)', () => {
  it('"đi thúc anh Tuấn": nghe, gọi tool theo thứ tự, đề xuất, trả lời, đọc thành tiếng', async () => {
    const providers = createProviders({});
    expect(providers.kinds).toEqual({ stt: 'fake', llm: 'fake', tts: 'fake' });
    const stt = providers.stt as FakeStt;
    const tts = providers.tts as FakeTts;
    stt.enqueue({ interim: ['đi thúc'], final: 'đi thúc anh Tuấn', confidence: 0.95 });

    // Nghe
    const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: ['Tuấn'], utteranceEndMs: 1300 });
    let heard = '';
    session.on('final', (e) => (heard = e.text));
    session.sendAudio(new Uint8Array(3200));
    await session.close();
    expect(heard).toBe('đi thúc anh Tuấn');

    // Hiểu và gọi tool: vòng lặp tối giản, mọi tool_result của một lượt nằm trong MỘT tin nhắn người dùng
    const messages: LlmMsg[] = [{ role: 'user', content: heard }];
    const called: string[] = [];
    let reply = '';
    for (let round = 0; round < 6; round++) {
      const uses: LlmToolUsePart[] = [];
      let text = '';
      let stop = '';
      for await (const e of providers.llm.stream({ system: [], tools: [], messages, effort: 'low' })) {
        if (e.type === 'text_delta') text += e.text;
        else if (e.type === 'tool_use') uses.push({ type: 'tool_use', id: e.id, name: e.name, input: e.input });
        else if (e.type === 'message_stop') stop = e.stopReason;
      }
      if (stop !== 'tool_use') {
        reply = text;
        break;
      }
      messages.push({ role: 'assistant', content: uses });
      const results: LlmToolResultPart[] = uses.map((u) => {
        called.push(u.name);
        return { type: 'tool_result', tool_use_id: u.id, content: wrap(u.name, fakeTool(u.name)) };
      });
      messages.push({ role: 'user', content: results });
    }
    expect(called).toEqual(['search_people', 'list_overdue_steps', 'propose_nudge']);
    expect(reply).toContain('anh Tuấn');
    const nudge = messages.flatMap((m) => (m.role === 'assistant' && typeof m.content !== 'string' ? m.content : [])).find((p) => p.type === 'tool_use' && p.name === 'propose_nudge');
    expect(nudge).toMatchObject({ input: { stepRunIds: [S3.id], named: true } });

    // Đọc lại
    let bytes = 0;
    for await (const chunk of tts.synthesize(reply, { voice: 'giong-thu', speed: 0.9, format: 'mp3' })) bytes += chunk.byteLength;
    expect(bytes).toBeGreaterThan(0);
    expect(tts.spoken[0]?.text).toBe(reply);
  });

  it('"tình hình đón đoàn Nhật": list_runs rồi get_run rồi trả lời bằng số trong kết quả tool', () => {
    const llm = new FakeLlm();
    const run = { id: '01920000-0000-7000-8000-0000000000b1', title: 'Đón đoàn nhà đầu tư Nhật Bản', progress: { done: 4, total: 6 } };
    const detail = {
      ...run,
      steps: [
        { id: 's1', title: 'Lập chương trình đón đoàn', state: 'done', isOverdue: false },
        { id: 's4', title: 'Lập đề nghị tạm ứng', state: 'done', isOverdue: false },
        { id: 's6', title: 'Duyệt đề nghị tạm ứng', state: 'done', isOverdue: false },
        { id: 's2', title: 'Hồ sơ pháp lý đất và tài liệu giới thiệu', state: 'done', isOverdue: false },
        { id: 's5', title: 'Báo giá thuê nhà xưởng cho đoàn', state: 'ready', isOverdue: false },
        S3,
      ],
    };
    const messages: LlmMsg[] = [{ role: 'user', content: 'tình hình đón đoàn Nhật' }];
    expect(llm.decide({ system: [], messages }).toolCalls?.[0]?.name).toBe('list_runs');
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'list_runs', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: wrap('list_runs', { ok: true, result: { runs: [run] } }) }] },
    );
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'get_run', args: { runId: run.id } }]);
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'get_run', input: { runId: run.id } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: wrap('get_run', { ok: true, result: detail }) }] },
    );
    const reply = llm.decide({ system: [], messages }).reply ?? '';
    expect(reply).toContain('4 trên 6 việc đã xong');
    expect(reply).toContain('1 việc đang làm và 1 việc quá hạn');
    expect(reply).toContain('anh Tuấn');
  });

  it('"huỷ cả đợt đón đoàn": list_runs rồi propose_cancel_run', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [{ role: 'user', content: 'huỷ cả đợt đón đoàn' }];
    expect(llm.decide({ system: [], messages }).toolCalls?.[0]).toMatchObject({ name: 'list_runs' });
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'list_runs', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: wrap('list_runs', { ok: true, result: { runs: [{ id: 'run-1', title: 'Đón đoàn' }] } }) }] },
    );
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'propose_cancel_run', args: { runId: 'run-1', reason: 'Người dùng yêu cầu huỷ qua trợ lý' } }]);
  });
});

describe('FakeLlm: các câu của kịch bản vàng B ngoài "đi thúc anh Tuấn"', () => {
  const step = (id: string, title: string) => ({ id, title, lateWorkingDays: 2, isOverdue: true, state: 'ready', assignee: TUAN });
  const toolTurn = (id: string, name: string, input: Record<string, unknown>, result: unknown): LlmMsg[] => [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: wrap(name, result) }] },
  ];

  it('"Đi thúc các việc đang chậm": không coi "các việc đang chậm" là tên người; nhắc hàng loạt mọi việc quá hạn', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [{ role: 'user', content: 'Đi thúc các việc đang chậm' }];
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'list_overdue_steps', args: {} }]);
    messages.push(...toolTurn('a', 'list_overdue_steps', {}, { ok: true, result: { steps: [step('s-3', 'Kiểm tra tuyến'), step('s-4', 'Lập đề nghị')] } }));
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'propose_nudge', args: { stepRunIds: ['s-3', 's-4'], named: true } }]);
  });

  it('câu soạn sẵn của M5 có tên lượt trong ngoặc: chỉ lấy việc quá hạn của lượt đó', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [{ role: 'user', content: 'Đi thúc các việc đang chậm của lượt ‘Đón đoàn nhà đầu tư Nhật Bản’' }];
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'list_runs', args: { state: 'running', query: 'Đón đoàn nhà đầu tư Nhật Bản' } }]);
    messages.push(...toolTurn('a', 'list_runs', {}, { ok: true, result: { runs: [{ id: 'run-9', title: 'Đón đoàn nhà đầu tư Nhật Bản' }] } }));
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'list_overdue_steps', args: { runId: 'run-9' } }]);
  });

  it('mọi việc đều bị chặn làm phiền: nói đúng lý do, không nói "đã soạn lời nhắc"', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [{ role: 'user', content: 'đi thúc anh Tuấn' }];
    messages.push(...toolTurn('a', 'search_people', {}, { ok: true, result: { people: [TUAN] } }));
    messages.push(...toolTurn('b', 'list_overdue_steps', {}, { ok: true, result: { steps: [step('s-3', 'Kiểm tra tuyến')] } }));
    messages.push(
      ...toolTurn('c', 'propose_nudge', {}, { ok: true, proposals: [], result: { created: 0, skipped: [{ stepRunId: 's-3', reason: 'already_nudged_today', nextAllowedAt: null }] } }),
    );
    const reply = llm.decide({ system: [], messages }).reply ?? '';
    expect(reply).toContain('chưa soạn lời nhắc');
    expect(reply).toContain('hôm nay việc này đã được nhắc rồi');
    expect(reply).not.toContain('đã soạn lời nhắc gửi');
  });

  it('tên mơ hồ rồi người dùng chạm chọn: tiếp tục đúng việc đi thúc đang dở', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [
      { role: 'user', content: 'nhắc chị Lan' },
      { role: 'assistant', content: 'Dạ, chị Lan nào ạ?' },
      { role: 'user', content: 'Nguyễn Thu Lan' },
    ];
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'search_people', args: { query: 'Nguyễn Thu Lan' } }]);
  });

  it('"Ai đang chậm?": đọc việc quá hạn rồi nêu việc trễ nhất bằng số của tool', () => {
    const llm = new FakeLlm();
    const messages: LlmMsg[] = [{ role: 'user', content: 'Ai đang chậm?' }];
    expect(llm.decide({ system: [], messages }).toolCalls).toEqual([{ name: 'list_overdue_steps', args: {} }]);
    messages.push(...toolTurn('a', 'list_overdue_steps', {}, { ok: true, result: { steps: [step('s-3', 'Kiểm tra tuyến tham quan')] } }));
    const reply = llm.decide({ system: [], messages }).reply ?? '';
    expect(reply).toContain('1 việc quá hạn');
    expect(reply).toContain('Kiểm tra tuyến tham quan');
    expect(reply).toContain('trễ 2 ngày làm việc');
  });
});

describe('createProviders', () => {
  it('mặc định là bản giả; bỏ qua chú thích cuối dòng trong .env', () => {
    expect(createProviders({ STT_PROVIDER: 'fake        # fake | deepgram | vbee', LLM_PROVIDER: ' FAKE ', TTS_PROVIDER: '' }).kinds).toEqual({ stt: 'fake', llm: 'fake', tts: 'fake' });
  });

  it('FAKE_STT_SCRIPT: STT giả nghe lần lượt từng câu rồi quay lại từ đầu (để thử tay với app)', async () => {
    const { stt } = createProviders({ FAKE_STT_SCRIPT: 'tình hình đón đoàn Nhật | đi thúc anh Tuấn' });
    const heard: string[] = [];
    for (let i = 0; i < 3; i++) {
      const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
      session.on('final', (e) => heard.push(`${e.text}@${e.confidence}`));
      await session.close();
    }
    expect(heard).toEqual(['tình hình đón đoàn Nhật@0.95', 'đi thúc anh Tuấn@0.95', 'tình hình đón đoàn Nhật@0.95']);
  });

  it('FAKE_STT_AUTO_END_CHUNKS: STT giả tự chốt lượt sau từng ấy khối âm thanh, như Deepgram báo hết câu (thử chế độ trò chuyện không tốn tiền)', async () => {
    const { stt } = createProviders({ FAKE_STT_SCRIPT: 'tình hình đón đoàn Nhật', FAKE_STT_AUTO_END_CHUNKS: '3   # 3 khối là 180 ms' });
    const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
    const events: string[] = [];
    for (const name of ['interim', 'final', 'utteranceEnd'] as const) session.on(name, (e) => events.push(e.type));
    session.sendAudio(new Uint8Array(1920));
    session.sendAudio(new Uint8Array(1920));
    expect(events).toEqual(['interim']);
    session.sendAudio(new Uint8Array(1920));
    expect(events).toEqual(['interim', 'final', 'utteranceEnd']);
  });

  it('FAKE_STT_AUTO_END_CHUNKS trống, không phải số nguyên dương, hoặc bằng 0: không tự chốt (chỉ chốt khi đóng phiên)', async () => {
    for (const raw of ['', 'abc', '0', '-2', '1.5']) {
      const { stt } = createProviders({ FAKE_STT_SCRIPT: 'đi thúc anh Tuấn', FAKE_STT_AUTO_END_CHUNKS: raw });
      const session = await stt.open({ language: 'vi', sampleRate: 16000, keyterms: [], utteranceEndMs: 1300 });
      const events: string[] = [];
      for (const name of ['final', 'utteranceEnd'] as const) session.on(name, (e) => events.push(e.type));
      for (let i = 0; i < 50; i++) session.sendAudio(new Uint8Array(1920));
      expect(events, `giá trị "${raw}"`).toEqual([]);
      await session.close();
    }
  });

  it('bản thật thiếu khoá thì báo lỗi rõ, không âm thầm chạy', () => {
    expect(() => createProviders({ STT_PROVIDER: 'deepgram' })).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => createProviders({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createProviders({ TTS_PROVIDER: 'vbee' })).toThrow(/VBEE/);
    expect(() => createProviders({ STT_PROVIDER: 'vbee' })).toThrow(/chưa được cài/);
    expect(() => createProviders({ LLM_PROVIDER: 'gpt' })).toThrow(/không hợp lệ/);
  });

  it('có khoá thì dựng bản thật (không gọi mạng lúc dựng)', () => {
    const p = createProviders({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'k', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', TTS_PROVIDER: 'vbee', VBEE_APP_ID: 'a', VBEE_TOKEN: 't' });
    expect(p.kinds).toEqual({ stt: 'deepgram', llm: 'anthropic', tts: 'vbee' });
  });
});
