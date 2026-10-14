export type GateOptions = {
  /** Mức (dBFS) phải vượt để tính là có tiếng nói. */
  thresholdDb: number;
  /** Số khung liên tiếp vượt ngưỡng mới coi là bắt đầu nói; lọc tiếng động ngắn (tiếng chạm bàn, ho). */
  attackFrames: number;
  /** Số khung liên tiếp dưới ngưỡng mới coi là ngừng nói. */
  releaseFrames: number;
  /** Khi đang nói, ngưỡng để ngừng thấp hơn ngưỡng bắt đầu chừng này: mức dao động quanh ngưỡng không làm cổng đóng mở liên tục. Mặc định 3 dB. */
  releaseDropDb?: number;
};

export type GateEvent = 'start' | 'end' | null;

/**
 * Cổng nhận ra tiếng nói bằng mức âm, có trễ nhịp bắt đầu và nhịp kết thúc. Là mầm của việc ngắt lời trợ lý bằng giọng:
 * mỗi khung micro (sau khử vọng) đẩy vào `push`, trả `'start'` ở khung mà tiếng nói được xác nhận.
 * Ngưỡng do người gọi hiệu chuẩn (màn đo khử vọng lấy từ mức tiếng vọng đo được); cổng không tự đoán ngưỡng.
 */
export class SpeechGate {
  private above = 0;
  private below = 0;
  private open = false;

  constructor(private readonly options: GateOptions) {}

  get speaking(): boolean {
    return this.open;
  }

  push(levelDb: number): GateEvent {
    const { thresholdDb, attackFrames, releaseFrames, releaseDropDb = 3 } = this.options;
    if (!this.open) {
      this.above = levelDb > thresholdDb ? this.above + 1 : 0;
      if (this.above < attackFrames) return null;
      this.open = true;
      this.above = 0;
      this.below = 0;
      return 'start';
    }
    this.below = levelDb <= thresholdDb - releaseDropDb ? this.below + 1 : 0;
    if (this.below < releaseFrames) return null;
    this.open = false;
    this.above = 0;
    this.below = 0;
    return 'end';
  }

  reset(): void {
    this.above = 0;
    this.below = 0;
    this.open = false;
  }
}
