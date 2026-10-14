import type { NotificationView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { useFocusEffect, router } from 'expo-router';
import * as Linking from 'expo-linking';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { errorMessage } from '@/api/errors';
import { keys, useNotifications } from '@/data/queries';
import { OfflineBanner } from '@/features/StatusNotices';
import { groupNotifications, notificationDestination, notificationTime } from '@/features/notifications';
import { stepRouteParams } from '@/push/link';
import { useNow } from '@/hooks';
import { pushPermission, type PushPermission } from '@/push/push';
import { api, queryClient } from '@/services';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { EmptyState, ErrorState, LoadingState, SectionHeading } from '@/ui/Blocks';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { Screen } from '@/ui/Screen';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.notifications;

function NotificationRow({ item, now, onPress }: { item: NotificationView; now: number; onPress: () => void }) {
  const unread = item.readAt === null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? t.unread : t.read}. ${item.title}. ${item.body}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, unread && styles.rowUnread, pressed && styles.pressed]}
      testID={`notification-${item.id}`}
    >
      <AppText weight={unread ? 'semibold' : 'regular'}>{item.title}</AppText>
      {item.body ? <AppText tone="sub">{item.body}</AppText> : null}
      <View style={styles.rowFoot}>
        <AppText variant="caption" tone="sub">
          {notificationTime(item.createdAt, now)}
        </AppText>
        {unread ? <Chip label={t.unread} tone="neutral" /> : null}
      </View>
    </Pressable>
  );
}

/** S7 Thông báo (SPEC 8.2): danh sách theo thời gian, đánh dấu đã đọc, chạm tin mở đúng việc. */
export default function NotificationsScreen() {
  const now = useNow();
  const query = useNotifications();
  const [permission, setPermission] = useState<PushPermission>('unavailable');
  const [pulling, setPulling] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void pushPermission(false).then(setPermission);
    }, []),
  );

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items), [query.data]);
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;
  const groups = useMemo(() => (items ? groupNotifications(items, now) : []), [items, now]);

  const markRead = async (body: { ids: string[] } | { all: true }) => {
    try {
      await api.call('notifications.read', { body });
    } catch {}
    // Mất mạng thì tin vẫn hiện "Chưa đọc"; lần tải sau sẽ đúng lại.
    void queryClient.invalidateQueries({ queryKey: keys.notifications });
  };

  const open = (item: NotificationView) => {
    if (item.readAt === null) void markRead({ ids: [item.id] });
    const target = notificationDestination(item);
    if (target) router.push({ pathname: '/step/[id]', params: stepRouteParams(target) });
  };

  const refresh = async () => {
    setPulling(true);
    await query.refetch();
    setPulling(false);
  };

  return (
    <Screen
      title={t.title}
      refreshing={pulling}
      onRefresh={() => void refresh()}
      top={
        <View style={styles.top}>
          <OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />
          {permission === 'denied' ? (
            <Banner tone="info">
              <AppText>{t.permissionOff}</AppText>
              <Button variant="secondary" label={t.openSettings} onPress={() => void Linking.openSettings().catch(() => undefined)} />
            </Banner>
          ) : null}
          {unreadCount > 0 ? <Button variant="secondary" label={t.markAllRead} onPress={() => void markRead({ all: true })} testID="mark-all-read" /> : null}
        </View>
      }
      testID="screen-notifications"
    >
      {!items ? (
        query.isError ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : query.fetchStatus === 'paused' ? (
          <EmptyState text={vi.staff.feedback.offlineNoData} />
        ) : (
          <LoadingState />
        )
      ) : groups.length === 0 ? (
        <EmptyState text={t.empty} />
      ) : (
        <>
          {groups.map((group) => (
            <View key={group.key} style={styles.group}>
              <SectionHeading title={group.title} />
              {group.items.map((item) => (
                <NotificationRow key={item.id} item={item} now={now} onPress={() => open(item)} />
              ))}
            </View>
          ))}
          {query.hasNextPage ? <Button variant="secondary" label={t.loadMore} busy={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()} /> : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: profile.space.screen, paddingBottom: space.md, gap: space.md },
  group: { gap: space.sm },
  row: {
    minHeight: profile.touch.min,
    backgroundColor: color.surface,
    borderWidth: profile.borderWidth,
    borderColor: color.hairline,
    borderRadius: profile.radius,
    padding: space.md,
    gap: space.xs,
  },
  // Tin chưa đọc: viền đậm hơn, chữ đậm, và chip "Chưa đọc"; không chỉ khác màu.
  rowUnread: { borderColor: color.border, borderLeftWidth: 4, borderLeftColor: color.primary },
  pressed: { backgroundColor: color.primaryTint },
  rowFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, marginTop: 2 },
});
