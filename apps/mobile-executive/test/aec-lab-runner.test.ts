import { describe, expect, it } from 'vitest';
import { AecLabRunner, FIRST_FRAME_WAIT_MS, PROMPT_AFTER_MS, SILENCE_MS, type LabConfig } from '../src/duplex/lab';
import type { DuplexAudioNative, DuplexFrameEvent, DuplexPlaybackEvent, DuplexStartOptions, DuplexStartResult, DuplexStateEvent, Subscription } from '../src/duplex/types';

/** Mô-đun gốc giả: ghi lại lời gọi, để test tự đẩy khung và sự kiện vào như máy thật. */
class FakeNative implements DuplexAudioNative {
  calls: string[] = [];
  startOptions: DuplexStartOptions | null = null;
  startError: Error | null = null;
  playError: Error | null = null;
  /** Giữ `start` lại tới khi test cho chạy tiếp (mô phỏng micro đang mở dở). */
  startGate: Promise<void> | null = null;
  removed = 0;
  result: DuplexStartResult = { inputSampleRate: 24_000, inputChannels: 1, voiceProcessing: true, route: 'Speaker / MicrophoneBuiltIn' };

  private readonly frameListeners = new Set<(e: DuplexFrameEvent) => void>();
  private readonly playbackListeners = new Set<(e: DuplexPlaybackEvent) => void>();
  private readonly stateListeners = new Set<(e: DuplexStateEvent) => void>();

