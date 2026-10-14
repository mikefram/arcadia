import { Downsampler, Pcm16Framer, PcmFramer, TARGET_SAMPLE_RATE, firstChannel, pcm16ToFloat } from './pcm';

/**
 * Phần của nguồn thu âm không phụ thuộc React Native hay expo, để test được bằng Node (SPEC 6.1, 10.7.2):
 * PCM 16-bit, đơn kênh, 16 kHz, little-endian, mỗi khung 20 đến 100 ms.
 */
export interface MicSource {
  /** Mở micro và gọi `onChunk` với từng khung PCM 16-bit 16 kHz. Chỉ gọi khi người dùng bấm nút. */
  start(onChunk: (pcm16: Uint8Array) => void): Promise<void>;
  /** Đóng micro và trả lại thiết bị cho hệ điều hành. Gọi nhiều lần cũng không sao. */
  stop(): Promise<void>;
}

export type MicErrorReason = 'denied' | 'unsupported' | 'error';

export class MicError extends Error {
  constructor(readonly reason: MicErrorReason) {
    super(`mic_${reason}`);
    this.name = 'MicError';
  }
}

/** Khối PCM do luồng thu của máy gửi lên: phần ta dùng của `AudioStreamBuffer` (expo-audio). */
export type NativeStreamBuffer = {
  data: ArrayBuffer;
  /** tần số thật; máy không đưa được tần số đã xin thì khác 16 kHz */
  sampleRate: number;
  /** số kênh thật; nhiều kênh thì xen kẽ [T, P, T, P, ...] */
  channels: number;
};

export type NativeStreamOptions = { sampleRate: number; channels: number; encoding: 'int16' };

/** Phần của `AudioStream` (expo-audio) mà ta dùng; tách ra để test mà không cần máy thật. */
export type NativeAudioStream = {
  start(): Promise<void>;
  stop(): void;
  release(): void;
  addListener(event: 'audioStreamBuffer', listener: (buffer: NativeStreamBuffer) => void): { remove(): void };
};

export type NativeMicDeps = {
  /** Xin quyền micro; true khi đã được phép. */
  requestPermission: () => Promise<boolean>;
  /** Tạo một luồng thu mới. Ném lỗi khi máy (hoặc bản Expo Go) chưa có `AudioStream`. */
  createStream: (options: NativeStreamOptions) => NativeAudioStream;
  /**
   * Trả phiên âm thanh về chế độ phát. Luồng thu của expo-audio đặt phiên iOS ở chế độ chỉ thu và không trả lại,
   * nên không gọi hàm này thì câu trả lời của trợ lý phát ra mà loa im.
   */
  restorePlayback: () => Promise<void>;
  /** Chờ `ms` mili giây (test thay bằng hàm không chờ). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Sau khi người dùng bấm dừng, chờ thêm chừng này trước khi đóng luồng: máy gửi âm thanh theo khối 100 ms, nên
 * khối cuối chứa vài từ vừa nói còn đang trên đường về. Đóng ngay thì câu bị cụt phần chót, mà tiếng Việt
 * phân biệt nghĩa bằng dấu thanh ở cuối âm tiết.
 */
export const NATIVE_TAIL_MS = 150;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}

/**
 * Thu âm trên iOS và Android bằng `AudioStream` của expo-audio (đề xuất cho Q15, chưa thử trên máy thật).
 * Xin luồng 16 kHz, đơn kênh, 16-bit: máy trả đúng như vậy thì chỉ cắt thành khung 60 ms, không đổi gì.
 * Máy không đưa được (Android lùi về 48 kHz, thiết bị nhiều kênh) thì hạ mẫu ở đây, như đường web.
 * Chưa chạy lần nào trên máy thật; chỗ chắc chắn nhất là các phép đổi mẫu và cắt khung (có test).
 */
export class NativeMicSource implements MicSource {
  private stream: NativeAudioStream | null = null;
  private subscription: { remove(): void } | null = null;
  private emit: ((pcm16: Uint8Array) => void) | null = null;
  private exact = new Pcm16Framer();
  private converted = new PcmFramer();
  private downsampler: Downsampler | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly deps: NativeMicDeps) {}

  async start(onChunk: (pcm16: Uint8Array) => void): Promise<void> {
    await this.stop();

    let granted: boolean;
    try {
      granted = await this.deps.requestPermission();
    } catch {
      throw new MicError('error');
    }
    if (!granted) throw new MicError('denied');

    let stream: NativeAudioStream;
    try {
      stream = this.deps.createStream({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, encoding: 'int16' });
    } catch {
      throw new MicError('unsupported');
    }

    this.emit = onChunk;
    this.exact = new Pcm16Framer();
    this.converted = new PcmFramer();
    this.downsampler = null;
    this.stream = stream;
    this.subscription = stream.addListener('audioStreamBuffer', (buffer) => this.onBuffer(buffer));
    try {
      await stream.start();
    } catch {
      // Không mở được micro (máy khác đang giữ, hoặc quyền bị thu hồi giữa chừng): dọn sạch, không để lại luồng nửa vời.
      await this.release();
      throw new MicError('error');
    }
  }

  stop(): Promise<void> {
    if (!this.stream) return this.stopping ?? Promise.resolve();
    this.stopping ??= this.finish();
    return this.stopping;
  }

  private async finish(): Promise<void> {
    try {
      await (this.deps.sleep ?? defaultSleep)(NATIVE_TAIL_MS);
      const emit = this.emit;
      // Phần lẻ cuối cùng của câu nói vẫn gửi đi trước khi đóng.
      if (emit) for (const tail of [this.exact.flush(), this.converted.flush()]) if (tail) emit(tail);
    } finally {
      await this.release();
      this.stopping = null;
    }
  }

  private async release(): Promise<void> {
    const { stream, subscription } = this;
    this.stream = null;
    this.subscription = null;
    this.emit = null;
    this.downsampler = null;
    try {
      subscription?.remove();
    } catch {}
    try {
      stream?.stop();
    } catch {}
    try {
      stream?.release();
    } catch {}
    await this.deps.restorePlayback().catch(() => undefined);
  }

  private onBuffer(buffer: NativeStreamBuffer): void {
    const emit = this.emit;
    if (!emit) return;
    const bytes = bytesOf(buffer.data);
    if (buffer.sampleRate === TARGET_SAMPLE_RATE && buffer.channels === 1) {
      for (const frame of this.exact.push(bytes)) emit(frame);
      return;
    }
    if (!(buffer.sampleRate > 0)) return;
    if (!this.downsampler || this.downsampler.inputRate !== buffer.sampleRate) this.downsampler = new Downsampler(buffer.sampleRate);
    const mono = firstChannel(pcm16ToFloat(bytes), Math.max(1, buffer.channels));
    for (const frame of this.converted.push(this.downsampler.process(mono))) emit(frame);
  }
}
