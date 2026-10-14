import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError } from '@mihato/api-client';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { vnToday } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/auth';
import { personName } from '@/lib/person';
import { useApiMutation } from '@/lib/query';
import { STEP_INVALIDATE } from './shared';

const t = vi.admin.shell.dispatch.giveTask;

const schema = z.object({
  title: z.string().trim().min(1, t.taskTitleRequired).max(TASK_TITLE_MAX, vi.admin.shell.dispatch.reasonTooLong),
  description: z.string().trim().max(TASK_DESCRIPTION_MAX, vi.admin.shell.dispatch.reasonTooLong),
  assigneeId: z.string().min(1, t.assigneeRequired),
  dueDate: z.string().min(1, t.dueDateRequired),
});
type FormValues = z.infer<typeof schema>;

/** Câu cho lỗi từng ô của máy chủ (mã con của `input_invalid`); mã lạ thì dùng câu chung. */
function problemText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return error ? errorMessage(error) : null;
  const code = error.extra.errors?.[0]?.code;
  const table: Record<string, string> = t.errors;
  return (code ? table[code] : undefined) ?? errorMessage(error);
}

function GiveTaskForm({ onOpenChange, onDone }: { onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const me = useMe();
  const [person, setPerson] = useState<PersonOption | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: '', description: '', assigneeId: '', dueDate: '' } });
  const create = useApiMutation('tasks.create', { invalidate: [...STEP_INVALIDATE, 'people.search'], toastError: false });
  const errors = form.formState.errors;

  const submit = form.handleSubmit((values) => {
    if (!person) return;
    create.mutate(
      { body: { title: values.title, ...(values.description ? { description: values.description } : {}), assigneeId: values.assigneeId, dueDate: values.dueDate } },
      {
        onSuccess: () => {
          toast.success(fmt(t.done, { tên: personName(person, 'short') }));
          onDone?.();
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {create.error ? <Callout tone="error">{problemText(create.error)}</Callout> : null}
        <Field label={t.taskTitle} hint={t.taskTitleHint} required error={errors.title?.message}>
          <Input autoComplete="off" maxLength={TASK_TITLE_MAX + 20} {...form.register('title')} />
        </Field>
        <Field label={t.assignee} required error={errors.assigneeId?.message}>
          <PersonPicker
            value={person}
            excludeIds={[me.id]}
            onChange={(p) => {
              setPerson(p);
              form.setValue('assigneeId', p?.id ?? '', { shouldValidate: form.formState.isSubmitted });
            }}
          />
        </Field>
        <Field label={t.dueDate} hint={t.dueDateHint} required error={errors.dueDate?.message}>
          <Input type="date" min={vnToday()} {...form.register('dueDate')} />
        </Field>
        <Field label={t.description} hint={t.descriptionHint} error={errors.description?.message}>
          <Textarea {...form.register('description')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

export type GiveTaskDialogProps = { open: boolean; onOpenChange: (open: boolean) => void; onDone?: () => void };

/**
 * Giao một việc ngoài quy trình (`tasks.create`): tên việc, người nhận tuỳ ý, hạn và lời dặn. Khác việc nằm trong quy trình,
 * người giao chọn người nhận tự do (docs/DECISIONS.md, 05/10/2026).
 */
export function GiveTaskDialog({ open, onOpenChange, onDone }: GiveTaskDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <GiveTaskForm onOpenChange={onOpenChange} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}
