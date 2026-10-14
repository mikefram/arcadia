/**
 * Đọc thành tiếng (SPEC 6.4, 6.9). Hai chế độ:
 *  - `synthesize`: câu trả lời tương tác, tối đa 300 ký tự mỗi lần gọi, âm thanh trả về theo khối.
 *    Bên gọi tự tách câu (`splitForTts` ở @mihato/domain/vi-speak) và đổi số thành chữ (`toSpeakable`) trước.
 *  - `synthesizeBatch`: bản tin sáng dựng sẵn, trả liên kết tệp âm thanh có hạn.
 * Văn bản gửi TTS không được chứa số điện thoại hay thư điện tử (SPEC 6.4, 6.8): bên gọi chạy `redact()` trước.
 */
export type TtsFormat = 'mp3' | 'pcm';

export type TtsSynthesizeOptions = {
  voice: string;
  /** 0.25 đến 1.9; mặc định của app là 0.9 */
  speed: number;
  format: TtsFormat;
  /** dừng ngay khi người dùng ngắt lời hoặc ngắt kết nối */
  signal?: AbortSignal;
};

export type TtsBatchOptions = { voice: string; speed: number };

export interface TtsProvider {
  synthesize(text: string, o: TtsSynthesizeOptions): AsyncIterable<Uint8Array>;
  synthesizeBatch(text: string, o: TtsBatchOptions): Promise<{ url: string; expiresAt: Date }>;
}

/** Giới hạn của chế độ `sync` (SPEC 6.4). */
export const TTS_SYNC_MAX_CHARS = 300;
/** Giới hạn của chế độ `async` (SPEC 6.4). */
export const TTS_BATCH_MAX_CHARS = 100_000;

const clampSpeed = (speed: number) => Math.min(1.9, Math.max(0.25, Number.isFinite(speed) ? speed : 0.9));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ───────────────────────── Vbee ─────────────────────────

export type VbeeTtsOptions = {
  appId: string;
  token: string;
  /** mặc định https://api.vbee.vn */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** tần số lấy mẫu của âm thanh trả về (8000 đến 48000 Hz) */
  sampleRate?: number;
  /** hỏi lại kết quả batch: khoảng cách và số lần tối đa */
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
};

export type VbeeMode = 'sync' | 'async';

/**
 * Thân yêu cầu `POST /v1/tts`.
 *
 * [CHƯA XÁC MINH] TÊN TRƯỜNG. SPEC 6.4 chỉ xác minh được: địa chỉ, hai header (`Authorization: Bearer`, `App-Id`),
 * `mode: "sync" | "async"`, giới hạn ký tự, `speed` 0.25 đến 1.9, định dạng mp3, wav, pcm, tần số 8000 đến 48000 Hz,
 * `webhookUrl` cho batch. Tên các trường `text`, `voiceCode`, `audioType`, `sampleRate` dưới đây là GIẢ ĐỊNH.
 * PHẢI mở lại tài liệu gốc ở SPEC mục 17 (api-docs.vbee.vn: realtime-api, batch-api) và sửa hàm này trước khi
 * gọi Vbee thật. Mọi chỗ phụ thuộc tên trường đều gom ở đây và ở `readVbeeBatch`.
 */
export function buildVbeeBody(text: string, o: { voice: string; speed: number; mode: VbeeMode; format: 'mp3' | 'pcm' | 'wav'; sampleRate: number }): Record<string, unknown> {
  return {
    mode: o.mode,
    text,
    voiceCode: o.voice,
    speed: clampSpeed(o.speed),
    audioType: o.format,
    sampleRate: o.sampleRate,
  };
}

/**
 * Đọc phản hồi của chế độ batch. [CHƯA XÁC MINH] tên trường: thử các tên hay gặp, ở gốc hoặc trong `result`.
 * Mở lại tài liệu batch-api (SPEC mục 17) trước khi dùng thật.
 */
export function readVbeeBatch(json: unknown): { requestId: string | null; status: string | null; audioUrl: string | null } {
  const root = isRecord(json) ? json : {};
  const inner = isRecord(root.result) ? root.result : isRecord(root.data) ? root.data : root;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = inner[k] ?? root[k];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  };
  return {
    requestId: pick('requestId', 'request_id', 'id'),
    status: pick('status', 'state'),
    audioUrl: pick('audioUrl', 'audioLink', 'audio_link', 'audio_url', 'url'),
  };
}

/** Liên kết âm thanh của Vbee sống 3 phút (SPEC 6.4). */
const VBEE_LINK_TTL_MS = 3 * 60_000;

/**
 * Vbee AIVoice API (SPEC 6.4). Token chỉ nằm ở máy chủ, không đưa xuống app.
 * Chưa được gọi thật lần nào (không có token trong phiên dựng mã); test dùng `fetch` giả.
 * [CHƯA XÁC MINH] ngoài tên trường: giọng nào chạy được ở chế độ sync (tài liệu nêu Ngọc Huyền và Mai Phương,
 * bản cập nhật 04/2026 chỉ nêu Ngọc Huyền), bảng giá hiện hành, nơi đặt máy chủ.
 */
export class VbeeTts implements TtsProvider {
  private readonly baseUrl: string;

