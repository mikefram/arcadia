/**
 * Mic chỉ mở khi bấm, ngắt lời, và các sự cố của từng nhà cung cấp (SPEC 6.2, 6.6, 6.10, 6.11, 10.7.2).
 */
import type { FakeLlmStep } from '@mihato/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { done, type Harness, ofType, sequence, sleep, startHarness, textTurn, until, voiceTurn } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.stop();
});

const HELLO = { final: 'xin chào trợ lý', confidence: 0.95 };
const LONG_REPLY = Array.from({ length: 12 }, (_, i) => `Đây là câu trả lời dài thứ ${i + 1} để trợ lý đọc thành nhiều khối âm thanh liên tiếp nhau.`).join(' ');

describe('mic chỉ mở khi người dùng bấm', () => {
  it('khung nhị phân ngoài lượt nói bị bỏ: không mở kết nối STT nào', async () => {
    h = await startHarness({ utterances: [HELLO] });
    const client = await h.connect();
    client.sendAudio();
    client.sendAudio();
    await sleep(40);
    expect(h.stt.sessions).toHaveLength(0);
    expect(client.frames.filter((f) => f.type !== 'ready')).toEqual([]);

    // Âm thanh đến sau end_turn (app gửi trễ) cũng bị bỏ.
    await voiceTurn(client);
    client.sendAudio();
    await sleep(20);
    expect(h.stt.sessions).toHaveLength(1);
    expect(h.stt.sessions[0]).toMatchObject({ audioChunks: 2, closed: true });
    client.close();
    await client.closed;
    await until(() => h.logs.some((l) => l.includes('"session_closed"')));
    const closed = JSON.parse(h.logs.find((l) => l.includes('"session_closed"')) ?? '{}') as { droppedAudioFrames: number };
    expect(closed.droppedAudioFrames).toBe(3);
  });

  it('kết nối STT chỉ sống trong lượt nói, mang đúng tham số và keyterm của tổ chức', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO] });
    const client = await h.connect();
    expect(h.stt.openSessions).toBe(0);
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
    await until(() => h.stt.openSessions === 1);
    client.sendAudio();
    client.send({ type: 'end_turn' });
    await client.waitIdle(from);
    expect(h.stt.openSessions).toBe(0);
    expect(h.stt.sessions[0]?.options).toEqual({ language: 'vi', sampleRate: 16000, keyterms: ['Bùi Quốc Tuấn', 'Nguyễn Thu Lan', 'Kinh doanh'], utteranceEndMs: 1300 });
    await voiceTurn(client);
    expect(h.stt.sessions).toHaveLength(2);
    expect(h.stt.openSessions).toBe(0);
  });

  it('app tạm ngừng gửi âm thanh: scribe tự gửi KeepAlive cho STT', async () => {
    h = await startHarness({ utterances: [HELLO], config: { sttKeepAliveMs: 20 } });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
    client.sendAudio();
    await until(() => (h.stt.sessions[0]?.keepAlives ?? 0) >= 2);
    client.send({ type: 'end_turn' });
    await client.waitIdle(from);
    const sent = h.stt.sessions[0]?.keepAlives ?? 0;
    await sleep(60);
    // Hết lượt nói thì thôi gửi.
    expect(h.stt.sessions[0]?.keepAlives).toBe(sent);
  });

  it('STT báo hết lượt nói thì máy chủ tự chốt, không cần end_turn', async () => {
    h = await startHarness({ utterances: [{ final: 'tình hình đón đoàn Nhật', confidence: 0.9 }], sttAutoEndAfterChunks: 3 });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
    for (let i = 0; i < 3; i++) client.sendAudio();
    await client.waitIdle(from);
    const frames = client.since(from);
    expect(ofType(frames, 'transcript.final')[0]).toMatchObject({ text: 'tình hình đón đoàn Nhật', confidence: 0.9 });
    expect(done(frames)?.text).toContain('4 trên 6 việc đã xong');
    expect(h.stt.openSessions).toBe(0);
  });

  it('lượt nói quá dài thì tự chốt', async () => {
    h = await startHarness({ utterances: [HELLO], config: { maxTurnMs: 60 } });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitIdle(from);
    expect(ofType(client.since(from), 'transcript.final')[0]).toMatchObject({ text: 'xin chào trợ lý' });
  });

  it('end_turn tới trước khi kết nối STT mở xong vẫn được chốt đúng', async () => {
    h = await startHarness({ utterances: [HELLO] });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    client.sendAudio();
    client.send({ type: 'end_turn' });
    await client.waitIdle(from);
    expect(ofType(client.since(from), 'transcript.final')[0]).toMatchObject({ text: 'xin chào trợ lý' });
    expect(h.stt.sessions[0]).toMatchObject({ audioChunks: 1, closed: true });
  });

  it('ngắt kết nối giữa lượt nói: đóng luồng STT ngay', async () => {
    h = await startHarness({ utterances: [HELLO] });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
    client.sendAudio();
    await until(() => h.stt.openSessions === 1);
    client.terminate();
    await until(() => h.stt.openSessions === 0);
    await until(() => h.server.sessionCount() === 0);
    expect(h.llm.calls).toHaveLength(0);
  });
});

