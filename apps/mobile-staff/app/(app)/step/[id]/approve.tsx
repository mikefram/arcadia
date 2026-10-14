import { newId, type StepDetail } from '@mihato/domain';
import { fmt, formatLate, formatMoney, vi, vnDateKey } from '@mihato/i18n';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { errorMessage, isApiError } from '@/api/errors';
import { StepBadgeChips, StepDiscussion } from '@/features/StepComments';
import { ResultFormFields } from '@/features/ResultFormFields';
import { StepFormShell } from '@/features/StepFormShell';
import { StepRunSections } from '@/features/StepRunSections';
import { fileFieldState } from '@/features/files';
import { IdempotencyKeys } from '@/features/idempotency';
import { buildResult, webOnlyRequired, type FormValues } from '@/features/result-form';
import { dueText, personName, stepChips } from '@/features/steps';
import { useFormFiles } from '@/files/transfer';
import { useNow, useOnline } from '@/hooks';
import { focusFromParam } from '@/push/link';
import { api, applyStepResult, stepUpSigner } from '@/services';
import { obtainStepUpToken } from '@/session/step-up-flow';
import { useReauth } from '@/session/useReauth';
import { AppText } from '@/ui/AppText';
import { Banner } from '@/ui/Banner';
import { Card, SectionHeading } from '@/ui/Blocks';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { TextField } from '@/ui/Field';
import { showFlash } from '@/ui/Flash';
import { ScreenCaptureGuard } from '@/ui/ScreenCaptureGuard';
import { space } from '@/ui/theme';

const t = vi.staff.approval;

