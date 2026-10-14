import type { NudgeView, StepAction, StepDetail } from '@mihato/domain';
import { fmt, formatLate, vi } from '@mihato/i18n';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { errorMessage } from '@/api/errors';
import { useStep } from '@/data/queries';
import { StepBadgeChips, StepDiscussion } from '@/features/StepComments';
import { focusFromParam } from '@/push/link';
import { StepRunSections } from '@/features/StepRunSections';
import { OfflineBanner, RejectedNotice } from '@/features/StatusNotices';
import { useChecklist } from '@/features/checklist';
import { historyLines, resultValueText } from '@/features/history';
import { actionLabel } from '@/features/queue-text';
import { dateTimeText, dueText, giverOf, personName, stepChips } from '@/features/steps';
import { flashOutcome, submitStepAction } from '@/features/submit';
import { useNow, useStepQueue } from '@/hooks';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Card, EmptyState, ErrorState, InfoList, InfoRow, LoadingState, SectionHeading } from '@/ui/Blocks';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { Glyph } from '@/ui/Glyph';
import { Screen } from '@/ui/Screen';
import { color, profile, space } from '@/ui/theme';

const t = vi.staff.stepDetail;

/** Lời nhắc do đi thúc, kèm ba nút trả lời nhanh (SPEC 4.7 bước 5). Mỗi nút chỉ hiện khi máy chủ cho phép thao tác tương ứng. */
function NudgeCard({ nudge, stepId, allowed }: { nudge: NudgeView; stepId: string; allowed: readonly StepAction[] }) {
  const go = (screen: 'complete' | 'extension' | 'block') => router.push({ pathname: `/step/[id]/${screen}`, params: { id: stepId, nudgeId: nudge.id } });
  return (
    <View style={styles.nudge} testID="nudge-card">
      <AppText variant="heading" tone="gold" accessibilityRole="header">
        {t.nudge.title}
      </AppText>
      <AppText>{nudge.message}</AppText>
      <View>
        <AppText variant="caption" weight="medium" testID="nudge-sender">
          {nudge.senderName}
        </AppText>
        {nudge.aiDisclosure ? (
          <AppText variant="caption" tone="sub" testID="nudge-ai">
            {nudge.aiDisclosure}
          </AppText>
        ) : null}
        <AppText variant="caption" tone="sub">
          {dateTimeText(nudge.sentAt)}
        </AppText>
      </View>
      <AppText weight="medium" style={styles.nudgeReplyTitle}>
        {t.nudge.replyTitle}
      </AppText>
      <View style={styles.nudgeReplies}>
        {allowed.includes('complete') ? <Button variant="secondary" label={t.nudge.replyDone} onPress={() => go('complete')} testID="nudge-reply-done" /> : null}
        {allowed.includes('requestExtension') ? <Button variant="secondary" label={t.nudge.replyNeedTime} onPress={() => go('extension')} testID="nudge-reply-need-time" /> : null}
        {allowed.includes('block') ? <Button variant="secondary" label={t.nudge.replyBlocked} onPress={() => go('block')} testID="nudge-reply-blocked" /> : null}
      </View>
    </View>
  );
}

