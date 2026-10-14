/**
 * Luồng STT mở sẵn cho lượt nói kế tiếp (Mike đồng ý ngày 04/10/2026, trái SPEC 10.7.2 "scribe chỉ mở kết nối tới Deepgram trong lượt
 * đó"; docs/DECISIONS.md). Lý do: bắt tay với Deepgram mất 0,8 đến 2,5 giây, nên mỗi lượt nói bị chậm chữ đầu chừng đó; mở sẵn thì lượt
 * từ lần hai trở đi nghe ngay. Điều phải giữ: luồng chờ KHÔNG nhận tiếng nói nào cho tới khi người dùng bắt đầu một lượt, mỗi phiên chỉ
 * có một luồng chờ, và nó đóng cùng phiên. STT giả ở đây bật `canPrewarm` như Deepgram; các test khác dùng STT giả mặc định (không mở sẵn).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, ofType, sleep, startHarness, until, voiceTurn } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.stop();
});

const HELLO = { final: 'xin chào trợ lý', confidence: 0.95 };
const listening = (f: { type: string; phase?: string }) => f.type === 'status' && f.phase === 'listening';

describe('luồng STT mở sẵn cho lượt kế', () => {
  it('phiên giọng nói vừa sẵn sàng đã có đúng một luồng chờ, mang đúng tham số, chưa nhận tiếng nói nào', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO], sttPrewarm: true });
    await h.connect();
    await until(() => h.stt.sessions.length === 1);
    expect(h.stt.openSessions).toBe(1);
    expect(h.stt.sessions[0]).toMatchObject({ audioChunks: 0, audioBytes: 0, closed: false });
    expect(h.stt.sessions[0]?.options).toEqual({ language: 'vi', sampleRate: 16000, keyterms: ['Bùi Quốc Tuấn', 'Nguyễn Thu Lan', 'Kinh doanh'], utteranceEndMs: 1300 });
    await sleep(30);
    expect(h.stt.sessions).toHaveLength(1);
  });

  it('lượt đầu dùng luôn luồng chờ (không mở thêm cho chính nó) và mở sẵn luồng cho lượt sau', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO], sttPrewarm: true });
    const client = await h.connect();
    await until(() => h.stt.sessions.length === 1);
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor(listening, from);
    await until(() => h.stt.sessions.length === 2);
    client.sendAudio();
    client.sendAudio();
    client.send({ type: 'end_turn' });
    const finalFrame = await client.waitFor((f) => f.type === 'transcript.final', from);
    await client.waitIdle(from);
    expect(finalFrame).toMatchObject({ text: 'xin chào trợ lý' });
    // Tiếng nói của lượt đi vào luồng thứ nhất (đã mở sẵn); luồng thứ hai nằm chờ, chưa nhận gì.
    expect(h.stt.sessions[0]).toMatchObject({ audioChunks: 2, closed: true });
    expect(h.stt.sessions[1]).toMatchObject({ audioChunks: 0, closed: false });
    expect(h.stt.openSessions).toBe(1);
  });

  it('lượt thứ hai dùng luồng đã mở sẵn từ lượt đầu; lúc nào cũng chỉ có một luồng chờ', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO, HELLO], sttPrewarm: true });
    const client = await h.connect();
    await voiceTurn(client);
    await voiceTurn(client);
    await until(() => h.stt.sessions.length === 3);
    expect(h.stt.sessions.map((s) => s.audioChunks)).toEqual([2, 2, 0]);
    expect(h.stt.sessions.map((s) => s.closed)).toEqual([true, true, false]);
    expect(h.stt.openSessions).toBe(1);
  });

  it('đóng phiên thì đóng cả luồng chờ', async () => {
    h = await startHarness({ utterances: [HELLO], sttPrewarm: true });
    const client = await h.connect();
    await until(() => h.stt.openSessions === 1);
    client.close();
    await client.closed;
    await until(() => h.stt.openSessions === 0);
    expect(h.stt.sessions[0]).toMatchObject({ audioChunks: 0, closed: true });
  });

  it('luồng chờ nhận KeepAlive đều đặn để nhà cung cấp không đóng nó vì im lặng quá 10 giây', async () => {
    h = await startHarness({ utterances: [HELLO], sttPrewarm: true, config: { sttKeepAliveMs: 15 } });
    await h.connect();
    await until(() => (h.stt.sessions[0]?.keepAlives ?? 0) >= 3);
    expect(h.stt.sessions[0]?.audioChunks).toBe(0);
  });

  it('luồng chờ không mở được: lượt nói mở mới như cũ, không báo lỗi', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO], sttPrewarm: true });
    h.stt.failNextOpen = 1; // luồng chờ lúc phiên sẵn sàng sẽ lỗi
    const client = await h.connect();
    await sleep(30);
    expect(h.stt.sessions).toHaveLength(0);
    const frames = await voiceTurn(client);
    expect(ofType(frames, 'error')).toEqual([]);
    expect(ofType(frames, 'transcript.final')[0]).toMatchObject({ text: 'xin chào trợ lý' });
  });

  it('luồng chờ bị nhà cung cấp đóng khi đang chờ: bỏ nó, lượt nói mở mới và vẫn nghe được', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO], sttPrewarm: true });
    const client = await h.connect();
    await until(() => h.stt.sessions.length === 1);
    h.stt.sessions[0]?.fail('stt_closed_1011');
    await until(() => h.stt.sessions[0]?.closed === true);
    const frames = await voiceTurn(client);
    expect(ofType(frames, 'error')).toEqual([]);
    expect(ofType(frames, 'transcript.final')[0]).toMatchObject({ text: 'xin chào trợ lý' });
    // luồng thứ hai là luồng mở mới cho lượt này, luồng thứ ba là luồng chờ cho lượt sau
    await until(() => h.stt.sessions.length === 3);
    expect(h.stt.sessions[1]?.audioChunks).toBe(2);
  });

  it('ngắt lượt nói giữa chừng chỉ đóng luồng của lượt đó; luồng chờ cho lượt sau vẫn còn', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO], sttPrewarm: true });
    const client = await h.connect();
    const from = client.mark();
    client.send({ type: 'start_turn', mode: 'dictation' });
    await client.waitFor(listening, from);
    await until(() => h.stt.sessions.length === 2);
    client.send({ type: 'interrupt' });
    await until(() => h.stt.sessions[0]?.closed === true);
    expect(h.stt.sessions[1]?.closed).toBe(false);
    expect(h.stt.openSessions).toBe(1);
  });

  it('phiên gõ chữ, hoặc tổ chức tắt STT: không mở luồng chờ', async () => {
    h = await startHarness({ utterances: [HELLO], sttPrewarm: true });
    h.api.claim = { channel: 'text' };
    await h.connect();
    await sleep(40);
    expect(h.stt.sessions).toHaveLength(0);
    await h.stop();

    h = await startHarness({ utterances: [HELLO], sttPrewarm: true });
    h.api.claim = { ai: { enabled: true, stt: 'off', llm: 'anthropic', tts: 'vbee' } };
    await h.connect();
    await sleep(40);
    expect(h.stt.sessions).toHaveLength(0);
  });

  it('STT không cho mở sẵn (mặc định của bản giả): không có luồng nào ngoài lượt nói, như trước', async () => {
    h = await startHarness({ utterances: [HELLO, HELLO] });
    const client = await h.connect();
    await sleep(40);
    expect(h.stt.sessions).toHaveLength(0);
    await voiceTurn(client);
    await sleep(20);
    expect(h.stt.sessions).toHaveLength(1);
    expect(h.stt.openSessions).toBe(0);
  });
});
