import { useState } from 'react';
import type { ExtensionRequestView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { DueLabel, formatDue } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { isApiError } from '@/lib/errors';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { DispatchError, STEP_INVALIDATE } from './shared';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.shell.dispatch.extension;
const MAX_COMMENT = 2000;

export type ExtensionDecisionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: ExtensionRequestView | null;
  onDone?: () => void;
};

function DecisionForm({ request, onOpenChange, onDone }: { request: ExtensionRequestView; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const [comment, setComment] = useState('');
  const decide = useApiMutation('extensionRequests.decide', {
    invalidate: STEP_INVALIDATE,
    toastError: false,
    onError: (err) => {
      if (isApiError(err, 'state_conflict')) invalidateRoutes(STEP_INVALIDATE);
    },
  });
  const tooLong = comment.length > MAX_COMMENT;
  const deciding = decide.isPending ? decide.variables.body.decision : null;

  const submit = (decision: 'approved' | 'declined') => {
    if (tooLong) return;
    const text = comment.trim();
    decide.mutate(
      { params: { id: request.id }, body: { decision, ...(text ? { comment: text } : {}) } },
      {
        onSuccess: () => {
          toast.success(decision === 'approved' ? t.approved : t.declined);
          onDone?.();
          onOpenChange(false);
        },
      },
    );
  };

  const { step } = request;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-3">
          <p className="font-semibold">{step.title}</p>
          <p className="text-sm text-ink-sub">{runLabel(step)}</p>
          <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <dt className="text-ink-sub">{t.requestedBy}</dt>
            <dd>
              <PersonName person={request.requestedBy} />
            </dd>
            <dt className="text-ink-sub">{t.current}</dt>
            <dd>
              <DueLabel dueAt={step.dueAt} dueOriginalAt={step.dueOriginalAt} isOverdue={step.isOverdue} lateWorkingDays={step.lateWorkingDays} />
            </dd>
            <dt className="text-ink-sub">{t.proposed}</dt>
            <dd className="font-semibold">
              <time dateTime={request.proposedDueAt}>{formatDue(request.proposedDueAt)}</time>
            </dd>
            <dt className="text-ink-sub">{t.reason}</dt>
            <dd className="whitespace-pre-line">{request.reason}</dd>
          </dl>
        </div>
        <DispatchError error={decide.error} />
        <Field label={t.comment} error={tooLong ? t.commentTooLong : undefined}>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" className="sm:mr-auto" onClick={() => onOpenChange(false)}>
          {vi.admin.shell.ui.close}
        </Button>
        <Button variant="secondary" loading={deciding === 'declined'} disabled={deciding === 'approved'} onClick={() => submit('declined')}>
          {t.decline}
        </Button>
        <Button variant="primary" loading={deciding === 'approved'} disabled={deciding === 'declined'} onClick={() => submit('approved')}>
          {t.approve}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Duyệt hoặc chưa duyệt một yêu cầu gia hạn của người nhận việc (`extensionRequests.decide`). */
export function ExtensionDecisionDialog({ open, onOpenChange, request, onDone }: ExtensionDecisionDialogProps) {
  return (
    <Dialog open={open && request !== null} onOpenChange={onOpenChange}>
      <DialogContent>{request ? <DecisionForm request={request} onOpenChange={onOpenChange} onDone={onDone} /> : null}</DialogContent>
    </Dialog>
  );
}
