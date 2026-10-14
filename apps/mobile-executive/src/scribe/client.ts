import { WS_CLOSE, WsServerFrameSchema, type WsClientFrame, type WsServerFrame } from '@mihato/domain';

/**
 * Lớp WebSocket của trợ lý (SPEC 10.7.2). Thuần TypeScript: không nạp React Native, không biết gì về màn hình,
 * nên test được bằng Vitest với máy chủ giả.
 *
 * Điều phải giữ:
 * - Token phiên sống 120 giây và dùng MỘT lần: mỗi lần nối (kể cả nối lại) phải gọi `createSession()` mới.
 * - Khung đầu tiên là `hello`; chỉ khi nhận `ready` mới được gửi khung khác.
 * - Âm thanh (khung nhị phân PCM 16-bit, 16 kHz) chỉ gửi giữa `start_turn` và `end_turn`: micro chỉ mở khi bấm.
 * - Khung chữ từ máy chủ kiểm bằng `WsServerFrameSchema`; khung lạ thì bỏ qua (máy chủ có thể thêm loại khung mới).
 */
export type ScribeSessionInfo = { wsUrl: string; token: string };

export type ScribeConnectionState = 'closed' | 'connecting' | 'ready';

export type ScribeCloseReason =
  /** 4401: token sai, hết hạn hoặc đã dùng */
  | 'bad_token'
  /** 4408: im 60 giây, hoặc phiên đã sống đủ 15 phút */
  | 'idle'
  /** 4429: hết hạn mức trong ngày */
  | 'quota'
  /** 1011, hoặc máy chủ đóng bằng mã lạ */
  | 'server_error'
  /** đứt mạng, không nối được */
  | 'network'
  /** app tự đóng (rời màn hình, khoá app) */
  | 'client';

export type ScribeClientEvent =
  | { type: 'state'; state: ScribeConnectionState }
  | { type: 'frame'; frame: WsServerFrame }
  /** một khối âm thanh mp3 của câu trả lời, nằm giữa `audio.start` và `audio.end` */
  | { type: 'audio'; chunk: Uint8Array }
  | { type: 'closed'; code: number; reason: ScribeCloseReason };

/** Phần của WebSocket mà lớp này dùng: trình duyệt, React Native và Node 22 đều có sẵn. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type ScribeClientOptions = {
  /** `POST /v1/scribe/sessions`: gọi lại ở MỖI lần nối. Ném lỗi (ví dụ ApiError `ai_disabled`) thì `connect()` ném theo. */
  createSession: () => Promise<ScribeSessionInfo>;
  appVersion: string;
  onEvent: (event: ScribeClientEvent) => void;
  /** mặc định `new WebSocket(url)` */
  createSocket?: (url: string) => WebSocketLike;
  /** chờ `ready` tối đa từng này mili giây (máy chủ tự đóng 4401 nếu 5 giây không có `hello`) */
  readyTimeoutMs?: number;
};

export class ScribeConnectError extends Error {
  constructor(
    readonly reason: ScribeCloseReason,
    readonly code: number,
  ) {
    super(`scribe_connect_failed:${reason}`);
    this.name = 'ScribeConnectError';
  }
}

export function closeReasonOf(code: number, closedByClient: boolean): ScribeCloseReason {
  if (closedByClient) return 'client';
  if (code === WS_CLOSE.badToken) return 'bad_token';
  if (code === WS_CLOSE.idle) return 'idle';
  if (code === WS_CLOSE.quota) return 'quota';
  if (code === WS_CLOSE.serverError) return 'server_error';
  // 1006: đứt kết nối không có khung đóng. 1000, 1001, 1005: máy chủ đóng êm (ví dụ sau khi báo `ai_disabled`).
  if (code === 1006 || code === 0) return 'network';
  if (code === 1000 || code === 1001 || code === 1005) return 'idle';
  return 'server_error';
}

const OPEN = 1;

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

type Attempt = { socket: WebSocketLike; closedByClient: boolean };

export class ScribeClient {
  private attempt: Attempt | null = null;
  private current: ScribeConnectionState = 'closed';
  private connecting: Promise<void> | null = null;
  private turnOpen = false;
  private generation = 0;

  constructor(private readonly opts: ScribeClientOptions) {}

  get state(): ScribeConnectionState {
    return this.current;
  }

  /** Đang trong một lượt nói (đã gửi `start_turn`, chưa gửi `end_turn`). */
  get isTurnOpen(): boolean {
    return this.turnOpen;
  }

  private setState(state: ScribeConnectionState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onEvent({ type: 'state', state });
  }

