/**
 * Nhận dạng giọng nói (SPEC 6.2, 6.9). `scribe` chỉ mở một phiên STT trong lúc người dùng đang bấm micro,
 * nên mỗi `SttSession` ứng với đúng một lượt nói.
 *
 * Quy ước sự kiện (chung cho mọi nhà cung cấp):
 *  - `interim`: giả thuyết tạm của ĐOẠN đang nói (chưa chốt), để hiện chữ ngay lên màn hình.
 *  - `final`: một đoạn đã chốt kèm độ tin cậy. Một lượt nói có thể gồm nhiều đoạn; bên gọi tự nối lại.
 *  - `utteranceEnd`: nhà cung cấp báo người nói đã ngừng (theo `utteranceEndMs`).
 *  - `error`: chỉ mang mã lỗi, không mang văn bản câu nói (SPEC 6.8).
 * `close()` chỉ trả về sau khi mọi đoạn chốt còn lại đã được phát ra.
 */
import WebSocket from 'ws';

export type SttInterimEvent = { type: 'interim'; text: string };
export type SttFinalEvent = { type: 'final'; text: string; confidence: number };
export type SttUtteranceEndEvent = { type: 'utteranceEnd' };
export type SttErrorEvent = { type: 'error'; code: string; retryable: boolean };
export type SttEvent = SttInterimEvent | SttFinalEvent | SttUtteranceEndEvent | SttErrorEvent;
export type SttEventName = SttEvent['type'];
export type SttListener<E extends SttEventName> = (e: Extract<SttEvent, { type: E }>) => void;

export interface SttSession {
  /** PCM 16-bit, 16 kHz, đơn kênh, little-endian */
  sendAudio(chunk: Uint8Array): void;
  on<E extends SttEventName>(event: E, cb: SttListener<E>): void;
  /** gọi mỗi 3 đến 5 giây khi app tạm ngừng gửi âm thanh; quá 10 giây im lặng thì Deepgram đóng kết nối */
  keepAlive(): void;
  close(): Promise<void>;
}

export type SttOpenOptions = {
  language: 'vi';
  sampleRate: 16000;
  /** tên người, phòng ban, tên quy trình (SPEC 6.2) */
  keyterms: string[];
  /** điểm xuất phát 1200 đến 1500 ms [GIẢ ĐỊNH], chỉnh theo bài đo ở SPEC 6.2.1 */
  utteranceEndMs: number;
};

export interface SttProvider {
  open(o: SttOpenOptions): Promise<SttSession>;
  /**
   * `true` khi một phiên mở trước có thể nằm chờ (nhờ `keepAlive`) tới lượt nói kế tiếp mà không tốn gì thêm. Scribe dùng để mở sẵn
   * luồng STT cho lượt kế, bỏ khoảng bắt tay với nhà cung cấp (đo 04/10/2026: 0,8 đến 2,5 giây với Deepgram) khỏi lúc người dùng
   * vừa bắt đầu nói. Mike đồng ý ngày 04/10/2026 (trái SPEC 10.7.2 "chỉ mở kết nối trong lượt nói", xem docs/DECISIONS.md).
   * Bản giả mặc định không mở sẵn, để các test đếm phiên không bị lệch.
   */
  readonly canPrewarm?: boolean;
}

/** Bộ phát sự kiện nhỏ, có kiểu, dùng chung cho bản thật và bản giả. */
class SttEmitter {
  private readonly listeners: { [E in SttEventName]: SttListener<E>[] } = { interim: [], final: [], utteranceEnd: [], error: [] };

  on<E extends SttEventName>(event: E, cb: SttListener<E>): void {
    (this.listeners[event] as SttListener<E>[]).push(cb);
  }

  emit<E extends SttEventName>(e: Extract<SttEvent, { type: E }>): void {
    for (const cb of this.listeners[e.type as E] as SttListener<E>[]) cb(e);
  }
}

// ───────────────────────── Deepgram ─────────────────────────

export type DeepgramSttOptions = {
  apiKey: string;
  /** mặc định wss://api.deepgram.com/v1/listen; test trỏ về máy chủ WebSocket cục bộ */
  baseUrl?: string;
  model?: string;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** trần token của keyterm mỗi yêu cầu (SPEC 6.2: tối đa 500) */
  keytermTokenBudget?: number;
  /**
   * Có gửi `keyterm` hay không. MẶC ĐỊNH TẮT. Đo với Deepgram thật ngày 04/10/2026 (Nova-3, `language=vi`, cùng một
   * câu tiếng Việt, cùng âm thanh): 0 hoặc 1 từ khoá thì nhận đúng; từ 3 từ khoá trở lên (thử 3, 8 và 30) thì MỌI kết quả
   * tạm và kết quả chốt đều rỗng, nên trợ lý luôn báo "nghe chưa rõ". Chỉ bật khi đã đo lại và thấy có lợi.
   */
  useKeyterms?: boolean;
  /**
   * Im lặng số hoá gửi ngay sau khi mở phiên, trước âm thanh thật (mili giây; mặc định 400, 0 là tắt). Đo ngày 04/10/2026:
   * tiếng nói bắt đầu ngay ở giây 0 của luồng thì Deepgram trả rỗng cho cả câu đầu; chèn 300 đến 600 ms im lặng ở đầu thì
   * nhận ra bình thường. Gửi một lần, không chờ theo nhịp thật nên không làm chậm lượt nói; tốn thêm đúng chừng đó giây âm thanh.
   */
  prerollMs?: number;
};

