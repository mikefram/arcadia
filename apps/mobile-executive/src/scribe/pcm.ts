/**
 * Xử lý âm thanh thu từ micro trước khi gửi (SPEC 6.1, 10.7.2): hạ mẫu về 16 kHz, đổi sang PCM 16-bit little-endian,
 * cắt thành khung 20 đến 100 ms. Hàm thuần để test được; không phải thuật toán mật mã hay nén.
 */
export const TARGET_SAMPLE_RATE = 16_000;
/** 60 ms mỗi khung: 960 mẫu, 1.920 byte. */
export const FRAME_SAMPLES = 960;

/**
 * Bộ hạ mẫu theo dòng: lấy trung bình các mẫu rơi vào mỗi mẫu đích (lọc thông thấp đơn giản, đủ cho tiếng nói),
 * giữ phần lẻ giữa các lần gọi để không lệch pha khi tỷ lệ không nguyên (44.100 Hz về 16.000 Hz).
 */
export class Downsampler {
  private readonly ratio: number;
  private position = 0;
  private sum = 0;
  private count = 0;

  constructor(readonly inputRate: number, readonly outputRate: number = TARGET_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError('Tần số lấy mẫu phải lớn hơn 0');
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio <= 1) return input.slice();
    const out = new Float32Array(Math.ceil((input.length + this.count) / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i] ?? 0;
      this.count++;
      this.position += 1;
      if (this.position >= this.ratio) {
        out[n++] = this.sum / this.count;
        this.position -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

/** Mẫu số thực trong khoảng -1..1 sang PCM 16-bit little-endian. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return out;
}

/** Gom mẫu 16 kHz thành các khung đều nhau; phần lẻ giữ lại cho lần sau, `flush()` trả nốt khi dừng thu. */
export class PcmFramer {
  private buffer = new Float32Array(0);

  constructor(private readonly frameSamples: number = FRAME_SAMPLES) {}

  push(samples: Float32Array): Uint8Array[] {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (merged.length - offset >= this.frameSamples) {
      frames.push(floatToPcm16(merged.subarray(offset, offset + this.frameSamples)));
      offset += this.frameSamples;
    }
    this.buffer = merged.slice(offset);
    return frames;
  }

  flush(): Uint8Array | null {
    if (this.buffer.length === 0) return null;
    const frame = floatToPcm16(this.buffer);
    this.buffer = new Float32Array(0);
    return frame;
  }
}

/** PCM 16-bit little-endian sang mẫu số thực -1..1. Byte lẻ ở cuối (nếu có) bị bỏ. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Lấy kênh đầu của dữ liệu xen kẽ [T, P, T, P, ...]; đơn kênh thì trả nguyên. */
export function firstChannel(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const out = new Float32Array(Math.floor(samples.length / channels));
  for (let i = 0; i < out.length; i++) out[i] = samples[i * channels] ?? 0;
  return out;
}

/**
 * Gom PCM 16-bit little-endian đã đúng 16 kHz đơn kênh (thư viện thu của máy đưa sẵn) thành khung đều nhau.
 * Giữ nguyên từng byte, không đổi mẫu; mỗi khung nằm trong vùng nhớ riêng để gửi qua WebSocket an toàn.
 */
export class Pcm16Framer {
  private buffer = new Uint8Array(0);

  constructor(private readonly frameBytes: number = FRAME_SAMPLES * 2) {
    if (!(frameBytes > 0) || frameBytes % 2 !== 0) throw new RangeError('Khung PCM 16-bit phải có số byte chẵn và lớn hơn 0');
  }

  push(bytes: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (merged.length - offset >= this.frameBytes) {
      frames.push(merged.slice(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.buffer = merged.slice(offset);
    return frames;
  }

  /** Phần lẻ còn lại, cắt về số byte chẵn (một mẫu là hai byte). */
  flush(): Uint8Array | null {
    const whole = this.buffer.length - (this.buffer.length % 2);
    const tail = whole > 0 ? this.buffer.slice(0, whole) : null;
    this.buffer = new Uint8Array(0);
    return tail;
  }
}
