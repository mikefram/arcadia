/**
 * Kiểm adapter Vbee STT với MÁY CHỦ WEBSOCKET CỤC BỘ. Không gọi Vbee thật (chưa có khoá, và CLAUDE.md luật 10).
 * Các test chỉ chứng minh mã gửi và đọc đúng điều mô tả trong ghi chú đầu `src/vbee-stt.ts`; chúng KHÔNG chứng minh
 * Vbee thật chấp nhận, vì giao thức đó chưa được đối chiếu với bản gốc.
 */
import type { SttEvent, SttSession } from '@mihato/providers';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { buildVbeeAudioMessage, buildVbeeSttUrl, buildVbeeStreamingConfig, readVbeeMessage, VBEE_STT_URL, VbeeStt } from '../src/vbee-stt';

const OPEN: Parameters<VbeeStt['open']>[0] = { language: 'vi', sampleRate: 16000, keyterms: ['Tuấn'], utteranceEndMs: 1300 };

describe('buildVbeeSttUrl', () => {
  it('xác thực nằm trong địa chỉ: token và appId', () => {
    const url = new URL(buildVbeeSttUrl({ appId: 'app-1', token: 'tok-2' }));
    expect(url.origin + url.pathname).toBe(VBEE_STT_URL);
    expect(url.searchParams.get('token')).toBe('tok-2');
    expect(url.searchParams.get('appId')).toBe('app-1');
  });
  it('mã hoá ký tự đặc biệt', () => {
    const url = new URL(buildVbeeSttUrl({ appId: 'a b', token: 'x&y=z' }));
    expect(url.searchParams.get('token')).toBe('x&y=z');
    expect(url.searchParams.get('appId')).toBe('a b');
  });
  it('đổi được địa chỉ gốc để thử cục bộ', () => {
    expect(buildVbeeSttUrl({ appId: 'a', token: 't', baseUrl: 'ws://127.0.0.1:9/x' })).toBe('ws://127.0.0.1:9/x?token=t&appId=a');
  });
});

describe('buildVbeeStreamingConfig', () => {
  it.each([
    [0, 500],
    [499, 500],
    [500, 500],
    [800, 800],
    [1000, 1000],
    [1300, 1300],
    [1299.6, 1300],
    [1500, 1500],
    [2999, 2999],
    [3000, 3000],
    [3001, 3000],
    [10_000, 3000],
  ])('utterance_end_ms %s → speechCompleteTimeoutMs %s (kẹp trong 500 đến 3000)', (ms, expected) => {
    const c = buildVbeeStreamingConfig({ ...OPEN, utteranceEndMs: ms }) as { config: { vadConfig: { speechCompleteTimeoutMs: number } } };
    expect(c.config.vadConfig.speechCompleteTimeoutMs).toBe(expected);
  });

  it('PCM 16 kHz, 16-bit, đơn kênh, có kết quả tạm; không gửi keyterm', () => {
    expect(buildVbeeStreamingConfig(OPEN)).toEqual({
      type: 'STREAMING_CONFIG',
      config: {
        sampleRateHertz: 16000,
        sampleSizeByte: 2,
        channel: 1,
        interimResults: true,
        vadConfig: { noInputTimeoutMs: 10_000, speechCompleteTimeoutMs: 1300 },
      },
    });
    expect(JSON.stringify(buildVbeeStreamingConfig(OPEN))).not.toContain('Tuấn');
  });
});

describe('buildVbeeAudioMessage', () => {
  it('âm thanh nằm trong khung văn bản AUDIO_CHUNK dạng base64', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const msg = JSON.parse(buildVbeeAudioMessage(bytes)) as { type: string; audioContent: string };
    expect(msg.type).toBe('AUDIO_CHUNK');
    expect([...Buffer.from(msg.audioContent, 'base64')]).toEqual([...bytes]);
  });
  it('chỉ lấy đúng phần của khung con (không lấy cả bộ đệm lớn)', () => {
    const big = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const msg = JSON.parse(buildVbeeAudioMessage(big.subarray(2, 5))) as { audioContent: string };
    expect([...Buffer.from(msg.audioContent, 'base64')]).toEqual([1, 2, 3]);
  });
  it('khung rỗng', () => {
    const msg = JSON.parse(buildVbeeAudioMessage(new Uint8Array(0))) as { audioContent: string };
    expect(msg.audioContent).toBe('');
  });
});

