import { describe, expect, it } from 'vitest';
import { MicError, NATIVE_TAIL_MS, NativeMicSource, type NativeAudioStream, type NativeMicDeps, type NativeStreamBuffer, type NativeStreamOptions } from '../src/scribe/mic-core';

/** Luồng thu giả: ghi lại các lời gọi, để test tự đẩy khối âm thanh vào như máy thật. */
class FakeStream implements NativeAudioStream {
  calls: string[] = [];
  removed = 0;
  startError: Error | null = null;
  private listener: ((buffer: NativeStreamBuffer) => void) | null = null;

  async start(): Promise<void> {
    this.calls.push('start');
    if (this.startError) throw this.startError;
  }
  stop(): void {
    this.calls.push('stop');
  }
  release(): void {
    this.calls.push('release');
  }
  addListener(_event: 'audioStreamBuffer', listener: (buffer: NativeStreamBuffer) => void) {
    this.listener = listener;
    return {
      remove: () => {
        this.removed++;
        this.listener = null;
      },
    };
  }
  push(buffer: NativeStreamBuffer): void {
    this.listener?.(buffer);
  }
}

const int16 = (samples: number[], sampleRate = 16_000, channels = 1): NativeStreamBuffer => {
  const data = new ArrayBuffer(samples.length * 2);
  const view = new DataView(data);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return { data, sampleRate, channels };
};

const samplesOf = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
};

function setup(overrides: Partial<NativeMicDeps> = {}, configure: (stream: FakeStream) => void = () => undefined) {
  const streams: FakeStream[] = [];
  const created: NativeStreamOptions[] = [];
  const log: string[] = [];
  const hooks: { duringWait?: () => void } = {};
  const deps: NativeMicDeps = {
    requestPermission: async () => true,
    createStream: (options) => {
      created.push(options);
      const stream = new FakeStream();
      configure(stream);
      streams.push(stream);
      return stream;
    },
    restorePlayback: async () => {
      log.push('restore');
    },
    sleep: async (ms) => {
      log.push(`sleep:${ms}`);
      hooks.duringWait?.();
    },
    ...overrides,
  };
  const frames: Uint8Array[] = [];
  const source = new NativeMicSource(deps);
  return { source, streams, created, log, hooks, frames, onChunk: (frame: Uint8Array) => frames.push(frame) };
}

