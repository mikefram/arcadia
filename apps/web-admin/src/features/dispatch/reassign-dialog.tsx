import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { invalidateRoutes, useApiMutation, useApiQuery } from '@/lib/query';
import { BatchResults, DispatchError, eligible, STEP_INVALIDATE, StepSummary, type DispatchDialogProps, type ItemResult } from './shared';

const t = vi.admin.shell.dispatch;

const schema = z.object({
  toUserId: z.string().min(1, t.reassign.toUserRequired),
  reason: z.string().trim().min(1, t.reassign.reasonRequired).max(2000, t.reasonTooLong),
});
type FormValues = z.infer<typeof schema>;

function ReassignForm({ steps, onOpenChange, onDone }: Omit<DispatchDialogProps, 'open'>) {
  const targets = eligible(steps, 'reassign');
  const only = targets.length === 1 ? targets[0] : undefined;
  const [person, setPerson] = useState<PersonOption | null>(null);
  const [results, setResults] = useState<ItemResult[] | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { toUserId: '', reason: '' } });
  // Việc trong quy trình chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền (docs/DECISIONS.md, 05/10/2026);
  // việc ngoài quy trình thì ai cũng được. Nhiều việc: phần chung của các việc bị giới hạn.
  const assignees = useApiQuery('steps.assignees', { body: { stepIds: targets.map((s) => s.id) } }, { enabled: targets.length > 0, staleTime: 0, gcTime: 0 });
  const restricted = assignees.data !== undefined && !assignees.data.anyone;

  const onError = (err: Error) => {
    if (isApiError(err, 'state_conflict')) invalidateRoutes(STEP_INVALIDATE);
  };
  const single = useApiMutation('steps.reassign', { invalidate: STEP_INVALIDATE, toastError: false, onError });
  const batch = useApiMutation('steps.batch', { invalidate: STEP_INVALIDATE, toastError: false, onError });
  const pending = single.isPending || batch.isPending;

  const submit = form.handleSubmit((values) => {
    if (!person) return;
    const name = personName(person, 'short');
    if (only) {
      single.mutate(
        { params: { id: only.id }, body: { toUserId: values.toUserId, reason: values.reason } },
        {
          onSuccess: () => {
            toast.success(fmt(t.reassign.done, { tên: name }));
            onDone?.();
            onOpenChange(false);
          },
        },
      );
      return;
    }
    batch.mutate(
      { body: { action: 'reassign', stepIds: targets.map((s) => s.id), params: { toUserId: values.toUserId, reason: values.reason } } },
      {
        onSuccess: (res) => {
          onDone?.();
          if (res.results.every((r) => r.ok)) {
            toast.success(fmt(t.reassign.doneMany, { n: res.results.length, tên: name }));
            onOpenChange(false);
          } else {
            setResults(res.results);
          }
        },
      },
    );
  });

  const title = targets.length > 1 ? fmt(t.reassign.titleMany, { n: targets.length }) : t.reassign.title;

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
        <Field label={t.reassign.toUser} required hint={restricted ? t.reassign.onlyAppointed : undefined} error={form.formState.errors.toUserId?.message}>
          <PersonPicker
            value={person}
            candidates={restricted ? assignees.data?.people : null}
            disabled={assignees.isPending}
            excludeIds={only?.assignee ? [only.assignee.id] : undefined}
            onChange={(p) => {
              setPerson(p);
              form.setValue('toUserId', p?.id ?? '', { shouldValidate: form.formState.isSubmitted });
            }}
          />
        </Field>
        <Field label={t.reassign.reason} hint={t.reassign.reasonHint} required error={form.formState.errors.reason?.message}>
          <Textarea {...form.register('reason')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={pending} disabled={targets.length === 0}>
          {t.reassign.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Giao lại một hoặc nhiều việc: chọn người và ghi lý do (bắt buộc).
 * Một việc gọi `steps.reassign`; nhiều việc gọi `steps.batch` (tối đa 50) và hiện kết quả từng việc nếu có việc chưa làm được.
 */
export function ReassignDialog({ open, onOpenChange, steps, onDone }: DispatchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ReassignForm steps={steps} onOpenChange={onOpenChange} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}
