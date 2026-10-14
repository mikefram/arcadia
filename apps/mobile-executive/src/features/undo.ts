import { PROPOSAL_UNDO_WINDOW_MS, type ProposalView } from '@mihato/domain';

/**
 * Cửa hoàn tác 30 giây của M3b (SPEC 6.5 điều 8, 10.6). Hàm thuần: đồng hồ tính theo `undoUntil` do máy chủ trả,
 * không tự đếm bằng bộ hẹn giờ của máy (hẹn giờ có thể trượt khi app bị tạm dừng).
 */
export const UNDO_WINDOW_SECONDS = Math.round(PROPOSAL_UNDO_WINDOW_MS / 1000);

/** Số giây còn lại, làm tròn lên để chữ "Còn 1 giây" không biến thành "Còn 0 giây" khi vẫn còn hoàn tác được. */
export function secondsLeft(undoUntil: string | null | undefined, nowMs: number): number {
  if (!undoUntil) return 0;
  const until = Date.parse(undoUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
}

/**
 * Số giây nêu trong câu "Đã đồng ý. Sẽ gửi sau {n} giây.": số giây còn lại lúc màn hình mở, không vượt cửa 30 giây
 * (đồng hồ của máy có thể lệch với máy chủ).
 */
export function announcedSeconds(undoUntil: string | null | undefined, openedAtMs: number): number {
  return Math.min(UNDO_WINDOW_SECONDS, secondsLeft(undoUntil, openedAtMs));
}

export type AppliedOutcome =
  /** mọi đề xuất đã được máy chủ thực hiện (`confirmed` và `result` khác null) */
  | 'sent'
  /** có đề xuất không thực hiện được */
  | 'failed'
  /** đã hết giờ hoàn tác nhưng máy chủ chưa báo xong */
  | 'sending'
  | 'undone';

/** Sau khi hết giờ: máy chủ đã làm tới đâu. */
export function appliedOutcome(proposals: readonly Pick<ProposalView, 'state' | 'result'>[]): AppliedOutcome {
  if (proposals.length === 0) return 'sending';
  if (proposals.some((p) => p.state === 'failed')) return 'failed';
  if (proposals.every((p) => p.state === 'undone')) return 'undone';
  if (proposals.every((p) => p.state === 'undone' || (p.state === 'confirmed' && p.result !== null))) return 'sent';
  return 'sending';
}