describe('ngắt lời', () => {
  const steps: FakeLlmStep[] = [{ when: /đọc bài dài/iu, reply: LONG_REPLY }];

  it('interrupt khi trợ lý đang đọc: dừng đọc ngay, đóng audio, về rảnh', async () => {
    h = await startHarness({ llmSteps: steps, tts: { chunkDelayMs: 25 } });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'text', text: 'đọc bài dài' });
    await client.waitType('binary', from);
    client.send({ type: 'interrupt' });
    await client.waitIdle(from);
    const at = client.mark();
    const names = sequence(client.since(from));
    expect(names.slice(-2)).toEqual(['audio.end', 'status:idle']);
    const binaryBefore = ofType(client.since(from), 'binary').length;
    await sleep(120);
    // Sau audio.end không còn khối âm thanh nào, và TTS không đọc hết các đoạn.
    expect(client.since(at)).toEqual([]);
    expect(binaryBefore).toBeLessThan(10);
    expect(done(client.since(from))?.text).toBe(LONG_REPLY);
  });

  it('bấm micro khi trợ lý đang đọc: dừng đọc và nghe tiếp', async () => {
    h = await startHarness({ llmSteps: steps, tts: { chunkDelayMs: 25 }, utterances: [HELLO] });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'text', text: 'đọc bài dài' });
    await client.waitType('binary', from);
    const cut = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', cut);
    expect(sequence(client.since(cut)).filter((n) => n !== 'binary')).toEqual(['audio.end', 'status:listening']);
    client.sendAudio();
    client.send({ type: 'end_turn' });
    await client.waitIdle(cut);
    expect(ofType(client.since(cut), 'transcript.final')[0]).toMatchObject({ text: 'xin chào trợ lý' });
    // Lượt mới có turnId mới.
    expect(ofType(client.since(cut), 'transcript.final')[0]?.turnId).not.toBe(done(client.since(from))?.turnId);
  });

  it('interrupt khi trợ lý đang nghĩ: huỷ lượt gọi model, không có assistant.done, lịch sử không giữ lượt dở', async () => {
    h = await startHarness({ llmDelayMs: 150 });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'text', text: 'tình hình đón đoàn Nhật' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'thinking', from);
    client.send({ type: 'interrupt' });
    await client.waitIdle(from);
    await sleep(200);
    expect(sequence(client.since(from))).toEqual(['status:thinking', 'status:idle']);
    const frames = await textTurn(client, 'xin chào trợ lý');
    expect(done(frames)).toBeDefined();
    expect(h.llm.calls.at(-1)?.messages).toEqual([{ role: 'user', content: 'xin chào trợ lý' }]);
  });
});

