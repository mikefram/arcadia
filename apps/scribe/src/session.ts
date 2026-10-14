/**
 * Máy trạng thái của MỘT phiên WebSocket `/scribe/ws` (SPEC 10.7.2).
 *
 *   chờ hello ──hello hợp lệ──▶ rảnh ◀──────────────────────────────────────────────┐
 *                                 │ start_turn                                        │
 *                                 ▼                                                   │
 *                               nghe ──end_turn hoặc STT báo hết lượt nói──▶ chốt chữ ─┤ (mode confirm: dừng ở đây)
 *                                 │ text (gõ chữ, đi chung đường xử lý)        │       │
 *                                 └──────────────────────────────────────────▶ nghĩ ──▶ nói ──┘
 *
 * Điều phải giữ:
 *  - Mic chỉ mở khi người dùng bấm; khung nhị phân ngoài lượt nói bị bỏ. Kết nối STT sống trong một lượt nói, TRỪ MỘT kết nối mở sẵn
 *    cho lượt kế (Mike đồng ý ngày 04/10/2026, trái SPEC 10.7.2; docs/DECISIONS.md): nó không nhận tiếng nói nào (chỉ chừng 0,4 giây
 *    im lặng và KeepAlive) cho tới khi người dùng bắt đầu một lượt nói, và đóng cùng phiên.
 *  - AI không có đường ghi: scribe chỉ gọi /internal/v1/*; đề xuất do máy chủ tạo, câu xác nhận do máy chủ dựng.
 *  - Không giữ trạng thái giữa các phiên; ngắt kết nối thì đóng luồng STT ngay.
 *  - Nhật ký chỉ có id, độ dài, độ trễ và mã lỗi (SPEC 6.8).
 */
import { buildSystemBlocks, buildTodayText, checkStyle, claudeToolDefinitions, unclearReply } from '@mihato/ai-tools';
import { type InternalClaimResponse, WS_CLOSE, WsClientFrameSchema, type WsServerFrame, WsServerFrameSchema } from '@mihato/domain';
import { redact } from '@mihato/domain/vi-normalize';
import { splitForTts, toSpeakable } from '@mihato/domain/vi-speak';
import { type LlmEffort, pickArray, type Providers, type SttOpenOptions, type SttSession } from '@mihato/providers';
import type { RawData, WebSocket } from 'ws';
import { type AgentDeps, AgentError, type AgentState, type AgentTurnResult, type AgentUsage, emptyUsage, newAgentState, runAgentTurn, type ToolCallRecord } from '@mihato/ai-tools';
import { type InternalApi, InternalApiError, type OnBehalfOf } from './internal-api';
import { errorName, type Logger } from './log';
import { type SessionTokenVerifier, TokenError } from './token';

export type SessionConfig = {
  /** khung đầu phải là `hello` trong từng này mili giây, nếu không đóng 4401 */
  helloTimeoutMs: number;
  /** không có khung nào từ app trong từng này mili giây thì đóng 4408 */
  idleTimeoutMs: number;
  /**
   * Thời hạn nghỉ dài hơn khi người dùng đang đọc các bước của một quy trình mới (từ lần trợ lý đọc lại bước đầu tiên tới lúc đề
   * xuất tạo bản nháp): họ cần thời gian nghĩ giữa các bước, và đóng phiên giữa chừng thì mất danh sách bước đã đọc.
   */
  draftIdleTimeoutMs: number;
  /** một phiên sống tối đa 15 phút [MỤC TIÊU] */
  maxSessionMs: number;
  /** một lượt nói dài tối đa từng này mili giây rồi tự chốt */
  maxTurnMs: number;
  /** quá từng này mili giây chưa có chữ trả lời thì gửi lại `status thinking` (app phát câu "xin chờ" dựng sẵn) */
  thinkingNoticeMs: number;
  /** LLM quá từng này mili giây chưa có sự kiện đầu thì báo `llm_unavailable` */
  llmTimeoutMs: number;
  /** TTS quá từng này mili giây chưa có byte đầu thì báo `tts_unavailable` (vẫn gửi chữ) */
  ttsFirstByteTimeoutMs: number;
  /** chu kỳ kiểm để gửi KeepAlive cho STT khi app tạm ngừng gửi âm thanh (SPEC 6.2: mỗi 3 đến 5 giây) */
  sttKeepAliveMs: number;
  /** chờ STT trả nốt kết quả chốt sau khi đóng lượt nói */
  sttCloseTimeoutMs: number;
  utteranceEndMs: number;
  /** ngưỡng độ tin cậy: dưới ngưỡng thì trả câu "nghe chưa rõ", không gọi LLM */
  minConfidence: number;
  effort: LlmEffort;
  defaultVoice: string;
  /** số lượt gọi model tối đa cho một lượt nói */
  maxRounds: number;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  helloTimeoutMs: 5_000,
  idleTimeoutMs: 60_000,
  draftIdleTimeoutMs: 5 * 60_000,
  maxSessionMs: 15 * 60_000,
  maxTurnMs: 60_000,
  thinkingNoticeMs: 2_000,
  llmTimeoutMs: 15_000,
  ttsFirstByteTimeoutMs: 3_000,
  sttKeepAliveMs: 4_000,
  sttCloseTimeoutMs: 3_000,
  utteranceEndMs: 1_300,
  minConfidence: 0.8,
  effort: 'low',
  defaultVoice: '',
  maxRounds: 6,
};

export type SessionDeps = { providers: Providers; api: InternalApi; verifier: SessionTokenVerifier; log: Logger; config: SessionConfig };

