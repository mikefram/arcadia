/**
 * Vbee STT streaming, bản tạm cho bài đo (SPEC 6.2 phần dự phòng, S1-06). `packages/providers` chưa có `VbeeStt`
 * (factory.ts: "đưa vào bài đo ở Giai đoạn 0 rồi mới dựng"), nên adapter nằm ở đây để bài đo chạy được Vbee mà không
 * đụng `packages/providers`. Nếu Vbee được chọn thì chuyển nguyên tệp này sang `packages/providers/src/stt.ts`.
 *
 * [CHƯA XÁC MINH] Giao thức dưới đây lấy từ trang streaming-api của Vbee
 * (https://api-docs.vbee.vn/vbee-api/speech-to-text/streaming-api.md) đọc qua công cụ tóm tắt ngày 03/10/2026, KHÔNG phải
 * đọc trực tiếp bản gốc, và chưa gọi Vbee thật lần nào (không có khoá). Mở lại trang gốc đối chiếu từng tên trường trước
 * khi chạy với `--real`. Mọi chỗ phụ thuộc tên trường gom ở bốn hàm `build*` và `readVbeeMessage`:
 *  - Địa chỉ: wss://api.vbee.vn/v1/stt/realtime?token=…&appId=… (xác thực nằm trong địa chỉ, nên KHÔNG BAO GIỜ đưa địa chỉ vào lỗi).
 *  - Gửi `STREAMING_CONFIG`, đợi `READY`, rồi gửi âm thanh bằng khung VĂN BẢN `AUDIO_CHUNK` (base64), không phải khung nhị phân.
 *  - Nhận `INTERIM_RESULT`, `FINAL_RESULT` (một kết quả mỗi câu theo bộ dò tiếng nói phía Vbee), `ERROR`, `PONG`.
 *  - Kết thúc bằng `DONE`, nhận `STREAM_END`, máy chủ đóng kết nối. Phiên tối đa 90 giây.
 *
 * Ánh xạ sang `SttSession`: mỗi `FINAL_RESULT` có chữ phát `final` rồi `utteranceEnd` (Vbee chốt câu khi im lặng quá
 * `speechCompleteTimeoutMs`, đóng vai `utterance_end_ms`). `utteranceEndMs` của bài đo ánh xạ sang `speechCompleteTimeoutMs`
 * (500 đến 3000). Vbee không có tương đương `keyterm` nên `keyterms` bị bỏ qua.
 */
import type { SttEvent, SttEventName, SttListener, SttOpenOptions, SttProvider, SttSession } from '@mihato/providers';
import WebSocket from 'ws';

export const VBEE_STT_URL = 'wss://api.vbee.vn/v1/stt/realtime';
export const VBEE_MAX_SESSION_MS = 90_000;
const SPEECH_COMPLETE_RANGE = { min: 500, max: 3000 } as const;
const NO_INPUT_TIMEOUT_MS = 10_000;
/** mã lỗi Vbee ghi là có thể thử lại */
const RETRYABLE_CODES = new Set(['STT_MAX_CCR_REACHED', 'PROVIDER_UNAVAILABLE', 'RECOGNIZE_FAILED', 'INTERNAL_ERROR']);

export type VbeeSttOptions = {
  appId: string;
  token: string;
  /** mặc định wss://api.vbee.vn/v1/stt/realtime; test trỏ về máy chủ WebSocket cục bộ */
  baseUrl?: string;
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
};

export function buildVbeeSttUrl(o: Pick<VbeeSttOptions, 'appId' | 'token' | 'baseUrl'>): string {
  const q = new URLSearchParams({ token: o.token, appId: o.appId });
  return `${o.baseUrl ?? VBEE_STT_URL}?${q.toString()}`;
}

export function buildVbeeStreamingConfig(o: SttOpenOptions): Record<string, unknown> {
  const speechCompleteTimeoutMs = Math.min(SPEECH_COMPLETE_RANGE.max, Math.max(SPEECH_COMPLETE_RANGE.min, Math.round(o.utteranceEndMs)));
  return {
    type: 'STREAMING_CONFIG',
    config: {
      sampleRateHertz: o.sampleRate,
      sampleSizeByte: 2,
      channel: 1,
      interimResults: true,
      vadConfig: { noInputTimeoutMs: NO_INPUT_TIMEOUT_MS, speechCompleteTimeoutMs },
    },
  };
}

export function buildVbeeAudioMessage(chunk: Uint8Array): string {
  return JSON.stringify({ type: 'AUDIO_CHUNK', audioContent: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
}

export type VbeeIncoming =
  | { type: 'READY' }
  | { type: 'INTERIM_RESULT'; text: string }
  | { type: 'FINAL_RESULT'; text: string; confidence: number; speech: boolean }
  | { type: 'STREAM_END' }
  | { type: 'PONG' }
  | { type: 'ERROR'; code: string; retryable: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Đọc một khung văn bản của Vbee; null nếu không đúng dạng hoặc loại không dùng. Không bao giờ ném lỗi. */
export function readVbeeMessage(raw: string): VbeeIncoming | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg)) return null;
  switch (msg.type) {
    case 'READY':
      return { type: 'READY' };
    case 'INTERIM_RESULT':
      return { type: 'INTERIM_RESULT', text: str(msg.text) };
    case 'FINAL_RESULT': {
      // Chữ thô (`textRaw`) trước, vì câu chuẩn của bài đo là chữ đọc ra, không phải chữ đã định dạng số.
      const text = str(msg.textRaw) || str(msg.text);
      return {
        type: 'FINAL_RESULT',
        text,
        confidence: typeof msg.confidenceScore === 'number' ? msg.confidenceScore : 0,
        speech: msg.speechType !== 'no-speech',
      };
    }
    case 'STREAM_END':
      return { type: 'STREAM_END' };
    case 'PONG':
      return { type: 'PONG' };
    case 'ERROR': {
      // Chỉ nhận mã dạng CHỮ_HOA_GẠCH_DƯỚI; không chuyển tiếp `message` (có thể chứa nội dung ngoài ý muốn).
      const code = /^[A-Z0-9_]{1,40}$/.test(str(msg.code)) ? str(msg.code) : 'UNKNOWN';
      return { type: 'ERROR', code, retryable: RETRYABLE_CODES.has(code) };
    }
    default:
      return null;
  }
}

