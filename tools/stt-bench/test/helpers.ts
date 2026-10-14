/**
 * Đồ dùng chung cho test: đồng hồ ảo (để kiểm độ trễ chính xác từng mili giây mà không chờ thật), nhà cung cấp STT giả có
 * hẹn giờ, và dựng câu mẫu. Không có gì ở đây gọi mạng.
 */
import type { SttEvent, SttEventName, SttListener, SttOpenOptions, SttProvider, SttSession } from '@mihato/providers';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchConfig } from '../src/configs';
import type { ManifestItem } from '../src/manifest';
import type { Clock, LoadedItem, RunSettings } from '../src/runner';

export const FIXTURES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures');
export const FIXTURE_MANIFEST = join(FIXTURES_DIR, 'manifest.json');

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Đồng hồ ảo: `sleep` chỉ xong khi `drive` đẩy thời gian tới hạn của nó. Thời gian ảo không trôi nếu không ai ngủ. */
export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: { at: number; seq: number; resolve: () => void }[] = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = { at: this.t + Math.max(0, ms), seq: this.seq++, resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((x) => x !== timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Chạy tới khi `p` xong: sau mỗi lượt xử lý hết tác vụ chờ, đánh thức hẹn giờ sớm nhất. */
  async drive<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    const wrapped = p.finally(() => {
      settled = true;
    });
    wrapped.catch(() => {});
    for (let guard = 0; guard < 2_000_000; guard++) {
      await tick();
      if (settled) break;
      const next = [...this.timers].sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) {
        await tick();
        if (settled) break;
        throw new Error('Đồng hồ ảo: còn việc chờ mà không có hẹn giờ nào (treo)');
      }
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    return wrapped;
  }
}

export type SessionApi = {
  clock: VirtualClock;
  /** tổng số byte âm thanh phiên đã nhận */
  bytes(): number;
  emit(event: SttEvent): void;
  /** hẹn phát sự kiện sau `ms` mili giây ảo */
  later(ms: number, fn: () => void): void;
};

export type TimedSttBehavior = {
  /** ném lỗi để mô phỏng không mở được phiên */
  onOpen?: (o: SttOpenOptions) => void;
  /** gọi sau MỖI khung âm thanh nhận được (đã cộng vào bytes) */
  onAudio?: (api: SessionApi) => void;
  onClose?: (api: SessionApi) => void;
};

export type TimedSessionRecord = { options: SttOpenOptions; bytes: number; chunks: number; keepAlives: number; closed: boolean };

/** Nhà cung cấp STT giả có hẹn giờ, để dựng đúng kịch bản "nhà cung cấp chốt sau X mili giây". */
export class TimedStt implements SttProvider {
  readonly sessions: TimedSessionRecord[] = [];

  constructor(
    private readonly clock: VirtualClock,
    private readonly behavior: TimedSttBehavior = {},
  ) {}

  async open(o: SttOpenOptions): Promise<SttSession> {
    this.behavior.onOpen?.(o);
    const record: TimedSessionRecord = { options: { ...o, keyterms: [...o.keyterms] }, bytes: 0, chunks: 0, keepAlives: 0, closed: false };
    this.sessions.push(record);
    const listeners: { [E in SttEventName]: SttListener<E>[] } = { interim: [], final: [], utteranceEnd: [], error: [] };
    const emit = (e: SttEvent) => {
      for (const cb of listeners[e.type] as SttListener<typeof e.type>[]) (cb as (x: SttEvent) => void)(e);
    };
    const api: SessionApi = {
      clock: this.clock,
      bytes: () => record.bytes,
      emit,
      later: (ms, fn) => void this.clock.sleep(ms).then(fn),
    };
    const behavior = this.behavior;
    return {
      sendAudio(chunk) {
        if (record.closed) return;
        record.bytes += chunk.byteLength;
        record.chunks += 1;
        behavior.onAudio?.(api);
      },
      on(event, cb) {
        (listeners[event] as SttListener<typeof event>[]).push(cb);
      },
      keepAlive() {
        record.keepAlives += 1;
      },
      async close() {
        if (record.closed) return;
        behavior.onClose?.(api);
        record.closed = true;
      },
    };
  }
}

export function configFor(provider: SttProvider | ((item: ManifestItem) => SttProvider), over: Partial<BenchConfig> = {}): BenchConfig {
  return {
    id: 'fake',
    label: 'Cấu hình thử',
    real: false,
    usdPerMinute: 0,
    sendKeyterms: false,
    maxSessionMs: null,
    utteranceEndRangeMs: { min: 1, max: 60_000 },
    createProvider: (ctx) => (typeof provider === 'function' ? provider(ctx.item) : provider),
    ...over,
  };
}

export function makeItem(over: Partial<ManifestItem> = {}): ManifestItem {
  return {
    id: 't1',
    file: 't1.wav',
    speaker: 'S01',
    reference: 'đi thúc anh Tuấn',
    entities: { people: [], amountsVnd: [], dates: [] },
    ...over,
  };
}

/** Âm thanh im lặng `ms` mili giây (nội dung không quan trọng với bản giả) và điểm hết tiếng cho trước. */
export function makeLoaded(ms: number, speechEndMs: number | null, item: ManifestItem = makeItem()): LoadedItem {
  return { item, pcm: new Uint8Array(ms * 32), speechEndMs };
}

export const SETTINGS: RunSettings = { chunkMs: 100, speed: 1, endMode: 'utterance-end', speechEnd: 'vad', concurrency: 1, closeTimeoutMs: 5000 };

export function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    get out() {
      return out.join('');
    },
    get err() {
      return err.join('');
    },
  };
}
