/**
 * Máy chủ WebSocket cục bộ đóng vai Deepgram và Vbee, để kiểm đường `--real` mà KHÔNG gọi nhà cung cấp nào
 * (CLAUDE.md luật 10). Chúng chỉ trả lời khi nhận lệnh đóng, nên không phụ thuộc thời gian.
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export type MockConnection = { url: string; auth: string | undefined; bytes: number; messages: Record<string, unknown>[] };

export type Mock = {
  url: string;
  connections: MockConnection[];
  close(): Promise<void>;
};

async function listen(wss: WebSocketServer): Promise<string> {
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

const closer = (wss: WebSocketServer) => () =>
  new Promise<void>((resolve) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => resolve());
  });

/** Deepgram giả: nhận âm thanh nhị phân, tới `CloseStream` thì trả `Results` (câu thứ i theo thứ tự kết nối), `UtteranceEnd` rồi đóng. */
export async function startDeepgramMock(transcripts: string[]): Promise<Mock> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const connections: MockConnection[] = [];
  wss.on('connection', (socket: WebSocket, req) => {
    const conn: MockConnection = { url: req.url ?? '', auth: req.headers.authorization, bytes: 0, messages: [] };
    const index = connections.push(conn) - 1;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        conn.bytes += (data as Buffer).byteLength;
        return;
      }
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      conn.messages.push(msg);
      if (msg.type === 'CloseStream') {
        socket.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: transcripts[index % transcripts.length], confidence: 0.9 }] } }));
        socket.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1.2 }));
        socket.close(1000);
      }
    });
  });
  return { url: `${await listen(wss)}/v1/listen`, connections, close: closer(wss) };
}

/** Vbee giả: READY sau STREAMING_CONFIG; tới `DONE` thì trả `FINAL_RESULT`, `STREAM_END` rồi đóng. */
export async function startVbeeMock(transcripts: string[]): Promise<Mock> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const connections: MockConnection[] = [];
  wss.on('connection', (socket: WebSocket, req) => {
    const conn: MockConnection = { url: req.url ?? '', auth: undefined, bytes: 0, messages: [] };
    const index = connections.push(conn) - 1;
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      conn.messages.push(msg);
      if (msg.type === 'STREAMING_CONFIG') socket.send(JSON.stringify({ type: 'READY', sessionId: `srv-${index}` }));
      else if (msg.type === 'AUDIO_CHUNK') conn.bytes += Buffer.from(String(msg.audioContent), 'base64').byteLength;
      else if (msg.type === 'DONE') {
        const text = transcripts[index % transcripts.length];
        socket.send(JSON.stringify({ type: 'FINAL_RESULT', text, textRaw: text, confidenceScore: 0.9, speechType: 'detected-speech' }));
        socket.send(JSON.stringify({ type: 'STREAM_END', sessionId: `srv-${index}`, totalUtterances: 1 }));
        socket.close(1000);
      }
    });
  });
  return { url: `${await listen(wss)}/v1/stt/realtime`, connections, close: closer(wss) };
}