  /**
   * Mở một phiên mới: xin token, nối, gửi `hello`, chờ `ready`. Nhiều nơi cùng gọi thì chờ chung một lần nối.
   * Ném `ScribeConnectError` khi máy chủ đóng trước `ready`, hoặc lỗi của `createSession()`.
   */
  connect(): Promise<void> {
    if (this.current === 'ready') return Promise.resolve();
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Bảo đảm có phiên đang mở trước khi gửi. Token chỉ dùng một lần nên nếu máy chủ từ chối `hello` (4401, ví dụ
   * token vừa hết 120 giây) thì thử đúng một lần nữa với token mới.
   */
  async ensureReady(): Promise<void> {
    if (this.current === 'ready') return;
    try {
      await this.connect();
    } catch (err) {
      if (err instanceof ScribeConnectError && err.reason === 'bad_token') return this.connect();
      throw err;
    }
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.setState('connecting');
    let info: ScribeSessionInfo;
    try {
      info = await this.opts.createSession();
    } catch (err) {
      if (generation === this.generation) this.setState('closed');
      throw err;
    }
    // `close()` được gọi trong lúc đang xin token: bỏ, không mở kết nối.
    if (generation !== this.generation) throw new ScribeConnectError('client', 1000);

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = this.opts.createSocket ? this.opts.createSocket(info.wsUrl) : (new WebSocket(info.wsUrl) as unknown as WebSocketLike);
      } catch {
        this.setState('closed');
        reject(new ScribeConnectError('network', 0));
        return;
      }
      const attempt: Attempt = { socket, closedByClient: false };
      this.attempt = attempt;
      socket.binaryType = 'arraybuffer';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        // Không nhận được `ready`: coi như không nối được, đóng để lần sau xin token mới.
        attempt.closedByClient = false;
        try {
          socket.close();
        } catch {}
        finish(new ScribeConnectError('network', 0));
      }, this.opts.readyTimeoutMs ?? 8000);

      const finish = (err?: ScribeConnectError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      socket.onopen = () => {
        this.sendFrame({ type: 'hello', token: info.token, appVersion: this.opts.appVersion }, socket);
      };

      socket.onmessage = (event) => {
        if (this.attempt !== attempt) return;
        const data = event.data;
        if (typeof data === 'string') {
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            return;
          }
          const parsed = WsServerFrameSchema.safeParse(json);
          if (!parsed.success) return;
          const frame = parsed.data;
          if (frame.type === 'ready') {
            this.setState('ready');
            this.opts.onEvent({ type: 'frame', frame });
            finish();
            return;
          }
          this.opts.onEvent({ type: 'frame', frame });
          return;
        }
        const bytes = toBytes(data);
        if (bytes) this.opts.onEvent({ type: 'audio', chunk: bytes });
      };

      socket.onerror = () => {
        // Chi tiết nằm ở sự kiện `close` ngay sau đó; trình duyệt không cho biết gì thêm ở đây.
      };

      socket.onclose = (event) => {
        if (this.attempt !== attempt) return;
        this.attempt = null;
        this.turnOpen = false;
        const code = typeof event.code === 'number' ? event.code : 1006;
        const reason = closeReasonOf(code, attempt.closedByClient);
        this.setState('closed');
        this.opts.onEvent({ type: 'closed', code, reason });
        finish(new ScribeConnectError(reason, code));
      };
    });
  }

  private sendFrame(frame: WsClientFrame, socket: WebSocketLike | undefined = this.attempt?.socket): boolean {
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  private sendWhenReady(frame: WsClientFrame): boolean {
    return this.current === 'ready' && this.sendFrame(frame);
  }

  /** Người dùng bấm micro. `confirm`: chỉ chép chữ, không gọi LLM (xác nhận bằng giọng ở M3, đọc vào ô nhập). */
  startTurn(mode: 'dictation' | 'confirm'): boolean {
    const sent = this.sendWhenReady({ type: 'start_turn', mode });
    this.turnOpen = sent;
    return sent;
  }

  /** PCM 16-bit, đơn kênh, 16 kHz, little-endian, mỗi khung 20 đến 100 ms. Ngoài lượt nói thì bỏ, không gửi. */
  sendAudio(pcm16: Uint8Array): boolean {
    const socket = this.attempt?.socket;
    if (!this.turnOpen || this.current !== 'ready' || !socket || socket.readyState !== OPEN) return false;
    socket.send(pcm16);
    return true;
  }

  /** Người dùng bấm micro lần nữa. */
  endTurn(): boolean {
    if (!this.turnOpen) return false;
    this.turnOpen = false;
    return this.sendWhenReady({ type: 'end_turn' });
  }

  /** Máy chủ tự chốt lượt nói (hết câu, hoặc lỗi): từ đây không gửi âm thanh nữa. */
  markTurnClosed(): void {
    this.turnOpen = false;
  }

  /** Gõ chữ: kết quả y hệt đường giọng nói. */
  sendText(text: string): boolean {
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed) return false;
    this.turnOpen = false;
    return this.sendWhenReady({ type: 'text', text: trimmed });
  }

  /** Bấm micro khi trợ lý đang nghĩ hoặc đang đọc: dừng ngay. */
  interrupt(): boolean {
    this.turnOpen = false;
    return this.sendWhenReady({ type: 'interrupt' });
  }

  /** App tự đóng phiên: rời màn hình, khoá app, đăng xuất. Lần dùng sau sẽ mở phiên mới. */
  close(): void {
    this.generation++;
    this.turnOpen = false;
    const attempt = this.attempt;
    if (!attempt) {
      this.setState('closed');
      return;
    }
    attempt.closedByClient = true;
    try {
      attempt.socket.close(1000);
    } catch {}
  }
}
