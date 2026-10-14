import { fmt, formatTime, vi, vnDateKey, type DateInput } from '@mihato/i18n';
import type { QueueItem } from '../offline/queue';
import { dateTimeText } from './steps';

const t = vi.staff.offline;

/**
 * Lý do bằng chữ khi máy chủ không nhận một thao tác đã xếp hàng (SPEC 8.4): việc đã xong từ trước,
 * lượt chạy đã hủy, việc đã chuyển cho người khác, hoặc tình trạng việc đã đổi. Hàm thuần, có test.
 */
export function rejectedReason(item: QueueItem): string {
  const vars = { việc: item.stepTitle, lượt: item.runTitle };
  switch (item.lastErrorCode) {
    case 'state_conflict':
      if (item.conflictState === 'done') return fmt(t.rejectedDone, vars);
      if (item.conflictState === 'cancelled') return fmt(t.rejectedCancelled, vars);
      return fmt(t.rejectedOther, vars);
    case 'not_found':
    case 'forbidden':
      // Việc ra khỏi tầm nhìn hoặc không còn quyền: việc đã được giao cho người khác.
      return fmt(t.rejectedReassigned, vars);
    default:
      return fmt(t.rejectedOther, vars);
  }
}

/** Tên thao tác đang chờ gửi hoặc bị từ chối: "Báo hoàn thành", "Xin thêm thời gian"… */
export function actionLabel(item: QueueItem): string {
  return vi.common.actions[item.action.kind];
}

/** "Đang không có mạng. Số liệu lúc 14:05." (`vi.common.offline`). Bản lưu của ngày khác thì ghi cả ngày. */
export function offlineText(updatedAt: DateInput, now: DateInput): string {
  const sameDay = vnDateKey(updatedAt) === vnDateKey(now);
  return fmt(vi.common.offline, { giờ: sameDay ? formatTime(updatedAt) : dateTimeText(updatedAt) });
}