export const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
export const DEEPGRAM_KEYTERM_TOKEN_BUDGET = 500;
export const DEEPGRAM_DEFAULT_PREROLL_MS = 400;

/**
 * Ước lượng số token của một keyterm. [CHƯA XÁC MINH] Deepgram không công bố cách đếm token cho tiếng Việt;
 * tạm tính dè dặt 1 token cho mỗi 2 ký tự để không vượt trần 500. Đo lại ở bài đo STT (SPEC 6.2.1).
 */
export function estimateKeytermTokens(term: string): number {
  return Math.max(1, Math.ceil(term.trim().length / 2));
}

/** Giữ thứ tự ưu tiên của danh sách, bỏ trùng và bỏ rỗng, dừng khi chạm trần token. */
export function limitKeyterms(terms: string[], tokenBudget: number = DEEPGRAM_KEYTERM_TOKEN_BUDGET): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const raw of terms) {
    const term = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    const cost = estimateKeytermTokens(term);
    if (used + cost > tokenBudget) break;
    seen.add(key);
    used += cost;
    out.push(term);
  }
  return out;
}

/**
 * Địa chỉ streaming của Deepgram [ĐÃ XÁC MINH 02/10/2026 theo SPEC 6.2; mở lại trang gốc ở mục 17 trước khi dùng thật]:
 * cố định `model=nova-3&language=vi` (không dùng `multi` hay `detect_language`), âm thanh thô `linear16` kèm
 * `sample_rate`, `interim_results=true` (bắt buộc để có `utterance_end_ms`), luôn `mip_opt_out=true`.
 *
 * [ĐÃ ĐO 04/10/2026] `keyterm` với tiếng Việt làm Deepgram trả rỗng từ 3 từ khoá trở lên, nên chỉ gửi khi
 * `opts.useKeyterms` bật (xem `DeepgramSttOptions.useKeyterms`).
 *
 * [CHƯA XÁC MINH] `smart_format` và `numerals` cho `vi`: chưa xác nhận, nên KHÔNG gửi. Số, tiền, ngày do mã chuẩn hoá (SPEC 6.6).
 */
