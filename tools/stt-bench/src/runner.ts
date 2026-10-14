/**
 * Chạy bộ ghi âm qua một cấu hình STT, mỗi câu một phiên, MÔ PHỎNG HÀNH VI CỦA `scribe` (apps/scribe/src/session.ts):
 *  - phát khung âm thanh như micro: khung thứ k chỉ có sau khi đã "thu" xong k+1 khung (theo `--speed`);
 *  - `final` được gom lại (nối bằng dấu cách) thành kết quả của lượt nói;
 *  - gặp `utteranceEnd` là CHỐT LƯỢT: ngừng gửi âm thanh, `close()` để nhà cung cấp trả nốt đoạn chốt, rồi mới chấm.
 *    Vì thế một `utteranceEnd` tới giữa câu làm mất phần sau của câu: ảnh hưởng lên cả WER và các số đo tên, tiền, ngày;
 *  - hết tệp mà chưa có `utteranceEnd` (`endMode: 'utterance-end'`) thì gửi tiếp khung im lặng cho tới khi nhà cung cấp báo
 *    hết câu, tối đa `utterance_end_ms` + TAIL_MARGIN_MS, rồi mới `close()`. Đây là đường rảnh tay của SPEC 6.1 bước 3.
 *    `endMode: 'close'` thì đóng ngay khi hết tệp (đường người dùng nhả nút micro), rẻ hơn nhưng không đo được `utterance_end_ms`.
 *
 * Nhật ký và tiến độ chỉ có đếm và mã; không bao giờ chứa văn bản câu nói hay khoá (CLAUDE.md luật 6).
 */
import type { SttSession } from '@mihato/providers';
import { AudioError, chunkPcm, detectSpeechEndMs, frameBytes, loadAudioFile, silenceChunk } from './audio';
import { TAIL_MARGIN_MS, type BenchConfig, type EndMode } from './configs';
import { itemGroups, resolveAudioPath, type Manifest, type ManifestItem } from './manifest';
import { computeLatencyMs, countEarlyEvents, scoreItem, type ItemStatus, type ScoreContext, type ScoredItem, type TimedEvent } from './metrics';

// ───────────────────────── Đồng hồ ─────────────────────────

