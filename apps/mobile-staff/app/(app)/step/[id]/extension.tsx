import type { StepDetail } from '@mihato/domain';
import { fmt, formatDateWeekday, formatTime, vi, vnDateKey } from '@mihato/i18n';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useWorkCalendar } from '@/data/queries';
import { StepFormShell, backToStep } from '@/features/StepFormShell';
import { isDayOff, noonOf } from '@/features/calendar';
import { dateTimeText, minExtensionDate, proposedDueAt } from '@/features/steps';
import { flashOutcome, submitStepAction, takeRejection } from '@/features/submit';
import { useNow } from '@/hooks';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { DateGrid } from '@/ui/DateGrid';
import { ChoiceList, Field, TextField } from '@/ui/Field';

const t = vi.staff.extension;

const REASONS = ['waitingInput', 'moreWork', 'otherPriority', 'absent', 'other'] as const;
type ReasonKey = (typeof REASONS)[number];
const REASON_OPTIONS = REASONS.map((value) => ({ value, label: t.reasons[value] }));

/**
 * S4 Xin thêm thời gian (SPEC 8.2): chọn hạn mới trên lưới ngày, chọn lý do mẫu hoặc gõ. Hạn mới giữ giờ trong ngày
 * của hạn hiện tại. Gửi xong, việc hiện chip "Chờ duyệt" cho tới khi người giao quyết.
 */
export default function ExtensionScreen() {
  const { id, nudgeId } = useLocalSearchParams<{ id: string; nudgeId?: string }>();
  const now = useNow();
  const today = vnDateKey(now);
  const calendar = useWorkCalendar(Number(today.slice(0, 4)));
  // Việc chưa có hạn thì hạn đề nghị rơi vào giờ tan làm của tổ chức.
  const endOfDay = calendar?.workEnd ?? '17:00';
  const [day, setDay] = useState<string | null>(null);
  const [reasonKey, setReasonKey] = useState<ReasonKey | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [errors, setErrors] = useState<{ day?: string; reason?: string }>({});
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = async (step: StepDetail) => {
    const typed = reasonText.trim();
    // Lý do mẫu đi kèm phần gõ thêm; chọn "Lý do khác" thì bắt buộc gõ.
    const reason = reasonKey && reasonKey !== 'other' ? (typed ? `${t.reasons[reasonKey]}. ${typed}` : t.reasons[reasonKey]) : typed;
    const nextErrors = { day: day ? undefined : t.dayRequired, reason: reason ? undefined : t.reasonRequired };
    setErrors(nextErrors);
    if (!day || !reason) return;

    setSending(true);
    setProblem(null);
    const outcome = await submitStepAction(step, { kind: 'requestExtension', proposedDueAt: proposedDueAt(day, step.dueAt, endOfDay), reason, nudgeId: nudgeId || undefined });
    setSending(false);

    const rejection = takeRejection(outcome);
    if (rejection) {
      setProblem(rejection);
      return;
    }
    flashOutcome(outcome, t.sent);
    backToStep(step.id);
  };

  return (
    <StepFormShell
      stepId={id}
      title={t.title}
      problem={problem}
      footer={(step) => (step.pendingExtension ? null : <Button label={t.send} busy={sending} onPress={() => void send(step)} testID="send" />)}
      testID="screen-extension"
    >
      {(step) =>
        step.pendingExtension ? (
          <Banner tone="waiting" testID="extension-already">
            <AppText>{t.alreadyPending}</AppText>
            <AppText tone="sub">{fmt(vi.staff.stepDetail.extensionPending, { hạn: dateTimeText(step.pendingExtension.proposedDueAt) })}</AppText>
          </Banner>
        ) : (
          <>
            <AppText>{step.dueAt ? fmt(t.currentDue, { hạn: dateTimeText(step.dueAt) }) : vi.staff.stepDetail.noDue}</AppText>
            <Field label={t.newDueLabel} error={errors.day}>
              <DateGrid
                value={day}
                min={minExtensionDate(step.dueAt, now)}
                today={today}
                isOff={(d) => isDayOff(d, calendar)}
                onOffPress={() => setErrors((e) => ({ ...e, day: t.notWorkingDay }))}
                onChange={(next) => {
                  setDay(next);
                  setErrors((e) => ({ ...e, day: undefined }));
                }}
              />
              {day ? (
                <AppText weight="semibold" accessibilityLiveRegion="polite" testID="extension-picked">
                  {fmt(vi.staff.format.dayTime, { ngày: formatDateWeekday(noonOf(day)), giờ: step.dueAt ? formatTime(step.dueAt) : endOfDay })}
                </AppText>
              ) : errors.day ? null : (
                <AppText variant="caption" tone="sub">
                  {t.pickDate}
                </AppText>
              )}
            </Field>
            <ChoiceList
              label={t.reasonLabel}
              options={REASON_OPTIONS}
              value={reasonKey}
              onChange={(next) => {
                setReasonKey(next);
                setErrors((e) => ({ ...e, reason: undefined }));
              }}
              error={errors.reason}
            />
            <TextField label={t.reasonDetailLabel} value={reasonText} onChangeText={setReasonText} placeholder={t.reasonPlaceholder} multiline maxLength={1500} testID="reason" />
          </>
        )
      }
    </StepFormShell>
  );
}
