import type { AddressInfo } from 'node:net';
import { WS_CLOSE, WsClientFrameSchema, type WsClientFrame, type WsServerFrame } from '@mihato/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { ScribeClient, ScribeConnectError, closeReasonOf, type ScribeClientEvent } from '../src/scribe/client';

/**
 * Lớp WebSocket của trợ lý với MÁY CHỦ GIẢ (thư viện `ws`), nối bằng WebSocket có sẵn của Node, cùng cách dùng với
 * trình duyệt và React Native. Máy chủ giả làm đúng giao thức ở SPEC 10.7.2: khung đầu phải là `hello`, token dùng
 * một lần, mã đóng 4401, 4408, 4429.
 */
const SESSION = '0199c000-0000-7000-8000-00000000aaaa';
const CONVERSATION = '0199c000-0000-7000-8000-00000000bbbb';
const PROPOSAL = '0199c000-0000-7000-8000-00000000cccc';
const BATCH = '0199c000-0000-7000-8000-00000000dddd';

type Received = { frames: WsClientFrame[]; binary: Uint8Array[] };

async function fakeScribe() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const usedTokens = new Set<string>();
  const connections: { socket: ServerSocket; received: Received }[] = [];
  /** token nào cũng hợp lệ đúng một lần, trừ token bị ghi ở đây */
  const rejectTokens = new Set<string>();
  let onFrame: (frame: WsClientFrame, socket: ServerSocket, received: Received) => void = () => undefined;

  wss.on('connection', (socket) => {
    const received: Received = { frames: [], binary: [] };
    connections.push({ socket, received });
    let greeted = false;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!greeted) return socket.close(WS_CLOSE.badToken);
        received.binary.push(new Uint8Array(data as Buffer));
        return;
      }
      const parsed = WsClientFrameSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (!greeted) {
        if (frame.type !== 'hello' || usedTokens.has(frame.token) || rejectTokens.has(frame.token)) return socket.close(WS_CLOSE.badToken);
        usedTokens.add(frame.token);
        greeted = true;
        received.frames.push(frame);
        socket.send(JSON.stringify({ type: 'ready', sessionId: SESSION, conversationId: CONVERSATION, quotaLeft: 200 } satisfies WsServerFrame));
        return;
      }
      received.frames.push(frame);
      onFrame(frame, socket, received);
    });
  });

  return {
    url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/scribe/ws`,
    connections,
    rejectTokens,
    setHandler: (fn: typeof onFrame) => {
      onFrame = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

const send = (socket: ServerSocket, frame: WsServerFrame) => socket.send(JSON.stringify(frame));

type FakeScribe = Awaited<ReturnType<typeof fakeScribe>>;

function harness(server: FakeScribe) {
  const events: ScribeClientEvent[] = [];
  const waiters: { test: (e: ScribeClientEvent) => boolean; resolve: (e: ScribeClientEvent) => void }[] = [];
  let sessions = 0;
  const client = new ScribeClient({
    appVersion: '1.0.0',
    createSession: async () => ({ wsUrl: server.url(), token: `token-${++sessions}` }),
    onEvent: (event) => {
      events.push(event);
      for (const w of [...waiters]) {
        if (w.test(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    },
  });
  /** Chờ một sự kiện thoả điều kiện (kể cả sự kiện đã tới trước đó). */
  const waitFor = (test: (e: ScribeClientEvent) => boolean) =>
    new Promise<ScribeClientEvent>((resolve, reject) => {
      const hit = events.find(test);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error('chờ sự kiện quá 3 giây')), 3000);
      waiters.push({
        test,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  const frameTypes = () => events.flatMap((e) => (e.type === 'frame' ? [e.frame.type === 'status' ? `status:${e.frame.phase}` : e.frame.type] : e.type === 'audio' ? ['audio'] : []));
  return { client, events, waitFor, frameTypes, sessions: () => sessions };
}

const isFrame = (type: WsServerFrame['type']) => (e: ScribeClientEvent) => e.type === 'frame' && e.frame.type === type;
const isIdle = (e: ScribeClientEvent) => e.type === 'frame' && e.frame.type === 'status' && e.frame.phase === 'idle';
const isClosed = (e: ScribeClientEvent) => e.type === 'closed';

describe('ScribeClient với máy chủ giả (SPEC 10.7.2)', () => {
  let server: FakeScribe;
  beforeEach(async () => {
    server = await fakeScribe();
  });
  afterEach(async () => {
    await server.close();
  });

  it('nối: xin token mới, khung đầu là hello kèm token và phiên bản app, nhận ready rồi mới sẵn sàng', async () => {
    const h = harness(server);
    expect(h.client.state).toBe('closed');
    await h.client.connect();
    expect(h.client.state).toBe('ready');
    expect(h.sessions()).toBe(1);
    expect(server.connections[0]?.received.frames).toEqual([{ type: 'hello', token: 'token-1', appVersion: '1.0.0' }]);
    expect(h.events.filter((e) => e.type === 'state').map((e) => (e.type === 'state' ? e.state : ''))).toEqual(['connecting', 'ready']);
    // Gọi lại khi đã nối: không xin token lần nữa.
    await h.client.ensureReady();
    expect(h.sessions()).toBe(1);
    h.client.close();
  });

  it('gõ chữ: nhận đủ khung của một lượt theo đúng thứ tự, âm thanh là các khối nhị phân nằm giữa audio.start và audio.end', async () => {
    const h = harness(server);
    server.setHandler((frame, socket) => {
      if (frame.type !== 'text') return;
      send(socket, { type: 'status', phase: 'thinking' });
      send(socket, { type: 'proposal.created', proposalId: PROPOSAL, batchId: BATCH, risk: 1, itemCount: 2 });
      send(socket, { type: 'assistant.delta', turnId: 't1', text: 'Dạ, trợ lý ' });
      send(socket, { type: 'assistant.delta', turnId: 't1', text: 'hiểu như sau.' });
      send(socket, { type: 'assistant.done', turnId: 't1', text: 'Dạ, trợ lý hiểu như sau.' });
      send(socket, { type: 'status', phase: 'speaking' });
      send(socket, { type: 'audio.start', turnId: 't1', format: 'mp3' });
      socket.send(new Uint8Array([0xff, 0xfb, 1, 2]), { binary: true });
      socket.send(new Uint8Array([3, 4, 5]), { binary: true });
      send(socket, { type: 'audio.end', turnId: 't1' });
      send(socket, { type: 'status', phase: 'idle' });
    });
    await h.client.connect();
    expect(h.client.sendText('  đi thúc anh Tuấn  ')).toBe(true);
    await h.waitFor(isIdle);

    expect(server.connections[0]?.received.frames.at(-1)).toEqual({ type: 'text', text: 'đi thúc anh Tuấn' });
    expect(h.frameTypes()).toEqual(['ready', 'status:thinking', 'proposal.created', 'assistant.delta', 'assistant.delta', 'assistant.done', 'status:speaking', 'audio.start', 'audio', 'audio', 'audio.end', 'status:idle']);
    const audio = h.events.flatMap((e) => (e.type === 'audio' ? [[...e.chunk]] : []));
    expect(audio).toEqual([
      [0xff, 0xfb, 1, 2],
      [3, 4, 5],
    ]);
    const proposal = h.events.find(isFrame('proposal.created'));
    expect(proposal).toMatchObject({ frame: { proposalId: PROPOSAL, batchId: BATCH, risk: 1, itemCount: 2 } });
    h.client.close();
  });

  it('một lượt nói: start_turn, âm thanh PCM chỉ gửi trong lượt, end_turn; khung ngoài lượt nói bị bỏ ngay ở app', async () => {
    const h = harness(server);
    server.setHandler((frame, socket) => {
      if (frame.type === 'start_turn') send(socket, { type: 'status', phase: 'listening' });
      if (frame.type === 'end_turn') {
        send(socket, { type: 'transcript.final', turnId: 't1', text: 'tình hình đón đoàn Nhật', confidence: 0.94 });
        send(socket, { type: 'status', phase: 'idle' });
      }
    });
    await h.client.connect();
    // Chưa bấm micro: không gửi âm thanh.
    expect(h.client.sendAudio(new Uint8Array([9, 9]))).toBe(false);

    expect(h.client.startTurn('dictation')).toBe(true);
    expect(h.client.isTurnOpen).toBe(true);
    expect(h.client.sendAudio(new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(h.client.sendAudio(new Uint8Array([5, 6]))).toBe(true);
    expect(h.client.endTurn()).toBe(true);
    // Đã bấm dừng: micro đóng, khung đến muộn không được gửi.
    expect(h.client.sendAudio(new Uint8Array([7, 7]))).toBe(false);
    expect(h.client.endTurn()).toBe(false);

    await h.waitFor(isIdle);
    const received = server.connections[0]?.received;
    expect(received?.frames.map((f) => f.type)).toEqual(['hello', 'start_turn', 'end_turn']);
    expect(received?.frames[1]).toEqual({ type: 'start_turn', mode: 'dictation' });
    expect(received?.binary.map((b) => [...b])).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
    expect(h.events.find(isFrame('transcript.final'))).toMatchObject({ frame: { text: 'tình hình đón đoàn Nhật', confidence: 0.94 } });
    h.client.close();
  });

  it('lượt confirm (xác nhận bằng giọng ở M3) và ngắt lời: gửi đúng khung', async () => {
    const h = harness(server);
    await h.client.connect();
    h.client.startTurn('confirm');
    h.client.interrupt();
    expect(h.client.isTurnOpen).toBe(false);
    server.setHandler((_frame, socket) => send(socket, { type: 'status', phase: 'idle' }));
    h.client.sendText('x');
    await h.waitFor(isIdle);
    expect(server.connections[0]?.received.frames.slice(1)).toEqual([{ type: 'start_turn', mode: 'confirm' }, { type: 'interrupt' }, { type: 'text', text: 'x' }]);
    h.client.close();
  });

  it('khung lạ hoặc sai dạng từ máy chủ bị bỏ qua, không làm hỏng phiên', async () => {
    const h = harness(server);
    server.setHandler((_frame, socket) => {
      socket.send('không phải JSON');
      socket.send(JSON.stringify({ type: 'loai_khung_moi', x: 1 }));
      socket.send(JSON.stringify({ type: 'status', phase: 'ngủ' }));
      send(socket, { type: 'status', phase: 'idle' });
    });
    await h.client.connect();
    h.client.sendText('thử');
    await h.waitFor(isIdle);
    expect(h.frameTypes()).toEqual(['ready', 'status:idle']);
    expect(h.client.state).toBe('ready');
    h.client.close();
  });

  it('4401 (token sai, hết hạn hoặc đã dùng): connect ném lỗi bad_token; ensureReady thử đúng một lần với token MỚI', async () => {
    const h = harness(server);
    server.rejectTokens.add('token-1');
    await expect(h.client.connect()).rejects.toMatchObject({ name: 'ScribeConnectError', reason: 'bad_token', code: WS_CLOSE.badToken });
    expect(h.client.state).toBe('closed');
    expect(h.events.find(isClosed)).toMatchObject({ code: 4401, reason: 'bad_token' });

    // Lần nối lại không dùng lại token cũ: gọi createSession mới.
    await h.client.ensureReady();
    expect(h.client.state).toBe('ready');
    expect(h.sessions()).toBe(2);
    expect(server.connections.at(-1)?.received.frames[0]).toMatchObject({ type: 'hello', token: 'token-2' });
    h.client.close();

    // Máy chủ từ chối cả hai lần: ensureReady không thử mãi.
    const again = harness(server);
    server.rejectTokens.add('token-1').add('token-2');
    await expect(again.client.ensureReady()).rejects.toBeInstanceOf(ScribeConnectError);
    expect(again.sessions()).toBe(2);
  });

  it('4408 (im 60 giây hoặc hết 15 phút): phiên đóng; người dùng nói tiếp thì app mở phiên MỚI bằng token mới', async () => {
    const h = harness(server);
    await h.client.connect();
    h.client.startTurn('dictation');
    server.connections[0]?.socket.close(WS_CLOSE.idle);
    const closed = await h.waitFor(isClosed);
    expect(closed).toMatchObject({ code: 4408, reason: 'idle' });
    expect(h.client.state).toBe('closed');
    // Lượt nói dở bị đóng theo: không còn gửi âm thanh.
    expect(h.client.isTurnOpen).toBe(false);
    expect(h.client.sendText('còn đó không')).toBe(false);

    await h.client.ensureReady();
    expect(h.client.state).toBe('ready');
    expect(h.sessions()).toBe(2);
    expect(server.connections).toHaveLength(2);
    h.client.close();
  });

  it('4429 (hết hạn mức): báo quota sau khi nhận khung error', async () => {
    const h = harness(server);
    server.setHandler((_frame, socket) => {
      send(socket, { type: 'error', code: 'quota_exceeded', retryable: false });
      socket.close(WS_CLOSE.quota);
    });
    await h.client.connect();
    h.client.sendText('hỏi thêm');
    const closed = await h.waitFor(isClosed);
    expect(closed).toMatchObject({ code: 4429, reason: 'quota' });
    expect(h.events.find(isFrame('error'))).toMatchObject({ frame: { code: 'quota_exceeded', retryable: false } });
  });

  it('app tự đóng (rời màn hình, khoá app): lý do là client', async () => {
    const h = harness(server);
    await h.client.connect();
    h.client.close();
    expect(await h.waitFor(isClosed)).toMatchObject({ reason: 'client' });
    expect(h.client.state).toBe('closed');
  });

  it('createSession lỗi (ví dụ tổ chức tắt AI): connect ném đúng lỗi đó, không mở kết nối', async () => {
    const failure = new Error('ai_disabled');
    const client = new ScribeClient({ appVersion: '1.0.0', createSession: () => Promise.reject(failure), onEvent: () => undefined });
    await expect(client.connect()).rejects.toBe(failure);
    expect(client.state).toBe('closed');
    expect(server.connections).toHaveLength(0);
  });

  it('nhiều nơi cùng gọi connect: chỉ xin một token và mở một kết nối', async () => {
    const h = harness(server);
    await Promise.all([h.client.connect(), h.client.connect(), h.client.ensureReady()]);
    expect(h.sessions()).toBe(1);
    expect(server.connections).toHaveLength(1);
    h.client.close();
  });
});

describe('closeReasonOf: mã đóng kết nối', () => {
  it('đổi mã đóng thành lý do', () => {
    expect(closeReasonOf(4401, false)).toBe('bad_token');
    expect(closeReasonOf(4408, false)).toBe('idle');
    expect(closeReasonOf(4429, false)).toBe('quota');
    expect(closeReasonOf(1011, false)).toBe('server_error');
    expect(closeReasonOf(1006, false)).toBe('network');
    expect(closeReasonOf(1000, false)).toBe('idle');
    expect(closeReasonOf(4408, true)).toBe('client');
  });
});