class Emitter {
  private readonly listeners: { [E in SttEventName]: SttListener<E>[] } = { interim: [], final: [], utteranceEnd: [], error: [] };

  on<E extends SttEventName>(event: E, cb: SttListener<E>): void {
    (this.listeners[event] as SttListener<E>[]).push(cb);
  }

  emit<E extends SttEventName>(e: Extract<SttEvent, { type: E }>): void {
    for (const cb of this.listeners[e.type as E] as SttListener<E>[]) cb(e);
  }
}

class VbeeSession implements SttSession {
  private readonly emitter = new Emitter();
  private isReady = false;
  private closing = false;
  private readonly closed: Promise<void>;
  readonly ready: Promise<void>;
  private resolveReady: () => void = () => {};
  private rejectReady: (reason: Error) => void = () => {};

  constructor(
    private readonly ws: WebSocket,
    streamingConfig: Record<string, unknown>,
    private readonly closeTimeoutMs: number,
  ) {
    this.closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    ws.on('open', () => ws.send(JSON.stringify(streamingConfig)));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.onMessage(String(data));
    });
    ws.on('error', () => {
      if (!this.isReady) this.rejectReady(new Error('stt_open_failed'));
      else if (!this.closing) this.emitter.emit({ type: 'error', code: 'stt_socket_error', retryable: true });
    });
    ws.on('close', (code) => {
      if (!this.isReady) this.rejectReady(new Error('stt_open_failed'));
      else if (!this.closing) this.emitter.emit({ type: 'error', code: `stt_closed_${code}`, retryable: true });
    });
  }

  /** Huỷ lúc đang mở kết nối (quá hạn đợi READY). */
  failOpen(reason: string): void {
    this.rejectReady(new Error(reason));
    this.ws.terminate();
  }

  private onMessage(raw: string): void {
    const msg = readVbeeMessage(raw);
    if (!msg) return;
    if (msg.type === 'READY') {
      this.isReady = true;
      this.resolveReady();
    } else if (msg.type === 'ERROR') {
      // Lỗi xác thực và cấu hình đến TRƯỚC `READY`: báo lỗi mở phiên kèm mã (mã không nhạy cảm, không có địa chỉ).
      if (!this.isReady) this.rejectReady(new Error(`stt_open_failed_${msg.code.toLowerCase()}`));
      else this.emitter.emit({ type: 'error', code: `stt_vbee_${msg.code.toLowerCase()}`, retryable: msg.retryable });
    } else if (!this.isReady) {
      // Ngoài READY và ERROR, mọi thứ khác trước READY là bất thường: bỏ qua.
    } else if (msg.type === 'INTERIM_RESULT') {
      if (msg.text) this.emitter.emit({ type: 'interim', text: msg.text });
    } else if (msg.type === 'FINAL_RESULT') {
      if (msg.text && msg.speech) {
        this.emitter.emit({ type: 'final', text: msg.text, confidence: msg.confidence });
        this.emitter.emit({ type: 'utteranceEnd' });
      }
    }
    // STREAM_END và PONG: không cần làm gì; máy chủ tự đóng kết nối sau STREAM_END.
  }

  on<E extends SttEventName>(event: E, cb: SttListener<E>): void {
    this.emitter.on(event, cb);
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN && this.isReady && !this.closing) this.ws.send(buildVbeeAudioMessage(chunk));
  }

  keepAlive(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'PING' }));
  }

  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'DONE' }));
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

/** Vbee STT streaming. Chưa gọi thật lần nào; xem ghi chú đầu tệp. */
export class VbeeStt implements SttProvider {
  constructor(private readonly opts: VbeeSttOptions) {
    if (!opts.appId || !opts.token) throw new Error('VbeeStt: thiếu VBEE_APP_ID hoặc VBEE_TOKEN');
  }

  async open(o: SttOpenOptions): Promise<SttSession> {
    const openTimeoutMs = this.opts.openTimeoutMs ?? 5000;
    const ws = new WebSocket(buildVbeeSttUrl(this.opts), { handshakeTimeout: openTimeoutMs });
    const session = new VbeeSession(ws, buildVbeeStreamingConfig(o), this.opts.closeTimeoutMs ?? 3000);
    const timer = setTimeout(() => session.failOpen('stt_open_timeout'), openTimeoutMs);
    try {
      await session.ready;
    } catch (err) {
      ws.terminate();
      // `ready` chỉ bị từ chối bằng các lỗi do chính tệp này tạo ('stt_open_failed', 'stt_open_timeout', 'stt_open_failed_<mã>'),
      // không bao giờ bằng lỗi gốc của `ws` (có thể chứa địa chỉ kèm token), nên ném lại nguyên văn là an toàn.
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return session;
  }
}