export function buildDeepgramUrl(o: SttOpenOptions, opts: Pick<DeepgramSttOptions, 'baseUrl' | 'model' | 'keytermTokenBudget' | 'useKeyterms'> = {}): string {
  const q = new URLSearchParams({
    model: opts.model ?? 'nova-3',
    language: o.language,
    encoding: 'linear16',
    sample_rate: String(o.sampleRate),
    channels: '1',
    interim_results: 'true',
    utterance_end_ms: String(Math.max(1000, Math.round(o.utteranceEndMs))),
    mip_opt_out: 'true',
  });
  if (opts.useKeyterms) for (const term of limitKeyterms(o.keyterms, opts.keytermTokenBudget)) q.append('keyterm', term);
  return `${opts.baseUrl ?? DEEPGRAM_LISTEN_URL}?${q.toString()}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Đọc một thông điệp `Results` của Deepgram; trả null nếu không đúng dạng. */
function readDeepgramResult(msg: Record<string, unknown>): { text: string; confidence: number; isFinal: boolean } | null {
  const channel = msg.channel;
  if (!isRecord(channel) || !Array.isArray(channel.alternatives)) return null;
  const alt: unknown = channel.alternatives[0];
  if (!isRecord(alt) || typeof alt.transcript !== 'string') return null;
  return {
    text: alt.transcript.trim(),
    confidence: typeof alt.confidence === 'number' ? alt.confidence : 0,
    isFinal: msg.is_final === true,
  };
}

class DeepgramSession implements SttSession {
  private readonly emitter = new SttEmitter();
  private closing = false;
  private closed: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly closeTimeoutMs: number,
  ) {
    this.closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!isRecord(msg)) return;
      if (msg.type === 'Results') {
        const r = readDeepgramResult(msg);
        if (!r || !r.text) return;
        if (r.isFinal) this.emitter.emit({ type: 'final', text: r.text, confidence: r.confidence });
        else this.emitter.emit({ type: 'interim', text: r.text });
      } else if (msg.type === 'UtteranceEnd') {
        this.emitter.emit({ type: 'utteranceEnd' });
      }
      // Metadata, SpeechStarted và các loại khác: bỏ qua.
    });
    ws.on('error', () => {
      if (!this.closing) this.emitter.emit({ type: 'error', code: 'stt_socket_error', retryable: true });
    });
    ws.on('close', (code) => {
      // Đóng ngoài ý muốn, ví dụ NET-0001 khi quá 10 giây không có âm thanh hay KeepAlive.
      if (!this.closing) this.emitter.emit({ type: 'error', code: `stt_closed_${code}`, retryable: true });
    });
  }

  on<E extends SttEventName>(event: E, cb: SttListener<E>): void {
    this.emitter.on(event, cb);
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk, { binary: true });
  }

  /** Gửi `ms` mili giây im lặng PCM 16-bit (toàn số 0), mỗi khối 100 ms, ngay lập tức. */
  sendSilence(ms: number, sampleRate: number): void {
    const blockBytes = Math.round(sampleRate / 10) * 2;
    for (let sent = 0; sent < ms; sent += 100) this.sendAudio(new Uint8Array(blockBytes));
  }

  keepAlive(): void {
    // Phải là khung VĂN BẢN; gửi dạng nhị phân sẽ bị coi là âm thanh.
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }

  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      // CloseStream: Deepgram xử lý nốt âm thanh đã nhận, trả các đoạn chốt còn lại rồi tự đóng.
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.closeTimeoutMs);
      });
      await Promise.race([this.closed, timeout]);
      clearTimeout(timer);
    }
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
  }
}

/**
 * Deepgram Nova-3 tiếng Việt qua WebSocket (SPEC 6.2). Khoá API chỉ nằm ở máy chủ [QUYẾT ĐỊNH proxy]:
 * app gửi âm thanh tới `scribe`, `scribe` gửi tới Deepgram.
 * Đã gọi Deepgram thật một lần (04/10/2026, bằng giọng tổng hợp): mở được phiên, chữ tạm về khoảng mỗi giây,
 * chốt câu sau lúc ngừng nói chừng 0,4 giây. Hai điều đo được đã đổi cách dùng: `useKeyterms` và `prerollMs`.
 * Test thường chạy với máy chủ WebSocket cục bộ.
 */
export class DeepgramStt implements SttProvider {
  /** Deepgram tính tiền theo giây âm thanh gửi lên, không tính kết nối chờ; `KeepAlive` mỗi vài giây giữ kết nối quá mốc 10 giây im lặng. */
  readonly canPrewarm = true;

  constructor(private readonly opts: DeepgramSttOptions) {
    if (!opts.apiKey) throw new Error('DeepgramStt: thiếu DEEPGRAM_API_KEY');
  }

  open(o: SttOpenOptions): Promise<SttSession> {
    const url = buildDeepgramUrl(o, this.opts);
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.opts.apiKey}` }, handshakeTimeout: this.opts.openTimeoutMs ?? 5000 });
    return new Promise<SttSession>((resolve, reject) => {
      const onError = () => {
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        // Không đưa thông điệp gốc vào lỗi: có thể chứa địa chỉ kèm keyterm (tên người).
        reject(new Error('stt_open_failed'));
      };
      ws.once('error', onError);
      ws.once('open', () => {
        ws.removeListener('error', onError);
        const session = new DeepgramSession(ws, this.opts.closeTimeoutMs ?? 3000);
        session.sendSilence(this.opts.prerollMs ?? DEEPGRAM_DEFAULT_PREROLL_MS, o.sampleRate);
        resolve(session);
      });
    });
  }
}

// ───────────────────────── Bản giả ─────────────────────────

export type FakeSttUtterance = {
  /** các kết quả tạm, phát lần lượt theo từng khối âm thanh nhận được */
  interim?: string[];
  /** câu chốt; chuỗi rỗng để kiểm nhánh "nghe không rõ" (không phát sự kiện `final`, giống Deepgram khi im lặng) */
  final: string;
  confidence: number;
  /** phát sự kiện `error` thay vì kết quả: ở khối âm thanh đầu tiên, hoặc lúc `close()` nếu chưa có âm thanh nào */
  error?: boolean;
};

export type FakeSttSessionRecord = {
  options: SttOpenOptions;
  audioChunks: number;
  audioBytes: number;
  keepAlives: number;
  closed: boolean;
  /** để test giả lập nhà cung cấp tự đóng phiên đang nằm chờ: phát sự kiện `error` mang mã này */
  fail: (code?: string) => void;
};

