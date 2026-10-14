import type { StepView } from '@mihato/domain';
import { fmtExecutive, formatDateFull, formatProgress, vi } from '@mihato/i18n';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { Glyph } from '@senior/Glyph';
import { LoadingText } from '@senior/Loading';
import { Notice, SectionTitle } from '@senior/Notice';
import { ProgressBar } from '@senior/ProgressBar';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorText } from '@senior/SeniorText';
import { StatusChip } from '@senior/StatusChip';
import { color, useSenior } from '@senior/theme';
import { errorMessage } from '@/api/errors';
import { useRun } from '@/data/queries';
import { createNamer, fullPersonName } from '@/features/address';
import { lateSteps, scheduleLine, stepChip } from '@/features/steps';
import { useDisplayPrefs, useOnline } from '@/hooks';
import { AppScreen } from '@/ui/AppScreen';
import { OfflineBanner } from '@/ui/Banners';

const t = vi.executive.runDetail;

function StepRow({ step, name, index }: { step: StepView; name: string | null; index: number }) {
  const m = useSenior();
  const chip = stepChip(step);
  const due = step.dueAt ? fmtExecutive(t.step.due, { hạn: formatDateFull(step.dueAt) }) : t.step.noDue;
  const who = name ? fmtExecutive(t.step.assignee, { người: name }) : t.step.unassigned;
  return (
    <SeniorCard tone="quiet" testID={`step-${index}`}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={fmtExecutive(t.step.a11y, { việc: step.title, người: name ?? t.step.unassigned, hạn: step.dueAt ? formatDateFull(step.dueAt) : t.step.noDue, 'trạng thái': chip.label })}
        style={{ gap: m.space.sm }}
      >
        <SeniorText variant="emphasis" weight="bold">
          {step.title}
        </SeniorText>
        <SeniorText testID={`step-${index}-assignee`}>
          {who}
          {step.onBehalfOf ? ` (${fmtExecutive(t.step.onBehalfOf, { người: fullPersonName(step.onBehalfOf) })})` : ''}
        </SeniorText>
        <SeniorText testID={`step-${index}-due`}>{step.state === 'done' && step.completedAt ? fmtExecutive(t.step.doneAt, { ngày: formatDateFull(step.completedAt) }) : due}</SeniorText>
        <StatusChip kind={chip.kind} label={chip.label} testID={`step-${index}-chip`} />
        {step.bucket === 'today' && chip.kind === 'open' ? (
          <SeniorText weight="semibold" tone="warn">
            {t.step.dueToday}
          </SeniorText>
        ) : null}
        {step.blockedReason ? <SeniorText tone="sub">{fmtExecutive(t.step.blocked, { 'lý do': step.blockedReason })}</SeniorText> : null}
        {step.pendingExtension ? <SeniorText tone="sub">{fmtExecutive(t.step.extensionPending, { hạn: formatDateFull(step.pendingExtension.proposedDueAt) })}</SeniorText> : null}
      </View>
    </SeniorCard>
  );
}

/**
 * M5 Chi tiết lượt chạy (SPEC 7.4): danh sách DỌC các việc, không dùng sơ đồ: tên việc, người nhận (lần đầu viết đủ
 * "chị Nguyễn Thu Lan", sau đó "chị Lan"), hạn viết đủ, trạng thái có hình kèm chữ.
 * Nút chính: **Nhờ trợ lý đi thúc những việc chậm**, mở M2 với câu đã soạn sẵn.
 */
export default function RunDetailScreen() {
  const m = useSenior();
  const { id } = useLocalSearchParams<{ id: string }>();
  const online = useOnline();
  const { address, assistantEnabled } = useDisplayPrefs();
  const query = useRun(id);
  const run = query.data;

  const late = run ? lateSteps(run.steps) : [];
  const namer = createNamer(run?.steps.map((s) => s.assignee) ?? []);
  const schedule = run ? scheduleLine(run) : null;
  const canNudge = run !== undefined && run.state === 'running' && late.length > 0 && assistantEnabled;

  return (
    <AppScreen
      title={run?.title}
      back
      banner={<OfflineBanner online={online} updatedAt={query.dataUpdatedAt} />}
      footer={
        canNudge ? (
          <SeniorButton
            icon="mic"
            label={t.nudgeLate}
            onPress={() => router.push({ pathname: '/assistant', params: { prefill: fmtExecutive(t.nudgePrefill, { lượt: run.title }) } })}
            testID="run-nudge-late"
          />
        ) : undefined
      }
      testID="screen-run"
    >
      {query.isPending ? <LoadingText address={address} /> : null}
      {query.isError && !run ? (
        <View style={{ gap: m.space.md }}>
          <Notice live>{errorMessage(query.error, address)}</Notice>
          <SeniorButton variant="secondary" label={vi.executive.status.retry} onPress={() => void query.refetch()} testID="run-retry" />
        </View>
      ) : null}

      {run && schedule ? (
        <>
          <View style={{ gap: m.space.md }}>
            <ProgressBar done={run.progress.done} total={run.progress.total} label={formatProgress(run.progress.done, run.progress.total)} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: m.space.sm }}>
              <Glyph name={schedule.late ? 'alert' : 'check'} size={Math.round(m.font.body)} tint={schedule.late ? color.lateText : color.primary} />
              <SeniorText weight="semibold" tone={schedule.late ? 'late' : 'primary'} style={{ flex: 1 }} testID="run-schedule">
                {schedule.label}
              </SeniorText>
            </View>
            {run.targetAt ? <SeniorText tone="sub">{fmtExecutive(t.target, { ngày: formatDateFull(run.targetAt) })}</SeniorText> : null}
            <SeniorText tone="sub">{fmtExecutive(t.startedBy, { người: fullPersonName(run.initiator) })}</SeniorText>
          </View>

          <SectionTitle>{t.stepsTitle}</SectionTitle>
          <View style={{ gap: m.space.betweenCards }}>
            {run.steps.map((step, i) => (
              <StepRow key={step.id} step={step} name={step.assignee ? namer(step.assignee) : null} index={i} />
            ))}
          </View>

          {run.state === 'running' && late.length === 0 ? <SeniorText tone="sub">{t.noLate}</SeniorText> : null}
          {run.state === 'running' && late.length > 0 && !assistantEnabled ? <Notice>{fmtExecutive(t.assistantOff, {}, address)}</Notice> : null}
        </>
      ) : null}
    </AppScreen>
  );
}
