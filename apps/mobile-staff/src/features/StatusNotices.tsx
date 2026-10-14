import { fmt, vi } from '@mihato/i18n';
import { View } from 'react-native';
import { useNow, useOnline, useQueueItems } from '../hooks';
import { noteOf, type QueueItem } from '../offline/queue';
import { queue } from '../services';
import { AppText } from '../ui/AppText';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { space } from '../ui/theme';
import { actionLabel, offlineText, rejectedReason } from './queue-text';

const t = vi.staff.offline;

/**
 * Dải "đang không có mạng" kèm giờ của bản lưu đang hiện (SPEC 8.4). Chỉ hiện khi mất mạng.
 * `updatedAt` là giờ tải thành công gần nhất của dữ liệu trên màn (dataUpdatedAt của TanStack Query).
 */
export function OfflineBanner({ updatedAt }: { updatedAt: number | undefined }) {
  const online = useOnline();
  const now = useNow();
  if (online) return null;
  return (
    <Banner tone="info" live testID="offline-banner">
      {updatedAt ? offlineText(updatedAt, now) : vi.staff.feedback.offlineNoData}
    </Banner>
  );
}

/** Một thao tác máy chủ không nhận: lý do bằng chữ, ghi chú đã nhập được giữ lại, và nút "Đã rõ". */
export function RejectedNotice({ item }: { item: QueueItem }) {
  const note = noteOf(item.action);
  return (
    <Banner tone="info" title={t.rejectedTitle} live testID="queue-rejected">
      <AppText>{rejectedReason(item)}</AppText>
      <AppText variant="caption" tone="sub">
        {fmt(t.actionLine, { tên: actionLabel(item) })}
      </AppText>
      {note ? (
        <View style={{ gap: space.xs }}>
          <AppText variant="caption" tone="sub">
            {t.noteKept}
          </AppText>
          <AppText selectable testID="queue-rejected-note">
            {note}
          </AppText>
        </View>
      ) : null}
      <Button variant="secondary" label={t.dismiss} onPress={() => void queue.dismiss(item.eventId)} testID="queue-dismiss" />
    </Banner>
  );
}

/** Đầu màn Việc của tôi: số thao tác đang chờ gửi, và mọi thao tác chưa thực hiện được. */
export function QueueNotices() {
  const items = useQueueItems();
  const pending = items.filter((i) => i.status === 'pending').length;
  const rejected = items.filter((i) => i.status === 'rejected');
  if (pending === 0 && rejected.length === 0) return null;
  return (
    <View style={{ gap: space.md }}>
      {pending > 0 ? (
        <Banner tone="waiting" glyph="send" title={fmt(t.queuedCount, { n: pending })} testID="queue-pending">
          {t.queuedHint}
        </Banner>
      ) : null}
      {rejected.map((item) => (
        <RejectedNotice key={item.eventId} item={item} />
      ))}
    </View>
  );
}
