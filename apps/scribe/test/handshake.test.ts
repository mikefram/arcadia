/**
 * Bắt tay và vòng đời phiên (SPEC 10.7.2, 10.11 điều 8): hello, token, claim, hạn mức, công tắc AI, hẹn giờ.
 */
import { generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CONVERSATION_ID, type Harness, IDS, newSessionId, ofType, sequence, sleep, startHarness, textTurn } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.stop();
});

describe('GET /healthz và đường dẫn WebSocket', () => {
  it('healthz trả 200 và cho biết đang chạy bản giả', async () => {
    h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'scribe', providers: { stt: 'fake', llm: 'fake', tts: 'fake' } });
    expect((await fetch(`http://127.0.0.1:${h.port}/khac`)).status).toBe(404);
  });

  it('chỉ nhận nâng cấp WebSocket ở /scribe/ws', async () => {
    h = await startHarness();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/khac`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(404);
  });
});

describe('hello và token phiên', () => {
  it('hello hợp lệ: nhận ready kèm sessionId, conversationId, quotaLeft', async () => {
    h = await startHarness();
    const sessionId = newSessionId();
    const client = await h.connect({ sessionId });
    expect(client.frames[0]).toEqual({ type: 'ready', sessionId, conversationId: CONVERSATION_ID, quotaLeft: 200 });
    // claim mang đúng jti; mọi lời gọi nội bộ kèm service token
    const claim = h.api.requests.find((r) => r.path.endsWith('/claim'));
    expect(claim).toMatchObject({ method: 'POST', path: `/internal/v1/scribe/sessions/${sessionId}/claim`, body: { jti: sessionId } });
    // Tổ chức và người dùng lấy từ claim `org` và `sub` của token phiên.
    expect(claim?.headers['x-org-id']).toBe(IDS.ORG_DEMO);
    expect(claim?.headers['x-on-behalf-of']).toBe(IDS.U_CHAIRMAN);
    expect(h.api.requests.every((r) => r.headers.authorization === 'Bearer test-service-token')).toBe(true);
  });

  it('không gửi hello trong thời hạn: đóng 4401', async () => {
    h = await startHarness({ config: { helloTimeoutMs: 80 } });
    const client = await h.raw();
    expect((await client.closed).code).toBe(4401);
    expect(h.api.paths('/internal/v1/scribe')).toEqual([]);
  });

  it('khung đầu không phải hello (kể cả khung nhị phân hay JSON hỏng): đóng 4401', async () => {
    h = await startHarness();
    const a = await h.raw();
    a.send({ type: 'start_turn', mode: 'dictation' });
    expect((await a.closed).code).toBe(4401);
    const b = await h.raw();
    b.sendAudio();
    expect((await b.closed).code).toBe(4401);
    const c = await h.raw();
    c.sendRaw('{không phải json');
    expect((await c.closed).code).toBe(4401);
  });

  it('token hết hạn: đóng 4401, không gọi claim', async () => {
    h = await startHarness();
    const client = await h.raw();
    client.send({ type: 'hello', token: await h.api.token({ expiresInSec: -60 }), appVersion: '1.0.0' });
    expect((await client.closed).code).toBe(4401);
    expect(client.frames).toEqual([]);
    expect(h.api.paths().filter((p) => p.endsWith('/claim'))).toEqual([]);
  });

  it('token sai chữ ký, sai scope hoặc không phải JWT: đóng 4401', async () => {
    h = await startHarness();
    const otherKeys = await generateKeyPair('ES256');
    for (const token of [await h.api.token({ keys: otherKeys }), await h.api.token({ scope: 'api' }), 'khong-phai-jwt']) {
      const client = await h.raw();
      client.send({ type: 'hello', token, appVersion: '1.0.0' });
      expect((await client.closed).code).toBe(4401);
    }
    expect(h.api.paths().filter((p) => p.endsWith('/claim'))).toEqual([]);
  });

  it('dùng lại một token: lần hai bị từ chối (claim trả 409, đóng 4401)', async () => {
    h = await startHarness();
    const token = await h.api.token();
    const first = await h.raw();
    first.send({ type: 'hello', token, appVersion: '1.0.0' });
    await first.waitType('ready');

    const second = await h.raw();
    second.send({ type: 'hello', token, appVersion: '1.0.0' });
    expect((await second.closed).code).toBe(4401);
    expect(second.frames).toEqual([]);
    // Phiên đầu vẫn dùng bình thường.
    expect(sequence(await textTurn(first, 'xin chào trợ lý'))).toContain('assistant.done');
  });

  it('token của tổ chức khác với phiên: API không tìm thấy phiên, đóng 4401', async () => {
    h = await startHarness();
    const client = await h.raw();
    client.send({ type: 'hello', token: await h.api.token({ org: '01920000-0000-7000-8000-0000000000ee' }), appVersion: '1.0.0' });
    expect((await client.closed).code).toBe(4401);
    expect(h.api.claimed.size).toBe(0);
  });

  it('API nội bộ lỗi máy chủ lúc claim: đóng 1011, không phải 4401', async () => {
    h = await startHarness();
    h.api.claimError = { status: 500, code: 'internal_error' };
    const client = await h.raw();
    client.send({ type: 'hello', token: await h.api.token(), appVersion: '1.0.0' });
    expect((await client.closed).code).toBe(1011);
  });

  it('token của người khác với phiên được claim: đóng 4401', async () => {
    h = await startHarness();
    const client = await h.raw();
    client.send({ type: 'hello', token: await h.api.token({ sub: '01920000-0000-7000-8000-0000000000ff' }), appVersion: '1.0.0' });
    expect((await client.closed).code).toBe(4401);
  });

  it('khoá công khai được đệm: nhiều phiên chỉ tải jwks một lần', async () => {
    h = await startHarness();
    await h.connect();
    await h.connect();
    await h.connect();
    expect(h.api.paths().filter((p) => p === '/internal/v1/jwks')).toHaveLength(1);
  });
});

describe('hạn mức và công tắc AI', () => {
  it('hết hạn mức ngay lúc claim: error quota_exceeded rồi đóng 4429', async () => {
    h = await startHarness();
    h.api.claim = { quotaLeft: 0 };
    const client = await h.raw();
    client.send({ type: 'hello', token: await h.api.token(), appVersion: '1.0.0' });
    expect((await client.closed).code).toBe(4429);
    expect(client.frames).toEqual([{ type: 'error', code: 'quota_exceeded', retryable: false }]);
  });

  it('hết hạn mức sau một lượt: lượt đó trả lời xong, rồi error quota_exceeded và đóng 4429', async () => {
    h = await startHarness();
    h.api.quotaAfterUsage = 0;
    const client = await h.connect();
    client.send({ type: 'text', text: 'tình hình đón đoàn Nhật' });
    expect((await client.closed).code).toBe(4429);
    const names = sequence(client.frames);
    expect(names.indexOf('assistant.done')).toBeGreaterThan(0);
    expect(names.slice(-1)).toEqual(['error:quota_exceeded']);
    expect(names.indexOf('audio.end')).toBeLessThan(names.indexOf('error:quota_exceeded'));
  });

  it('công tắc AI tắt, hoặc llm là off: error ai_disabled, không có ready', async () => {
    for (const ai of [
      { enabled: false, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' },
      { enabled: true, stt: 'deepgram', llm: 'off', tts: 'vbee' },
    ]) {
      h = await startHarness();
      h.api.claim = { ai };
      const client = await h.raw();
      client.send({ type: 'hello', token: await h.api.token(), appVersion: '1.0.0' });
      await client.closed;
      expect(client.frames).toEqual([{ type: 'error', code: 'ai_disabled', retryable: false }]);
      expect(h.llm.calls).toHaveLength(0);
      await h.stop();
    }
  });

  it('API từ chối claim vì tổ chức tắt trợ lý (503 ai_disabled): error ai_disabled', async () => {
    h = await startHarness();
    h.api.claimError = { status: 503, code: 'ai_disabled' };
    const client = await h.raw();
    client.send({ type: 'hello', token: await h.api.token(), appVersion: '1.0.0' });
    expect((await client.closed).code).toBe(1000);
    expect(client.frames).toEqual([{ type: 'error', code: 'ai_disabled', retryable: false }]);
  });

  it('tts tắt: vẫn trả lời bằng chữ, không có khung âm thanh và không gọi TTS', async () => {
    h = await startHarness();
    h.api.claim = { ai: { enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'off' } };
    const client = await h.connect();
    const frames = await textTurn(client, 'tình hình đón đoàn Nhật');
    expect(ofType(frames, 'assistant.done')).toHaveLength(1);
    expect(sequence(frames)).not.toContain('audio.start');
    expect(sequence(frames)).not.toContain('status:speaking');
    expect(h.tts.spoken).toHaveLength(0);
  });
});

describe('hẹn giờ của phiên', () => {
  it('không có khung nào trong thời hạn: đóng 4408', async () => {
    h = await startHarness({ config: { idleTimeoutMs: 120 } });
    const client = await h.connect();
    expect((await client.closed).code).toBe(4408);
  });

  it('đang đọc các bước quy trình mới: được nghỉ lâu hơn; tạo xong đề xuất thì trở lại thời hạn thường', async () => {
    // Thời hạn thường 600 ms; khi đang đọc quy trình là 3500 ms. Đóng phiên giữa chừng làm mất danh sách bước đã đọc.
    // Con số lớn vì máy chạy CI chậm: 150 ms làm một lượt trả lời bình thường bị đóng 4408 (lần chạy đầu trên GitHub).
    h = await startHarness({ config: { idleTimeoutMs: 600, draftIdleTimeoutMs: 3500 } });
    const client = await h.connect();
    await textTurn(client, 'tạo quy trình họp hội đồng quản trị');
    const first = await textTurn(client, 'bước một, soạn tài liệu họp, anh Tuấn làm, hạn ba ngày');
    expect(ofType(first, 'assistant.done')[0]?.text).toContain('Bước 1');

    // Nghỉ gấp đôi thời hạn thường: phiên vẫn sống và đọc tiếp được.
    await sleep(1300);
    const second = await textTurn(client, 'bước hai, Giám đốc duyệt tài liệu họp, hạn hai ngày');
    expect(ofType(second, 'assistant.done')[0]?.text).toContain('Bước 2');

    // Đã tạo đề xuất: không còn đang đọc, nghỉ quá thời hạn thường thì đóng 4408.
    const finished = await textTurn(client, 'xong');
    expect(ofType(finished, 'proposal.created')).toHaveLength(1);
    expect((await client.closed).code).toBe(4408);
  }, 20_000);

  it('phiên sống tối đa một thời hạn: error session_expired rồi đóng', async () => {
    h = await startHarness({ config: { maxSessionMs: 120 } });
    const client = await h.connect();
    expect((await client.closed).code).toBe(4408);
    expect(client.frames.at(-1)).toEqual({ type: 'error', code: 'session_expired', retryable: true });
  });

  it('khung lạ sau ready bị bỏ qua, phiên vẫn sống', async () => {
    h = await startHarness();
    const client = await h.connect();
    client.sendRaw('{hỏng');
    client.send({ type: 'khong_co_khung_nay' });
    client.send({ type: 'hello', token: 'x', appVersion: '1' });
    client.send({ type: 'end_turn' });
    client.send({ type: 'interrupt' });
    expect(sequence(await textTurn(client, 'xin chào trợ lý'))).toContain('assistant.done');
  });

  it('không giữ trạng thái giữa các phiên: phiên mới bắt đầu với lịch sử trống', async () => {
    h = await startHarness();
    const first = await h.connect();
    await textTurn(first, 'tình hình đón đoàn Nhật');
    first.close();
    await first.closed;
    const before = h.llm.calls.length;
    const second = await h.connect();
    await textTurn(second, 'xin chào trợ lý');
    expect(h.llm.calls[before]?.messages).toEqual([{ role: 'user', content: 'xin chào trợ lý' }]);
  });
});
