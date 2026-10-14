import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FileText, ShieldCheck } from 'lucide-react';
import { BLOCK_REASON_CODES, type BlockReasonCode, type FileView, type StepView } from '@mihato/domain';
import { fmt, formatMoney, vi } from '@mihato/i18n';
import { DueLabel } from '@/components/due-label';
import { FileRow } from '@/components/file-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { PasswordInput } from '@/features/auth/password-input';
import { STEP_INVALIDATE } from '@/features/dispatch';
import { attachedFileIds, FormFieldsGroup, hasUploading, toPayload, validateFields } from '@/features/runs/form-fields';
import { PresentedFile } from '@/features/runs/run-attachments';
import { useFieldValues } from '@/features/runs/use-field-values';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { instantToVnLocal, vnLocalToInstant, vnToday } from '@/lib/datetime';
import { errorMessage, isApiError, problemFields } from '@/lib/errors';
import { orderCompiled } from '@/lib/files';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.runs.myTasks;
const MAX_TEXT = 2000;

type StepDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: StepView;
  /** lời đi thúc đang trả lời: máy chủ ghi câu trả lời nhanh tương ứng */
  nudgeId?: string | undefined;
};

/** 409 khi việc đã đổi trạng thái: làm mới dữ liệu phía sau; hộp thoại vẫn mở và giữ nội dung đã nhập (SPEC 8.4). */
function refreshOnConflict(err: Error): void {
  if (isApiError(err, 'state_conflict') || isApiError(err, 'not_found') || problemFields(err).some((p) => p.code === 'compile_required')) invalidateRoutes(STEP_INVALIDATE);
}

/** Lỗi của một thao tác trên việc của tôi: 409 được nói rõ bằng chữ. */
function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return <Callout tone="error">{isApiError(error, 'state_conflict') ? t.detail.conflict : errorMessage(error)}</Callout>;
}

function StepHead({ step }: { step: StepView }) {
  return (
    <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
      <p className="font-semibold">{step.title}</p>
      <p className="text-sm text-ink-sub">{runLabel(step)}</p>
    </div>
  );
}

function Optional({ children }: { children: ReactNode }) {
  return (
    <>
      {children} <span className="font-normal text-ink-sub">({t.complete.noteOptional})</span>
    </>
  );
}

// ───────────────────────── Báo hoàn thành ─────────────────────────

/** Tệp Word tổng hợp đã xuất ở việc này: của máy chủ và của lần vừa xuất, không trùng, mới nhất trước. */
function mergeCompiled(fromServer: readonly FileView[] | undefined, local: readonly FileView[]): FileView[] {
  const byId = new Map<string, FileView>();
  for (const f of [...(fromServer ?? []).filter((x) => x.compiled), ...local]) byId.set(f.id, f);
  return orderCompiled([...byId.values()]);
}

/**
 * Khối xuất tệp Word của việc tổng hợp: nút Xuất (gửi kèm các ô đang gõ), danh sách tệp đã xuất mới nhất trước,
 * và lời giải thích khi tệp là bắt buộc mà chưa xuất.
 */
