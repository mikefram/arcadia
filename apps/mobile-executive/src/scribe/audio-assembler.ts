/**
 * Ghép âm thanh câu trả lời (SPEC 10.7.2): máy chủ gửi `audio.start {format:'mp3'}`, rồi các khung nhị phân mp3 nối
 * theo thứ tự (mỗi đoạn không quá 300 ký tự được tổng hợp lần lượt), rồi `audio.end`. App gom các khung giữa hai mốc
 * đó thành một khối rồi mới phát. Hàm thuần, không giữ âm thanh sau khi đã trả ra: âm thanh không được lưu lại.
 */
export type AssembledAudio = { turnId: string; format: 'mp3'; bytes: Uint8Array };

/** Trần an toàn cho một câu trả lời (khoảng 4 phút mp3 128 kbps): vượt thì bỏ, app chỉ hiện chữ. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export class AudioAssembler {
  private turnId: string | null = null;
  private chunks: Uint8Array[] = [];
  private size = 0;
  private overflow = false;

  /** `audio.start`: bắt đầu gom cho một lượt. Phần đang gom dở của lượt trước (nếu có) bị bỏ. */
  start(turnId: string): void {
    this.turnId = turnId;
    this.chunks = [];
    this.size = 0;
    this.overflow = false;
  }

  /** Khung nhị phân. Khung tới ngoài cặp `audio.start` và `audio.end` thì bỏ. */
  push(chunk: Uint8Array): void {
    if (this.turnId === null || chunk.byteLength === 0) return;
    if (this.size + chunk.byteLength > MAX_AUDIO_BYTES) {
      this.overflow = true;
      return;
    }
    // Chép ra vùng nhớ riêng: bộ đệm của WebSocket có thể được dùng lại.
    this.chunks.push(chunk.slice());
    this.size += chunk.byteLength;
  }

  /**
   * `audio.end`: trả khối âm thanh đã ghép theo đúng thứ tự nhận, rồi quên. Trả null khi `turnId` không khớp lượt
   * đang gom, khi không có byte nào, hoặc khi vượt trần.
   */
  end(turnId: string): AssembledAudio | null {
    if (this.turnId !== turnId) return null;
    const { chunks, size, overflow } = this;
    this.reset();
    if (size === 0 || overflow) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { turnId, format: 'mp3', bytes };
  }

  /** Bị ngắt lời, đổi lượt, đứt kết nối: bỏ phần đang gom. */
  reset(): void {
    this.turnId = null;
    this.chunks = [];
    this.size = 0;
    this.overflow = false;
  }

  get collecting(): boolean {
    return this.turnId !== null;
  }
}