function leave(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * S6 Duyệt (SPEC 8.2): nội dung, người đề nghị, số tiền nếu có. Hai lựa chọn là "Đồng ý" và "Chưa đồng ý"
 * (bắt buộc ghi lý do). Việc có số tiền (`requiresStepUp`) thì xác thực lại trên máy bằng sinh trắc học hoặc PIN,
 * rồi lấy mã nâng quyền và gửi kèm ở header `X-Step-Up-Token`.
 */
export default function ApproveScreen() {
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  const [discussionY, setDiscussionY] = useState<number | null>(null);
  const now = useNow();
  const online = useOnline();
  const reauth = useReauth(t.stepUpPinTitle);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  // Bước đóng góp (hoặc duyệt có biểu mẫu): các ô người dùng điền cùng lúc với Gửi.
  const [values, setValues] = useState<FormValues>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ô tệp của biểu mẫu: chọn là tải lên ngay; chỉ gửi khi mọi tệp đã tải xong (tệp lỗi phải thử lại hoặc gỡ).
  const { controller, files } = useFormFiles();
  const [attempted, setAttempted] = useState(false);
  // Khoá chống lặp giữ qua lỗi mạng và 5xx (gửi lại chỉ có hiệu lực một lần), nhưng đổi sau mọi phản hồi 4xx:
  // máy chủ lưu cả lỗi theo khoá nên gửi lại sau khi sửa nội dung sẽ nhận `idempotency_key_reuse`.
  const keyRing = useRef(new IdempotencyKeys<'approve' | 'reject'>(newId));

  const approve = async (step: StepDetail) => {
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      return;
    }
    setError(null);
    setAttempted(true);
    const built = buildResult(step.form, values, files);
    const fileState = fileFieldState(step.form, files);
    const blockedWeb = webOnlyRequired(step.form);
    setMissing([...built.missing, ...blockedWeb]);
    setInvalid(built.invalid);
    if (fileState.uploading.length > 0 || fileState.failed.length > 0 || built.missing.length > 0 || built.invalid.length > 0 || blockedWeb.length > 0) return;
    setBusy('approve');
    try {
      let stepUpToken: string | undefined;
      if (step.requiresStepUp) {
        if (!(await reauth.confirm())) return;
        stepUpToken = await obtainStepUpToken();
      }
      const result = await api.call('steps.approve', { params: { id: step.id }, body: { comment: comment.trim() || undefined, result: built.result } }, { idempotencyKey: keyRing.current.get('approve'), stepUpToken });
      keyRing.current.settle('approve', { ok: true });
      applyStepResult(result);
      showFlash(step.action === 'contribute' ? t.contributeSent : t.approved);
      leave();
    } catch (err) {
      keyRing.current.settle('approve', { ok: false, error: err });
      setError(isApiError(err, 'step_up_required') ? t.stepUpFailed : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reject = async (step: StepDetail) => {
    const text = reason.trim();
    if (!text) {
      setReasonError(t.reasonRequired);
      return;
    }
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      return;
    }
    setError(null);
    setBusy('reject');
    try {
      const result = await api.call('steps.reject', { params: { id: step.id }, body: { reason: text } }, { idempotencyKey: keyRing.current.get('reject') });
      keyRing.current.settle('reject', { ok: true });
      applyStepResult(result);
      showFlash(t.rejected);
      leave();
    } catch (err) {
      keyRing.current.settle('reject', { ok: false, error: err });
      // Lý do đã gõ vẫn nằm trong ô nhập.
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const footer = (step: StepDetail) => {
    const canApprove = step.allowedActions.includes('approve');
    const canReject = step.allowedActions.includes('reject');
    if (!canApprove && !canReject) return null;
    if (rejecting) {
      return (
        <>
          <Button label={vi.common.actions.send} busy={busy === 'reject'} onPress={() => void reject(step)} testID="reject-send" />
          <Button variant="quiet" label={vi.common.actions.back} disabled={busy !== null} onPress={() => setRejecting(false)} />
        </>
      );
    }
    // Máy chưa ký được mã nâng quyền thì việc có số tiền phải duyệt trên web; vẫn ghi được "Chưa đồng ý".
    const blocked = step.requiresStepUp && !stepUpSigner.supported;
    return (
      <>
        {canApprove && !blocked ? <Button label={step.action === 'contribute' ? t.contributeSend : t.approve} busy={busy === 'approve'} onPress={() => void approve(step)} testID="approve" /> : null}
        {canReject ? <Button variant="secondary" label={t.reject} disabled={busy !== null} onPress={() => setRejecting(true)} testID="reject" /> : null}
      </>
    );
  };

  return (
    <>
      <StepFormShell stepId={id} title={(step) => (step?.action === 'contribute' ? t.contributeTitle : t.title)} problem={null} footer={footer} scrollToY={focusFromParam(focus) ? discussionY : null} testID="screen-approve">
        {(step) => {
          // Người đề nghị là người làm việc đứng ngay trước (`requestedBy`). Việc duyệt đứng đầu lượt chạy không có
          // việc trước: khi đó người đề nghị là người khởi chạy (`assignedBy`).
          const requester = personName(step.requestedBy ?? step.assignedBy);
          const contribute = step.action === 'contribute';
          const onBehalfOf = personName(step.onBehalfOf);
          const open = step.allowedActions.includes('approve') || step.allowedActions.includes('reject');
          return (
            <>
              <ScreenCaptureGuard active={step.amountVnd !== null} />
              <Card testID="approval-summary">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                  {stepChips(step, { queued: false }).map((chip) => (
                    <Chip key={chip.key} label={chip.label} tone={chip.tone} glyph={chip.glyph} />
                  ))}
                  <StepBadgeChips step={step} />
                </View>
                {!step.adhoc ? <AppText>{fmt(t.run, { lượt: step.runTitle })}</AppText> : null}
                {requester ? <AppText>{fmt(contribute ? t.assignedBy : t.requester, { người: requester })}</AppText> : null}
                {step.amountVnd !== null ? (
                  <AppText variant="cardTitle" testID="approval-amount">
                    {fmt(t.amount, { tiền: formatMoney(step.amountVnd) })}
                  </AppText>
                ) : null}
                <AppText tone={step.isOverdue ? 'late' : 'text'}>{step.dueAt ? fmt(vi.staff.myWork.card.due, { hạn: dueText(step.dueAt, now) }) : vi.staff.stepDetail.noDue}</AppText>
                {step.isOverdue ? <AppText tone="late">{formatLate(step.lateWorkingDays)}</AppText> : null}
              </Card>

              {onBehalfOf ? <Banner tone="info">{fmt(t.onBehalfOf, { người: onBehalfOf })}</Banner> : null}

              <View style={{ gap: space.sm }}>
                <SectionHeading title={contribute ? t.contributeContent : t.content} />
                <AppText tone={step.description ? 'text' : 'sub'}>{step.description || vi.staff.stepDetail.noDescription}</AppText>
              </View>

              <StepRunSections step={step} />

              {open && step.requiresStepUp && !rejecting ? (
                <Banner tone="info" testID="step-up-note">
                  {stepUpSigner.supported ? t.stepUp : t.stepUpUnsupported}
                </Banner>
              ) : null}

              {error ? (
                <Banner tone="info" live testID="approve-error">
                  {error}
                </Banner>
              ) : null}

              {open && rejecting ? (
                <TextField
                  label={t.reasonLabel}
                  value={reason}
                  onChangeText={(v) => {
                    setReason(v);
                    setReasonError(null);
                  }}
                  placeholder={t.reasonPlaceholder}
                  error={reasonError}
                  multiline
                  maxLength={2000}
                  autoFocus
                  testID="reject-reason"
                />
              ) : null}
              {open && !rejecting && step.form.length > 0 ? (
                <>
                  {step.action === 'contribute' ? <AppText tone="sub">{t.contributeHint}</AppText> : null}
                  {missing.length > 0 ? (
                    <AppText weight="medium" accessibilityRole="alert">
                      {t.contributeMissing}
                    </AppText>
                  ) : null}
                  {attempted && fileFieldState(step.form, files).uploading.length > 0 ? (
                    <AppText weight="medium" accessibilityRole="alert">
                      {vi.staff.files.stillUploading}
                    </AppText>
                  ) : null}
                  <ResultFormFields
                    fields={step.form}
                    values={values}
                    onChange={(key, value) => {
                      setValues((cur) => ({ ...cur, [key]: value }));
                      setMissing((cur) => cur.filter((k) => k !== key));
                      setInvalid((cur) => cur.filter((k) => k !== key));
                    }}
                    missing={missing}
                    invalid={invalid}
                    today={vnDateKey(now)}
                    files={files}
                    controller={controller}
                    attempted={attempted}
                  />
                </>
              ) : null}
              <StepDiscussion step={step} onLayoutY={setDiscussionY} />
              {open && !rejecting ? <TextField label={t.commentLabel} value={comment} onChangeText={setComment} multiline maxLength={2000} testID="approve-comment" /> : null}
            </>
          );
        }}
      </StepFormShell>
      {reauth.element}
    </>
  );
}