describe('sự cố của nhà cung cấp (SPEC 6.11)', () => {
  it('STT không mở được: error stt_unavailable, phiên vẫn dùng được bằng gõ chữ', async () => {
    h = await startHarness();
    h.stt.failNextOpen = 1;
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitIdle(from);
    expect(sequence(client.since(from))).toEqual(['status:listening', 'error:stt_unavailable', 'status:idle']);
    expect(ofType(client.since(from), 'error')[0]).toEqual({ type: 'error', code: 'stt_unavailable', retryable: true });
    expect(done(await textTurn(client, 'tình hình đón đoàn Nhật'))?.text).toContain('4 trên 6');
  });

  it('STT lỗi giữa lượt nói: error stt_unavailable, không gọi LLM', async () => {
    h = await startHarness({ utterances: [{ final: 'x', confidence: 1, error: true }] });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
    client.sendAudio();
    await client.waitIdle(from);
    expect(sequence(client.since(from))).toEqual(['status:listening', 'error:stt_unavailable', 'status:idle']);
    expect(h.llm.calls).toHaveLength(0);
    expect(h.stt.openSessions).toBe(0);
  });

  it('STT lỗi đúng lúc đang chốt lượt nói: báo stt_unavailable, không đoán câu', async () => {
    h = await startHarness({ utterances: [{ final: 'x', confidence: 1, error: true }] });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
    client.send({ type: 'end_turn' });
    await client.waitIdle(from);
    expect(sequence(client.since(from))).toEqual(['status:listening', 'error:stt_unavailable', 'status:idle']);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('STT bị tắt ở công tắc của tổ chức: lượt nói báo stt_unavailable không thử lại, gõ chữ vẫn chạy', async () => {
    h = await startHarness();
    h.api.claim = { ai: { enabled: true, stt: 'off', llm: 'anthropic', tts: 'vbee' } };
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitIdle(from);
    expect(ofType(client.since(from), 'error')[0]).toEqual({ type: 'error', code: 'stt_unavailable', retryable: false });
    expect(h.stt.sessions).toHaveLength(0);
  });

  it('LLM lỗi: error llm_unavailable rồi về rảnh; số liệu dùng ghi một lỗi', async () => {
    h = await startHarness();
    h.llm.failNext = 1;
    const client = await h.connect();
    const frames = await textTurn(client, 'tình hình đón đoàn Nhật');
    expect(sequence(frames)).toEqual(['status:thinking', 'error:llm_unavailable', 'status:idle']);
    expect(ofType(frames, 'error')[0]).toEqual({ type: 'error', code: 'llm_unavailable', retryable: true });
    expect(h.api.bodies('/internal/v1/scribe/usage')[0]).toMatchObject({ llmCalls: 1, errors: 1 });
    // Lượt lỗi không nằm lại trong lịch sử: lượt sau bắt đầu sạch.
    await textTurn(client, 'xin chào trợ lý');
    expect(h.llm.calls.at(-1)?.messages).toEqual([{ role: 'user', content: 'xin chào trợ lý' }]);
  });

  it('LLM quá hạn chờ: error llm_unavailable', async () => {
    h = await startHarness({ llmDelayMs: 400, config: { llmTimeoutMs: 60, thinkingNoticeMs: 1000 } });
    const frames = await textTurn(await h.connect(), 'tình hình đón đoàn Nhật');
    expect(sequence(frames)).toEqual(['status:thinking', 'error:llm_unavailable', 'status:idle']);
    expect(h.logs.some((l) => l.includes('"llm_unavailable"') && l.includes('"timeout"'))).toBe(true);
  });

  it('quá 2 giây chưa có chữ trả lời: gửi lại status thinking để app phát câu "xin chờ"', async () => {
    h = await startHarness({ llmDelayMs: 120, config: { thinkingNoticeMs: 40 } });
    const frames = await textTurn(await h.connect(), 'xin chào trợ lý');
    const beforeDone = frames.slice(0, frames.findIndex((f) => f.type === 'assistant.delta'));
    expect(beforeDone).toEqual([
      { type: 'status', phase: 'thinking' },
      { type: 'status', phase: 'thinking' },
    ]);
    // Trả lời nhanh thì chỉ có một khung thinking.
    await h.stop();
    h = await startHarness({ config: { thinkingNoticeMs: 500 } });
    const quick = await textTurn(await h.connect(), 'xin chào trợ lý');
    expect(quick.filter((f) => f.type === 'status' && f.phase === 'thinking')).toHaveLength(1);
  });

  it('TTS lỗi: error tts_unavailable nhưng VẪN gửi chữ', async () => {
    h = await startHarness();
    h.tts.failNext = 1;
    const frames = await textTurn(await h.connect(), 'xin chào trợ lý');
    expect(sequence(frames)).toEqual(['status:thinking', 'assistant.delta', 'assistant.done', 'status:speaking', 'error:tts_unavailable', 'status:idle']);
    expect(done(frames)?.text).toContain('Dạ thưa Chủ tịch');
    expect(ofType(frames, 'error')[0]).toEqual({ type: 'error', code: 'tts_unavailable', retryable: true });
    // Câu trả lời vẫn được ghi vào hội thoại.
    expect((h.api.bodies('/internal/v1/messages') as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('TTS quá 3 giây không có byte đầu: error tts_unavailable, không có audio.start', async () => {
    h = await startHarness({ tts: { firstByteDelayMs: 300 }, config: { ttsFirstByteTimeoutMs: 40 } });
    const frames = await textTurn(await h.connect(), 'xin chào trợ lý');
    expect(sequence(frames)).toEqual(['status:thinking', 'assistant.delta', 'assistant.done', 'status:speaking', 'error:tts_unavailable', 'status:idle']);
  });

  it('TTS lỗi giữa chừng: đóng audio rồi mới báo lỗi', async () => {
    h = await startHarness({ llmSteps: [{ when: /đọc bài dài/iu, reply: LONG_REPLY }], tts: { chunkDelayMs: 20 } });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'text', text: 'đọc bài dài' });
    await client.waitType('audio.start', from);
    // Đoạn đầu đang phát; đoạn kế tiếp sẽ lỗi.
    h.tts.failNext = 1;
    await client.waitIdle(from);
    const names = sequence(client.since(from));
    expect(names.slice(-3)).toEqual(['audio.end', 'error:tts_unavailable', 'status:idle']);
  });

  it('máy chủ tool hỏng: model được báo lỗi tool, trợ lý vẫn trả lời và không có đề xuất', async () => {
    h = await startHarness();
    h.api.toolsDown = true;
    const frames = await textTurn(await h.connect(), 'đi thúc anh Tuấn');
    expect(done(frames)).toBeDefined();
    expect(ofType(frames, 'proposal.created')).toEqual([]);
    const toolResult = h.llm.calls[1]?.messages.at(-1);
    expect(JSON.stringify(toolResult)).toContain('tool_unavailable');
    expect(JSON.stringify(toolResult)).toContain('"is_error":true');
  });

  it('ghi hội thoại lỗi không làm hỏng lượt trả lời', async () => {
    h = await startHarness();
    const client = await h.connect();
    await h.api.stop();
    const from = client.mark();
    client.send({ type: 'text', text: 'xin chào trợ lý' });
    await client.waitIdle(from);
    expect(done(client.since(from))).toBeDefined();
    expect(h.logs.filter((l) => l.includes('"persist_failed"')).length).toBeGreaterThan(0);
    h.api = await h.api.start();
  });
});
