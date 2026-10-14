import { fmt, vi } from '@mihato/i18n';
import { Redirect, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { errorMessage } from '@/api/errors';
import { useMe, useTeamSteps } from '@/data/queries';
import { OfflineBanner } from '@/features/StatusNotices';
import { StepCard } from '@/features/StepCard';
import { groupTodo } from '@/features/steps';
import { useNow } from '@/hooks';
import { AppText } from '@/ui/AppText';
import { EmptyState, ErrorState, LoadingState, SectionHeading } from '@/ui/Blocks';
import { Screen } from '@/ui/Screen';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.team;

type Filter = 'all' | 'overdue';

/**
 * S8 Nhóm của tôi (SPEC 8.2): chỉ hiện với trưởng đơn vị. Việc đang mở của người dưới quyền, nhóm Quá hạn trước.
 * Chạm một việc để xem chi tiết; ở đó có nút Đổi người nhận nếu máy chủ cho phép.
 */
export default function TeamScreen() {
  const me = useMe();
  const now = useNow();
  const isUnitHead = me.data?.isUnitHead === true;
  const query = useTeamSteps(isUnitHead);
  const [filter, setFilter] = useState<Filter>('all');
  const [pulling, setPulling] = useState(false);

  const items = query.data?.items;
  const groups = useMemo(() => {
    const all = items ? groupTodo(items) : [];
    return filter === 'overdue' ? all.filter((g) => g.bucket === 'overdue') : all;
  }, [items, filter]);

  if (me.data && !isUnitHead) return <Redirect href="/" />;

  const refresh = async () => {
    setPulling(true);
    await query.refetch();
    setPulling(false);
  };

  return (
    <Screen
      title={t.title}
      subtitle={t.overdueFirst}
      refreshing={pulling}
      onRefresh={() => void refresh()}
      top={
        <View style={styles.top}>
          <OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />
          <View style={styles.filters} accessibilityRole="radiogroup">
            {(['all', 'overdue'] as const).map((value) => {
              const selected = filter === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  accessibilityLabel={value === 'all' ? t.filterAll : t.filterOverdue}
                  onPress={() => setFilter(value)}
                  style={[styles.filter, selected && styles.filterOn]}
                  testID={`team-filter-${value}`}
                >
                  <AppText weight={selected ? 'bold' : 'medium'} tone={selected ? 'onPrimary' : 'text'}>
                    {value === 'all' ? t.filterAll : t.filterOverdue}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      }
      testID="screen-team"
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
        groups.map((group) => (
          <View key={group.bucket} style={styles.group}>
            <SectionHeading title={group.title} detail={fmt(vi.staff.myWork.groupCount, { n: group.steps.length })} />
            {group.steps.map((step) => (
              <StepCard key={step.id} step={step} now={now} queued={false} showAssignee onPress={() => router.push({ pathname: '/step/[id]', params: { id: step.id } })} />
            ))}
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: profile.space.screen, paddingBottom: space.md, gap: space.md },
  filters: { flexDirection: 'row', gap: space.sm },
  filter: {
    minHeight: profile.touch.min,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: profile.radius,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  filterOn: { backgroundColor: color.primary, borderColor: color.primary },
  group: { gap: profile.space.betweenCards },
});
