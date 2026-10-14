import type { StepView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { onlineManager } from '@tanstack/react-query';
import type { QueuedAction, SubmitOutcome } from '../offline/queue';
import { queue } from '../services';
import { showFlash } from '../ui/Flash';
import { rejectedReason } from './queue-text';

/**
 * Bốn thao tác Đã nhận, Báo hoàn thành, Xin thêm thời gian, Báo vướng đi qua hàng đợi ngoại tuyến:
 * ghi xuống máy trước rồi mới gửi, nên không bao giờ mất thao tác (SPEC 8.1 điều 3).
 */
export function submitStepAction(step: Pick<StepView, 'id' | 'title' | 'runTitle'>, action: QueuedAction): Promise<SubmitOutcome> {
  return queue.submit({ stepId: step.id, stepTitle: step.title, runTitle: step.runTitle, action });
}

/** Lời xác nhận sau khi gửi: đã tới máy chủ, hoặc đã lưu trên máy và chờ gửi. */
export function flashOutcome(outcome: SubmitOutcome, sentText: string): void {
  if (outcome.status === 'sent') showFlash(sentText, 'done');
  // Mất mạng thì nói rõ là mất mạng; có mạng mà máy chủ chưa nhận được thì nói đã lưu và sẽ tự gửi.
  else if (outcome.status === 'queued') showFlash(onlineManager.isOnline() ? vi.staff.offline.savedWillSend : vi.staff.complete.queued, 'waiting');
}

/**
 * Máy chủ không nhận thao tác vừa gửi (việc đã đổi người, lượt đã hủy…): trả lý do bằng chữ để hiện ngay tại màn nhập.
 * Ô nhập giữ nguyên ghi chú, nên gỡ thao tác khỏi hàng đợi để không báo lại lần nữa ở màn khác.
 */
export function takeRejection(outcome: SubmitOutcome): string | null {
  if (outcome.status !== 'rejected') return null;
  const item = queue.getSnapshot().find((i) => i.eventId === outcome.eventId);
  void queue.dismiss(outcome.eventId);
  return item ? rejectedReason(item) : vi.errors.staff.state_conflict;
}
