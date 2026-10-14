/**
 * Máy chủ HTTP và WebSocket của scribe: `GET /healthz` và `wss://<host>/scribe/ws` (SPEC 10.7.2).
 * Mỗi kết nối là một `ScribeSession` độc lập; máy chủ không giữ trạng thái hội thoại nào ngoài các phiên đang mở.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Providers } from '@mihato/providers';
import { WebSocketServer } from 'ws';
import type { ScribeEnv } from './env';
import { InternalApi } from './internal-api';
import { createLogger, type Logger } from './log';
import { DEFAULT_SESSION_CONFIG, ScribeSession, type SessionConfig } from './session';
import { SessionTokenVerifier } from './token';

export const WS_PATH = '/scribe/ws';
/** Một khung âm thanh 100 ms chỉ nặng 3.200 byte; chặn khung quá lớn ngay ở tầng WebSocket. */
const MAX_FRAME_BYTES = 256 * 1024;

export type ScribeServerOptions = {
  env: ScribeEnv;
  providers: Providers;
  log?: Logger;
  /** ghi đè hẹn giờ và ngưỡng (test) */
  config?: Partial<SessionConfig>;
  fetch?: typeof fetch;
};

export type ScribeServer = {
  http: Server;
  /** số phiên đang mở */
  sessionCount(): number;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
};

export function createScribeServer(opts: ScribeServerOptions): ScribeServer {
  const log = opts.log ?? createLogger();
  const api = new InternalApi({ baseUrl: opts.env.apiInternalUrl, serviceToken: opts.env.internalServiceToken, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const verifier = new SessionTokenVerifier({ fetchJwks: () => api.jwks() });
  const config: SessionConfig = {
    ...DEFAULT_SESSION_CONFIG,
    minConfidence: opts.env.voiceConfirmMinConfidence,
    effort: opts.env.llmEffort,
    defaultVoice: opts.env.defaultVoice,
    utteranceEndMs: opts.env.utteranceEndMs,
    ...opts.config,
  };

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'scribe', providers: opts.providers.kinds }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  wss.on('connection', (ws) => {
    new ScribeSession(ws, { providers: opts.providers, api, verifier, log, config }).start();
  });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return {
    http,
    sessionCount: () => wss.clients.size,
    listen: (port, host = '0.0.0.0') =>
      new Promise<number>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          resolve((http.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.close(1001);
        wss.close(() => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
      }),
  };
}
