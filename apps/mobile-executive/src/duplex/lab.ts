import { SpeechGate } from './gate';
import { summarize, type Stats } from './stats';
import type { DuplexAudioNative, DuplexFrameEvent, DuplexPlaybackEvent, DuplexStartResult, DuplexStateEvent, Subscription } from './types';

/**
 * Phép đo khử tiếng vọng trên điện thoại thật (docs/DECISIONS.md, "Ngắt lời bằng giọng nói", bước 1 của kế hoạch).
 * Câu hỏi cần trả lời: khi trợ lý đọc bằng loa ngoài, giọng người nói chen vào có cao hơn tiếng loa vọng lại micro
 * đủ nhiều để nhận ra chắc chắn, mà không nhận nhầm tiếng loa là giọng người? Ba bước:
 *   1. yên lặng      → mức nền của phòng
 *   2. trợ lý đọc, người nghe im lặng → mức tiếng vọng còn sót sau khử vọng
 *   3. trợ lý đọc, người nghe nói chen vào sau lời nhắc → mức giọng nói, và nhận ra sau bao lâu
 * Các ngưỡng dưới đây là ước đoán ban đầu, chưa có số đo thật; chỉnh lại sau lần đo đầu tiên.
 */

export const FRAME_MS = 50;
/** Bước 1: giữ yên lặng chừng này. */
export const SILENCE_MS = 5_000;
/** Bước 3: kể từ lúc trợ lý bắt đầu đọc, chừng này thì nhắc người dùng nói chen. */
export const PROMPT_AFTER_MS = 3_000;
/** Bước phát dài nhất cho phép (đoạn mẫu dài 18 giây). Quá thì coi là kẹt. */
export const PHASE_MAX_MS = 40_000;
/** Chờ khung đầu tiên tối đa chừng này theo đồng hồ thật, quá thì coi là micro không ra tiếng. */
export const FIRST_FRAME_WAIT_MS = 8_000;
/** Mỗi bước cần ít nhất chừng này khung (1 giây) mới kết luận được. */
export const MIN_PHASE_FRAMES = 20;
/** Mức loa trên ngưỡng này mới tính là trợ lý đang đọc; bỏ các quãng nghỉ giữa câu. */
export const REFERENCE_AUDIBLE_DB = -60;
/** Giọng nói chen vào phải cao hơn tiếng vọng (mức cao thường gặp) ít nhất chừng này thì "đạt". */
export const PASS_MARGIN_DB = 10;
/** Từ mức này đến PASS_MARGIN_DB là "chưa chắc". */
export const UNSURE_MARGIN_DB = 6;
export const GATE_ATTACK_FRAMES = 3;
export const GATE_RELEASE_FRAMES = 6;
/** Ngưỡng nhận giọng = mức cao thường gặp của tiếng vọng cộng chừng này, và không thấp hơn nền phòng cộng GATE_ABOVE_SILENCE_DB. */
export const GATE_ABOVE_ECHO_DB = 6;
export const GATE_ABOVE_SILENCE_DB = 10;
export const GATE_FLOOR_DB = -60;
const MAX_REPORTS = 6;

export type LabConfig = { voiceProcessing: boolean; voiceChatMode: boolean };
export type LabPoint = { t: number; micDb: number; refDb: number };
export type LabVerdict = 'pass' | 'unsure' | 'fail' | 'incomplete';

export type LabReport = {
  config: LabConfig;
  start: DuplexStartResult;
  /** số khung dùng cho từng bước; echo chỉ tính các khung lúc trợ lý đang đọc, talk chỉ tính sau lời nhắc */
  counts: { silence: number; echo: number; talk: number };
  /** số khung JS nhận được mỗi giây ở bước 1; phải gần 20 (nhận thiếu nghĩa là cầu nối làm rơi khung) */
  cadenceHz: number | null;
  pcmBytes: number;
  silence: Stats | null;
  echo: Stats | null;
  talk: Stats | null;
  /** mức phát ra loa (giữa) lúc trợ lý đọc ở bước 2 */
  referenceP50: number | null;
  /** loa phát bao nhiêu thì micro nghe lại nhỏ hơn bấy nhiêu: gộp đường truyền trong không khí và khử vọng. So hai lần đo bật/tắt khử vọng để biết riêng phần khử vọng. */
  echoLossDb: number | null;
  /** mức cao thường gặp (phân vị 90) của giọng nói chen vào */
  speechP90: number | null;
  /** giọng nói chen vào cao hơn tiếng vọng (phân vị 95) bao nhiêu */
  marginDb: number | null;
  thresholdDb: number | null;
  /** số lần cổng nhận giọng kêu ở bước 2, khi người nghe đang im lặng; phải là 0 */
  falseTriggers: number;
  /** từ lời nhắc đến lúc cổng xác nhận có tiếng nói; gồm cả thời gian người dùng kịp phản ứng */
  triggerDelayMs: number | null;
  verdict: LabVerdict;
};

