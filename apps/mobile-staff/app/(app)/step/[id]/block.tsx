import { BLOCK_REASON_CODES, type BlockReasonCode, type StepDetail } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StepFormShell, backToStep } from '@/features/StepFormShell';
import { flashOutcome, submitStepAction, takeRejection } from '@/features/submit';
import { AppText } from '@/ui/AppText';
import { Button } from '@/ui/Button';
import { ChoiceList, TextField } from '@/ui/Field';

const t = vi.staff.blocked;

const REASON_OPTIONS = BLOCK_REASON_CODES.map((value) => ({ value, label: t.reasons[value] }));

/**
 * S5 Báo vướng (SPEC 8.2): chọn một lý do mẫu (thiếu thông tin, chờ người khác, cần quyết định, khác) và ghi chú.
 * Tin gửi cho người giao và Văn phòng; trạng thái việc không đổi.
 */
export default function BlockScreen() {
  const { id, nudgeId } = useLocalSearchParams<{ id: string; nudgeId?: string }>();
  const [reasonCode, setReasonCode] = useState<BlockReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = async (step: StepDetail) => {
    if (!reasonCode) {
      setReasonError(t.reasonRequired);
      return;
    }
    setSending(true);
    setProblem(null);
    const outcome = await submitStepAction(step, { kind: 'block', reasonCode, note: note.trim() || undefined, nudgeId: nudgeId || undefined });
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
      footer={(step) => <Button label={t.send} busy={sending} onPress={() => void send(step)} testID="send" />}
      testID="screen-block"
    >
      {() => (
        <>
          <AppText tone="sub">{t.intro}</AppText>
          <ChoiceList
            label={t.reasonLabel}
            options={REASON_OPTIONS}
            value={reasonCode}
            onChange={(next) => {
              setReasonCode(next);
              setReasonError(null);
            }}
            error={reasonError}
          />
          <TextField label={t.noteLabel} value={note} onChangeText={setNote} placeholder={t.notePlaceholder} multiline maxLength={2000} testID="note" />
        </>
      )}
    </StepFormShell>
  );
}