function CompilePanel({ step, exported, onExport, busy, error, blocked, noteId }: {
  step: StepView;
  exported: readonly FileView[];
  onExport: () => void;
  busy: boolean;
  error: unknown;
  blocked: boolean;
  noteId: string;
}) {
  const info = step.compile;
  if (!info) return null;
  const tc = t.complete;
  const files = mergeCompiled(step.files, exported);
  return (
    <section aria-labelledby={`${noteId}-title`} className="flex flex-col gap-3 rounded-lg border border-hairline bg-canvas px-3.5 py-3.5" data-testid="compile-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${noteId}-title`} className="flex items-center gap-2 text-base font-semibold">
          <FileText aria-hidden="true" className="size-4 text-ink-sub" />
          {tc.compileHeading}
        </h3>
        {info.required ? <Badge tone="gold">{vi.admin.shell.ui.required}</Badge> : null}
      </div>
      <p className="text-sm text-ink-sub">{tc.compileIntro}</p>
      {error ? <Callout tone="error">{errorMessage(error)}</Callout> : null}
      <div>
        <Button variant={files.length === 0 ? 'primary' : 'secondary'} loading={busy} disabled={blocked} onClick={onExport} data-testid="compile-button">
          {busy ? null : <FileText aria-hidden="true" />}
          {busy ? tc.compiling : files.length === 0 ? tc.compileButton : tc.compileAgain}
        </Button>
        {blocked ? <p className="mt-1.5 text-sm text-ink-sub">{tc.compileNeedsFields}</p> : null}
      </div>
      {files.length > 0 ? (
        <ul aria-label={tc.compileListLabel} className="flex flex-col gap-2" data-testid="compile-files">
          {files.map((file, i) => (
            // Lần xuất mới nhất (Word và PDF của nó) nổi bật; nhãn "Mới nhất" chỉ ở tệp Word.
            <FileRow key={file.id} file={file} {...(i === 0 || (file.renditionOf !== null && file.renditionOf === files[0]?.id) ? { featured: true } : {})} {...(i === 0 ? { badge: <Badge tone="gold">{tc.compileLatest}</Badge> } : {})} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CompleteForm({ step, nudgeId, onOpenChange }: Omit<StepDialogProps, 'open'>) {
  const noteId = useId();
  const { values, setValue, serverErrors, captureServerErrors, clearServerErrors } = useFieldValues();
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [exported, setExported] = useState<FileView[]>([]);
  const complete = useApiMutation('steps.complete', {
    invalidate: STEP_INVALIDATE,
    toastError: false,
    onError: (err) => {
      captureServerErrors(step.form, err);
      refreshOnConflict(err);
    },
  });
  const compile = useApiMutation('steps.compile', { invalidate: ['steps.get', 'runs.get', 'runs.files', 'runs.events'], toastError: false });

  const errors = validateFields(step.form, values);
  const noteTooLong = note.length > MAX_TEXT;
  const uploading = hasUploading(step.form, values);
  const compileInfo = step.compile ?? null;
  const compiledCount = mergeCompiled(step.files, exported).length;
  // Việc có `compile.required`: chưa có tệp tổng hợp nào thì chưa cho báo xong, và nói rõ vì sao.
  const needsCompile = compileInfo?.required === true && !compileInfo.hasFile && compiledCount === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || noteTooLong || uploading || needsCompile) return;
    const text = note.trim();
    const result = toPayload(step.form, values);
    const fileIds = attachedFileIds(step.form, values);
    complete.mutate(
      {
        params: { id: step.id },
        body: { ...(text ? { note: text } : {}), ...(step.form.length > 0 ? { result } : {}), ...(fileIds.length > 0 ? { fileIds } : {}), ...(nudgeId ? { nudgeId } : {}) },
      },
      {
        onSuccess: () => {
          toast.success(t.complete.done);
          onOpenChange(false);
        },
      },
    );
  };

  const exportFile = () => {
    if (compile.isPending || uploading) return;
    compile.mutate(
      { params: { id: step.id }, body: { result: toPayload(step.form, values) } },
      {
        onSuccess: (file) => {
          const made = file.pdf ? [file, file.pdf] : [file];
          setExported((prev) => [...made, ...prev.filter((f) => !made.some((m) => m.id === f.id))]);
          toast.success(fmt(t.complete.compileDone, { tên: file.name }));
        },
        onError: (err) => captureServerErrors(step.form, err),
      },
    );
  };

  const lockNoteId = `${noteId}-khoa`;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        clearServerErrors();
        submit(e);
      }}
      className="flex min-h-0 flex-col"
    >
      <DialogHeader>
        <DialogTitle>{t.complete.title}</DialogTitle>
        <DialogDescription>{t.complete.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <StepHead step={step} />
        <ActionError error={complete.error} />
        {nudgeId ? <Callout tone="info">{t.complete.replyingNudge}</Callout> : null}
        {step.form.length > 0 ? (
          <div role="group" aria-label={t.complete.resultHeading} className="flex flex-col gap-4">
            <p className="text-base font-semibold">{t.complete.resultHeading}</p>
            <FormFieldsGroup fields={step.form} values={values} errors={errors} serverErrors={serverErrors} showErrors={showErrors} onChange={setValue} />
          </div>
        ) : null}
        <CompilePanel step={step} exported={exported} onExport={exportFile} busy={compile.isPending} error={compile.error} blocked={uploading} noteId={noteId} />
        <Field label={<Optional>{t.complete.note}</Optional>} error={noteTooLong ? t.complete.noteTooLong : undefined}>
          <Textarea placeholder={t.complete.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        {uploading || needsCompile ? (
          <p id={lockNoteId} className="text-sm text-ink-sub sm:mr-auto" data-testid="complete-lock-note">
            {uploading ? t.complete.uploadingBlock : t.complete.compileRequiredNote}
          </p>
        ) : null}
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={complete.isPending} aria-disabled={uploading || needsCompile || undefined} aria-describedby={uploading || needsCompile ? lockNoteId : undefined}>
          {t.complete.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Báo hoàn thành (`steps.complete`): ghi chú không bắt buộc, biểu mẫu kết quả theo `form` của việc (kể cả ô tệp),
 * và với việc tổng hợp có `compile` thì thêm khối xuất tệp Word.
 */
export function CompleteDialog({ open, onOpenChange, step, nudgeId }: StepDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <CompleteForm step={step} nudgeId={nudgeId} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Xin thêm thời gian ─────────────────────────

const QUICK_REASONS = Object.values(t.extension.reasons);

function ExtensionForm({ step, nudgeId, onOpenChange }: Omit<StepDialogProps, 'open'>) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState(step.dueAt ? instantToVnLocal(step.dueAt).time : '17:00');
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const request = useApiMutation('steps.requestExtension', { invalidate: STEP_INVALIDATE, toastError: false, onError: refreshOnConflict });

  const proposed = date && time ? vnLocalToInstant(date, time) : null;
  const dateError = !proposed
    ? t.extension.dateRequired
    : Date.parse(proposed) <= Date.now() || (step.dueAt !== null && Date.parse(proposed) <= Date.parse(step.dueAt))
      ? t.extension.mustBeLater
      : null;
  const reasonError = reason.trim() === '' ? t.extension.reasonRequired : reason.length > MAX_TEXT ? t.extension.reasonTooLong : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (dateError || reasonError || !proposed) return;
    request.mutate(
      { params: { id: step.id }, body: { proposedDueAt: proposed, reason: reason.trim(), ...(nudgeId ? { nudgeId } : {}) } },
      {
        onSuccess: () => {
          toast.success(t.extension.done);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.extension.title}</DialogTitle>
        <DialogDescription>{t.extension.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
          <p className="font-semibold">{step.title}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-ink-sub">{t.extension.current}:</span>
            <DueLabel dueAt={step.dueAt} dueOriginalAt={step.dueOriginalAt} isOverdue={step.isOverdue} lateWorkingDays={step.lateWorkingDays} />
          </p>
        </div>
        <ActionError error={request.error} />
        {step.pendingExtension ? <Callout tone="warn">{t.extension.alreadyPending}</Callout> : null}
        {nudgeId ? <Callout tone="info">{t.extension.replyingNudge}</Callout> : null}
        <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-start gap-3">
          <Field label={t.extension.newDate} required error={showErrors && dateError ? dateError : undefined}>
            <Input type="date" min={vnToday()} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t.extension.newTime} required>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <Field label={t.extension.reason} required error={showErrors && reasonError ? reasonError : undefined}>
          <Textarea placeholder={t.extension.reasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div role="group" aria-label={t.extension.reasonsLabel} className="-mt-1 flex flex-wrap gap-2">
          {QUICK_REASONS.map((text) => (
            <Button key={text} size="sm" aria-pressed={reason === text} className="font-medium aria-pressed:border-primary aria-pressed:bg-primary-tint" onClick={() => setReason(text)}>
              {text}
            </Button>
          ))}
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={request.isPending}>
          {t.extension.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Xin thêm thời gian (`steps.requestExtension`): hạn đề nghị và lý do. Người giao hoặc Văn phòng duyệt. */
export function ExtensionRequestDialog({ open, onOpenChange, step, nudgeId }: StepDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ExtensionForm step={step} nudgeId={nudgeId} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Báo vướng ─────────────────────────

function BlockForm({ step, nudgeId, onOpenChange }: Omit<StepDialogProps, 'open'>) {
  const groupId = useId();
  const [code, setCode] = useState<BlockReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const block = useApiMutation('steps.block', { invalidate: STEP_INVALIDATE, toastError: false, onError: refreshOnConflict });
  const noteTooLong = note.length > MAX_TEXT;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!code || noteTooLong) return;
    const text = note.trim();
    block.mutate(
      { params: { id: step.id }, body: { reasonCode: code, ...(text ? { note: text } : {}), ...(nudgeId ? { nudgeId } : {}) } },
      {
        onSuccess: () => {
          toast.success(t.block.done);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.block.title}</DialogTitle>
        <DialogDescription>{t.block.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <StepHead step={step} />
        <ActionError error={block.error} />
        {nudgeId ? <Callout tone="info">{t.block.replyingNudge}</Callout> : null}
        <fieldset aria-describedby={showErrors && !code ? `${groupId}-error` : undefined} className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-base font-medium">
            {t.block.reason} <span className="font-normal text-ink-sub">({vi.admin.shell.ui.required})</span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {BLOCK_REASON_CODES.map((value) => (
              <label
                key={value}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:bg-surface-alt has-checked:border-primary has-checked:bg-primary-tint has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary',
                )}
              >
                <input type="radio" name={groupId} value={value} checked={code === value} onChange={() => setCode(value)} className="size-4 accent-primary outline-none" />
                <span className="font-medium">{vi.common.blockReason[value]}</span>
              </label>
            ))}
          </div>
          {showErrors && !code ? <FieldError id={`${groupId}-error`}>{t.block.reasonRequired}</FieldError> : null}
        </fieldset>
        <Field label={<Optional>{t.block.note}</Optional>} error={noteTooLong ? t.block.noteTooLong : undefined}>
          <Textarea placeholder={t.block.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={block.isPending}>
          {t.block.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Báo vướng (`steps.block`): lý do mẫu và ghi chú. Không đổi trạng thái việc; báo người giao và Văn phòng. */
export function BlockDialog({ open, onOpenChange, step, nudgeId }: StepDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <BlockForm step={step} nudgeId={nudgeId} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Duyệt: Đồng ý (có nâng quyền khi có tiền) ─────────────────────────

function ApproveForm({ step, onOpenChange }: Omit<StepDialogProps, 'open' | 'nudgeId'>) {
  const me = useMe();
  const useTotp = me.mfaEnabled;
  // Bước đóng góp: mỗi người điền biểu mẫu và bấm Gửi, không có "Chưa đồng ý". Bước duyệt thường có thể kèm biểu mẫu (ý kiến, tệp).
  const contribute = step.action === 'contribute';
  const lockId = useId();
  const { values, setValue, serverErrors, captureServerErrors, clearServerErrors } = useFieldValues();
  const [showErrors, setShowErrors] = useState(false);
  const [comment, setComment] = useState('');
  const [phase, setPhase] = useState<'comment' | 'stepUp'>('comment');
  const [secret, setSecret] = useState('');
  const [secretError, setSecretError] = useState<string | null>(null);
  /** máy chủ vừa trả 403 step_up_required: hỏi lại và nói rõ vì sao */
  const [asked, setAsked] = useState(false);
  // Mã nâng quyền sống 60 giây, chỉ giữ trong bộ nhớ của hộp thoại này.
  const token = useRef<string | null>(null);

  const stepUp = useApiMutation('auth.stepUp', { toastError: false });
  const approve = useApiMutation('steps.approve', {
    invalidate: STEP_INVALIDATE,
    toastError: false,
    callOptions: () => (token.current ? { stepUpToken: token.current } : {}),
  });
  const commentTooLong = comment.length > MAX_TEXT;
  const pending = stepUp.isPending || approve.isPending;
  const errors = validateFields(step.form, values);
  const uploading = hasUploading(step.form, values);
  const formInvalid = Object.keys(errors).length > 0;
  // Bước đóng góp có biểu mẫu thì nội dung nằm ở biểu mẫu; không có biểu mẫu thì ô Ý kiến là nội dung.
  const showComment = !(contribute && step.form.length > 0);

  const sendApprove = () => {
    const text = comment.trim();
    const fileIds = attachedFileIds(step.form, values);
    approve.mutate(
      {
        params: { id: step.id },
        body: { ...(text && showComment ? { comment: text } : {}), ...(step.form.length > 0 ? { result: toPayload(step.form, values) } : {}), ...(fileIds.length > 0 ? { fileIds } : {}) },
      },
      {
        onSuccess: () => {
          toast.success(contribute ? t.contribute.done : t.approval.approved);
          onOpenChange(false);
        },
        onError: (err) => {
          if (isApiError(err, 'step_up_required')) {
            // Thiếu mã nâng quyền, hoặc mã đã hết 60 giây: hỏi lại, giữ nguyên ý kiến đã nhập.
            token.current = null;
            setSecret('');
            setAsked(true);
            setPhase('stepUp');
          } else {
            captureServerErrors(step.form, err);
            refreshOnConflict(err);
          }
        },
      },
    );
  };

  const submitComment = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    clearServerErrors();
    if (commentTooLong || formInvalid || uploading || pending) return;
    if (step.requiresStepUp && !token.current) {
      setPhase('stepUp');
      return;
    }
    sendApprove();
  };

  const submitStepUp = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const value = secret.trim();
    if (useTotp ? !/^\d{6}$/.test(value) : secret.length === 0) {
      setSecretError(useTotp ? t.stepUp.totpInvalid : t.stepUp.passwordRequired);
      return;
    }
    setSecretError(null);
    stepUp.mutate(
      { body: useTotp ? { totpCode: value } : { password: secret } },
      {
        onSuccess: (res) => {
          token.current = res.stepUpToken;
          setSecret('');
          sendApprove();
        },
      },
    );
  };

  const amount = step.amountVnd !== null ? formatMoney(step.amountVnd) : null;

  if (phase === 'stepUp') {
    const stepUpError = stepUp.isError ? (isApiError(stepUp.error, 'invalid_credentials') ? (useTotp ? t.stepUp.wrongTotp : t.stepUp.wrongPassword) : errorMessage(stepUp.error)) : null;
    const approveError = approve.isError && !isApiError(approve.error, 'step_up_required') ? approve.error : null;
    return (
      <form noValidate onSubmit={submitStepUp} className="flex min-h-0 flex-col" data-testid="step-up-form">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
            {t.stepUp.title}
          </DialogTitle>
          <DialogDescription>{useTotp ? t.stepUp.introTotp : t.stepUp.introPassword}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
            <p className="font-semibold">{step.title}</p>
            {amount ? <p className="tabular mt-0.5 font-medium">{fmt(t.card.amount, { tiền: amount })}</p> : null}
          </div>
          {asked && !stepUpError ? <Callout tone="warn">{t.stepUp.expired}</Callout> : null}
          {stepUpError ? <Callout tone="error">{stepUpError}</Callout> : null}
          <ActionError error={approveError} />
          {useTotp ? (
            <Field label={t.stepUp.totp} required error={secretError ?? undefined}>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus className="tabular max-w-40 tracking-[0.3em]" value={secret} onChange={(e) => setSecret(e.target.value.replace(/\D/g, ''))} />
            </Field>
          ) : (
            <Field label={t.stepUp.password} required error={secretError ?? undefined}>
              <PasswordInput autoComplete="current-password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={() => setPhase('comment')}>
            {vi.common.actions.back}
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {t.stepUp.submit}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={submitComment} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{contribute ? t.contribute.title : t.approval.approveTitle}</DialogTitle>
        <DialogDescription>{contribute ? t.contribute.intro : t.approval.approveIntro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
          <p className="font-semibold">{step.title}</p>
          <p className="text-sm text-ink-sub">{runLabel(step)}</p>
          {amount ? <p className="tabular mt-1.5 text-lg font-semibold">{amount}</p> : null}
        </div>
        {/* Bản trình duyệt ở ngay đầu hộp: người duyệt mở tệp xem trước khi quyết. */}
        {contribute ? null : <PresentedFile runId={step.runId} />}
        <ActionError error={approve.isError && !isApiError(approve.error, 'step_up_required') ? approve.error : null} />
        {step.requiresStepUp ? <Callout tone="info">{t.approval.stepUpNote}</Callout> : null}
        {step.form.length > 0 ? (
          <div role="group" aria-label={contribute ? t.contribute.formHeading : t.approval.formHeading} className="flex flex-col gap-4">
            <p className="text-base font-semibold">{contribute ? t.contribute.formHeading : t.approval.formHeading}</p>
            <FormFieldsGroup fields={step.form} values={values} errors={errors} serverErrors={serverErrors} showErrors={showErrors} onChange={setValue} />
          </div>
        ) : contribute ? (
          <p className="text-ink-sub">{t.contribute.emptyForm}</p>
        ) : null}
        {showComment ? (
          <Field label={<Optional>{t.approval.comment}</Optional>} error={commentTooLong ? t.approval.commentTooLong : undefined}>
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {uploading ? (
          <p id={lockId} className="text-sm text-ink-sub sm:mr-auto">
            {t.approval.uploadingBlock}
          </p>
        ) : null}
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={pending} aria-disabled={uploading || undefined} aria-describedby={uploading ? lockId : undefined}>
          {contribute ? vi.common.actions.send : t.approval.approveSubmit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Đồng ý ở việc duyệt (`steps.approve`). Việc có số tiền (`requiresStepUp`) thì hỏi lại mật khẩu, hoặc mã TOTP nếu
 * tài khoản đã bật xác thực hai bước, đổi lấy `stepUpToken` qua `auth.stepUp` rồi gửi kèm lời duyệt.
 * Máy chủ trả 403 `step_up_required` (thiếu mã hoặc mã hết hạn) thì hỏi lại, ý kiến đã nhập vẫn giữ.
 */
export function ApproveDialog({ open, onOpenChange, step }: Omit<StepDialogProps, 'nudgeId'>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ApproveForm step={step} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Duyệt: Chưa đồng ý ─────────────────────────

function RejectForm({ step, onOpenChange }: Omit<StepDialogProps, 'open' | 'nudgeId'>) {
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const reject = useApiMutation('steps.reject', { invalidate: STEP_INVALIDATE, toastError: false, onError: refreshOnConflict });
  const reasonError = reason.trim() === '' ? t.approval.reasonRequired : reason.length > MAX_TEXT ? t.approval.reasonTooLong : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (reasonError) return;
    reject.mutate(
      { params: { id: step.id }, body: { reason: reason.trim() } },
      {
        onSuccess: () => {
          toast.success(t.approval.rejected);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.approval.rejectTitle}</DialogTitle>
        <DialogDescription>{t.approval.rejectIntro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <StepHead step={step} />
        <ActionError error={reject.error} />
        <Field label={t.approval.reason} required error={showErrors && reasonError ? reasonError : undefined}>
          <Textarea placeholder={t.approval.reasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={reject.isPending}>
          {t.approval.rejectSubmit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Chưa đồng ý ở việc duyệt (`steps.reject`), bắt buộc ghi lý do. */
export function RejectDialog({ open, onOpenChange, step }: Omit<StepDialogProps, 'nudgeId'>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <RejectForm step={step} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
