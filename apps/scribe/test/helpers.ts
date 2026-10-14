/**
 * Đồ nghề cho test của scribe: không cần mạng ngoài, không cần CSDL, không gọi nhà cung cấp trả phí.
 *  - `FakeInternalApi`: máy chủ HTTP nhỏ trong bộ nhớ đóng vai giao diện nội bộ của API (jwks, claim, tools, messages, usage).
 *    Phần tool dùng chung `FakeToolBackend` với bộ đánh giá (kịch bản vàng lúc 08/10/2026 09:00).
 *  - token phiên ký bằng cặp khoá ES256 sinh ngay trong test.
 *  - `TestClient`: phía app của giao thức WebSocket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InternalClaimResponse, WsServerFrame } from '@mihato/domain';
import { FakeLlm, type FakeLlmStep, FakeStt, type FakeSttUtterance, FakeTts, type FakeTtsOptions, type Providers } from '@mihato/providers';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import WebSocket from 'ws';
import { FakeToolBackend } from '@mihato/ai-tools/evals/fake-backend';
import { IDS } from '@mihato/ai-tools/evals/fixtures';
import { readEnv } from '../src/env';
import { createLogger, type Logger } from '../src/log';
import { createScribeServer, type ScribeServer } from '../src/server';
import type { SessionConfig } from '../src/session';

export { IDS };

export const SERVICE_TOKEN = 'test-service-token';
export const CONVERSATION_ID = '01920000-0000-7000-8000-00000000cc01';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export type RecordedRequest = { method: string; path: string; headers: IncomingMessage['headers']; body: unknown };

let sessionSeq = 0;
/** Id phiên mới cho mỗi token (UUID hợp lệ). */
export const newSessionId = () => `01920000-0000-7000-8000-0000005e${String(++sessionSeq).padStart(4, '0')}`;

export class FakeInternalApi {
  readonly requests: RecordedRequest[] = [];
  readonly claimed = new Set<string>();
  backend: FakeToolBackend;
  /** ghi đè một phần kết quả `claim` (hạn mức, công tắc AI, orgPrompt…) */
  claim: Partial<InternalClaimResponse> = {};
  /** hạn mức còn lại mà `usage` trả về */
  quotaAfterUsage = 199;
  /** tool trả lỗi 500 (để kiểm nhánh máy chủ hỏng) */
  toolsDown = false;
  /** `claim` trả lỗi này thay vì thành công (ví dụ 503 ai_disabled như API thật khi tổ chức tắt trợ lý) */
  claimError: { status: number; code: string } | null = null;
  private server: Server | null = null;
  private keys: KeyPair | null = null;
  private jwk: JWK | null = null;
  url = '';

  constructor(fixture?: string) {
    this.backend = new FakeToolBackend(fixture ? { fixture } : {});
  }

