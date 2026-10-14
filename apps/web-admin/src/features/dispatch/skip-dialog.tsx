import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { StepView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { isApiError } from '@/lib/errors';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { DispatchError, STEP_INVALIDATE, StepSummary } from './shared';

const t = vi.admin.shell.dispatch;

const schema = z.object({ reason: z.string().trim().min(1, t.skip.reasonRequired).max(2000, t.reasonTooLong) });
type FormValues = z.infer<typeof schema>;

export type SkipDialogProps = { open: boolean; onOpenChange: (open: boolean) => void; step: StepView | null; onDone?: () => void };

function SkipForm({ step, onOpenChange, onDone }: { step: StepView; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });
  const skip = useApiMutation('steps.skip', {
    invalidate: STEP_INVALIDATE,
    toastError: false,
    onError: (err) => {
      if (isApiError(err, 'state_conflict')) invalidateRoutes(STEP_INVALIDATE);
    },
  });

  const submit = form.handleSubmit((values) => {
    skip.mutate(
      { params: { id: step.id }, body: { reason: values.reason } },
      {
        onSuccess: () => {
          toast.success(t.skip.done);
          onDone?.();
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.skip.title}</DialogTitle>
        <DialogDescription>{t.skip.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <StepSummary steps={[step]} />
        <DispatchError error={skip.error} />
        <Field label={t.skip.reason} required error={form.formState.errors.reason?.message}>
          <Textarea {...form.register('reason')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={skip.isPending}>
          {t.skip.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Bỏ qua một bước (`steps.skip`), bắt buộc lý do. */
export function SkipDialog({ open, onOpenChange, step, onDone }: SkipDialogProps) {
  return (
    <Dialog open={open && step !== null} onOpenChange={onOpenChange}>
      <DialogContent>{step ? <SkipForm step={step} onOpenChange={onOpenChange} onDone={onDone} /> : null}</DialogContent>
    </Dialog>
  );
}