/** Tốc độ đọc theo cài đặt của người dùng; mặc định 0.9 (SPEC 6.4). */
const SPEECH_RATE: Record<InternalClaimResponse['speechRate'], number> = { slow: 0.8, normal: 0.9, fast: 1.0 };
const HONORIFIC_WORD: Record<string, string> = { anh: 'anh', chi: 'chị', ong: 'ông', ba: 'bà', co: 'cô', chu: 'chú', bac: 'bác' };
/** Số khối âm thanh giữ tạm trong lúc kết nối STT đang mở (mỗi khối 20 đến 100 ms). */
const MAX_QUEUED_AUDIO_CHUNKS = 250;
/** PCM 16-bit, 16 kHz, đơn kênh: 32.000 byte mỗi giây. */
const PCM_BYTES_PER_SECOND = 32_000;

type Turn = {
  id: string;
  kind: 'dictation' | 'confirm' | 'text';
  phase: 'listening' | 'processing';
  abort: AbortController;
  cancelled: boolean;
  startedAt: number;
  // ── nghe ──
  stt: SttSession | null;
  queue: Uint8Array[];
  finals: { text: string; confidence: number }[];
  interim: string;
  audioBytes: number;
  lastAudioAt: number;
  endRequested: boolean;
  finalizing: boolean;
  sttFailed: boolean;
  keepAlive: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
  // ── nói ──
  audioOpen: boolean;
};

type TurnTotals = { usage: AgentUsage; sttSeconds: number; ttsChars: number; errors: number };

/** Luồng STT mở sẵn cho lượt nói kế tiếp. `taken`: một lượt đã lấy nó; `dead`: đã bỏ (lỗi, hoặc phiên đóng). */
type Spare = { promise: Promise<SttSession>; keepAlive: NodeJS.Timeout | null; taken: boolean; dead: boolean };

const sleepUntil = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('rejected'));
      },
    );
  });

/**
 * Những người khớp gần ngang nhau trong kết quả `search_people`: máy chủ đánh dấu `ambiguous` và kèm `score`
 * (giữ người trong khoảng 90% điểm cao nhất). Kết quả không có điểm thì coi mọi người trong danh sách là ứng viên.
 */
function ambiguousPeople(result: unknown): Record<string, unknown>[] {
  const people = pickArray(result, 'people', 'matches', 'items');
  const scores = people.map((p) => (typeof p.score === 'number' ? p.score : null));
  if (scores.some((x) => x === null)) return people;
  const top = Math.max(0, ...(scores as number[]));
  return people.filter((_, i) => (scores[i] as number) >= top * 0.9);
}

/** Chép ra vùng nhớ riêng: khối âm thanh có thể nằm chờ trong hàng đợi tới khi kết nối STT mở xong. */
const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data);
};

