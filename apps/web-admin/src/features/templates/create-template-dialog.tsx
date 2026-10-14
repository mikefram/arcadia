import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { TemplateSummary } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { sortByVi } from '@/lib/collator';
import { errorMessage } from '@/lib/errors';
import { useApiMutation } from '@/lib/query';

const t = vi.admin.designer.create;

const schema = z
  .object({
    name: z.string().trim().min(1, t.nameRequired).max(200, t.nameTooLong),
    description: z.string().trim().max(2000, t.descriptionTooLong),
    source: z.enum(['blank', 'clone']),
    cloneFrom: z.string(),
  })
  .refine((v) => v.source === 'blank' || v.cloneFrom !== '', { path: ['cloneFrom'], message: t.cloneRequired });
type FormValues = z.infer<typeof schema>;

export type CreateTemplateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** các mẫu có thể nhân bản */
  templates: readonly TemplateSummary[];
  /** mở từ mục "Nhân bản" của một dòng: chọn sẵn mẫu nguồn */
  cloneFrom?: TemplateSummary | null;
};

function CreateForm({ templates, cloneFrom, onOpenChange }: Omit<CreateTemplateDialogProps, 'open'>) {
  const navigate = useNavigate();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: cloneFrom ? fmt(t.cloneName, { tên: cloneFrom.name }).slice(0, 200) : '',
      description: cloneFrom?.description ?? '',
      source: cloneFrom ? 'clone' : 'blank',
      cloneFrom: cloneFrom?.id ?? '',
    },
  });
  const create = useApiMutation('templates.create', { invalidate: ['templates.list'], toastError: false });
  const source = form.watch('source');
  const picked = form.watch('cloneFrom');
  const errors = form.formState.errors;
  const options = sortByVi(templates, (x) => x.name).map((x) => ({ value: x.id, label: x.name }));

  const submit = form.handleSubmit((values) => {
    create.mutate(
      {
        body: {
          name: values.name,
          description: values.description || null,
          ...(values.source === 'clone' ? { cloneFromTemplateId: values.cloneFrom } : {}),
        },
      },
      {
        onSuccess: (created) => {
          toast.success(fmt(t.created, { tên: created.name }));
          onOpenChange(false);
          void navigate({ to: '/quy-trinh/$templateId', params: { templateId: created.id } });
        },
      },
    );
  });

  const choice = (value: FormValues['source'], title: string, hint: string) => (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary',
        source === value ? 'border-primary bg-primary-tint' : 'border-line bg-surface hover:bg-surface-alt',
      )}
    >
      <input type="radio" value={value} {...form.register('source')} className="mt-1 size-4 accent-primary outline-none" />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-ink-sub">{hint}</span>
      </span>
    </label>
  );

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {create.error ? <Callout tone="error">{errorMessage(create.error)}</Callout> : null}
        <Field label={t.name} required error={errors.name?.message}>
          <Input autoFocus placeholder={t.namePlaceholder} {...form.register('name')} />
        </Field>
        <Field label={t.description} hint={t.descriptionHint} error={errors.description?.message}>
          <Textarea rows={2} {...form.register('description')} />
        </Field>
        {templates.length > 0 ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-base font-medium">{t.source}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {choice('blank', t.sourceBlank, t.sourceBlankHint)}
              {choice('clone', t.sourceClone, t.sourceCloneHint)}
            </div>
          </fieldset>
        ) : null}
        {source === 'clone' ? (
          <Field label={t.cloneFrom} required error={errors.cloneFrom?.message}>
            <Select
              value={picked || null}
              placeholder={t.cloneFromPlaceholder}
              options={options}
              onValueChange={(id) => {
                form.setValue('cloneFrom', id ?? '', { shouldValidate: form.formState.isSubmitted });
                const origin = templates.find((x) => x.id === id);
                // Chưa gõ tên thì gợi ý luôn "<tên mẫu> (bản sao)".
                if (origin && !form.getValues('name').trim()) form.setValue('name', fmt(t.cloneName, { tên: origin.name }).slice(0, 200));
              }}
            />
          </Field>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={create.isPending} data-testid="create-submit">
          {t.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Tạo quy trình: tên và mô tả, bắt đầu từ bản trống hoặc nhân bản một mẫu có sẵn; xong thì mở thẳng trình thiết kế. */
export function CreateTemplateDialog({ open, onOpenChange, templates, cloneFrom }: CreateTemplateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-dialog">
        <CreateForm templates={templates} cloneFrom={cloneFrom} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
