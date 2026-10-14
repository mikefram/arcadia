import { newId, type StepDetail } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { errorMessage } from '@/api/errors';
import { useStepAssignees } from '@/data/queries';
import { PersonPicker, type PickedPerson } from '@/features/PersonPicker';
import { StepFormShell, backToStep } from '@/features/StepFormShell';
import { IdempotencyKeys } from '@/features/idempotency';
import { personName } from '@/features/steps';
import { useOnline } from '@/hooks';
import { api, applyStepResult } from '@/services';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/Field';
import { showFlash } from '@/ui/Flash';

const t = vi.staff.team;

/**
 * Đổi người nhận (SPEC 8.2 S8, `POST /v1/steps/:id/reassign`): trưởng đơn vị chọn một người trong đơn vị mình,
 * bắt buộc ghi lý do. Máy chủ kiểm quyền và đơn vị; app chỉ hiện nút khi `allowedActions` có `reassign`.
 */
export default function ReassignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const online = useOnline();
  const [person, setPerson] = useState<PickedPerson | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ person?: string; reason?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Khoá giữ qua lỗi mạng và 5xx, đổi sau mọi phản hồi 4xx (chọn lại người rồi gửi lại là yêu cầu mới).
  const keyRing = useRef(new IdempotencyKeys<'reassign'>(newId));
  const assignees = useStepAssignees(id);
  // Việc trong quy trình: chỉ người được bổ nhiệm hoặc được ủy quyền. Chưa biết (đang tải) thì chưa cho chọn bừa.
  const restricted = assignees.data ? !assignees.data.anyone : false;

  const send = async (step: StepDetail) => {
    const text = reason.trim();
    setErrors({ person: person ? undefined : t.personRequired, reason: text ? undefined : t.reasonRequired });
    if (!person || !text) return;
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.call('steps.reassign', { params: { id: step.id }, body: { toUserId: person.id, reason: text } }, { idempotencyKey: keyRing.current.get('reassign') });
      keyRing.current.settle('reassign', { ok: true });
      applyStepResult(result);
      showFlash(fmt(t.reassigned, { người: personName(person) ?? person.fullName }));
      backToStep(step.id);
    } catch (err) {
      keyRing.current.settle('reassign', { ok: false, error: err });
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFormShell
      stepId={id}
      title={t.reassignTitle}
      problem={null}
      footer={(step) => (step.allowedActions.includes('reassign') ? <Button label={t.reassignConfirm} busy={busy} onPress={() => void send(step)} testID="reassign-send" /> : null)}
      testID="screen-reassign"
    >
      {(step) => {
        const current = personName(step.assignee);
        return (
          <>
            {current ? <AppText>{fmt(t.assigneeLine, { người: current })}</AppText> : null}
            <AppText tone="sub">{restricted ? t.reassignOnlyAppointed : t.reassignAnyone}</AppText>
            {error ? (
              <Banner tone="info" live testID="reassign-error">
                {error}
              </Banner>
            ) : null}
            <PersonPicker
              label={t.reassignTo}
              value={person}
              excludeId={step.assignee?.id}
              candidates={restricted ? (assignees.data?.people ?? []) : null}
              error={errors.person}
              onChange={(next) => {
                setPerson(next);
                setErrors((e) => ({ ...e, person: undefined }));
              }}
            />
            <TextField
              label={t.reasonLabel}
              value={reason}
              onChangeText={(v) => {
                setReason(v);
                setErrors((e) => ({ ...e, reason: undefined }));
              }}
              error={errors.reason}
              multiline
              maxLength={2000}
              testID="reassign-reason"
            />
          </>
        );
      }}
    </StepFormShell>
  );
}