export class ScribeSession {
  private state: 'hello' | 'authenticating' | 'ready' | 'closed' = 'hello';
  private claim: InternalClaimResponse | null = null;
  private sessionId = '';
  private who: OnBehalfOf | null = null;
  /** cách gọi người dùng trong các câu mẫu, ví dụ "Chủ tịch" */
  private title = '';
  private agent: AgentDeps | null = null;
  private readonly agentState: AgentState = newAgentState();
  private active: Turn | null = null;
  /** luồng STT mở sẵn cho lượt kế; chỉ khi nhà cung cấp cho phép (`canPrewarm`) và là phiên giọng nói */
  private spare: Spare | null = null;
  private turnSeq = 0;
  private unclearCount = 0;
  private quotaLeft = 0;
  /** hạn mức đã hết sau lượt vừa rồi: lượt đó vẫn trả lời xong, rồi phiên đóng 4429 */
  private quotaExhausted = false;
  private droppedAudioFrames = 0;
  private helloTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** đang đọc các bước quy trình mới: được nghỉ lâu hơn giữa các bước */
  private drafting = false;
  private maxTimer: NodeJS.Timeout | null = null;
  private readonly cfg: SessionConfig;
  private readonly log: Logger;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: SessionDeps,
  ) {
    this.cfg = deps.config;
    this.log = deps.log;
  }

  start(): void {
    this.helloTimer = setTimeout(() => {
      this.log.warn('hello_timeout');
      this.close(WS_CLOSE.badToken);
    }, this.cfg.helloTimeoutMs);
    this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on('close', () => this.dispose('peer_closed'));
    this.ws.on('error', () => this.dispose('socket_error'));
  }

  // ───────────────────────── Gửi ─────────────────────────

  private send(frame: WsServerFrame): void {
    if (this.state === 'closed' || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private sendAudio(chunk: Uint8Array): void {
    if (this.state === 'closed' || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(chunk, { binary: true });
  }

  /** Đóng phiên từ phía máy chủ. */
  private close(code: number): void {
    if (this.state === 'closed') return;
    this.dispose('server_closed', code);
    try {
      this.ws.close(code);
    } catch {}
  }

  /** Dọn mọi thứ của phiên: đóng luồng STT ngay, huỷ lượt đang chạy, tắt hẹn giờ. Không giữ gì lại. */
  private dispose(reason: string, code?: number): void {
    if (this.state === 'closed') return;
    const wasReady = this.state === 'ready';
    this.state = 'closed';
    for (const t of [this.helloTimer, this.idleTimer, this.maxTimer]) if (t) clearTimeout(t);
    if (this.spare) this.dropSpare(this.spare);
    if (this.active) this.cancelActive();
    this.agentState.history.length = 0;
    this.agentState.toolResults.length = 0;
    this.agentState.userTexts.length = 0;
    if (wasReady || code !== undefined) this.log.info('session_closed', { sessionId: this.sessionId || null, reason, code: code ?? null, droppedAudioFrames: this.droppedAudioFrames });
  }

  private touch(): void {
    if (this.state !== 'ready') return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log.info('idle_timeout', { sessionId: this.sessionId });
      this.close(WS_CLOSE.idle);
    }, this.drafting ? Math.max(this.cfg.idleTimeoutMs, this.cfg.draftIdleTimeoutMs) : this.cfg.idleTimeoutMs);
  }

  // ───────────────────────── Nhận khung ─────────────────────────

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === 'closed') return;
    if (isBinary) {
      // Trước `hello` mà gửi âm thanh là sai giao thức.
      if (this.state === 'hello') return this.close(WS_CLOSE.badToken);
      this.touch();
      this.onAudio(toBytes(data));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      json = null;
    }
    const parsed = WsClientFrameSchema.safeParse(json);
    if (this.state === 'hello') {
      if (!parsed.success || parsed.data.type !== 'hello') {
        this.log.warn('hello_rejected', { code: 'not_hello' });
        return this.close(WS_CLOSE.badToken);
      }
      void this.onHello(parsed.data.token, parsed.data.appVersion);
      return;
    }
    if (this.state !== 'ready') return;
    this.touch();
    if (!parsed.success) {
      this.log.warn('bad_frame', { sessionId: this.sessionId });
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case 'hello':
        return;
      case 'start_turn':
        void this.onStartTurn(frame.mode);
        return;
      case 'end_turn':
        this.onEndTurn();
        return;
      case 'text':
        void this.onText(frame.text);
        return;
      case 'interrupt':
        this.onInterrupt();
        return;
    }
  }

  // ───────────────────────── Bắt tay ─────────────────────────

  private async onHello(token: string, appVersion: string): Promise<void> {
    this.state = 'authenticating';
    if (this.helloTimer) clearTimeout(this.helloTimer);
    const { api, verifier } = this.deps;

    let claims: Awaited<ReturnType<SessionTokenVerifier['verify']>>;
    try {
      claims = await verifier.verify(token);
    } catch (err) {
      const code = err instanceof TokenError ? err.code : 'invalid';
      this.log.warn('hello_rejected', { code });
      // Không lấy được khoá công khai là lỗi của máy chủ, không phải token sai.
      return this.close(code === 'jwks_unavailable' ? WS_CLOSE.serverError : WS_CLOSE.badToken);
    }
    if (this.state !== 'authenticating') return;

    let claim: InternalClaimResponse;
    try {
      claim = await api.claim(claims.sessionId, claims.jti, { userId: claims.userId, orgId: claims.orgId });
    } catch (err) {
      const status = err instanceof InternalApiError ? err.status : 0;
      const apiCode = err instanceof InternalApiError ? err.code : null;
      this.log.warn('hello_rejected', { code: 'claim_failed', status, apiCode });
      // Tổ chức tắt trợ lý: API từ chối ngay ở claim. App báo "Trợ lý tạm nghỉ" (SPEC 6.11).
      if (apiCode === 'ai_disabled') {
        this.send({ type: 'error', code: 'ai_disabled', retryable: false });
        return this.close(1000);
      }
      // 409: token đã dùng rồi. Các lỗi 4xx khác: phiên không tồn tại hoặc không hợp lệ.
      return this.close(status >= 400 && status < 500 ? WS_CLOSE.badToken : WS_CLOSE.serverError);
    }
    if (this.state !== 'authenticating') return;
    if (claim.userId !== claims.userId || claim.orgId !== claims.orgId) {
      this.log.warn('hello_rejected', { code: 'claim_mismatch' });
      return this.close(WS_CLOSE.badToken);
    }

    this.claim = claim;
    this.sessionId = claims.sessionId;
    this.who = { userId: claim.userId, orgId: claim.orgId };
    this.quotaLeft = claim.quotaLeft;
    this.state = 'ready';

    if (claim.quotaLeft <= 0) {
      this.log.info('quota_exceeded', { sessionId: this.sessionId });
      this.send({ type: 'error', code: 'quota_exceeded', retryable: false });
      return this.close(WS_CLOSE.quota);
    }
    // Công tắc AI của tổ chức (SPEC 12): tắt thì app báo "Trợ lý tạm nghỉ"; các thẻ không qua AI vẫn dùng bình thường.
    if (!claim.ai.enabled || claim.ai.llm === 'off') {
      this.log.info('ai_disabled', { sessionId: this.sessionId });
      this.send({ type: 'error', code: 'ai_disabled', retryable: false });
      return this.close(1000);
    }

    const who = this.who;
    // Gọi người dùng bằng chức danh (SPEC 6.6). Tài khoản không có chức danh thì gọi bằng xưng hô kèm tên gọi.
    const honorific = claim.user.honorific ? (HONORIFIC_WORD[claim.user.honorific] ?? claim.user.honorific) : '';
    this.title = claim.user.roleTitle.trim() || [honorific, claim.user.givenName.trim()].filter(Boolean).join(' ') || 'anh chị';
    const todayText = buildTodayText(new Date());
    this.agent = {
      llm: this.deps.providers.llm,
      callTool: (name, args) => api.callTool(name, args, who, claim.conversationId),
      // Ngày hôm nay chốt một lần cho cả phiên (tối đa 15 phút): system prompt không đổi thì cache và khối thinking còn hiệu lực.
      system: buildSystemBlocks({
        orgPrompt: redact(claim.orgPrompt),
        turn: { todayText, userName: redact(claim.user.fullName), userTitle: this.title, honorific: claim.user.honorific },
      }),
      tools: claudeToolDefinitions(),
      effort: this.cfg.effort,
      title: this.title,
      todayText,
      maxRounds: this.cfg.maxRounds,
      llmTimeoutMs: this.cfg.llmTimeoutMs,
    };

    this.log.info('session_ready', { sessionId: this.sessionId, conversationId: claim.conversationId, channel: claim.channel, quotaLeft: claim.quotaLeft, appVersion, keyterms: claim.keyterms.length });
    this.send({ type: 'ready', sessionId: this.sessionId, conversationId: claim.conversationId, quotaLeft: claim.quotaLeft });
    this.warmUp();
    this.touch();
    this.maxTimer = setTimeout(() => {
      this.log.info('session_expired', { sessionId: this.sessionId });
      this.send({ type: 'error', code: 'session_expired', retryable: true });
      this.close(WS_CLOSE.idle);
    }, this.cfg.maxSessionMs);
  }

  // ───────────────────────── Lượt nói ─────────────────────────

  private newTurn(kind: Turn['kind'], phase: Turn['phase']): Turn {
    const turn: Turn = {
      id: `t${++this.turnSeq}`,
      kind,
      phase,
      abort: new AbortController(),
      cancelled: false,
      startedAt: performance.now(),
      stt: null,
      queue: [],
      finals: [],
      interim: '',
      audioBytes: 0,
      lastAudioAt: performance.now(),
      endRequested: false,
      finalizing: false,
      sttFailed: false,
      keepAlive: null,
      maxTimer: null,
      audioOpen: false,
    };
    this.active = turn;
    return turn;
  }

  private stopListeningTimers(turn: Turn): void {
    if (turn.keepAlive) clearInterval(turn.keepAlive);
    if (turn.maxTimer) clearTimeout(turn.maxTimer);
    turn.keepAlive = null;
    turn.maxTimer = null;
  }

  /** Huỷ lượt đang chạy: dừng đọc ngay, huỷ lượt gọi model, đóng luồng STT. Làm đồng bộ để khung kế tiếp không bị chen. */
  private cancelActive(): void {
    const turn = this.active;
    if (!turn) return;
    this.active = null;
    turn.cancelled = true;
    turn.abort.abort();
    this.stopListeningTimers(turn);
    if (turn.stt) void turn.stt.close().catch(() => {});
    if (turn.audioOpen) {
      turn.audioOpen = false;
      this.send({ type: 'audio.end', turnId: turn.id });
    }
  }

  private finishTurn(turn: Turn): void {
    this.stopListeningTimers(turn);
    if (this.active === turn) this.active = null;
  }

  // ───── luồng STT mở sẵn cho lượt kế (Mike đồng ý 04/10/2026) ─────

  private sttOptions(claim: InternalClaimResponse): SttOpenOptions {
    return { language: 'vi', sampleRate: 16000, keyterms: claim.keyterms, utteranceEndMs: this.cfg.utteranceEndMs };
  }

  /**
   * Mở sẵn một luồng STT cho lượt nói kế tiếp, để lúc người dùng bắt đầu nói không phải chờ bắt tay với nhà cung cấp (đo 0,8 đến 2,5
   * giây với Deepgram). Chỉ có một luồng chờ mỗi phiên, chỉ ở phiên giọng nói và khi nhà cung cấp cho phép. Luồng chờ không nhận tiếng
   * nói nào: chỉ có đoạn im lặng đầu phiên của bộ nối và `KeepAlive` mỗi vài giây. Hỏng thì bỏ, lượt sau mở mới như cũ.
   */
  private warmUp(): void {
    const claim = this.claim;
    const provider = this.deps.providers.stt;
    if (this.spare || this.state !== 'ready' || !claim || claim.channel !== 'voice' || claim.ai.stt === 'off' || !provider.canPrewarm) return;
    let promise: Promise<SttSession>;
    try {
      promise = provider.open(this.sttOptions(claim));
    } catch {
      return;
    }
    const spare: Spare = { promise, keepAlive: null, taken: false, dead: false };
    this.spare = spare;
    promise.then(
      (session) => {
        // Phiên đóng trong lúc đang mở: đóng luồng vừa mở xong. Lượt nói đã lấy rồi: nó tự lo luồng đó.
        if (spare.dead) {
          void session.close().catch(() => {});
          return;
        }
        if (spare.taken) return;
        session.on('error', () => {
          if (!spare.taken) this.dropSpare(spare);
        });
        spare.keepAlive = setInterval(() => session.keepAlive(), this.cfg.sttKeepAliveMs);
      },
      () => this.dropSpare(spare),
    );
  }

  /** Lấy luồng chờ cho một lượt nói; null nếu không có hoặc đã hỏng. */
  private takeSpare(): Promise<SttSession> | null {
    const spare = this.spare;
    if (!spare) return null;
    this.spare = null;
    spare.taken = true;
    if (spare.keepAlive) clearInterval(spare.keepAlive);
    spare.keepAlive = null;
    return spare.dead ? null : spare.promise;
  }

  private dropSpare(spare: Spare): void {
    spare.dead = true;
    if (spare.keepAlive) clearInterval(spare.keepAlive);
    spare.keepAlive = null;
    if (this.spare === spare) this.spare = null;
    void spare.promise.then((session) => session.close()).catch(() => {});
  }

  /** Luồng STT cho lượt nói: dùng luồng mở sẵn nếu có; hỏng hoặc chưa có thì mở mới. */
  private async acquireStt(claim: InternalClaimResponse): Promise<SttSession> {
    const warm = this.takeSpare();
    if (warm) {
      try {
        return await warm;
      } catch {
        // luồng mở sẵn không mở được: mở mới bên dưới
      }
    }
    return this.deps.providers.stt.open(this.sttOptions(claim));
  }

  /** Kết thúc bình thường một lượt: về trạng thái rảnh, hoặc đóng 4429 nếu vừa hết hạn mức. */
  private endTurn(turn: Turn): void {
    if (turn.cancelled || this.state === 'closed') return;
    this.finishTurn(turn);
    this.warmUp();
    if (this.enforceQuota()) return;
    this.send({ type: 'status', phase: 'idle' });
  }

  private transcript(turn: Turn): string {
    return [...turn.finals.map((f) => f.text), turn.interim].filter(Boolean).join(' ');
  }

  private async onStartTurn(mode: 'dictation' | 'confirm'): Promise<void> {
    // Bấm micro khi trợ lý đang nghĩ hoặc đang đọc: ngắt lời rồi nghe tiếp (SPEC 6.6).
    if (this.active) this.cancelActive();
    const claim = this.claim;
    if (!claim || this.enforceQuota()) return;
    const turn = this.newTurn(mode, 'listening');
    if (claim.ai.stt === 'off') {
      this.send({ type: 'error', code: 'stt_unavailable', retryable: false });
      this.send({ type: 'status', phase: 'idle' });
      return this.finishTurn(turn);
    }
    this.send({ type: 'status', phase: 'listening' });

    let stt: SttSession;
    try {
      stt = await this.acquireStt(claim);
    } catch (err) {
      if (turn.cancelled) return;
      this.log.error('stt_open_failed', { sessionId: this.sessionId, turnId: turn.id, err: errorName(err) });
      this.send({ type: 'error', code: 'stt_unavailable', retryable: true });
      this.send({ type: 'status', phase: 'idle' });
      return this.finishTurn(turn);
    }
    // Phiên đóng hoặc lượt bị huỷ trong lúc đang mở kết nối: đóng luồng STT ngay.
    if (turn.cancelled || this.state === 'closed') {
      void stt.close().catch(() => {});
      return;
    }
    turn.stt = stt;
    // Đã có luồng cho lượt này: mở ngay luồng chờ cho lượt sau, để nó sẵn sàng trong lúc lượt này nghe, nghĩ và đọc.
    this.warmUp();
    stt.on('interim', (e) => {
      if (turn.cancelled || turn.phase !== 'listening') return;
      turn.interim = e.text;
      this.send({ type: 'transcript.partial', turnId: turn.id, text: this.transcript(turn) });
    });
    stt.on('final', (e) => {
      if (turn.cancelled || turn.phase !== 'listening') return;
      turn.finals.push({ text: e.text.trim(), confidence: e.confidence });
      turn.interim = '';
      this.send({ type: 'transcript.partial', turnId: turn.id, text: this.transcript(turn) });
    });
    stt.on('utteranceEnd', () => void this.finalizeListening(turn, 'utterance_end'));
    stt.on('error', (e) => {
      if (turn.cancelled || turn.phase !== 'listening') return;
      this.log.error('stt_error', { sessionId: this.sessionId, turnId: turn.id, code: e.code });
      // Lỗi đến trong lúc đang chốt: kết quả không còn đáng tin, để `finalizeListening` báo lỗi thay vì đoán.
      if (turn.finalizing) {
        turn.sttFailed = true;
        return;
      }
      this.cancelActive();
      this.send({ type: 'error', code: 'stt_unavailable', retryable: e.retryable });
      this.send({ type: 'status', phase: 'idle' });
    });

    for (const chunk of turn.queue.splice(0)) stt.sendAudio(chunk);
    // App tạm ngừng gửi âm thanh thì scribe tự gửi KeepAlive để nhà cung cấp không đóng kết nối (SPEC 6.2).
    turn.keepAlive = setInterval(() => {
      if (performance.now() - turn.lastAudioAt >= this.cfg.sttKeepAliveMs * 0.75) stt.keepAlive();
    }, this.cfg.sttKeepAliveMs);
    turn.maxTimer = setTimeout(() => void this.finalizeListening(turn, 'max_turn'), this.cfg.maxTurnMs);
    if (turn.endRequested) void this.finalizeListening(turn, 'end_turn');
  }

  private onAudio(chunk: Uint8Array): void {
    const turn = this.active;
    // Khung nhị phân ngoài lượt nói bị bỏ: mic chỉ mở khi người dùng bấm.
    if (!turn || turn.phase !== 'listening' || turn.finalizing || turn.endRequested) {
      this.droppedAudioFrames++;
      return;
    }
    turn.audioBytes += chunk.byteLength;
    turn.lastAudioAt = performance.now();
    if (turn.stt) turn.stt.sendAudio(chunk);
    else if (turn.queue.length < MAX_QUEUED_AUDIO_CHUNKS) turn.queue.push(chunk);
  }

  private onEndTurn(): void {
    const turn = this.active;
    if (!turn || turn.phase !== 'listening') return;
    turn.endRequested = true;
    if (turn.stt) void this.finalizeListening(turn, 'end_turn');
  }

  /** Chốt lượt nói: đóng luồng STT (nhà cung cấp trả nốt kết quả chốt), gửi `transcript.final`, rồi xử lý. */
  private async finalizeListening(turn: Turn, reason: 'end_turn' | 'utterance_end' | 'max_turn'): Promise<void> {
    if (turn.cancelled || turn.phase !== 'listening' || turn.finalizing || !turn.stt) return;
    turn.finalizing = true;
    this.stopListeningTimers(turn);
    const t0 = performance.now();
    try {
      await sleepUntil(turn.stt.close(), this.cfg.sttCloseTimeoutMs);
    } catch {}
    if (turn.cancelled) return;
    if (turn.sttFailed) {
      this.send({ type: 'error', code: 'stt_unavailable', retryable: true });
      return this.endTurn(turn);
    }

    const text = turn.finals
      .map((f) => f.text)
      .filter(Boolean)
      .join(' ')
      .trim();
    const weight = turn.finals.reduce((n, f) => n + f.text.length, 0);
    const confidence = weight > 0 ? Math.round((turn.finals.reduce((n, f) => n + f.confidence * f.text.length, 0) / weight) * 1000) / 1000 : 0;
    const sttSeconds = Math.ceil(turn.audioBytes / PCM_BYTES_PER_SECOND);
    this.log.info('stt_final', { sessionId: this.sessionId, turnId: turn.id, mode: turn.kind, reason, textLen: text.length, confidence, audioBytes: turn.audioBytes, sttFinalMs: Math.round(performance.now() - t0) });
    this.send({ type: 'transcript.final', turnId: turn.id, text, confidence });

    if (turn.kind === 'confirm') {
      // Chỉ chép chữ, KHÔNG gọi LLM: app tự gửi POST /v1/proposals/:id/confirm với via 'voice' (SPEC 6.5 điều 10).
      await this.persist(turn, { messages: [], totals: { usage: emptyUsage(), sttSeconds, ttsChars: 0, errors: 0 } });
      return this.endTurn(turn);
    }
    turn.phase = 'processing';
    await this.processUtterance(turn, text, confidence, 'voice', sttSeconds);
  }

  private async onText(text: string): Promise<void> {
    if (this.active) this.cancelActive();
    if (this.enforceQuota()) return;
    const turn = this.newTurn('text', 'processing');
    // Gõ chữ đi chung đường xử lý với giọng nói: kết quả y hệt (SPEC 6.6).
    await this.processUtterance(turn, text, 1, 'text', 0);
  }

  private onInterrupt(): void {
    if (!this.active) return;
    this.log.info('interrupt', { sessionId: this.sessionId, turnId: this.active.id, phase: this.active.phase });
    this.cancelActive();
    this.send({ type: 'status', phase: 'idle' });
  }

  // ───────────────────────── Hiểu và trả lời ─────────────────────────

  private async processUtterance(turn: Turn, rawText: string, confidence: number, via: 'voice' | 'text', sttSeconds: number): Promise<void> {
    const agent = this.agent;
    const claim = this.claim;
    if (!agent || !claim) return;
    const title = this.title;
    const text = rawText.trim();
    const totals: TurnTotals = { usage: emptyUsage(), sttSeconds, ttsChars: 0, errors: 0 };
    const userMessage = { role: 'user' as const, content: { text, via }, ...(via === 'voice' ? { sttConfidence: confidence } : {}) };

    let reply: string;
    let outcome: AgentTurnResult | null = null;

    if (text === '' || (via === 'voice' && confidence < this.cfg.minConfidence)) {
      // Nghe không rõ: không gọi LLM. Hai lần liên tiếp thì đề nghị gõ chữ hoặc nhờ Văn phòng (SPEC 6.6).
      this.unclearCount++;
      reply = unclearReply(this.unclearCount, title);
      this.log.info('turn_unclear', { sessionId: this.sessionId, turnId: turn.id, consecutive: this.unclearCount, textLen: text.length, confidence });
    } else {
      this.unclearCount = 0;
      this.send({ type: 'status', phase: 'thinking' });
      // Quá 2 giây chưa có chữ trả lời: báo lại để app phát câu "xin chờ" dựng sẵn (SPEC 6.10).
      const notice = setTimeout(() => {
        if (!turn.cancelled && this.active === turn) this.send({ type: 'status', phase: 'thinking' });
      }, this.cfg.thinkingNoticeMs);
      const choices: WsServerFrame[] = [];
      try {
        outcome = await runAgentTurn(agent, this.agentState, text, {
          signal: turn.abort.signal,
          onToolResult: (call) => this.onToolResult(turn, call, choices),
          onLlmCall: (m) => this.log.info('llm_call', { sessionId: this.sessionId, turnId: turn.id, round: m.round, llmFirstTokenMs: m.firstEventMs, llmTotalMs: m.totalMs, inputTokens: m.inputTokens, outputTokens: m.outputTokens, toolUses: m.toolUses, stop: m.stopReason }),
        });
      } catch (err) {
        clearTimeout(notice);
        const agentErr = err instanceof AgentError ? err : new AgentError('llm_unavailable', 'internal');
        totals.usage = agentErr.partial.usage;
        totals.errors = 1;
        const toolMessage = this.toolMessage(agentErr.partial.toolCalls);
        if (agentErr.code === 'aborted' || turn.cancelled) {
          // Bị ngắt lời hoặc mất kết nối: vẫn ghi lại phần đã xảy ra, không gửi thêm khung nào cho lượt này.
          totals.errors = 0;
          void this.persist(turn, { messages: [userMessage, ...toolMessage], totals });
          return;
        }
        this.log.error('llm_unavailable', { sessionId: this.sessionId, turnId: turn.id, code: agentErr.detail });
        this.send({ type: 'error', code: 'llm_unavailable', retryable: true });
        await this.persist(turn, { messages: [userMessage, ...toolMessage], totals });
        return this.endTurn(turn);
      }
      clearTimeout(notice);
      totals.usage = outcome.usage;
      reply = outcome.reply;
      const style = checkStyle(reply);
      this.log.info('turn_reply', {
        sessionId: this.sessionId,
        turnId: turn.id,
        source: outcome.source,
        replyLen: reply.length,
        sentences: style.sentences,
        questions: style.questions,
        bannedWords: style.banned.length,
        unknownNumbers: outcome.unknownNumbers.length,
        toolCalls: outcome.toolCalls.length,
        proposals: outcome.proposals.length,
      });
      if (turn.cancelled) {
        void this.persist(turn, { messages: [userMessage, ...this.toolMessage(outcome.toolCalls)], totals });
        return;
      }
      // Danh sách chạm chọn chỉ có nghĩa khi trợ lý thật sự hỏi lại (không tự chọn thay người dùng).
      if (outcome.proposals.length === 0 && style.questions > 0) for (const frame of choices) this.send(frame);
    }

    if (turn.cancelled) return;
    // Chữ trả lời đã qua chốt chặn số liệu rồi mới được gửi, theo từng cụm rồi bản đầy đủ.
    const words = reply.split(/(?<=\s)/u);
    for (let i = 0; i < words.length; i += 6) this.send({ type: 'assistant.delta', turnId: turn.id, text: words.slice(i, i + 6).join('') });
    this.send({ type: 'assistant.done', turnId: turn.id, text: reply });

    const segments = claim.ai.tts === 'off' ? [] : splitForTts(toSpeakable(redact(reply)), 300);
    totals.ttsChars = segments.reduce((n, s) => n + s.length, 0);
    const messages = [userMessage, ...(outcome ? this.toolMessage(outcome.toolCalls) : []), { role: 'assistant' as const, content: { text: reply, source: outcome?.source ?? 'unclear' } }];
    // Ghi hội thoại song song với lúc đọc; phiên chỉ về trạng thái rảnh khi cả hai đã xong.
    const persisted = this.persist(turn, { messages, totals });

    await this.speak(turn, segments);
    await persisted;
    if (turn.cancelled || this.state === 'closed') return;
    this.log.info('turn_done', { sessionId: this.sessionId, turnId: turn.id, via, totalMs: Math.round(performance.now() - turn.startedAt) });
    this.endTurn(turn);
  }

  private toolMessage(calls: ToolCallRecord[]): { role: 'tool'; content: unknown }[] {
    if (calls.length === 0) return [];
    return [{ role: 'tool', content: { calls: calls.map((c) => ({ name: c.name, args: c.args, ok: c.result.ok, result: c.result.result ?? null, error: c.result.error ?? null, proposalIds: (c.result.proposals ?? []).map((p) => p.proposalId) })) } }];
  }

  /** Kết quả tool vừa về: báo đề xuất mới cho app, và chuẩn bị danh sách chạm chọn khi tên mơ hồ. */
  private onToolResult(turn: Turn, call: ToolCallRecord, choices: WsServerFrame[]): void {
    this.log.info('tool_call', { sessionId: this.sessionId, turnId: turn.id, tool: call.name, ok: call.result.ok, toolMs: call.ms, code: call.result.error?.code ?? null, proposals: call.result.proposals?.length ?? 0 });
    if (turn.cancelled) return;

    // Mỗi lô đề xuất một khung; đề xuất lẻ (không có lô) mỗi cái một khung. App mở màn hình xác nhận và lấy câu
    // xác nhận bằng GET /v1/proposals/:id: câu đó do máy chủ dựng, không lấy chữ của LLM.
    const proposals = call.result.proposals ?? [];
    const seen = new Set<string>();
    for (const p of proposals) {
      const key = p.batchId ?? p.proposalId;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = p.batchId ? proposals.filter((x) => x.batchId === p.batchId) : [p];
      this.send({ type: 'proposal.created', proposalId: p.proposalId, batchId: p.batchId, risk: Math.max(...group.map((x) => x.risk)), itemCount: group.length });
    }

    // Người dùng đang đọc các bước của một quy trình mới: cho nghỉ lâu hơn giữa các bước; tạo xong đề xuất thì trở lại bình thường.
    if (call.name === 'preview_process' && call.result.ok && call.result.processReadback) {
      this.drafting = true;
      this.touch();
    } else if (call.name === 'propose_create_process' && (call.result.proposals?.length ?? 0) > 0) {
      this.drafting = false;
      this.touch();
    }

    if (call.name === 'search_people' && call.result.ok) {
      const people = ambiguousPeople(call.result.result);
      if (people.length > 1) {
        const options = people.map((p) => {
          const honorific = typeof p.honorific === 'string' ? (HONORIFIC_WORD[p.honorific] ?? p.honorific) : '';
          const name = typeof p.fullName === 'string' ? p.fullName : typeof p.givenName === 'string' ? p.givenName : '';
          return { id: p.id, label: [honorific, name].filter(Boolean).join(' '), sub: typeof p.unitName === 'string' && p.unitName ? p.unitName : null };
        });
        // Kiểm theo hợp đồng khung trước khi gửi: kết quả tool sai dạng thì bỏ danh sách, không làm hỏng phiên.
        const frame = WsServerFrameSchema.safeParse({ type: 'choices', turnId: turn.id, kind: 'person', options });
        if (frame.success) {
          choices.length = 0;
          choices.push(frame.data);
        }
      }
    }
  }

  // ───────────────────────── Đọc thành tiếng ─────────────────────────

  /**
   * Đọc lần lượt các đoạn (mỗi đoạn không quá 300 ký tự) bằng TTS chế độ sync. `audio.start` chỉ gửi khi đã có byte
   * đầu, nên TTS lỗi trước byte đầu thì app chỉ nhận `error tts_unavailable` và vẫn có chữ.
   * Âm thanh về nhanh hơn tốc độ phát nên đoạn kế tiếp tới trước khi app phát xong đoạn hiện tại.
   */
  private async speak(turn: Turn, segments: string[]): Promise<void> {
    const claim = this.claim;
    if (!claim || segments.length === 0 || turn.cancelled) return;
    this.send({ type: 'status', phase: 'speaking' });
    const voice = claim.voiceId ?? this.cfg.defaultVoice;
    const speed = SPEECH_RATE[claim.speechRate];
    const t0 = performance.now();
    let firstByteMs = -1;
    let bytes = 0;
    let failure: string | null = null;

    for (const segment of segments) {
      if (turn.cancelled) break;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      turn.abort.signal.addEventListener('abort', onAbort, { once: true });
      const iterator = this.deps.providers.tts.synthesize(segment, { voice, speed, format: 'mp3', signal: controller.signal })[Symbol.asyncIterator]();
      try {
        let first = true;
        for (;;) {
          const next = first ? await sleepUntil(iterator.next(), this.cfg.ttsFirstByteTimeoutMs) : await iterator.next();
          if (next === 'timeout') {
            controller.abort();
            failure = 'first_byte_timeout';
            break;
          }
          if (next.done || turn.cancelled) break;
          first = false;
          if (next.value.byteLength === 0) continue;
          if (firstByteMs < 0) firstByteMs = Math.round(performance.now() - t0);
          if (!turn.audioOpen) {
            turn.audioOpen = true;
            this.send({ type: 'audio.start', turnId: turn.id, format: 'mp3' });
          }
          bytes += next.value.byteLength;
          this.sendAudio(next.value);
        }
      } catch (err) {
        if (!turn.cancelled) failure = errorName(err);
      } finally {
        turn.abort.signal.removeEventListener('abort', onAbort);
        void iterator.return?.()?.catch(() => {});
      }
      if (failure) break;
    }

    if (turn.cancelled) return;
    if (turn.audioOpen) {
      turn.audioOpen = false;
      this.send({ type: 'audio.end', turnId: turn.id });
    }
    this.log.info('tts', { sessionId: this.sessionId, turnId: turn.id, segments: segments.length, chars: segments.reduce((n, s) => n + s.length, 0), bytes, ttsFirstByteMs: firstByteMs, failed: failure !== null });
    if (failure) {
      this.log.error('tts_unavailable', { sessionId: this.sessionId, turnId: turn.id, code: failure === 'first_byte_timeout' ? failure : 'tts_error' });
      // TTS lỗi: app chỉ hiện chữ, hoặc đọc bằng giọng của hệ điều hành (SPEC 6.11).
      this.send({ type: 'error', code: 'tts_unavailable', retryable: true });
    }
  }

  // ───────────────────────── Ghi hội thoại và hạn mức ─────────────────────────

  /**
   * Sau mỗi lượt: ghi `messages` (lượt nói đã chốt kèm độ tin cậy, kết quả tool, câu trả lời; không ghi âm thanh)
   * rồi cộng `usage`. Hết hạn mức thì báo và đóng 4429. Lỗi ghi không làm hỏng lượt đang trả lời.
   */
  private async persist(turn: Turn, data: { messages: { role: 'user' | 'assistant' | 'tool'; content: unknown; sttConfidence?: number }[]; totals: TurnTotals }): Promise<void> {
    const claim = this.claim;
    const who = this.who;
    if (!claim || !who) return;
    const { api } = this.deps;
    try {
      for (const m of data.messages) await api.postMessage({ conversationId: claim.conversationId, ...m }, who);
    } catch (err) {
      data.totals.errors++;
      this.log.error('persist_failed', { sessionId: this.sessionId, turnId: turn.id, op: 'message', status: err instanceof InternalApiError ? err.status : 0 });
    }
    try {
      this.quotaLeft = await api.postUsage(
        {
          conversationId: claim.conversationId,
          llmCalls: data.totals.usage.llmCalls,
          llmInputTokens: data.totals.usage.inputTokens,
          llmOutputTokens: data.totals.usage.outputTokens,
          sttSeconds: data.totals.sttSeconds,
          ttsChars: data.totals.ttsChars,
          errors: data.totals.errors,
        },
        who,
      );
    } catch (err) {
      this.log.error('persist_failed', { sessionId: this.sessionId, turnId: turn.id, op: 'usage', status: err instanceof InternalApiError ? err.status : 0 });
      return;
    }
    this.log.info('usage', { sessionId: this.sessionId, turnId: turn.id, llmCalls: data.totals.usage.llmCalls, inputTokens: data.totals.usage.inputTokens, outputTokens: data.totals.usage.outputTokens, sttSeconds: data.totals.sttSeconds, ttsChars: data.totals.ttsChars, errors: data.totals.errors, quotaLeft: this.quotaLeft });
    // Để lượt hiện tại đọc xong rồi mới đóng: người dùng vẫn nhận đủ câu trả lời cuối.
    if (this.quotaLeft <= 0) this.quotaExhausted = true;
  }

  /** Gọi sau khi một lượt kết thúc: hết hạn mức thì báo `quota_exceeded` rồi đóng 4429. */
  private enforceQuota(): boolean {
    if (!this.quotaExhausted || this.state !== 'ready') return false;
    this.log.info('quota_exceeded', { sessionId: this.sessionId });
    this.send({ type: 'error', code: 'quota_exceeded', retryable: false });
    this.close(WS_CLOSE.quota);
    return true;
  }
}