describe('thu âm trên iOS và Android bằng AudioStream của expo-audio (Q15, đề xuất)', () => {
  it('xin luồng 16 kHz, đơn kênh, 16-bit; có quyền rồi mới mở luồng', async () => {
    const { source, streams, created, onChunk } = setup();
    await source.start(onChunk);
    expect(created).toEqual([{ sampleRate: 16_000, channels: 1, encoding: 'int16' }]);
    expect(streams[0]?.calls).toEqual(['start']);
  });

  it('máy đưa đúng 16 kHz đơn kênh: giữ nguyên từng mẫu, cắt khung 60 ms; dừng thì gửi nốt phần lẻ, đóng luồng và trả loa', async () => {
    const { source, streams, log, frames, onChunk } = setup();
    await source.start(onChunk);
    const stream = streams[0] as FakeStream;
    const a = Array.from({ length: 1600 }, (_, i) => i - 800);
    const b = Array.from({ length: 1600 }, (_, i) => 800 - i);
    stream.push(int16(a));
    expect(frames).toHaveLength(1);
    stream.push(int16(b));
    expect(frames).toHaveLength(3);

    await source.stop();
    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.byteLength)).toEqual([1920, 1920, 1920, 640]);
    expect(frames.flatMap(samplesOf)).toEqual([...a, ...b]);
    expect(log).toEqual([`sleep:${NATIVE_TAIL_MS}`, 'restore']);
    expect(stream.calls).toEqual(['start', 'stop', 'release']);
    expect(stream.removed).toBe(1);
  });

  it('khối âm cuối còn trên đường về lúc người dùng bấm dừng vẫn được gửi; khối tới sau khi đã đóng thì bỏ', async () => {
    const { source, streams, hooks, frames, onChunk } = setup();
    await source.start(onChunk);
    const stream = streams[0] as FakeStream;
    hooks.duringWait = () => stream.push(int16(Array.from({ length: 960 }, () => 7)));
    await source.stop();
    expect(frames.map((f) => f.byteLength)).toEqual([1920]);
    expect(samplesOf(frames[0] as Uint8Array).every((s) => s === 7)).toBe(true);
    stream.push(int16([1, 2, 3]));
    expect(frames).toHaveLength(1);
  });

  it('chưa được phép dùng micro: báo denied, không tạo luồng', async () => {
    const { source, created, onChunk } = setup({ requestPermission: async () => false });
    await expect(source.start(onChunk)).rejects.toMatchObject({ name: 'MicError', reason: 'denied' });
    expect(created).toEqual([]);
  });

  it('xin quyền gặp lỗi: báo error', async () => {
    const { source, onChunk } = setup({
      requestPermission: async () => {
        throw new Error('boom');
      },
    });
    await expect(source.start(onChunk)).rejects.toMatchObject({ reason: 'error' });
  });

  it('máy hoặc bản Expo Go chưa có AudioStream: báo unsupported để app chuyển sang gõ chữ', async () => {
    const { source, onChunk } = setup({
      createStream: () => {
        throw new Error('audio_stream_unavailable');
      },
    });
    const error = await source.start(onChunk).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MicError);
    expect((error as MicError).reason).toBe('unsupported');
  });

  it('mở luồng thất bại (micro đang bị giữ): báo error, dọn sạch luồng và trả loa; dừng sau đó không lỗi', async () => {
    const { source, streams, log, onChunk } = setup({}, (stream) => {
      stream.startError = new Error('microphone busy');
    });
    await expect(source.start(onChunk)).rejects.toMatchObject({ reason: 'error' });
    const stream = streams[0] as FakeStream;
    expect(stream.calls).toEqual(['start', 'stop', 'release']);
    expect(stream.removed).toBe(1);
    expect(log).toEqual(['restore']);
    await source.stop();
    expect(log).toEqual(['restore']);
  });

  it('máy không đưa được 16 kHz (Android lùi về 48 kHz): hạ mẫu về 16 kHz như đường web', async () => {
    const { source, streams, frames, onChunk } = setup();
    await source.start(onChunk);
    // 100 ms ở 48 kHz là 4.800 mẫu; về 16 kHz còn 1.600 mẫu, mỗi mẫu là trung bình ba mẫu gốc.
    (streams[0] as FakeStream).push(int16(Array.from({ length: 4800 }, () => 1000), 48_000));
    await source.stop();
    const out = frames.flatMap(samplesOf);
    expect(out).toHaveLength(1600);
    for (const sample of out) expect(Math.abs(sample - 1000)).toBeLessThanOrEqual(1);
  });

  it('thiết bị hai kênh xen kẽ: chỉ lấy kênh đầu', async () => {
    const { source, streams, frames, onChunk } = setup();
    await source.start(onChunk);
    const stereo = Array.from({ length: 1920 }, (_, i) => (i % 2 === 0 ? 300 : -300));
    (streams[0] as FakeStream).push(int16(stereo, 16_000, 2));
    await source.stop();
    const out = frames.flatMap(samplesOf);
    expect(out).toHaveLength(960);
    for (const sample of out) expect(Math.abs(sample - 300)).toBeLessThanOrEqual(1);
  });

  it('khối dữ liệu là một khung nhìn lệch vị trí trên bộ đệm lớn hơn: chỉ đọc đúng phần của nó', async () => {
    const { source, streams, frames, onChunk } = setup();
    await source.start(onChunk);
    const backing = new Uint8Array(1930);
    backing.fill(0xff);
    const view = new Uint8Array(backing.buffer, 5, 1920);
    view.fill(0);
    (streams[0] as FakeStream).push({ data: view as unknown as ArrayBuffer, sampleRate: 16_000, channels: 1 });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('dừng nhiều lần cùng lúc, hoặc dừng khi chưa mở, đều không lỗi và chỉ trả loa một lần', async () => {
    const { source, streams, log, onChunk } = setup();
    await source.stop();
    expect(log).toEqual([]);
    await source.start(onChunk);
    await Promise.all([source.stop(), source.stop(), source.stop()]);
    await source.stop();
    expect(log).toEqual([`sleep:${NATIVE_TAIL_MS}`, 'restore']);
    expect(streams[0]?.calls).toEqual(['start', 'stop', 'release']);
  });

  it('mở lần hai khi luồng cũ còn đó: đóng luồng cũ trước rồi mở luồng mới', async () => {
    const { source, streams, frames, onChunk } = setup();
    await source.start(onChunk);
    await source.start(onChunk);
    expect(streams).toHaveLength(2);
    expect(streams[0]?.calls).toEqual(['start', 'stop', 'release']);
    expect(streams[1]?.calls).toEqual(['start']);
    (streams[0] as FakeStream).push(int16(Array.from({ length: 960 }, () => 1)));
    (streams[1] as FakeStream).push(int16(Array.from({ length: 960 }, () => 2)));
    expect(frames).toHaveLength(1);
    expect(samplesOf(frames[0] as Uint8Array)[0]).toBe(2);
  });
});
