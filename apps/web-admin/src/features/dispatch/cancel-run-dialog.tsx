import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { RouteKey } from '@mihato/api-client';
import type { RunSummary } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage, isApiError } from '@/lib/errors';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { STEP_INVALIDATE } from './shared';

const t = vi.admin.shell.dispatch.cancelRun;

const RUN_INVALIDATE: readonly RouteKey[] = STEP_INVALIDATE;

type RunRef = Pick<RunSummary, 'id' | 'title'>;
export type CancelRunDialogProps = { open: boolean; onOpenChange: (open: boolean) => void; run: RunRef | null; onDone?: () => void };

function CancelRunForm({ run, onOpenChange, onDone }: { run: RunRef; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const schema = z.object({
    reason: z.string().trim().min(1, t.reasonRequired).max(500, t.reasonTooLong),
    confirmTitle: z.string().refine((v) => v.trim() === run.title.trim(), t.mismatch),
  });
  type FormValues = z.infer<typeof schema>;
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { reason: '', confirmTitle: '' } });

  const cancel = useApiMutation('runs.cancel', {
    invalidate: RUN_INVALIDATE,
    toastError: false,
    onError: (err) => {
      if (isApiError(err, 'state_conflict')) invalidateRoutes(RUN_INVALIDATE);
    },
  });

  const submit = form.handleSubmit((values) => {
    cancel.mutate(
      { params: { id: run.id }, body: { reason: values.reason, confirmTitle: run.title } },
      {
        onSuccess: () => {
          toast.success(t.done);
          onDone?.();
          onOpenChange(false);
        },
      },
    );
  });

  const matches = form.watch('confirmTitle').trim() === run.title.trim();

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {cancel.isError ? (
          <Callout tone="error">{isApiError(cancel.error, 'state_conflict') ? vi.admin.shell.dispatch.runConflict : errorMessage(cancel.error)}</Callout>
        ) : null}
        <Field label={t.reason} required error={form.formState.errors.reason?.message}>
          <Textarea {...form.register('reason')} />
        </Field>
        <Field label={t.confirm} hint={fmt(t.confirmHint, { tên: run.title })} required error={form.formState.errors.confirmTitle?.message}>
          <Input autoComplete="off" spellCheck={false} {...form.register('confirmTitle')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{t.keep}</Button>
        </DialogClose>
        <Button type="submit" variant="danger" loading={cancel.isPending} aria-disabled={!matches || cancel.isPending || undefined}>
          {t.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Huỷ lượt chạy (`runs.cancel`): ghi lý do và gõ lại đúng tên lượt chạy mới bấm được. */
export function CancelRunDialog({ open, onOpenChange, run, onDone }: CancelRunDialogProps) {
  return (
    <Dialog open={open && run !== null} onOpenChange={onOpenChange}>
      <DialogContent>{run ? <CancelRunForm run={run} onOpenChange={onOpenChange} onDone={onDone} /> : null}</DialogContent>
    </Dialog>
  );
}
