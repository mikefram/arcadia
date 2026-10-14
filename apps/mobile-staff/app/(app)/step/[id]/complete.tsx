import type { StepDetail } from '@mihato/domain';
import { vi, vnDateKey } from '@mihato/i18n';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ResultFormFields } from '@/features/ResultFormFields';
import { StepFormShell, backToStep } from '@/features/StepFormShell';
import { fileFieldState } from '@/features/files';
import { buildResult, type FormValues } from '@/features/result-form';
import { flashOutcome, submitStepAction, takeRejection } from '@/features/submit';
import { useFormFiles } from '@/files/transfer';
import { useNow } from '@/hooks';
import { AppText } from '@/ui/AppText';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/Field';

const t = vi.staff.complete;

/**
 * S3 Báo hoàn thành (SPEC 8.2). Ghi chú không bắt buộc, nên từ S2 chỉ cần hai chạm: Báo hoàn thành rồi Gửi
 * (SPEC 8.1 điều 2), trừ khi việc có ô bắt buộc trong biểu mẫu kết quả. Mất mạng thì thao tác xếp hàng trên máy.
 */
export default function CompleteScreen() {
  const { id, nudgeId } = useLocalSearchParams<{ id: string; nudgeId?: string }>();
  const now = useNow();
  const [note, setNote] = useState('');
  const [values, setValues] = useState<FormValues>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Ô tệp: chọn là tải lên ngay; chỉ gửi khi mọi tệp đã tải xong (tệp lỗi phải thử lại hoặc gỡ).
  const { controller, files } = useFormFiles();
  const [attempted, setAttempted] = useState(false);

  const send = async (step: StepDetail) => {
    setAttempted(true);
    const built = buildResult(step.form, values, files);
    const fileState = fileFieldState(step.form, files);
    setMissing(built.missing);
    setInvalid(built.invalid);
    if (fileState.uploading.length > 0 || fileState.failed.length > 0 || built.missing.length > 0 || built.invalid.length > 0) return;

    setSending(true);
    setProblem(null);
    const outcome = await submitStepAction(step, { kind: 'complete', note: note.trim() || undefined, result: built.result, nudgeId: nudgeId || undefined });
    setSending(false);

    const rejection = takeRejection(outcome);
    if (rejection) {
      // Giữ nguyên ghi chú và các ô đã điền; chỉ báo lý do.
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
      testID="screen-complete"
    >
      {(step) => (
        <>
          {step.form.length > 0 ? (
            <>
              {missing.length > 0 ? (
                <AppText weight="medium" accessibilityRole="alert">
                  {t.resultRequired}
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
                  // Đang sửa ô nào thì gỡ lời báo lỗi của ô đó.
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
          <TextField label={t.noteLabel} value={note} onChangeText={setNote} placeholder={t.notePlaceholder} multiline maxLength={2000} testID="note" />
        </>
      )}
    </StepFormShell>
  );
}