describe('readVbeeMessage', () => {
  const cases: [string, unknown, unknown][] = [
    ['READY', { type: 'READY', sessionId: 'srv-1' }, { type: 'READY' }],
    ['kết quả tạm', { type: 'INTERIM_RESULT', text: ' đi thúc ', isFinal: false, stability: 0.8 }, { type: 'INTERIM_RESULT', text: 'đi thúc' }],
    ['kết quả tạm thiếu chữ', { type: 'INTERIM_RESULT' }, { type: 'INTERIM_RESULT', text: '' }],
    ['kết quả chốt: ưu tiên chữ thô', { type: 'FINAL_RESULT', text: 'đi thúc anh 20', textRaw: 'đi thúc anh hai mươi', confidenceScore: 0.92, speechType: 'detected-speech' }, { type: 'FINAL_RESULT', text: 'đi thúc anh hai mươi', confidence: 0.92, speech: true }],
    ['kết quả chốt: không có chữ thô thì lấy chữ đã xử lý', { type: 'FINAL_RESULT', text: 'đi thúc anh', confidenceScore: 0.5 }, { type: 'FINAL_RESULT', text: 'đi thúc anh', confidence: 0.5, speech: true }],
    ['kết quả chốt: chữ thô rỗng thì lấy chữ đã xử lý', { type: 'FINAL_RESULT', text: 'đi thúc', textRaw: '  ' }, { type: 'FINAL_RESULT', text: 'đi thúc', confidence: 0, speech: true }],
    ['kết quả chốt: không có tiếng nói', { type: 'FINAL_RESULT', text: '', speechType: 'no-speech' }, { type: 'FINAL_RESULT', text: '', confidence: 0, speech: false }],
    ['kết quả chốt: độ tin cậy không phải số', { type: 'FINAL_RESULT', text: 'x', confidenceScore: 'cao' }, { type: 'FINAL_RESULT', text: 'x', confidence: 0, speech: true }],
    ['STREAM_END', { type: 'STREAM_END', sessionId: 's', totalUtterances: 1 }, { type: 'STREAM_END' }],
    ['PONG', { type: 'PONG' }, { type: 'PONG' }],
    ['lỗi có thể thử lại', { type: 'ERROR', code: 'PROVIDER_UNAVAILABLE', message: 'x' }, { type: 'ERROR', code: 'PROVIDER_UNAVAILABLE', retryable: true }],
    ['lỗi hết giờ phiên', { type: 'ERROR', code: 'SESSION_TIMEOUT', message: 'Session exceeded maximum duration' }, { type: 'ERROR', code: 'SESSION_TIMEOUT', retryable: false }],
    ['lỗi xác thực', { type: 'ERROR', code: 'UNAUTHORIZED' }, { type: 'ERROR', code: 'UNAUTHORIZED', retryable: false }],
    ['lỗi hết số giây', { type: 'ERROR', code: 'STT_INSUFFICIENT_SECONDS' }, { type: 'ERROR', code: 'STT_INSUFFICIENT_SECONDS', retryable: false }],
    ['lỗi quá số phiên song song (thử lại được)', { type: 'ERROR', code: 'STT_MAX_CCR_REACHED' }, { type: 'ERROR', code: 'STT_MAX_CCR_REACHED', retryable: true }],
    ['lỗi nhận dạng (thử lại được)', { type: 'ERROR', code: 'RECOGNIZE_FAILED' }, { type: 'ERROR', code: 'RECOGNIZE_FAILED', retryable: true }],
    ['lỗi nội bộ (thử lại được)', { type: 'ERROR', code: 'INTERNAL_ERROR' }, { type: 'ERROR', code: 'INTERNAL_ERROR', retryable: true }],
    ['mã lỗi lạ có dấu bị thay bằng UNKNOWN', { type: 'ERROR', code: 'lỗi gì đó có chữ tên Tuấn' }, { type: 'ERROR', code: 'UNKNOWN', retryable: false }],
    ['mã lỗi thiếu', { type: 'ERROR' }, { type: 'ERROR', code: 'UNKNOWN', retryable: false }],
    ['loại lạ', { type: 'SOMETHING_ELSE' }, null],
    ['không có loại', { text: 'x' }, null],
    ['không phải đối tượng', 'chuỗi', null],
    ['mảng', [], null],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(readVbeeMessage(JSON.stringify(input))).toEqual(expected);
  });

  it('JSON hỏng thì null, không ném lỗi', () => {
    expect(readVbeeMessage('{không phải json')).toBeNull();
    expect(readVbeeMessage('')).toBeNull();
  });
});

// ───────────────────────── Với máy chủ WebSocket cục bộ ─────────────────────────

type Mock = { wss: WebSocketServer; url: string; seen: { url?: string; messages: Record<string, unknown>[]; audioBytes: number; connections: number } };

