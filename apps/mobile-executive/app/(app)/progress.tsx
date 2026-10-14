import type { RunSummary } from '@mihato/domain';
import { fmtExecutive, formatProgress, formatTimeSpoken, vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Glyph } from '@senior/Glyph';
import { LoadingText } from '@senior/Loading';
import { Notice, SectionTitle } from '@senior/Notice';
import { ProgressBar } from '@senior/ProgressBar';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorText } from '@senior/SeniorText';
import { color, useSenior } from '@senior/theme';
import { errorMessage } from '@/api/errors';
import { useOverview, useRunningRuns } from '@/data/queries';
import { createNamer } from '@/features/address';
import { ATTENTION_PREVIEW, attentionPreview, scheduleLine, sortRuns } from '@/features/steps';
import { useDisplayPrefs, useOnline } from '@/hooks';
import { AppScreen } from '@/ui/AppScreen';
import { OfflineBanner } from '@/ui/Banners';

const t = vi.executive.progress;

function RunCard({ run, index }: { run: RunSummary; index: number }) {
  const m = useSenior();
  const schedule = scheduleLine(run);
  const progressText = formatProgress(run.progress.done, run.progress.total);
  return (
    <SeniorCard
      onPress={() => router.push({ pathname: '/run/[id]', params: { id: run.id } })}
      accessibilityLabel={fmtExecutive(t.card.a11y, { lượt: run.title, 'tiến độ': progressText, 'trạng thái': schedule.label })}
      testID={`run-card-${index}`}
    >
      <View style={{ gap: m.space.md }}>
        <SeniorText variant="cardTitle">{run.title}</SeniorText>
        <ProgressBar done={run.progress.done} total={run.progress.total} label={progressText} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.space.sm }}>
          {/* Đỏ nâu và dấu cảnh báo chỉ dùng khi lượt đang chậm; luôn kèm chữ. */}
          <Glyph name={schedule.late ? 'alert' : 'check'} size={Math.round(m.font.body)} tint={schedule.late ? color.lateText : color.primary} />
          <SeniorText weight="semibold" tone={schedule.late ? 'late' : 'primary'} style={{ flex: 1 }} testID={`run-card-${index}-schedule`}>
            {schedule.label}
          </SeniorText>
        </View>
      </View>
    </SeniorCard>
  );
}

/**
 * M4 Tiến độ (SPEC 7.4): đầu danh sách là mục **Cần Chủ tịch biết** khi có việc quá hạn từ 3 ngày làm việc; rồi tới
 * thẻ từng lượt đang chạy: tên, thanh tiến độ kèm chữ, dòng trạng thái bằng chữ. Mất mạng thì hiện bản lưu gần nhất
 * kèm giờ cập nhật. Màn này không đi qua AI nên vẫn dùng được khi trợ lý tạm nghỉ.
 */
export default function ProgressScreen() {
  const m = useSenior();
  const online = useOnline();
  const { address } = useDisplayPrefs();
  const overview = useOverview();
  const runs = useRunningRuns();
  const [showAllAttention, setShowAllAttention] = useState(false);

  const attention = overview.data?.needsAttention ?? [];
  const namer = createNamer(attention.map((s) => s.assignee));
  const sortedAttention = [...attention].sort((a, b) => b.lateWorkingDays - a.lateWorkingDays);
  const preview = attentionPreview(attention, showAllAttention);
  const running = sortRuns(runs.data?.items ?? []);
  const finished = overview.data?.recentlyCompletedRuns ?? [];
  const updatedAt = Math.min(runs.dataUpdatedAt || Infinity, overview.dataUpdatedAt || Infinity);
  const stale = Number.isFinite(updatedAt) ? updatedAt : 0;

  return (
    <AppScreen tab="progress" title={t.title} banner={<OfflineBanner online={online} updatedAt={stale} />} testID="screen-progress">
      {runs.isPending ? <LoadingText address={address} /> : null}

      {runs.isError && !runs.data ? (
        <View style={{ gap: m.space.md }}>
          <Notice live>{errorMessage(runs.error, address)}</Notice>
          <SeniorButton variant="secondary" label={t.refresh} onPress={() => void runs.refetch()} testID="progress-retry" />
        </View>
      ) : null}

      {sortedAttention.length > 0 ? (
        <SeniorCard tone="late" testID="progress-need-to-know">
          <View style={{ gap: m.space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.space.sm }}>
              <Glyph name="alert" size={Math.round(m.font.cardTitle)} tint={color.lateText} />
              <SeniorText variant="cardTitle" tone="late" accessibilityRole="header" style={{ flex: 1 }}>
                {fmtExecutive(t.needToKnow.title, {}, address)}
              </SeniorText>
            </View>
            <SeniorText weight="semibold" tone="late">
              {fmtExecutive(t.needToKnow.body, { n: sortedAttention.length })}
            </SeniorText>
            {preview.shown.map((step) => (
              <SeniorText key={step.id} tone="late">
                {step.assignee
                  ? fmtExecutive(t.needToKnow.lineInRun, { việc: step.title, người: namer(step.assignee), lượt: step.runTitle, n: step.lateWorkingDays })
                  : fmtExecutive(t.needToKnow.lineNoOneInRun, { việc: step.title, lượt: step.runTitle, n: step.lateWorkingDays })}
              </SeniorText>
            ))}
            {sortedAttention.length > ATTENTION_PREVIEW ? (
              <>
                {preview.hidden > 0 ? <SeniorText tone="late">{fmtExecutive(t.needToKnow.more, { n: preview.hidden })}</SeniorText> : null}
                <SeniorButton variant="secondary" label={showAllAttention ? t.needToKnow.collapse : t.needToKnow.open} onPress={() => setShowAllAttention((v) => !v)} testID="progress-need-to-know-toggle" />
              </>
            ) : null}
          </View>
        </SeniorCard>
      ) : null}

      {runs.data ? (
        running.length > 0 ? (
          <View style={{ gap: m.space.betweenCards }}>
            <SectionTitle>{t.groups.running}</SectionTitle>
            {running.map((run, i) => (
              <RunCard key={run.id} run={run} index={i} />
            ))}
          </View>
        ) : (
          <SeniorCard tone="quiet" testID="progress-empty">
            <SeniorText tone="sub">{t.empty}</SeniorText>
          </SeniorCard>
        )
      ) : null}

      {finished.length > 0 ? (
        <View style={{ gap: m.space.betweenCards }}>
          <SectionTitle>{t.groups.finished}</SectionTitle>
          {finished.map((run, i) => (
            <RunCard key={run.id} run={run} index={running.length + i} />
          ))}
        </View>
      ) : null}

      {runs.data && online && stale ? (
        <SeniorText variant="caption" tone="sub" testID="progress-updated">
          {fmtExecutive(t.updatedAt, { giờ: formatTimeSpoken(stale) })}
        </SeniorText>
      ) : null}
    </AppScreen>
  );
}