export type ReportInput = {
  config: LabConfig;
  start: DuplexStartResult;
  silence: readonly LabPoint[];
  echo: readonly LabPoint[];
  talk: readonly LabPoint[];
  /** thời điểm (đồng hồ của mô-đun) hiện lời nhắc nói chen; null nếu chưa tới */
  promptT: number | null;
  /** thời điểm JS nhận từng khung ở bước 1 (đồng hồ JS, mili giây) */
  arrivals: readonly number[];
  pcmBytes: number;
};

function cadence(arrivals: readonly number[]): number | null {
  if (arrivals.length < 2) return null;
  const first = arrivals[0] ?? 0;
  const last = arrivals[arrivals.length - 1] ?? 0;
  return last > first ? ((arrivals.length - 1) / (last - first)) * 1000 : null;
}

/** Dựng báo cáo từ các khung đã thu. Hàm thuần. */
export function buildReport(input: ReportInput): LabReport {
  const echoFrames = input.echo.filter((p) => p.refDb > REFERENCE_AUDIBLE_DB);
  const promptT = input.promptT;
  const talkFrames = promptT === null ? [] : input.talk.filter((p) => p.t >= promptT);

  const silence = summarize(input.silence.map((p) => p.micDb));
  const echo = summarize(echoFrames.map((p) => p.micDb));
  const talk = summarize(talkFrames.map((p) => p.micDb));
  const referenceP50 = summarize(echoFrames.map((p) => p.refDb))?.p50 ?? null;

  const echoLossDb = referenceP50 !== null && echo ? referenceP50 - echo.p50 : null;
  const speechP90 = talk?.p90 ?? null;
  const marginDb = speechP90 !== null && echo ? speechP90 - echo.p95 : null;
  const thresholdDb = echo && silence ? Math.max(echo.p95 + GATE_ABOVE_ECHO_DB, silence.p95 + GATE_ABOVE_SILENCE_DB, GATE_FLOOR_DB) : null;

  let falseTriggers = 0;
  let triggerDelayMs: number | null = null;
  if (thresholdDb !== null) {
    const options = { thresholdDb, attackFrames: GATE_ATTACK_FRAMES, releaseFrames: GATE_RELEASE_FRAMES };
    const quiet = new SpeechGate(options);
    for (const p of input.echo) if (quiet.push(p.micDb) === 'start') falseTriggers += 1;
    if (promptT !== null) {
      // Cổng mới từ lúc có lời nhắc: tiếng vọng lọt qua trước đó không được tính là "đã nhận ra giọng".
      const talking = new SpeechGate(options);
      for (const p of input.talk) {
        if (p.t < promptT) continue;
        if (talking.push(p.micDb) === 'start') {
          triggerDelayMs = Math.max(0, p.t - promptT);
          break;
        }
      }
    }
  }

  let verdict: LabVerdict;
  if (!silence || input.silence.length < MIN_PHASE_FRAMES || echoFrames.length < MIN_PHASE_FRAMES || talkFrames.length < MIN_PHASE_FRAMES || marginDb === null) {
    verdict = 'incomplete';
  } else if (falseTriggers === 0 && triggerDelayMs !== null && marginDb >= PASS_MARGIN_DB) {
    verdict = 'pass';
  } else if (falseTriggers <= 1 && triggerDelayMs !== null && marginDb >= UNSURE_MARGIN_DB) {
    verdict = 'unsure';
  } else {
    verdict = 'fail';
  }

  return {
    config: input.config,
    start: input.start,
    counts: { silence: input.silence.length, echo: echoFrames.length, talk: talkFrames.length },
    cadenceHz: cadence(input.arrivals),
    pcmBytes: input.pcmBytes,
    silence,
    echo,
    talk,
    referenceP50,
    echoLossDb,
    speechP90,
    marginDb,
    thresholdDb,
    falseTriggers,
    triggerDelayMs,
    verdict,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

export type LabPhase = 'idle' | 'starting' | 'silence' | 'echo' | 'talk' | 'done' | 'error';
export type LabErrorCode = 'unavailable' | 'denied' | 'start' | 'stopped' | 'play' | 'timeout' | 'noFrames';

export type LabState = {
  phase: LabPhase;
  /** true từ lúc cần nói chen (bước 3, sau PROMPT_AFTER_MS) */
  prompt: boolean;
  micDb: number | null;
  refDb: number | null;
  frames: number;
  /** thời gian đã qua của bước hiện tại, mili giây, đếm theo khung */
  stepMs: number;
  route: string | null;
  error: { code: LabErrorCode; detail: string } | null;
  /** mới nhất ở đầu */
  reports: readonly LabReport[];
};

export type LabDeps = {
  native: DuplexAudioNative;
  /** Đường dẫn tệp đoạn mẫu tiếng Việt đã nằm trên máy. */
  clipUri: () => Promise<string>;
  requestPermission: () => Promise<boolean>;
  /** Trả phiên âm thanh về chế độ phát sau khi đo (expo-audio dùng lại). */
  restorePlayback: () => Promise<void>;
  now?: () => number;
  /** Hẹn giờ; trả hàm huỷ. Test thay bằng bản không chạy gì. */
  setTimer?: (fn: () => void, ms: number) => () => void;
};

type Run = {
  config: LabConfig;
  start: DuplexStartResult | null;
  clip: string;
  phase: 'silence' | 'echo' | 'talk';
  silence: LabPoint[];
  echo: LabPoint[];
  talk: LabPoint[];
  arrivals: number[];
  playing: boolean;
  frames: number;
  lastT: number;
  stepStartT: number | null;
  promptT: number | null;
  pcmBytes: number;
  subscriptions: Subscription[];
  cancelTimer: () => void;
};

const IDLE: LabState = { phase: 'idle', prompt: false, micDb: null, refDb: null, frames: 0, stepMs: 0, route: null, error: null, reports: [] };

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** Số byte của chuỗi base64 (không đọc nội dung). */
function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Điều phối ba bước đo. Không biết gì về màn hình: màn hình đăng ký `subscribe` và đọc `getState`.
 * Mọi chuyển bước do sự kiện của mô-đun gốc dẫn dắt (khung đủ thời gian, tiếng phát xong), nên test điều khiển được bằng khung giả.
 */
export class AecLabRunner {
  private state: LabState = IDLE;
  private readonly listeners = new Set<() => void>();
  private current: Run | null = null;
  private seq = 0;
  private starting = false;
  private lastPublish = 0;

  constructor(private readonly deps: LabDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): LabState => this.state;

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private timer(fn: () => void, ms: number): () => void {
    return (this.deps.setTimer ?? defaultTimer)(fn, ms);
  }

  private set(patch: Partial<LabState>): void {
    this.state = { ...this.state, ...patch };
    this.lastPublish = this.now();
    for (const listener of this.listeners) listener();
  }

  /** Khung đến dày (20 lần một giây): chỉ báo cho màn hình tối đa 10 lần một giây, trừ khi `force`. */
  private publish(patch: Partial<LabState>, force = false): void {
    if (!force && this.now() - this.lastPublish < 100) {
      this.state = { ...this.state, ...patch };
      return;
    }
    this.set(patch);
  }

  async start(config: LabConfig): Promise<void> {
    if (this.starting || this.current) return;
    this.starting = true;
    const id = ++this.seq;
    this.set({ phase: 'starting', prompt: false, micDb: null, refDb: null, frames: 0, stepMs: 0, error: null });

    let run: Run | null = null;
    try {
      if (!(await this.deps.requestPermission())) {
        this.set({ phase: 'error', error: { code: 'denied', detail: '' } });
        return;
      }
      const clip = await this.deps.clipUri();
      if (id !== this.seq) return;

      run = {
        config,
        start: null,
        clip,
        phase: 'silence',
        silence: [],
        echo: [],
        talk: [],
        arrivals: [],
        playing: false,
        frames: 0,
        lastT: 0,
        stepStartT: null,
        promptT: null,
        pcmBytes: 0,
        subscriptions: [],
        cancelTimer: () => undefined,
      };
      const active = run;
      // Đăng ký nghe trước khi mở: khung đầu tiên có thể đến trước khi `start` trả về.
      active.subscriptions = [
        this.deps.native.addListener('onFrame', (e) => this.onFrame(active, e)),
        this.deps.native.addListener('onPlayback', (e) => this.onPlayback(active, e)),
        this.deps.native.addListener('onState', (e) => this.onState(active, e)),
      ];
      this.current = active;

      const result = await this.deps.native.start({ voiceProcessing: config.voiceProcessing, voiceChatMode: config.voiceChatMode, frameMs: FRAME_MS, emitPcm: true });
      if (id !== this.seq) {
        // Người dùng bấm Dừng lúc micro đang mở dở: `abort` đã gọi `stop` trước khi `start` xong, nên đóng lại ở đây.
        await this.stopQuietly();
        return;
      }
      active.start = result;
      // Khung đầu có thể đã tới trong lúc `start` chạy; chỉ canh khi chưa thấy khung nào.
      if (active.stepStartT === null) active.cancelTimer = this.timer(() => this.fail(active, 'noFrames', ''), FIRST_FRAME_WAIT_MS);
      this.set({ phase: 'silence', route: result.route });
    } catch (err) {
      if (run && run === this.current) this.fail(run, 'start', messageOf(err));
      else this.set({ phase: 'error', error: { code: 'start', detail: messageOf(err) } });
    } finally {
      this.starting = false;
    }
  }

  /** Dừng giữa chừng (bấm Dừng, hoặc rời màn hình). Báo cáo đã có vẫn giữ. */
  async abort(): Promise<void> {
    this.seq += 1;
    const run = this.current;
    this.current = null;
    if (run) this.dispose(run);
    await this.stopQuietly();
    if (this.state.phase !== 'idle' && this.state.phase !== 'done') this.set({ phase: 'idle', prompt: false });
  }

  private dispose(run: Run): void {
    run.cancelTimer();
    for (const subscription of run.subscriptions) {
      try {
        subscription.remove();
      } catch {}
    }
    run.subscriptions = [];
  }

  private async stopQuietly(): Promise<void> {
    try {
      await this.deps.native.stop();
    } catch {}
    try {
      await this.deps.restorePlayback();
    } catch {}
  }

  private fail(run: Run, code: LabErrorCode, detail: string): void {
    if (run !== this.current) return;
    this.current = null;
    this.dispose(run);
    this.set({ phase: 'error', prompt: false, error: { code, detail } });
    void this.stopQuietly();
  }

  private onFrame(run: Run, e: DuplexFrameEvent): void {
    if (run !== this.current) return;
    run.frames += 1;
    run.lastT = e.t;
    if (e.pcm) run.pcmBytes += base64Bytes(e.pcm);
    const point: LabPoint = { t: e.t, micDb: e.micDb, refDb: e.refDb };

    if (run.phase === 'silence') {
      if (run.stepStartT === null) {
        run.stepStartT = e.t;
        run.cancelTimer();
        run.cancelTimer = () => undefined;
      }
      run.silence.push(point);
      run.arrivals.push(this.now());
      if (e.t - run.stepStartT >= SILENCE_MS) void this.beginEcho(run);
    } else if (run.phase === 'echo') {
      if (run.playing) run.echo.push(point);
    } else if (run.playing) {
      // Lời nhắc tính từ khung đầu tiên ghi được trong bước 3, không phải từ tiếng "bắt đầu phát" (đến trước khung đó một nhịp).
      if (run.promptT === null) run.promptT = e.t + PROMPT_AFTER_MS;
      run.talk.push(point);
    }

    const prompt = run.phase === 'talk' && run.promptT !== null && e.t >= run.promptT;
    this.publish({ micDb: e.micDb, refDb: e.refDb, frames: run.frames, stepMs: run.stepStartT === null ? 0 : Math.max(0, e.t - run.stepStartT), prompt }, prompt !== this.state.prompt);
  }

  private onPlayback(run: Run, e: DuplexPlaybackEvent): void {
    if (run !== this.current) return;
    if (e.state === 'started') {
      run.playing = true;
      run.stepStartT = run.lastT;
      return;
    }
    if (!run.playing) return;
    run.playing = false;
    if (run.phase === 'echo') void this.beginTalk(run);
    else if (run.phase === 'talk') void this.finish(run);
  }

  private onState(run: Run, e: DuplexStateEvent): void {
    if (run !== this.current) return;
    if (e.state === 'route') this.set({ route: e.detail });
    else this.fail(run, 'stopped', e.detail);
  }

  private async beginEcho(run: Run): Promise<void> {
    run.phase = 'echo';
    run.playing = false;
    run.stepStartT = run.lastT;
    run.cancelTimer();
    run.cancelTimer = this.timer(() => this.fail(run, 'timeout', ''), PHASE_MAX_MS + 10_000);
    this.set({ phase: 'echo', prompt: false, stepMs: 0 });
    await this.play(run);
  }

  private async beginTalk(run: Run): Promise<void> {
    run.phase = 'talk';
    run.playing = false;
    run.promptT = null;
    run.stepStartT = run.lastT;
    run.cancelTimer();
    run.cancelTimer = this.timer(() => this.fail(run, 'timeout', ''), PHASE_MAX_MS + 10_000);
    this.set({ phase: 'talk', prompt: false, stepMs: 0 });
    await this.play(run);
  }

  private async play(run: Run): Promise<void> {
    try {
      await this.deps.native.playFile(run.clip);
    } catch (err) {
      this.fail(run, 'play', messageOf(err));
    }
  }

  private async finish(run: Run): Promise<void> {
    if (run !== this.current || !run.start) return;
    this.current = null;
    this.dispose(run);
    await this.stopQuietly();
    const report = buildReport({ config: run.config, start: run.start, silence: run.silence, echo: run.echo, talk: run.talk, promptT: run.promptT, arrivals: run.arrivals, pcmBytes: run.pcmBytes });
    this.set({ phase: 'done', prompt: false, error: null, reports: [report, ...this.state.reports].slice(0, MAX_REPORTS) });
  }
}