describe('VbeeStt với máy chủ cục bộ', () => {
  const servers: WebSocketServer[] = [];
  const sessions: SttSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => {})));
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { for (const c of s.clients) c.terminate(); s.close(() => resolve()); })));
  });

  async function serve(onMessage: (socket: WebSocket, msg: Record<string, unknown>, mock: Mock['seen']) => void, onConnect?: (socket: WebSocket) => void): Promise<Mock> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    const seen: Mock['seen'] = { messages: [], audioBytes: 0, connections: 0 };
    wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
      seen.url = req.url;
      seen.connections += 1;
      onConnect?.(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        seen.messages.push(msg);
        if (msg.type === 'AUDIO_CHUNK') seen.audioBytes += Buffer.from(String(msg.audioContent), 'base64').byteLength;
        onMessage(socket, msg, seen);
      });
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    return { wss, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/stt/realtime`, seen };
  }

  /** Máy chủ đúng quy trình: READY sau STREAMING_CONFIG; chốt khi nhận DONE rồi STREAM_END và đóng. */
  const wellBehaved = (finalPayload: Record<string, unknown> = { type: 'FINAL_RESULT', text: 'đi thúc anh Tuấn', textRaw: 'đi thúc anh Tuấn', confidenceScore: 0.9, speechType: 'detected-speech' }) =>
    serve((socket, msg) => {
      if (msg.type === 'STREAMING_CONFIG') socket.send(JSON.stringify({ type: 'READY', sessionId: 'srv-1' }));
      else if (msg.type === 'AUDIO_CHUNK') socket.send(JSON.stringify({ type: 'INTERIM_RESULT', text: 'đi thúc', isFinal: false }));
      else if (msg.type === 'PING') socket.send(JSON.stringify({ type: 'PONG' }));
      else if (msg.type === 'DONE') {
        socket.send(JSON.stringify(finalPayload));
        socket.send(JSON.stringify({ type: 'STREAM_END', sessionId: 'srv-1', totalUtterances: 1 }));
        socket.close(1000);
      }
    });

  async function open(mock: Mock, extra: Partial<ConstructorParameters<typeof VbeeStt>[0]> = {}) {
    // closeTimeoutMs ngắn để bước dọn dẹp sau mỗi test (đóng phiên mà máy chủ giả không đáp DONE) không kéo dài.
    const stt = new VbeeStt({ appId: 'app-1', token: 'tok-bi-mat', baseUrl: mock.url, closeTimeoutMs: 300, ...extra });
    const session = await stt.open(OPEN);
    sessions.push(session);
    const events: SttEvent[] = [];
    for (const name of ['interim', 'final', 'utteranceEnd', 'error'] as const) session.on(name, (e) => events.push(e));
    return { session, events };
  }

  it('chạy trọn một phiên: cấu hình, READY, âm thanh, PING, DONE, kết quả', async () => {
    const mock = await wellBehaved();
    const { session, events } = await open(mock);
    session.sendAudio(new Uint8Array(3200));
    session.sendAudio(new Uint8Array(3200));
    session.keepAlive();
    await session.close();

    expect(mock.seen.messages.map((m) => m.type)).toEqual(['STREAMING_CONFIG', 'AUDIO_CHUNK', 'AUDIO_CHUNK', 'PING', 'DONE']);
    expect(mock.seen.messages[0]).toMatchObject({ config: { sampleRateHertz: 16000, sampleSizeByte: 2, channel: 1, interimResults: true, vadConfig: { speechCompleteTimeoutMs: 1300 } } });
    expect(mock.seen.audioBytes).toBe(6400);
    const q = new URL(`ws://x${mock.seen.url}`).searchParams;
    expect(q.get('token')).toBe('tok-bi-mat');
    expect(q.get('appId')).toBe('app-1');
    expect(events).toEqual([
      { type: 'interim', text: 'đi thúc' },
      { type: 'interim', text: 'đi thúc' },
      { type: 'final', text: 'đi thúc anh Tuấn', confidence: 0.9 },
      { type: 'utteranceEnd' },
    ]);
  });

  it('kết quả chốt không có tiếng nói hoặc rỗng thì không phát gì', async () => {
    for (const payload of [{ type: 'FINAL_RESULT', text: '', speechType: 'no-speech' }, { type: 'FINAL_RESULT', text: '   ' }, { type: 'FINAL_RESULT', text: 'ồn', speechType: 'no-speech' }]) {
      const mock = await wellBehaved(payload);
      const { session, events } = await open(mock);
      await session.close();
      expect(events).toEqual([]);
    }
  });

  it('không có keyterm trong bất kỳ khung nào', async () => {
    const mock = await wellBehaved();
    const { session } = await open(mock);
    await session.close();
    expect(JSON.stringify(mock.seen.messages)).not.toContain('Tuấn');
  });

  it('sau close() không gửi thêm âm thanh', async () => {
    const mock = await wellBehaved();
    const { session } = await open(mock);
    await session.close();
    session.sendAudio(new Uint8Array(3200));
    session.keepAlive();
    expect(mock.seen.messages.filter((m) => m.type === 'AUDIO_CHUNK')).toHaveLength(0);
  });

  it('close() gọi hai lần vẫn an toàn', async () => {
    const mock = await wellBehaved();
    const { session } = await open(mock);
    await Promise.all([session.close(), session.close()]);
    await session.close();
    expect(mock.seen.messages.filter((m) => m.type === 'DONE')).toHaveLength(1);
  });

  it('máy chủ đóng ngoài ý muốn thì phát lỗi chỉ có mã', async () => {
    const mock = await serve((socket, msg) => {
      if (msg.type === 'STREAMING_CONFIG') {
        socket.send(JSON.stringify({ type: 'READY' }));
        setTimeout(() => socket.close(1011), 20);
      }
    });
    const { session, events } = await open(mock);
    await new Promise<void>((resolve) => session.on('error', () => resolve()));
    expect(events).toEqual([{ type: 'error', code: 'stt_closed_1011', retryable: true }]);
  });

  it.each([
    ['PROVIDER_UNAVAILABLE', true],
    ['SESSION_TIMEOUT', false],
  ])('lỗi %s sau READY phát sự kiện lỗi (thử lại được: %s)', async (code, retryable) => {
    const mock = await serve((socket, msg) => {
      if (msg.type === 'STREAMING_CONFIG') socket.send(JSON.stringify({ type: 'READY' }));
      if (msg.type === 'AUDIO_CHUNK') socket.send(JSON.stringify({ type: 'ERROR', code, message: 'chi tiết có thể chứa nội dung' }));
    });
    const { session, events } = await open(mock);
    const got = new Promise<void>((resolve) => session.on('error', () => resolve()));
    session.sendAudio(new Uint8Array(3200));
    await got;
    expect(events).toEqual([{ type: 'error', code: `stt_vbee_${code.toLowerCase()}`, retryable }]);
    expect(JSON.stringify(events)).not.toContain('nội dung');
  });

  it('lỗi xác thực trước READY: open() báo lỗi kèm mã, không lộ token', async () => {
    const mock = await serve((socket, msg) => {
      if (msg.type === 'STREAMING_CONFIG') socket.send(JSON.stringify({ type: 'ERROR', code: 'UNAUTHORIZED' }));
    });
    const stt = new VbeeStt({ appId: 'app-1', token: 'tok-bi-mat', baseUrl: mock.url });
    const err = await stt.open(OPEN).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('stt_open_failed_unauthorized');
    expect(err?.message).not.toContain('tok-bi-mat');
  });

  it('máy chủ đóng ngay: open() báo stt_open_failed', async () => {
    const mock = await serve(() => {}, (socket) => socket.close(1008));
    await expect(new VbeeStt({ appId: 'a', token: 't', baseUrl: mock.url }).open(OPEN)).rejects.toThrow(/^stt_open_failed$/);
  });

  it('không có READY: quá hạn thì báo stt_open_timeout', async () => {
    const mock = await serve(() => {});
    await expect(new VbeeStt({ appId: 'a', token: 't', baseUrl: mock.url, openTimeoutMs: 150 }).open(OPEN)).rejects.toThrow(/^stt_open_timeout$/);
  });

  it('không nối được: báo stt_open_failed, không kèm địa chỉ hay token', async () => {
    const err = await new VbeeStt({ appId: 'app-1', token: 'tok-bi-mat', baseUrl: 'ws://127.0.0.1:1/v1/stt/realtime', openTimeoutMs: 500 }).open(OPEN).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('stt_open_failed');
  });

  it('máy chủ không trả STREAM_END: close() chờ tới hạn rồi tự cắt', async () => {
    const mock = await serve((socket, msg) => {
      if (msg.type === 'STREAMING_CONFIG') socket.send(JSON.stringify({ type: 'READY' }));
    });
    const { session } = await open(mock, { closeTimeoutMs: 120 });
    const started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('thiếu VBEE_APP_ID hoặc VBEE_TOKEN thì không dựng', () => {
    expect(() => new VbeeStt({ appId: '', token: 't' })).toThrowError(/VBEE_APP_ID hoặc VBEE_TOKEN/);
    expect(() => new VbeeStt({ appId: 'a', token: '' })).toThrowError(/VBEE_APP_ID hoặc VBEE_TOKEN/);
  });
});