export type FakeSttOptions = {
  /**
   * Sau từng này khối âm thanh thì bản giả tự coi là người nói đã ngừng: phát kết quả chốt rồi `utteranceEnd`
   * (để kiểm nhánh máy chủ tự chốt lượt nói). Bỏ trống: chỉ phát khi `close()`.
   */
  autoEndAfterChunks?: number;
  /** hết hàng đợi thì phát lại kịch bản từ đầu (để thử tay với app); mặc định hết hàng đợi là im lặng */
  loop?: boolean;
  /** giả làm nhà cung cấp cho phép mở sẵn phiên (để kiểm scribe mở sẵn luồng STT); mặc định không */
  canPrewarm?: boolean;
};

class FakeSttSession implements SttSession {
  private readonly emitter = new SttEmitter();
  private interimIdx = 0;
  private flushed = false;

  constructor(
    private readonly utterance: FakeSttUtterance,
    private readonly record: FakeSttSessionRecord,
    private readonly autoEndAfterChunks: number | undefined,
  ) {}

  on<E extends SttEventName>(event: E, cb: SttListener<E>): void {
    this.emitter.on(event, cb);
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.record.closed || this.flushed) return;
    this.record.audioChunks++;
    this.record.audioBytes += chunk.byteLength;
    // Kịch bản lỗi: hỏng ngay giữa lượt nói, ở khối âm thanh đầu tiên.
    if (this.utterance.error) return this.flush(false);
    const interim = this.utterance.interim ?? [];
    if (this.interimIdx < interim.length) {
      this.emitter.emit({ type: 'interim', text: interim[this.interimIdx++] as string });
    }
    if (this.autoEndAfterChunks !== undefined && this.record.audioChunks >= this.autoEndAfterChunks) this.flush(true);
  }

  keepAlive(): void {
    if (!this.record.closed) this.record.keepAlives++;
  }

  /** Nhà cung cấp tự đóng phiên: phát `error` (chỉ để test). */
  fail(code: string): void {
    if (!this.record.closed) this.emitter.emit({ type: 'error', code, retryable: true });
  }

  /** Phát phần còn lại của kịch bản đúng một lần. */
  private flush(withUtteranceEnd: boolean): void {
    if (this.flushed) return;
    this.flushed = true;
    if (this.utterance.error) {
      this.emitter.emit({ type: 'error', code: 'stt_fake_error', retryable: true });
      return;
    }
    const interim = this.utterance.interim ?? [];
    while (this.interimIdx < interim.length) this.emitter.emit({ type: 'interim', text: interim[this.interimIdx++] as string });
    if (this.utterance.final.trim()) {
      this.emitter.emit({ type: 'final', text: this.utterance.final, confidence: this.utterance.confidence });
      if (withUtteranceEnd) this.emitter.emit({ type: 'utteranceEnd' });
    }
  }

  async close(): Promise<void> {
    if (this.record.closed) return;
    this.flush(false);
    this.record.closed = true;
  }
}

/**
 * STT giả chạy theo bản ghi sẵn (SPEC 6.9, 13.1): mỗi lần `open()` lấy câu kế tiếp trong hàng đợi; hết hàng đợi
 * thì coi như im lặng (câu rỗng). Tất định, không cần mạng, không đọc nội dung âm thanh.
 */
export class FakeStt implements SttProvider {
  readonly queue: FakeSttUtterance[];
  readonly sessions: FakeSttSessionRecord[] = [];
  /** số lần `open()` kế tiếp sẽ lỗi (để kiểm `stt_unavailable`) */
  failNextOpen = 0;
  readonly canPrewarm: boolean;
  private readonly script: FakeSttUtterance[];

  constructor(
    script: FakeSttUtterance[] = [],
    private readonly opts: FakeSttOptions = {},
  ) {
    this.script = [...script];
    this.queue = [...script];
    this.canPrewarm = opts.canPrewarm === true;
  }

  enqueue(...utterances: FakeSttUtterance[]): this {
    this.queue.push(...utterances);
    return this;
  }

  /** số phiên đang mở (chưa `close()`): scribe phải đưa về 0 khi hết lượt nói hoặc khi app ngắt kết nối */
  get openSessions(): number {
    return this.sessions.filter((s) => !s.closed).length;
  }

  async open(o: SttOpenOptions): Promise<SttSession> {
    if (this.failNextOpen > 0) {
      this.failNextOpen--;
      throw new Error('stt_open_failed');
    }
    if (this.queue.length === 0 && this.opts.loop) this.queue.push(...this.script);
    const utterance = this.queue.shift() ?? { final: '', confidence: 0 };
    const record: FakeSttSessionRecord = { options: { ...o, keyterms: [...o.keyterms] }, audioChunks: 0, audioBytes: 0, keepAlives: 0, closed: false, fail: () => {} };
    this.sessions.push(record);
    const session = new FakeSttSession(utterance, record, this.opts.autoEndAfterChunks);
    record.fail = (code = 'stt_fake_closed') => session.fail(code);
    return session;
  }
}
