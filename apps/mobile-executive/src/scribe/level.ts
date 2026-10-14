/**
 * Mức âm của micro, để hiện thanh "máy đang nghe thấy" lúc trò chuyện (SPEC 7.2 điều 4: trạng thái luôn có chữ và hình).
 * Tính trên khung PCM 16-bit little-endian đã có sẵn trên đường gửi đi; không giữ lại âm thanh (SPEC 6.8).
 */

/** Dưới ngưỡng này (căn bậc hai của trung bình bình phương, thang 0..1) coi như im lặng: thanh đứng yên thay vì nhấp nháy theo tiếng ồn nền. */
const NOISE_FLOOR = 0.005;

/** Giá trị RMS của một khung PCM 16-bit, thang 0..1 (1 là toàn thang). Byte lẻ ở cuối bị bỏ. */
export function pcm16Rms(chunk: Uint8Array): number {
  const count = chunk.length >> 1;
  if (count === 0) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, count * 2);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const sample = view.getInt16(i * 2, true) / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

/**
 * RMS sang mức hiển thị 0..1. Nén theo căn bậc hai vì tai người nghe theo thang lôga: tiếng nói thường (RMS 0,03 đến 0,1)
 * rơi vào khoảng giữa thang, tiếng to không làm thanh kịch trần ngay.
 */
export function toLevel(rms: number): number {
  if (!(rms >= NOISE_FLOOR)) return 0;
  return Math.min(1, Math.sqrt(rms) * 2.4);
}

/**
 * Kho nhỏ giữ mức âm hiện tại cho màn hình đăng ký theo dõi (`useSyncExternalStore`). Khung đến mỗi 60 ms nhưng chỉ báo
 * cho màn hình tối đa mỗi 100 ms (vẽ lại 10 lần một giây là đủ), lấy đỉnh trong khoảng đó; lên nhanh, xuống từ từ cho đỡ giật.
 */
export class LevelMeter {
  private level = 0;
  private peak = 0;
  private lastPublish = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 100,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.level;

  push(chunk: Uint8Array): void {
    this.peak = Math.max(this.peak, toLevel(pcm16Rms(chunk)));
    const t = this.now();
    if (t - this.lastPublish < this.intervalMs) return;
    this.lastPublish = t;
    const next = Math.max(this.peak, this.level * 0.6);
    this.peak = 0;
    this.set(next < 0.04 ? 0 : next);
  }

  /** Micro đóng: thanh về 0 ngay. */
  reset(): void {
    this.peak = 0;
    this.lastPublish = 0;
    this.set(0);
  }

  private set(value: number): void {
    if (value === this.level) return;
    this.level = value;
    for (const listener of this.listeners) listener();
  }
}
