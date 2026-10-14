import { fmt, formatDateWeekday, vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { errorMessage } from '@/api/errors';
import { useAwaitingSteps, useMySteps } from '@/data/queries';
import { OfflineBanner, QueueNotices } from '@/features/StatusNotices';
import { StepCard } from '@/features/StepCard';
import { groupTodo } from '@/features/steps';
import { useNow, useQueueItems } from '@/hooks';
import { AppText } from '@/ui/AppText';
import { EmptyState, ErrorState, LoadingState, SectionHeading } from '@/ui/Blocks';
import { Screen } from '@/ui/Screen';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.myWork;

type Tab = 'todo' | 'done';

/** Hai tab Cần làm và Đã xong: mục đang chọn có nền xanh và chữ đậm, và báo `selected` cho trình đọc màn hình. */
function TabSwitch({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  return (
    <View style={styles.switch} accessibilityRole="tablist">
      {(['todo', 'done'] as const).map((tab) => {
        const selected = tab === value;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={t.tabs[tab]}
            onPress={() => onChange(tab)}
            style={[styles.switchItem, selected && styles.switchItemOn]}
            testID={`mywork-tab-${tab}`}
          >
            <AppText weight={selected ? 'bold' : 'medium'} tone={selected ? 'onPrimary' : 'text'}>
              {t.tabs[tab]}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * S1 Việc của tôi (SPEC 8.2): biết việc nào trước. Tab Cần làm chia nhóm Quá hạn, Hôm nay, Sắp tới theo
 * `bucket` của máy chủ, sắp theo hạn. Kéo để làm mới; tự làm mới mỗi 60 giây và khi app trở lại nền trước.
 */
export default function MyWorkScreen() {
  const [tab, setTab] = useState<Tab>('todo');
  const now = useNow();
  const query = useMySteps(tab);
  const awaiting = useAwaitingSteps(tab === 'done');
  const queueItems = useQueueItems();
  const [pulling, setPulling] = useState(false);

  const queuedStepIds = useMemo(() => new Set(queueItems.filter((i) => i.status === 'pending').map((i) => i.stepId)), [queueItems]);
  const items = query.data?.items;
  const groups = useMemo(() => (tab === 'todo' && items ? groupTodo(items) : []), [tab, items]);

  const refresh = async () => {
    setPulling(true);
    await Promise.all([query.refetch(), tab === 'done' ? awaiting.query.refetch() : undefined]);
    setPulling(false);
  };

  const open = (id: string) => router.push({ pathname: '/step/[id]', params: { id } });

  let body;
  if (!items) {
    if (query.isError) body = <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
    else if (query.fetchStatus === 'paused') body = <EmptyState text={vi.staff.feedback.offlineNoData} />;
    else body = <LoadingState />;
  } else if (tab === 'todo') {
    body =
      groups.length === 0 ? (
        <EmptyState text={t.emptyTodo} />
      ) : (
        groups.map((group) => (
          <View key={group.bucket} style={styles.group} testID={`group-${group.bucket}`}>
            <SectionHeading title={group.title} detail={fmt(t.groupCount, { n: group.steps.length })} />
            {group.steps.map((step) => (
              <StepCard key={step.id} step={step} now={now} queued={queuedStepIds.has(step.id)} onPress={() => open(step.id)} />
            ))}
          </View>
        ))
      );
  } else {
    // Việc đã gửi phần của mình mà còn mở vì người khác chưa gửi nằm trên cùng, rồi tới việc đã xong gần đây.
    const waiting = awaiting.items;
    body =
      items.length === 0 && waiting.length === 0 ? (
        <EmptyState text={t.emptyDone} />
      ) : (
        <>
          {waiting.length > 0 ? (
            <View style={styles.group} testID="group-awaiting">
              <SectionHeading title={t.groups.awaiting} detail={fmt(t.groupCount, { n: waiting.length })} />
              {waiting.map((step) => (
                <StepCard key={step.id} step={step} now={now} queued={queuedStepIds.has(step.id)} awaitingOthers onPress={() => open(step.id)} />
              ))}
            </View>
          ) : null}
          {items.length > 0 ? (
            <View style={styles.group} testID="group-done">
              {waiting.length > 0 ? <SectionHeading title={t.groups.recentDone} detail={fmt(t.groupCount, { n: items.length })} /> : null}
              {items.map((step) => (
                <StepCard key={step.id} step={step} now={now} queued={queuedStepIds.has(step.id)} onPress={() => open(step.id)} />
              ))}
            </View>
          ) : null}
        </>
      );
  }

  return (
    <Screen
      title={t.title}
      subtitle={formatDateWeekday(now)}
      refreshing={pulling}
      onRefresh={() => void refresh()}
      top={
        <View style={styles.top}>
          <OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />
          <TabSwitch value={tab} onChange={setTab} />
        </View>
      }
      testID="screen-mywork"
    >
      <QueueNotices />
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: profile.space.screen, paddingBottom: space.md, gap: space.md },
  switch: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: profile.radius,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  switchItem: { flex: 1, minHeight: profile.touch.min, alignItems: 'center', justifyContent: 'center', borderRadius: profile.radius - 3, paddingHorizontal: space.sm },
  switchItemOn: { backgroundColor: color.primary },
  group: { gap: profile.space.betweenCards },
});
