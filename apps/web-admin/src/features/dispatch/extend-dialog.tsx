import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { instantToVnLocal, vnLocalToInstant, vnToday } from '@/lib/datetime';
import { isApiError } from '@/lib/errors';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { BatchResults, DispatchError, eligible, STEP_INVALIDATE, StepSummary, type DispatchDialogProps, type ItemResult } from './shared';

const t = vi.admin.shell.dispatch;

const schema = z
  .object({
    date: z.string().min(1, t.extend.dateRequired),
    time: z.string().min(1, t.extend.dateRequired),
    reason: z.string().trim().min(1, t.extend.reasonRequired).max(2000, t.reasonTooLong),
  })
  .superRefine((v, ctx) => {
    if (!v.date || !v.time) return;
    const instant = vnLocalToInstant(v.date, v.time);
    if (!instant) ctx.addIssue({ code: 'custom', path: ['date'], message: t.extend.dateRequired });
    else if (Date.parse(instant) <= Date.now()) ctx.addIssue({ code: 'custom', path: ['date'], message: t.extend.inPast });
  });
type FormValues = z.infer<typeof schema>;

function ExtendForm({ steps, onOpenChange, onDone }: Omit<DispatchDialogProps, 'open'>) {
  const targets = eligible(steps, 'extend');
  const only = targets.length === 1 ? targets[0] : undefined;
  const [results, setResults] = useState<ItemResult[] | null>(null);
  // Giờ mặc định: giữ giờ của hạn đang có; nếu chưa có hạn thì cuối giờ làm việc.
  const defaultTime = only?.dueAt ? instantToVnLocal(only.dueAt).time : '17:00';
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { date: '', time: defaultTime, reason: '' } });

  const onError = (err: Error) => {
    if (isApiError(err, 'state_conflict')) invalidateRoutes(STEP_INVALIDATE);
  };
  const single = useApiMutation('steps.extend', { invalidate: STEP_INVALIDATE, toastError: false, onError });
  const batch = useApiMutation('steps.batch', { invalidate: STEP_INVALIDATE, toastError: false, onError });
  const pending = single.isPending || batch.isPending;

  const submit = form.handleSubmit((values) => {
    const newDueAt = vnLocalToInstant(values.date, values.time);
    if (!newDueAt) return;
    const day = formatDateTime(newDueAt);
    if (only) {
      single.mutate(
        { params: { id: only.id }, body: { newDueAt, reason: values.reason } },
        {
          onSuccess: () => {
            toast.success(fmt(t.extend.done, { ngày: day }));
            onDone?.();
            onOpenChange(false);
          },
        },
      );
      return;
    }
    batch.mutate(
      { body: { action: 'extend', stepIds: targets.map((s) => s.id), params: { newDueAt, reason: values.reason } } },
      {
        onSuccess: (res) => {
          onDone?.();
          if (res.results.every((r) => r.ok)) {
            toast.success(fmt(t.extend.doneMany, { n: res.results.length, ngày: day }));
            onOpenChange(false);
          } else {
            setResults(res.results);
          }
        },
      },
    );
  });

  const title = targets.length > 1 ? fmt(t.extend.titleMany, { n: targets.length }) : t.extend.title;
  const errors = form.formState.errors;

  if (results) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <BatchResults steps={targets} results={results} />
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="primary">{vi.admin.shell.ui.close}</Button>
          </DialogClose>
        </DialogFooter>
      </>
    );
  }

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <StepSummary steps={targets} total={steps.length} />
        <DispatchError error={single.error ?? batch.error} />
        <div className="grid grid-cols-[minmax(0,1fr)_8.5rem] items-start gap-3">
          <Field label={t.extend.newDate} required error={errors.date?.message}>
            <Input type="date" min={vnToday()} {...form.register('date')} />
          </Field>
          <Field label={t.extend.newTime} required error={errors.time?.message}>
            <Input type="time" {...form.register('time')} />
          </Field>
        </div>
        <Field label={t.extend.reason} hint={t.extend.reasonHint} required error={errors.reason?.message}>
          <Textarea {...form.register('reason')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={pending} disabled={targets.length === 0}>
          {t.extend.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Gia hạn một hoặc nhiều việc: hạn mới (giờ Việt Nam) và lý do. Một việc gọi `steps.extend`;
 * nhiều việc gọi `steps.batch` (tối đa 50).
 */
export function ExtendDialog({ open, onOpenChange, steps, onDone }: DispatchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ExtendForm steps={steps} onOpenChange={onOpenChange} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}