export interface Clock {
  /** mốc đơn điệu, mili giây */
  now(): number;
  /** chờ `ms` mili giây; `signal` bị huỷ thì xong ngay */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

// ───────────────────────── Nạp bộ ghi âm ─────────────────────────

export type LoadedItem = {
  item: ManifestItem;
  pcm: Uint8Array;
  /** mili giây từ đầu tệp tới hết tiếng nói theo bộ dò năng lượng; null nếu cả tệp là im lặng */
  speechEndMs: number | null;
};

/** Đọc mọi tệp âm thanh TRƯỚC khi gọi nhà cung cấp nào, để lỗi tệp hiện ra khi chưa tốn đồng nào. */
export function loadItems(manifest: Manifest, baseDir: string): { items: LoadedItem[]; problems: string[] } {
  const items: LoadedItem[] = [];
  const problems: string[] = [];
  for (const item of manifest.items) {
    try {
      const pcm = loadAudioFile(resolveAudioPath(baseDir, item.file));
      items.push({ item, pcm, speechEndMs: detectSpeechEndMs(pcm) });
    } catch (err) {
      problems.push(`${item.id}: ${err instanceof AudioError ? err.message : 'không đọc được tệp âm thanh'}`);
    }
  }
  return { items, problems };
}

// ───────────────────────── Một lượt chạy ─────────────────────────

export type RunSettings = {
  chunkMs: number;
  /** 1 = thời gian thực; N = nhanh gấp N; Infinity = không chờ. Độ trễ chỉ có nghĩa khi bằng 1 */
  speed: number;
  endMode: EndMode;
  /** 'vad': tìm điểm hết tiếng nói bằng năng lượng; 'audio': coi hết tệp là hết tiếng */
  speechEnd: 'vad' | 'audio';
  /** số câu chạy song song (mỗi câu vẫn phát theo thời gian riêng của nó) */
  concurrency: number;
  /** đợi `close()` tối đa chừng này mili giây (đồng hồ thật) */
  closeTimeoutMs: number;
};

export const DEFAULT_SETTINGS: RunSettings = { chunkMs: 100, speed: 1, endMode: 'utterance-end', speechEnd: 'vad', concurrency: 1, closeTimeoutMs: 5000 };

export type ItemOutcome = {
  id: string;
  speaker: string;
  file: string;
  reference: string;
  /** kết quả chốt: các `final` nối lại; rỗng nếu phiên lỗi */
  hypothesis: string;
  /** độ tin cậy cả câu: trung bình các `final` theo độ dài chữ, như scribe tính; null nếu không có kết quả. Để chọn ngưỡng tin cậy (SPEC 6.6) */
  confidence: number | null;
  errorCode: string | null;
  finals: number;
  interims: number;
  /** thời gian khung im lặng đã gửi thêm sau khi hết tệp, mili giây */
  tailMs: number;
  closeTimedOut: boolean;
  scored: ScoredItem;
};

export type PassResult = {
  configId: BenchConfig['id'];
  label: string;
  real: boolean;
  usdPerMinute: number | null;
  utteranceEndMs: number;
  outcomes: ItemOutcome[];
};

export type PassOptions = {
  config: BenchConfig;
  utteranceEndMs: number;
  items: readonly LoadedItem[];
  /** danh sách keyterm của cả manifest; chỉ gửi nếu cấu hình có `sendKeyterms` */
  keyterms: readonly string[];
  settings: RunSettings;
  score: ScoreContext;
  clock?: Clock;
  onProgress?: (done: number, total: number) => void;
};

/** Mã lỗi an toàn để ghi nhật ký: chỉ chữ, số, gạch; còn lại coi là không rõ. */
export function safeCode(value: unknown, fallback: string): string {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : fallback;
}

export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

type FinishParts = Partial<Omit<ItemOutcome, 'scored'>> & { scored?: Partial<ScoredItem> };

async function runItem(opts: PassOptions, loaded: LoadedItem, clock: Clock): Promise<ItemOutcome> {
  const { config, settings, utteranceEndMs } = opts;
  const { item, pcm } = loaded;
  const chunks = chunkPcm(pcm, settings.chunkMs);
  const frame = frameBytes(settings.chunkMs);
  const lastFrame = chunks.length - 1;
  const useVad = settings.speechEnd === 'vad' && loaded.speechEndMs !== null;
  const speechEndFrame = useVad ? Math.min(lastFrame, Math.max(0, Math.ceil((loaded.speechEndMs as number) / settings.chunkMs) - 1)) : lastFrame;
  const speechEndBytes = useVad ? Math.min(pcm.byteLength, (speechEndFrame + 1) * frame) : null;

  const finish = (hypothesis: string, status: ItemStatus, parts: FinishParts = {}): ItemOutcome => {
    const score = scoreItem(item, status === 'failed' ? '' : hypothesis, opts.score);
    const { scored: extra, ...rest } = parts;
    return {
      id: item.id,
      speaker: item.speaker,
      file: item.file,
      reference: item.reference,
      hypothesis: status === 'failed' ? '' : hypothesis,
      confidence: null,
      errorCode: null,
      finals: 0,
      interims: 0,
      tailMs: 0,
      closeTimedOut: false,
      ...rest,
      scored: { id: item.id, speaker: item.speaker, groups: itemGroups(item), status, score, latencyMs: null, earlyUtteranceEnds: 0, earlyFinals: 0, bytesSent: 0, ...extra },
    };
  };

  const keyterms = config.sendKeyterms ? [...opts.keyterms] : [];
  let session: SttSession;
  try {
    session = await config.createProvider({ item, audioBytes: pcm.byteLength, chunkMs: settings.chunkMs }).open({ language: 'vi', sampleRate: 16000, keyterms, utteranceEndMs });
  } catch (err) {
    return finish('', 'failed', { errorCode: safeCode(err, 'stt_open_failed') });
  }

  // Trạng thái đổi bên trong các hàm gọi lại, gom vào một đối tượng để kiểu không bị thu hẹp sai.
  const st = { sentBytes: 0, frameNo: 0, tailFrames: 0, interims: 0, speechEndSentAt: null as number | null, utteranceEndSeen: false, errorCode: null as string | null };
  const events: TimedEvent[] = [];
  const finals: string[] = [];
  const weights: { length: number; confidence: number }[] = [];
  session.on('interim', () => {
    st.interims += 1;
    events.push({ type: 'interim', atMs: clock.now(), sentBytes: st.sentBytes });
  });
  session.on('final', (e) => {
    finals.push(e.text.trim());
    weights.push({ length: e.text.length, confidence: e.confidence });
    events.push({ type: 'final', atMs: clock.now(), sentBytes: st.sentBytes });
  });
  session.on('utteranceEnd', () => {
    st.utteranceEndSeen = true;
    events.push({ type: 'utteranceEnd', atMs: clock.now(), sentBytes: st.sentBytes });
  });
  session.on('error', (e) => {
    st.errorCode ??= safeCode(e.code, 'stt_error');
  });

  const t0 = clock.now();
  /** Phát một khung đúng giờ. Trả false nếu phải dừng (đã chốt lượt hoặc lỗi), như `onAudio` của scribe bỏ khung sau khi chốt. */
  const send = async (chunk: Uint8Array, fromFile: boolean): Promise<boolean> => {
    const due = settings.speed === Infinity ? 0 : ((st.frameNo + 1) * settings.chunkMs) / settings.speed;
    await clock.sleep(Math.max(0, t0 + due - clock.now()));
    if (st.utteranceEndSeen || st.errorCode !== null) return false;
    // Cộng trước khi gửi: bản giả có thể phát sự kiện ngay trong sendAudio, lúc đó khung này đã được tính là gửi.
    st.sentBytes += chunk.byteLength;
    if (fromFile && st.frameNo === speechEndFrame) st.speechEndSentAt = clock.now();
    if (!fromFile) st.tailFrames += 1;
    st.frameNo += 1;
    session.sendAudio(chunk);
    return true;
  };

  try {
    let sending = true;
    for (const chunk of chunks) {
      sending = await send(chunk, true);
      if (!sending) break;
    }
    if (sending && settings.endMode === 'utterance-end') {
      const silence = silenceChunk(settings.chunkMs);
      const maxTail = Math.floor((utteranceEndMs + TAIL_MARGIN_MS) / settings.chunkMs);
      for (let k = 0; k < maxTail; k++) if (!(await send(silence, false))) break;
    }
  } catch {
    st.errorCode ??= 'stt_send_failed';
  }

  // Đóng phiên để nhà cung cấp trả nốt các đoạn chốt còn lại, nhưng không đợi vô hạn.
  let closeTimedOut = false;
  const abort = new AbortController();
  try {
    const closed = session.close().then(() => 'closed' as const);
    const timeout = clock.sleep(settings.closeTimeoutMs, abort.signal).then(() => 'timeout' as const);
    closeTimedOut = (await Promise.race([closed, timeout])) === 'timeout';
  } catch {
    st.errorCode ??= 'stt_close_failed';
  }
  abort.abort();

  const hypothesis = finals.filter(Boolean).join(' ').trim();
  const status: ItemStatus = st.errorCode !== null ? 'failed' : finals.some(Boolean) ? 'ok' : 'no_result';
  const early = countEarlyEvents(events, { audioBytes: pcm.byteLength, speechEndBytes });
  const totalLength = weights.reduce((n, w) => n + w.length, 0);
  const confidence = status === 'failed' || totalLength === 0 ? null : Math.round((weights.reduce((n, w) => n + w.confidence * w.length, 0) / totalLength) * 1000) / 1000;
  return finish(hypothesis, status, {
    confidence,
    errorCode: st.errorCode,
    finals: finals.length,
    interims: st.interims,
    tailMs: st.tailFrames * settings.chunkMs,
    closeTimedOut,
    scored: {
      latencyMs: status === 'failed' ? null : computeLatencyMs(events, st.speechEndSentAt),
      earlyUtteranceEnds: early.earlyUtteranceEnds,
      earlyFinals: early.earlyFinals,
      bytesSent: st.sentBytes,
    },
  });
}

/** Chạy toàn bộ bộ ghi âm qua một cấu hình với một giá trị `utterance_end_ms`. */
export async function runPass(opts: PassOptions): Promise<PassResult> {
  const clock = opts.clock ?? realClock;
  let done = 0;
  const outcomes = await mapPool(opts.items, opts.settings.concurrency, async (loaded) => {
    const outcome = await runItem(opts, loaded, clock);
    done += 1;
    opts.onProgress?.(done, opts.items.length);
    return outcome;
  });
  return { configId: opts.config.id, label: opts.config.label, real: opts.config.real, usdPerMinute: opts.config.usdPerMinute, utteranceEndMs: opts.utteranceEndMs, outcomes };
}

export type BenchRequest = {
  configs: readonly BenchConfig[];
  /** giá trị `utterance_end_ms` cần quét; mỗi giá trị là một lượt chạy riêng cho mỗi cấu hình */
  utteranceEndValues: readonly number[];
  items: readonly LoadedItem[];
  keyterms: readonly string[];
  settings: RunSettings;
  score: ScoreContext;
  clock?: Clock;
  onPassStart?: (config: BenchConfig, utteranceEndMs: number) => void;
  onProgress?: (done: number, total: number) => void;
};

/** Lần lượt từng cấu hình, từng giá trị `utterance_end_ms` (các lượt chạy không chồng nhau để số đo không nhiễu). */
export async function runBench(req: BenchRequest): Promise<PassResult[]> {
  const passes: PassResult[] = [];
  for (const config of req.configs) {
    for (const utteranceEndMs of req.utteranceEndValues) {
      req.onPassStart?.(config, utteranceEndMs);
      passes.push(await runPass({ config, utteranceEndMs, items: req.items, keyterms: req.keyterms, settings: req.settings, score: req.score, clock: req.clock, onProgress: req.onProgress }));
    }
  }
  return passes;
}

/** Số byte tối đa một câu có thể gửi (tệp + đuôi im lặng), để đối chiếu với kế hoạch và trần phút. */
export function maxBytesFor(audioBytes: number, utteranceEndMs: number, settings: RunSettings): number {
  if (settings.endMode !== 'utterance-end') return audioBytes;
  return audioBytes + Math.floor((utteranceEndMs + TAIL_MARGIN_MS) / settings.chunkMs) * frameBytes(settings.chunkMs);
}