  async start(): Promise<this> {
    this.keys = await generateKeyPair('ES256');
    this.jwk = { ...(await exportJWK(this.keys.publicKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections();
    });
  }

  /** Ký token phiên như `POST /v1/scribe/sessions` của API thật: ES256, sống 120 giây, scope 'scribe'. */
  async token(over: { sessionId?: string; sub?: string; org?: string; scope?: string; expiresInSec?: number; keys?: KeyPair } = {}): Promise<string> {
    const sessionId = over.sessionId ?? newSessionId();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (over.expiresInSec ?? 120);
    return new SignJWT({ scope: over.scope ?? 'scribe', org: over.org ?? IDS.ORG_DEMO, device: 'thiet-bi-thu' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
      .setSubject(over.sub ?? IDS.U_CHAIRMAN)
      .setJti(sessionId)
      .setIssuedAt(Math.min(now, exp - 1))
      .setExpirationTime(exp)
      .sign((over.keys ?? (this.keys as KeyPair)).privateKey);
  }

  paths(prefix = ''): string[] {
    return this.requests.filter((r) => r.path.startsWith(prefix)).map((r) => r.path);
  }

  bodies(path: string): unknown[] {
    return this.requests.filter((r) => r.path === path).map((r) => r.body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const path = (req.url ?? '').split('?')[0] ?? '';
    this.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) return json(401, { code: 'unauthorized' });

    if (req.method === 'GET' && path === '/internal/v1/jwks') return json(200, { keys: [this.jwk] });

    const claim = /^\/internal\/v1\/scribe\/sessions\/([^/]+)\/claim$/.exec(path);
    if (req.method === 'POST' && claim) {
      const id = decodeURIComponent(claim[1] as string);
      // Như API thật: tổ chức lấy từ header X-Org-Id, và `jti` phải bằng id phiên.
      if (req.headers['x-org-id'] !== IDS.ORG_DEMO) return json(404, { code: 'not_found' });
      if ((body as { jti?: unknown } | undefined)?.jti !== id) return json(422, { code: 'input_invalid' });
      if (this.claimError) return json(this.claimError.status, { code: this.claimError.code });
      if (this.claimed.has(id)) return json(409, { code: 'state_conflict' });
      this.claimed.add(id);
      const response: InternalClaimResponse = {
        userId: IDS.U_CHAIRMAN,
        orgId: IDS.ORG_DEMO,
        conversationId: CONVERSATION_ID,
        channel: 'voice',
        quotaLeft: 200,
        user: { fullName: 'Trần Đức Minh', givenName: 'Minh', honorific: 'ong', roleTitle: 'Chủ tịch' },
        ai: { enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee' },
        voiceId: 'giong-thu',
        speechRate: 'normal',
        keyterms: ['Bùi Quốc Tuấn', 'Nguyễn Thu Lan', 'Kinh doanh'],
        orgPrompt: 'Người trong tổ chức: anh Bùi Quốc Tuấn (Kỹ thuật), chị Nguyễn Thu Lan (Kinh doanh), chị Phạm Thị Lan (Kế toán).',
        ...this.claim,
      };
      return json(200, response);
    }

    const tool = /^\/internal\/v1\/tools\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && tool) {
      if (this.toolsDown) return json(500, { code: 'internal' });
      const args = (body as { args?: unknown } | undefined)?.args;
      return json(200, this.backend.call(decodeURIComponent(tool[1] as string), args));
    }
    if (req.method === 'POST' && path === '/internal/v1/messages') return json(200, { ok: true });
    if (req.method === 'POST' && path === '/internal/v1/scribe/usage') return json(200, { quotaLeft: this.quotaAfterUsage });
    return json(404, { code: 'not_found' });
  }
}

// ───────────────────────── Phía app ─────────────────────────

export type ClientFrame = WsServerFrame | { type: 'binary'; bytes: number };

export class TestClient {
  readonly frames: ClientFrame[] = [];
  readonly closed: Promise<{ code: number }>;
  private readonly ws: WebSocket;
  private readonly waiters: (() => void)[] = [];
  private closeCode: number | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      this.frames.push(isBinary ? { type: 'binary', bytes: (data as Buffer).byteLength } : (JSON.parse(String(data)) as WsServerFrame));
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code) => {
        this.closeCode = code;
        for (const w of this.waiters.splice(0)) w();
        resolve({ code });
      });
    });
    this.ws.on('error', () => {});
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  sendAudio(bytes = 3200): void {
    this.ws.send(Buffer.alloc(bytes, 1), { binary: true });
  }

  terminate(): void {
    this.ws.terminate();
  }

  close(): void {
    this.ws.close();
  }

  /** Vị trí hiện tại trong dòng khung, để chỉ chờ khung đến SAU mốc này. */
  mark(): number {
    return this.frames.length;
  }

  async waitFor<T extends ClientFrame>(pred: (f: ClientFrame) => f is T, from?: number, timeoutMs?: number): Promise<T>;
  async waitFor(pred: (f: ClientFrame) => boolean, from?: number, timeoutMs?: number): Promise<ClientFrame>;
  async waitFor(pred: (f: ClientFrame) => boolean, from = 0, timeoutMs = 5000): Promise<ClientFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (this.closeCode !== null) throw new Error(`kết nối đã đóng (${this.closeCode}) trước khi nhận khung cần chờ; đã nhận: ${this.summary(from)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`hết giờ chờ khung; đã nhận: ${this.summary(from)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  waitType<K extends ClientFrame['type']>(type: K, from = 0): Promise<Extract<ClientFrame, { type: K }>> {
    return this.waitFor((f): f is Extract<ClientFrame, { type: K }> => f.type === type, from);
  }

  waitIdle(from = 0): Promise<ClientFrame> {
    return this.waitFor((f) => f.type === 'status' && f.phase === 'idle', from);
  }

  since(from: number): ClientFrame[] {
    return this.frames.slice(from);
  }

  summary(from = 0): string {
    return this.frames
      .slice(from)
      .map((f) => (f.type === 'status' ? `status:${f.phase}` : f.type === 'error' ? `error:${f.code}` : f.type))
      .join(' ');
  }
}

/** Dãy tên khung, gộp các khung lặp liền nhau (partial, delta, binary) để so thứ tự. */
export function sequence(frames: ClientFrame[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const name = f.type === 'status' ? `status:${f.phase}` : f.type === 'error' ? `error:${f.code}` : f.type;
    if (out.at(-1) !== name) out.push(name);
  }
  return out;
}

// ───────────────────────── Dựng scribe ─────────────────────────

export type Harness = {
  api: FakeInternalApi;
  stt: FakeStt;
  llm: FakeLlm;
  tts: FakeTts;
  server: ScribeServer;
  logs: string[];
  log: Logger;
  port: number;
  wsUrl: string;
  /** mở kết nối, gửi hello bằng token mới, chờ `ready` */
  connect(tokenOver?: Parameters<FakeInternalApi['token']>[0]): Promise<TestClient>;
  /** mở kết nối mà chưa gửi gì */
  raw(): Promise<TestClient>;
  stop(): Promise<void>;
};

export type HarnessOptions = {
  utterances?: FakeSttUtterance[];
  sttAutoEndAfterChunks?: number;
  /** STT giả cho phép mở sẵn luồng cho lượt kế (như Deepgram); mặc định không, để các test cũ đếm phiên không bị lệch */
  sttPrewarm?: boolean;
  llmSteps?: FakeLlmStep[];
  llmDelayMs?: number;
  llmDefaults?: boolean;
  tts?: FakeTtsOptions;
  config?: Partial<SessionConfig>;
  fixture?: string;
};

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const api = await new FakeInternalApi(opts.fixture).start();
  const stt = new FakeStt(opts.utterances ?? [], { ...(opts.sttAutoEndAfterChunks ? { autoEndAfterChunks: opts.sttAutoEndAfterChunks } : {}), ...(opts.sttPrewarm ? { canPrewarm: true } : {}) });
  const llm = new FakeLlm(opts.llmSteps ?? [], { delayMs: opts.llmDelayMs ?? 0, includeDefaults: opts.llmDefaults ?? true });
  const tts = new FakeTts(opts.tts ?? {});
  const providers: Providers = { stt, llm, tts, kinds: { stt: 'fake', llm: 'fake', tts: 'fake' } };
  const logs: string[] = [];
  const log = createLogger((line) => logs.push(line));
  const env = readEnv({ API_INTERNAL_URL: api.url, INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN, VOICE_CONFIRM_MIN_CONFIDENCE: '0.8' });
  const server = createScribeServer({ env, providers, log, ...(opts.config ? { config: opts.config } : {}) });
  const port = await server.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/scribe/ws`;
  const clients: TestClient[] = [];

  const raw = async () => {
    const client = new TestClient(wsUrl);
    clients.push(client);
    await client.opened();
    return client;
  };
  return {
    api,
    stt,
    llm,
    tts,
    server,
    logs,
    log,
    port,
    wsUrl,
    raw,
    connect: async (tokenOver) => {
      const client = await raw();
      client.send({ type: 'hello', token: await api.token(tokenOver), appVersion: '1.0.0' });
      await client.waitType('ready');
      return client;
    },
    stop: async () => {
      for (const c of clients) c.terminate();
      await server.close();
      await api.stop();
    },
  };
}

/** Một lượt nói bằng giọng: bấm micro, gửi vài khối âm thanh, bấm micro lần nữa, chờ phiên về trạng thái rảnh. */
export async function voiceTurn(client: TestClient, mode: 'dictation' | 'confirm' = 'dictation', chunks = 2): Promise<ClientFrame[]> {
  const from = client.mark();
  client.send({ type: 'start_turn', mode });
  await client.waitFor((f) => f.type === 'status' && f.phase === 'listening', from);
  for (let i = 0; i < chunks; i++) client.sendAudio();
  client.send({ type: 'end_turn' });
  await client.waitIdle(from);
  return client.since(from);
}

/** Một lượt gõ chữ. */
export async function textTurn(client: TestClient, text: string): Promise<ClientFrame[]> {
  const from = client.mark();
  client.send({ type: 'text', text });
  await client.waitIdle(from);
  return client.since(from);
}

export const done = (frames: ClientFrame[]) => frames.find((f): f is Extract<ClientFrame, { type: 'assistant.done' }> => f.type === 'assistant.done');
export const ofType = <K extends ClientFrame['type']>(frames: ClientFrame[], type: K) => frames.filter((f): f is Extract<ClientFrame, { type: K }> => f.type === type);
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Chờ tới khi điều kiện đúng (thăm dò mỗi 5 ms), cho những thứ xảy ra ở phía máy chủ sau khi khung đã về. */
export async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('hết giờ chờ điều kiện');
    await sleep(5);
  }
}