  async start(options: DuplexStartOptions): Promise<DuplexStartResult> {
    this.calls.push('start');
    this.startOptions = options;
    if (this.startGate) await this.startGate;
    if (this.startError) throw this.startError;
    return this.result;
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async playFile(uri: string): Promise<void> {
    this.calls.push(`play:${uri}`);
    if (this.playError) throw this.playError;
  }
  async stopPlayback(): Promise<void> {
    this.calls.push('stopPlayback');
  }
  getRoute(): string {
    return 'Speaker / MicrophoneBuiltIn';
  }

  addListener(event: 'onFrame', listener: (e: DuplexFrameEvent) => void): Subscription;
  addListener(event: 'onPlayback', listener: (e: DuplexPlaybackEvent) => void): Subscription;
  addListener(event: 'onState', listener: (e: DuplexStateEvent) => void): Subscription;
  addListener(event: 'onFrame' | 'onPlayback' | 'onState', listener: never): Subscription {
    const set = (event === 'onFrame' ? this.frameListeners : event === 'onPlayback' ? this.playbackListeners : this.stateListeners) as unknown as Set<unknown>;
    set.add(listener);
    return {
      remove: () => {
        this.removed += 1;
        set.delete(listener);
      },
    };
  }

  frame(t: number, micDb: number, refDb = -120, pcm?: string): void {
    for (const listener of this.frameListeners) listener({ micDb, peakDb: micDb + 6, refDb, t, pcm });
  }
  playback(state: DuplexPlaybackEvent['state']): void {
    for (const listener of this.playbackListeners) listener({ state });
  }
  state(state: DuplexStateEvent['state'], detail: string): void {
    for (const listener of this.stateListeners) listener({ state, detail });
  }
  get listenerCount(): number {
    return this.frameListeners.size + this.playbackListeners.size + this.stateListeners.size;
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ON: LabConfig = { voiceProcessing: true, voiceChatMode: true };
const echoLevel = (i: number) => [-52, -50, -48, -50, -49, -51][i % 6] as number;

function setup(options: { granted?: boolean } = {}) {
  const native = new FakeNative();
  const log: string[] = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  let now = 0;
  const runner = new AecLabRunner({
    native,
    clipUri: async () => 'file:///clip.wav',
    requestPermission: async () => options.granted ?? true,
    restorePlayback: async () => {
      log.push('restore');
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const liveTimers = () => timers.filter((t) => !t.cancelled);
  return { native, runner, log, timers, liveTimers, advance: (ms: number) => (now += ms) };
}

/** Đẩy `count` khung cách nhau 50 ms từ `from`; trả thời điểm khung kế tiếp. */
function feed(native: FakeNative, from: number, count: number, mic: (i: number) => number, ref = -120): number {
  for (let i = 0; i < count; i++) native.frame(from + i * 50, mic(i), ref);
  return from + count * 50;
}

/** Chạy trọn ba bước với tín hiệu như một lần đo tốt; trả thời điểm cuối. */
async function runGood(native: FakeNative, runner: AecLabRunner): Promise<void> {
  await runner.start(ON);
  let t = feed(native, 0, SILENCE_MS / 50 + 1, () => -60);
  await flush();
  native.playback('started');
  t = feed(native, t, 200, echoLevel, -25);
  native.playback('ended');
  await flush();
  native.playback('started');
  // 3,4 giây đầu chỉ có tiếng vọng, rồi người nghe nói chen vào ở -30 dB
  const talkStart = t;
  t = feed(native, t, 200, (i) => (i * 50 >= PROMPT_AFTER_MS + 400 ? -30 : echoLevel(i)), -25);
  expect(t).toBe(talkStart + 200 * 50);
  native.playback('ended');
  await flush();
}

describe('phép đo khử tiếng vọng: bộ điều phối ba bước', () => {
  it('mở micro với tuỳ chọn đã chọn, rồi đi qua yên lặng, tiếng vọng, nói chen và ra báo cáo', async () => {
    const { native, runner, log } = setup();
    expect(runner.getState().phase).toBe('idle');
    await runner.start(ON);
    expect(native.startOptions).toEqual({ voiceProcessing: true, voiceChatMode: true, frameMs: 50, emitPcm: true });
    expect(runner.getState()).toMatchObject({ phase: 'silence', route: 'Speaker / MicrophoneBuiltIn' });

    // bước 1 xong khi đủ 5 giây khung: chưa đủ thì chưa phát
    feed(native, 0, SILENCE_MS / 50, () => -60);
    await flush();
    expect(runner.getState().phase).toBe('silence');
    expect(native.calls).toEqual(['start']);
    native.frame(SILENCE_MS, -60);
    await flush();
    expect(runner.getState().phase).toBe('echo');
    expect(native.calls).toEqual(['start', 'play:file:///clip.wav']);

    // bước 2: phát xong thì sang bước 3 và phát lần hai
    native.playback('started');
    feed(native, SILENCE_MS + 50, 200, echoLevel, -25);
    native.playback('ended');
    await flush();
    expect(runner.getState().phase).toBe('talk');
    expect(native.calls).toEqual(['start', 'play:file:///clip.wav', 'play:file:///clip.wav']);

    // bước 3: lời nhắc chỉ hiện sau PROMPT_AFTER_MS kể từ khung đầu tiên ghi được lúc trợ lý đọc
    native.playback('started');
    const t0 = SILENCE_MS + 50 + 200 * 50;
    native.frame(t0, -50, -25);
    expect(runner.getState().prompt).toBe(false);
    native.frame(t0 + PROMPT_AFTER_MS - 50, -50, -25);
    expect(runner.getState().prompt).toBe(false);
    native.frame(t0 + PROMPT_AFTER_MS, -30, -25);
    expect(runner.getState().prompt).toBe(true);
    for (let i = 1; i < 60; i++) native.frame(t0 + PROMPT_AFTER_MS + i * 50, -30, -25);
    native.playback('ended');
    await flush();

    const state = runner.getState();
    expect(state.phase).toBe('done');
    expect(state.prompt).toBe(false);
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]).toMatchObject({ config: ON, verdict: 'pass', falseTriggers: 0 });
    // đóng micro và trả phiên âm thanh cho expo-audio; không còn ai nghe sự kiện
    expect(native.calls.slice(-1)).toEqual(['stop']);
    expect(log).toEqual(['restore']);
    expect(native.listenerCount).toBe(0);
    expect(native.removed).toBe(3);
  });

  it('một lần đo tốt cho kết luận "đạt" và con số khớp tín hiệu đưa vào', async () => {
    const { native, runner } = setup();
    await runGood(native, runner);
    const report = runner.getState().reports[0];
    expect(report?.verdict).toBe('pass');
    expect(report?.silence?.p50).toBe(-60);
    expect(report?.echo?.p50).toBeCloseTo(-50, 5);
    expect(report?.echoLossDb).toBeCloseTo(25, 5);
    // người nói từ 400 ms sau lời nhắc; cổng cần 3 khung liên tiếp nên xác nhận ở khung thứ ba (sau 400 + 2 × 50 ms)
    expect(report?.triggerDelayMs).toBe(400 + 2 * 50);
    expect(report?.start.route).toBe('Speaker / MicrophoneBuiltIn');
  });

  it('chỉ ghi khung trong lúc trợ lý đang đọc: khung đến trước tiếng "bắt đầu" và sau tiếng "kết thúc" bị bỏ', async () => {
    const { native, runner } = setup();
    await runner.start(ON);
    feed(native, 0, SILENCE_MS / 50 + 1, () => -60);
    await flush();
    // khung vọt cao đến trước khi loa thật sự phát: không được tính vào tiếng vọng
    feed(native, 5_050, 10, () => -20, -25);
    native.playback('started');
    feed(native, 5_550, 50, echoLevel, -25);
    native.playback('ended');
    await flush();
    feed(native, 8_050, 10, () => -20, -25); // đến trong khoảng giữa hai bước
    native.playback('started');
    for (let i = 0; i < 100; i++) native.frame(8_550 + i * 50, i * 50 >= PROMPT_AFTER_MS ? -30 : echoLevel(i), -25);
    native.playback('ended');
    await flush();
    const report = runner.getState().reports[0];
    expect(report?.counts.echo).toBe(50);
    expect(report?.echo?.max).toBe(-48);
  });

  it('không có quyền micro: báo lỗi, không mở gì', async () => {
    const { native, runner } = setup({ granted: false });
    await runner.start(ON);
    expect(runner.getState()).toMatchObject({ phase: 'error', error: { code: 'denied' } });
    expect(native.calls).toEqual([]);
  });

  it('mở micro lỗi: báo lỗi kèm lý do, bỏ nghe, đóng và trả phiên âm thanh', async () => {
    const { native, runner, log } = setup();
    native.startError = new Error('session: Session activation failed');
    await runner.start(ON);
    expect(runner.getState()).toMatchObject({ phase: 'error', error: { code: 'start', detail: 'session: Session activation failed' } });
    await flush();
    expect(native.calls).toEqual(['start', 'stop']);
    expect(log).toEqual(['restore']);
    expect(native.listenerCount).toBe(0);
  });

  it('không phát được đoạn mẫu: báo lỗi và đóng', async () => {
    const { native, runner } = setup();
    native.playError = new Error('bad_file: empty');
    await runner.start(ON);
    feed(native, 0, SILENCE_MS / 50 + 1, () => -60);
    await flush();
    expect(runner.getState()).toMatchObject({ phase: 'error', error: { code: 'play', detail: 'bad_file: empty' } });
    expect(native.calls.at(-1)).toBe('stop');
  });

  it('hệ điều hành dừng âm thanh giữa chừng (có cuộc gọi đến, đổi tai nghe): báo lỗi, không ra báo cáo nửa vời', async () => {
    const { native, runner } = setup();
    await runner.start(ON);
    feed(native, 0, 30, () => -60);
    native.state('stopped', 'interruption');
    await flush();
    expect(runner.getState()).toMatchObject({ phase: 'error', error: { code: 'stopped', detail: 'interruption' } });
    expect(runner.getState().reports).toHaveLength(0);
    native.frame(2_000, -60); // khung muộn sau khi đã dừng thì bỏ qua
    expect(runner.getState().frames).toBe(30);
  });

  it('đổi đường âm thanh thì ghi lại để hiện, đo vẫn tiếp tục', async () => {
    const { native, runner } = setup();
    await runner.start(ON);
    native.state('route', 'BluetoothHFP / BluetoothHFP');
    expect(runner.getState()).toMatchObject({ phase: 'silence', route: 'BluetoothHFP / BluetoothHFP' });
  });

  it('micro không ra khung nào: hết giờ chờ thì báo lỗi', async () => {
    const { native, runner, liveTimers } = setup();
    await runner.start(ON);
    expect(liveTimers().map((t) => t.ms)).toEqual([FIRST_FRAME_WAIT_MS]);
    liveTimers()[0]?.fn();
    await flush();
    expect(runner.getState()).toMatchObject({ phase: 'error', error: { code: 'noFrames' } });
    expect(native.calls.at(-1)).toBe('stop');
  });

  it('có khung rồi thì không còn canh "không ra khung"; bước phát có giờ chờ riêng, hết giờ thì báo kẹt', async () => {
    const { native, runner, liveTimers } = setup();
    await runner.start(ON);
    native.frame(0, -60);
    expect(liveTimers()).toHaveLength(0);
    feed(native, 50, SILENCE_MS / 50, () => -60);
    await flush();
    expect(runner.getState().phase).toBe('echo');
    expect(liveTimers()).toHaveLength(1);
    liveTimers()[0]?.fn();
    await flush();
    expect(runner.getState()).toMatchObject({ phase: 'error', error: { code: 'timeout' } });
  });

  it('khung đến trước khi `start` trả về vẫn được ghi, và khi đó không canh "không ra khung"', async () => {
    const { native, runner, liveTimers } = setup();
    let release = () => {};
    native.startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = runner.start(ON);
    await flush();
    native.frame(0, -60);
    release();
    await starting;
    expect(runner.getState().phase).toBe('silence');
    expect(runner.getState().frames).toBe(1);
    expect(liveTimers()).toHaveLength(0);
  });

  it('bấm Dừng lúc micro đang mở dở: sau khi mở xong vẫn đóng lại, không để micro treo', async () => {
    const { native, runner, log } = setup();
    let release = () => {};
    native.startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = runner.start(ON);
    await flush();
    await runner.abort();
    expect(runner.getState().phase).toBe('idle');
    expect(native.calls).toEqual(['start', 'stop']);
    release();
    await starting;
    await flush();
    // `stop` thứ hai là cái đóng micro vừa mở xong
    expect(native.calls).toEqual(['start', 'stop', 'stop']);
    expect(log).toEqual(['restore', 'restore']);
    expect(runner.getState().phase).toBe('idle');
    expect(native.listenerCount).toBe(0);
  });

  it('bấm Dừng giữa chừng: đóng, bỏ nghe, về trạng thái nghỉ và giữ báo cáo cũ', async () => {
    const { native, runner } = setup();
    await runGood(native, runner);
    expect(runner.getState().reports).toHaveLength(1);
    await runner.start({ voiceProcessing: false, voiceChatMode: true });
    feed(native, 0, 30, () => -60);
    await runner.abort();
    expect(runner.getState()).toMatchObject({ phase: 'idle', prompt: false });
    expect(runner.getState().reports).toHaveLength(1);
    expect(native.listenerCount).toBe(0);
    native.frame(5_000, -60);
    expect(runner.getState().frames).toBe(30);
  });

  it('đang đo thì bấm bắt đầu lần nữa không mở thêm', async () => {
    const { native, runner } = setup();
    await runner.start(ON);
    await runner.start(ON);
    expect(native.calls.filter((c) => c === 'start')).toHaveLength(1);
  });

  it('đo hai lần (bật rồi tắt khử vọng): giữ cả hai báo cáo, mới nhất ở đầu, ghi đúng cách đo', async () => {
    const { native, runner } = setup();
    await runGood(native, runner);
    native.result = { ...native.result, voiceProcessing: false };
    // lần hai không khử vọng: tiếng vọng to bằng giọng nói
    await runner.start({ voiceProcessing: false, voiceChatMode: true });
    let t = feed(native, 0, SILENCE_MS / 50 + 1, () => -60);
    await flush();
    native.playback('started');
    t = feed(native, t, 200, () => -30, -25);
    native.playback('ended');
    await flush();
    native.playback('started');
    feed(native, t, 200, () => -30, -25);
    native.playback('ended');
    await flush();
    const [latest, earlier] = runner.getState().reports;
    expect(latest?.config).toEqual({ voiceProcessing: false, voiceChatMode: true });
    expect(latest?.start.voiceProcessing).toBe(false);
    expect(latest?.verdict).toBe('fail');
    expect(earlier?.verdict).toBe('pass');
  });

  it('báo cho màn hình không quá 10 lần mỗi giây dù khung đến 20 lần mỗi giây, nhưng đổi bước thì báo ngay', async () => {
    const { native, runner, advance } = setup();
    let notified = 0;
    runner.subscribe(() => {
      notified += 1;
    });
    await runner.start(ON);
    const before = notified;
    for (let i = 0; i < 40; i++) {
      advance(50);
      native.frame(i * 50, -60);
    }
    // 2 giây = 40 khung; mỗi 100 ms báo một lần → tối đa 20 lần
    expect(notified - before).toBeLessThanOrEqual(20);
    expect(notified - before).toBeGreaterThan(0);
    expect(runner.getState().frames).toBe(40);
  });
});