/** Danh sách kiểm: mỗi mục một ô đánh dấu cao từ 48dp. Dấu tích chỉ lưu trên máy này. */
function Checklist({ stepId, items }: { stepId: string; items: readonly string[] }) {
  const { checked, toggle } = useChecklist(stepId);
  return (
    <View style={styles.section}>
      <SectionHeading title={t.checklist} detail={fmt(t.checklistProgress, { xong: checked.filter((i) => i < items.length).length, tổng: items.length })} />
      <Card style={styles.flush}>
        {items.map((item, index) => {
          const on = checked.includes(index);
          return (
            <Pressable
              key={`${index}-${item}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={item}
              onPress={() => toggle(index)}
              style={({ pressed }) => [styles.checkRow, index > 0 && styles.checkRowLine, pressed && styles.checkRowPressed]}
            >
              <View style={[styles.checkbox, on && styles.checkboxOn]}>{on ? <Glyph name="check" size={14} tint={color.onPrimary} /> : null}</View>
              <AppText style={styles.grow}>{item}</AppText>
            </Pressable>
          );
        })}
      </Card>
    </View>
  );
}

function History({ step }: { step: StepDetail }) {
  const lines = useMemo(() => historyLines(step), [step]);
  return (
    <View style={styles.section}>
      <SectionHeading title={t.history} />
      {lines.length === 0 ? (
        <AppText tone="sub">{t.historyEmpty}</AppText>
      ) : (
        <Card style={styles.flush}>
          {lines.map((line, index) => (
            <View key={line.key} style={[styles.historyRow, index > 0 && styles.checkRowLine]}>
              <AppText variant="caption" tone="sub">
                {dateTimeText(line.at)}
              </AppText>
              <AppText>{line.text}</AppText>
              {line.quote ? <AppText tone="sub">{line.quote}</AppText> : null}
              {line.aiNote ? (
                <AppText variant="caption" tone="sub">
                  {line.aiNote}
                </AppText>
              ) : null}
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

/**
 * S2 Chi tiết việc (SPEC 8.2). Nút CHỈ hiện theo `allowedActions` do máy chủ tính. Nút chính Báo hoàn thành
 * nằm cố định ở đáy, luôn trong màn hình đầu tiên. Việc loại duyệt chuyển sang S6.
 */
export default function StepDetailScreen() {
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  const now = useNow();
  const query = useStep(id);
  // Mở từ thông báo bình luận: cuộn tới mục Thảo luận.
  const [discussionY, setDiscussionY] = useState<number | null>(null);
  const { pending, rejected } = useStepQueue(id);
  const [accepting, setAccepting] = useState(false);
  const step = query.data;

  if (!step) {
    return (
      <Screen title={t.title} back testID="screen-step">
        <OfflineBanner updatedAt={undefined} />
        {rejected.map((item) => (
          <RejectedNotice key={item.eventId} item={item} />
        ))}
        {query.isError ? <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : query.fetchStatus === 'paused' ? <EmptyState text={vi.staff.feedback.offlineNoData} /> : <LoadingState />}
      </Screen>
    );
  }

  const allowed = step.allowedActions;
  // Việc loại duyệt đang chờ mình quyết: sang màn Duyệt (S6).
  if (step.kind === 'approval' && (allowed.includes('approve') || allowed.includes('reject'))) {
    return <Redirect href={{ pathname: '/step/[id]/approve', params: focusFromParam(focus) ? { id: step.id, focus: 'comments' } : { id: step.id } }} />;
  }

  const pendingKinds = new Set(pending.map((i) => i.action.kind));
  const completing = pendingKinds.has('complete');
  // Thao tác đã xếp hàng chờ gửi thì không mời bấm lại; đã báo hoàn thành thì ẩn hết các nút còn lại.
  const can = (action: 'accept' | 'complete' | 'requestExtension' | 'block') => allowed.includes(action) && !completing && !pendingKinds.has(action);

  const accept = async () => {
    setAccepting(true);
    const outcome = await submitStepAction(step, { kind: 'accept' });
    setAccepting(false);
    flashOutcome(outcome, t.accepted);
  };

  const go = (screen: 'complete' | 'extension' | 'block' | 'reassign') => router.push({ pathname: `/step/[id]/${screen}`, params: { id: step.id } });

  // Việc duyệt hoặc đóng góp: người giao là người đứng ngay trước (người đề nghị), không có thì người khởi chạy.
  const isApproval = step.kind === 'approval';
  const giverInfo = giverOf(step);
  const giver = personName(giverInfo.person);
  // Việc duyệt hoặc đóng góp có nhiều người cùng làm: `assignee` chỉ là người đứng đầu danh sách nên không nêu ở đây (có mục "Người cùng gửi phần").
  const assignee = isApproval ? null : personName(step.assignee);
  const onBehalfOf = personName(step.onBehalfOf);
  const done = step.state === 'done';
  const dueChanged = step.dueAt !== null && step.dueOriginalAt !== null && step.dueAt !== step.dueOriginalAt;
  const secondary = can('accept') || can('requestExtension') || can('block') || allowed.includes('reassign');

  return (
    <Screen
      title={t.title}
      back
      refreshing={query.isRefetching && !query.isPlaceholderData}
      onRefresh={() => void query.refetch()}
      keyboard
      scrollToY={focusFromParam(focus) ? discussionY : null}
      footer={can('complete') ? <Button label={t.actions.complete} onPress={() => go('complete')} testID="action-complete" /> : undefined}
      testID="screen-step"
    >
      <OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />

      {rejected.map((item) => (
        <RejectedNotice key={item.eventId} item={item} />
      ))}

      {pending.length > 0 ? (
        <Banner tone="waiting" glyph="send" title={vi.staff.offline.queuedChip} testID="step-queued">
          <AppText>{pending.map(actionLabel).join(', ')}</AppText>
          <AppText variant="caption" tone="sub">
            {vi.staff.offline.queuedHint}
          </AppText>
        </Banner>
      ) : null}

      {step.openNudge ? <NudgeCard nudge={step.openNudge} stepId={step.id} allowed={completing ? [] : allowed} /> : null}

      <Card testID="step-summary">
        <AppText variant="screenTitle" weight="semibold" accessibilityRole="header" testID="step-title">
          {step.title}
        </AppText>
        <View style={styles.chips}>
          {stepChips(step, { queued: pending.length > 0 }).map((chip) => (
            <Chip key={chip.key} label={chip.label} tone={chip.tone} glyph={chip.glyph} testID={`chip-${chip.key}`} />
          ))}
          <StepBadgeChips step={step} />
        </View>
        <InfoList>
          {step.adhoc ? <InfoRow label={t.kind}>{t.adhocKind}</InfoRow> : <InfoRow label={t.run}>{step.runTitle}</InfoRow>}
          <InfoRow label={t.due}>
            <AppText weight="medium" tone={step.isOverdue ? 'late' : 'text'}>
              {step.dueAt ? dueText(step.dueAt, now) : t.noDue}
            </AppText>
            {step.isOverdue ? <AppText tone="late">{formatLate(step.lateWorkingDays)}</AppText> : null}
          </InfoRow>
          {dueChanged && step.dueOriginalAt ? <InfoRow label={t.dueOriginal}>{dateTimeText(step.dueOriginalAt)}</InfoRow> : null}
          {giver ? <InfoRow label={t[giverInfo.label]}>{giver}</InfoRow> : null}
          {assignee ? (
            <InfoRow label={t.assignee}>
              <AppText>{assignee}</AppText>
              {onBehalfOf ? (
                <AppText variant="caption" tone="sub">
                  {fmt(t.onBehalfOf, { người: onBehalfOf })}
                </AppText>
              ) : null}
            </InfoRow>
          ) : null}
        </InfoList>
      </Card>

      {secondary ? (
        <View style={styles.actions}>
          {can('accept') ? <Button variant="secondary" label={t.actions.accept} busy={accepting} onPress={() => void accept()} style={styles.action} testID="action-accept" /> : null}
          {can('requestExtension') ? <Button variant="secondary" label={t.actions.requestExtension} onPress={() => go('extension')} style={styles.action} testID="action-extension" /> : null}
          {can('block') ? <Button variant="secondary" label={t.actions.block} onPress={() => go('block')} style={styles.action} testID="action-block" /> : null}
          {allowed.includes('reassign') ? <Button variant="secondary" label={vi.staff.team.reassign} onPress={() => go('reassign')} style={styles.action} testID="action-reassign" /> : null}
        </View>
      ) : null}

      {done && step.completedAt ? <Banner tone="done">{fmt(t.doneBanner, { giờ: dateTimeText(step.completedAt) })}</Banner> : null}
      {step.state === 'cancelled' ? <Banner tone="info">{t.runCancelled}</Banner> : null}
      {step.state === 'pending' ? <Banner tone="info">{t.waitingPrevious}</Banner> : null}
      {step.pendingExtension ? (
        <Banner tone="waiting" testID="extension-pending">
          <AppText>{fmt(t.extensionPending, { hạn: dateTimeText(step.pendingExtension.proposedDueAt) })}</AppText>
          <AppText tone="sub">{step.pendingExtension.reason}</AppText>
        </Banner>
      ) : null}
      {step.blockedReason ? <Banner tone="info">{fmt(t.blockedBanner, { 'lý do': step.blockedReason })}</Banner> : null}

      <View style={styles.section}>
        <SectionHeading title={t.description} />
        <AppText tone={step.description ? 'text' : 'sub'}>{step.description || t.noDescription}</AppText>
      </View>

      {step.checklist.length > 0 ? <Checklist stepId={step.id} items={step.checklist} /> : null}

      <StepRunSections step={step} />

      {!isApproval && step.form.length > 0 ? (
        <View style={styles.section}>
          <SectionHeading title={t.resultForm} />
          <Card style={styles.flush}>
            {step.form.map((field, index) => {
              const value = resultValueText(field, step.result?.[field.key]);
              return (
                <View key={field.key} style={[styles.historyRow, index > 0 && styles.checkRowLine]}>
                  <AppText variant="caption" tone="sub">
                    {field.required ? fmt(vi.staff.complete.requiredField, { tên: field.label }) : field.label}
                  </AppText>
                  <AppText tone={value ? 'text' : 'sub'}>{value ?? vi.staff.complete.notFilled}</AppText>
                </View>
              );
            })}
          </Card>
        </View>
      ) : null}

      <StepDiscussion step={step} onLayoutY={setDiscussionY} />

      <History step={step} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: profile.space.betweenButtons },
  action: { flexGrow: 1 },
  section: { gap: space.sm },
  flush: { paddingVertical: space.xs, gap: 0 },
  grow: { flex: 1 },
  nudge: {
    backgroundColor: color.goldTint,
    borderRadius: profile.radius,
    borderWidth: profile.borderWidth,
    borderColor: color.gold,
    padding: profile.space.cardPadding,
    gap: space.xs,
  },
  nudgeReplyTitle: { marginTop: space.sm },
  nudgeReplies: { gap: profile.space.betweenButtons, marginTop: space.xs },
  checkRow: { minHeight: profile.touch.min, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  checkRowLine: { borderTopWidth: 1, borderTopColor: color.hairline },
  checkRowPressed: { backgroundColor: color.primaryTint },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: color.border, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface },
  checkboxOn: { backgroundColor: color.primary, borderColor: color.primary },
  historyRow: { paddingVertical: space.sm + 2, gap: 2 },
});
