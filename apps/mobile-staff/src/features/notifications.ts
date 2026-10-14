import type { NotificationView } from '@mihato/domain';
import { formatTime, vi, vnDateKey, type DateInput } from '@mihato/i18n';
import { notificationTarget, type NotificationTarget } from '../push/link';
import { dateTimeText } from './steps';

const t = vi.staff.notifications;

export type NotificationGroup = { key: 'today' | 'yesterday' | 'earlier'; title: string; items: NotificationView[] };

/** S7: chia tin theo Hôm nay, Hôm qua, Trước đó (theo ngày Việt Nam), giữ thứ tự mới nhất trước của máy chủ. */
export function groupNotifications(items: readonly NotificationView[], now: DateInput): NotificationGroup[] {
  const today = vnDateKey(now);
  const yesterday = vnDateKey((now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now)) - 86_400_000);
  const groups: NotificationGroup[] = [
    { key: 'today', title: t.today, items: [] },
    { key: 'yesterday', title: t.yesterday, items: [] },
    { key: 'earlier', title: t.earlier, items: [] },
  ];
  for (const item of items) {
    const day = vnDateKey(item.createdAt);
    const group = day === today ? groups[0] : day === yesterday ? groups[1] : groups[2];
    group?.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Giờ của một tin: tin hôm nay chỉ ghi giờ, tin cũ hơn ghi cả ngày. */
export function notificationTime(createdAt: string, now: DateInput): string {
  return vnDateKey(createdAt) === vnDateKey(now) ? formatTime(createdAt) : dateTimeText(createdAt);
}

/**
 * Nơi mà một tin dẫn tới: việc từ `stepId` của tin hoặc liên kết sâu `mihato://step/{id}` trong `payload.link`, và đoạn cần cuộn tới
 * (tin `comment_new` mở mục Thảo luận). Loại tin lấy từ `kind`, không có thì từ `payload.type`.
 */
export function notificationDestination(item: Pick<NotificationView, 'kind' | 'stepId' | 'payload'>): NotificationTarget | null {
  return notificationTarget({ type: item.kind || item.payload.type, link: item.payload.link, stepId: item.stepId });
}

/** Việc mà một tin dẫn tới. */
export function notificationStepId(item: Pick<NotificationView, 'kind' | 'stepId' | 'payload'>): string | null {
  return notificationDestination(item)?.stepId ?? null;
}