  constructor(private readonly opts: VbeeTtsOptions) {
    if (!opts.appId || !opts.token) throw new Error('VbeeTts: thiếu VBEE_APP_ID hoặc VBEE_TOKEN');
    this.baseUrl = (opts.baseUrl ?? 'https://api.vbee.vn').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}`, 'App-Id': this.opts.appId, 'Content-Type': 'application/json' };
  }

  async *synthesize(text: string, o: TtsSynthesizeOptions): AsyncIterable<Uint8Array> {
    if (text.length > TTS_SYNC_MAX_CHARS) throw new RangeError(`Chế độ sync nhận tối đa ${TTS_SYNC_MAX_CHARS} ký tự mỗi yêu cầu`);
    if (!text.trim()) return;
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.baseUrl}/v1/tts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(buildVbeeBody(text, { voice: o.voice, speed: o.speed, mode: 'sync', format: o.format, sampleRate: this.opts.sampleRate ?? 24000 })),
      signal: o.signal,
    });
    if (!res.ok || !res.body) throw new Error(`tts_http_${res.status}`);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield value;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async synthesizeBatch(text: string, o: TtsBatchOptions): Promise<{ url: string; expiresAt: Date }> {
    if (text.length > TTS_BATCH_MAX_CHARS) throw new RangeError(`Chế độ async nhận tối đa ${TTS_BATCH_MAX_CHARS} ký tự`);
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.baseUrl}/v1/tts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(buildVbeeBody(text, { voice: o.voice, speed: o.speed, mode: 'async', format: 'mp3', sampleRate: this.opts.sampleRate ?? 24000 })),
    });
    if (!res.ok) throw new Error(`tts_http_${res.status}`);
    const created = readVbeeBatch(await res.json());
    if (created.audioUrl) return { url: created.audioUrl, expiresAt: new Date(Date.now() + VBEE_LINK_TTL_MS) };
    if (!created.requestId) throw new Error('tts_batch_no_request_id');

    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxAttempts = this.opts.pollMaxAttempts ?? 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, interval));
      const poll = await doFetch(`${this.baseUrl}/v1/tts/requests/${encodeURIComponent(created.requestId)}`, { headers: this.headers() });
      if (!poll.ok) throw new Error(`tts_http_${poll.status}`);
      const state = readVbeeBatch(await poll.json());
      if (state.audioUrl) return { url: state.audioUrl, expiresAt: new Date(Date.now() + VBEE_LINK_TTL_MS) };
      if (state.status && /fail|error/i.test(state.status)) throw new Error('tts_batch_failed');
    }
    throw new Error('tts_batch_timeout');
  }
}

// ───────────────────────── Bản giả ─────────────────────────

export type FakeTtsCall = { text: string; voice: string; speed: number; format: TtsFormat | 'batch' };

export type FakeTtsOptions = {
  /** trễ trước byte đầu (để kiểm ngưỡng 3 giây) */
  firstByteDelayMs?: number;
  /** trễ giữa các khối (để kiểm ngắt lời giữa chừng) */
  chunkDelayMs?: number;
  /** số byte mỗi khối */
  chunkBytes?: number;
};

/** Chờ `ms` mili giây; trả `false` nếu bị huỷ giữa chừng. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * TTS giả (SPEC 6.9, 13.1): trả vài khối byte tất định theo độ dài văn bản và ghi lại văn bản đã "đọc".
 * Khối đầu mở bằng hai byte đồng bộ của khung mp3 (0xFF 0xFB) để dễ nhận ra khi gỡ lỗi; phần còn lại không phải âm thanh thật.
 */
export class FakeTts implements TtsProvider {
  readonly spoken: FakeTtsCall[] = [];
  /** số lần gọi kế tiếp sẽ lỗi (để kiểm `tts_unavailable`) */
  failNext = 0;

  constructor(private readonly opts: FakeTtsOptions = {}) {}

  /** Số khối của một đoạn: một khối cho mỗi 100 ký tự, ít nhất 1, nhiều nhất 4. */
  static chunkCount(text: string): number {
    return Math.min(4, Math.max(1, Math.ceil(text.length / 100)));
  }

  private chunk(text: string, index: number): Uint8Array {
    const size = this.opts.chunkBytes ?? 64;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = (text.charCodeAt((index * size + i) % Math.max(1, text.length)) + index * 31 + i) & 0xff;
    if (index === 0 && size >= 2) {
      out[0] = 0xff;
      out[1] = 0xfb;
    }
    return out;
  }

  async *synthesize(text: string, o: TtsSynthesizeOptions): AsyncIterable<Uint8Array> {
    if (text.length > TTS_SYNC_MAX_CHARS) throw new RangeError(`Chế độ sync nhận tối đa ${TTS_SYNC_MAX_CHARS} ký tự mỗi yêu cầu`);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('tts_fake_error');
    }
    this.spoken.push({ text, voice: o.voice, speed: o.speed, format: o.format });
    if (this.opts.firstByteDelayMs && !(await sleep(this.opts.firstByteDelayMs, o.signal))) return;
    const n = FakeTts.chunkCount(text);
    for (let i = 0; i < n; i++) {
      if (o.signal?.aborted) return;
      if (i > 0 && this.opts.chunkDelayMs && !(await sleep(this.opts.chunkDelayMs, o.signal))) return;
      yield this.chunk(text, i);
    }
  }

  async synthesizeBatch(text: string, o: TtsBatchOptions): Promise<{ url: string; expiresAt: Date }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('tts_fake_error');
    }
    this.spoken.push({ text, voice: o.voice, speed: o.speed, format: 'batch' });
    return { url: `https://tts.fake.invalid/audio/${this.spoken.length}.mp3`, expiresAt: new Date(Date.now() + VBEE_LINK_TTL_MS) };
  }

  reset(): void {
    this.spoken.length = 0;
    this.failNext = 0;
  }
}
