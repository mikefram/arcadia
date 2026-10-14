import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { TemplatePreset, TemplateSummary } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/errors';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { categoryLabel, isNameTaken, sortPresets } from './template-categories';

const t = vi.admin.designer.list.presets;
const c = vi.admin.designer.create;

/** Số dòng “Ai làm gì” hiện trên một thẻ; phần còn lại gộp thành “Và n việc nữa”. */
const MAX_SUMMARY_LINES = 6;

const schema = z.object({
  name: z.string().trim().min(1, c.nameRequired).max(200, c.nameTooLong),
  description: z.string().trim().max(2000, c.descriptionTooLong),
});
type FormValues = z.infer<typeof schema>;

function PresetCard({ preset, onPick }: { preset: TemplatePreset; onPick: (preset: TemplatePreset) => void }) {
  const lines = preset.summary.slice(0, MAX_SUMMARY_LINES);
  const rest = preset.summary.length - lines.length;
  const headingId = `preset-${preset.id}-name`;
  return (
    <li className="flex">
      <article aria-labelledby={headingId} data-testid={`preset-${preset.id}`} className="flex w-full flex-col gap-3 rounded-xl border border-hairline bg-surface p-4">
        <header className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="primary">{categoryLabel(preset.category)}</Badge>
            <Badge tone="muted">{fmt(t.steps, { n: preset.steps })}</Badge>
          </div>
          <h3 id={headingId} className="text-lg font-semibold text-ink">
            {preset.name}
          </h3>
          <p className="text-base text-ink-sub">{preset.description}</p>
        </header>
        <div className="flex-1">
          <p className="mb-1 text-sm font-semibold text-ink-sub">{t.summaryLabel}</p>
          {lines.length > 0 ? (
            <ol className="list-decimal space-y-0.5 pl-5 text-sm text-ink marker:text-ink-sub">
              {lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
              {rest > 0 ? <li className="list-none text-ink-sub">{fmt(t.moreSteps, { n: rest })}</li> : null}
            </ol>
          ) : (
            <p className="text-sm text-ink-sub">{t.noSummary}</p>
          )}
        </div>
        <Button variant="secondary" onClick={() => onPick(preset)} aria-label={fmt(t.pickFor, { tên: preset.name })} data-testid={`preset-pick-${preset.id}`}>
          {t.pick}
        </Button>
      </article>
    </li>
  );
}

function PickStep({ onPick }: { onPick: (preset: TemplatePreset) => void }) {
  const presets = useApiQuery('templates.presets', {}, { staleTime: 5 * 60_000 });
  const items = sortPresets(presets.data?.items ?? []);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {presets.isError ? (
          <Callout
            tone="error"
            title={vi.admin.shell.ui.loadFailedTitle}
            action={
              <Button size="sm" onClick={() => void presets.refetch()}>
                {vi.admin.shell.ui.retry}
              </Button>
            }
          >
            {errorMessage(presets.error)}
          </Callout>
        ) : presets.isPending ? (
          <div role="status" aria-label={t.loading} className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-52 rounded-xl" />
            <Skeleton className="h-52 rounded-xl" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title={t.empty} />
        ) : (
          <ul aria-label={t.region} className="grid gap-3 sm:grid-cols-2">
            {items.map((preset) => (
              <PresetCard key={preset.id} preset={preset} onPick={onPick} />
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function NameStep({ preset, templates, onBack, onClose }: { preset: TemplatePreset; templates: readonly TemplateSummary[]; onBack: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: preset.name.slice(0, 200), description: preset.description } });
  const create = useApiMutation('templates.create', { invalidate: ['templates.list'], toastError: false });
  const errors = form.formState.errors;
  const duplicate = isNameTaken(form.watch('name'), templates);

  const submit = form.handleSubmit((values) => {
    create.mutate(
      {
        body: {
          name: values.name,
          description: values.description || null,
          category: preset.category,
          // Máy chủ chỉ điền tên vào định nghĩa khi định nghĩa chưa có tên, nên đặt thẳng tên người dùng đã chọn.
          definition: { ...preset.definition, name: values.name },
        },
      },
      {
        onSuccess: (created) => {
          toast.success(fmt(t.created, { tên: created.name }));
          onClose();
          void navigate({ to: '/quy-trinh/$templateId', params: { templateId: created.id } });
        },
      },
    );
  });

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.nameTitle}</DialogTitle>
        <DialogDescription>{fmt(t.nameIntro, { tên: preset.name })}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {create.error ? <Callout tone="error">{errorMessage(create.error)}</Callout> : null}
        <Field label={c.name} required error={errors.name?.message}>
          <Input autoFocus data-testid="preset-name" {...form.register('name')} />
        </Field>
        {duplicate ? (
          <p role="status" data-testid="preset-name-duplicate" className="-mt-2 flex items-start gap-1.5 text-sm font-medium text-warn">
            <TriangleAlert aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
            <span>{t.nameDuplicate}</span>
          </p>
        ) : null}
        <Field label={c.description} hint={c.descriptionHint} error={errors.description?.message}>
          <Textarea rows={3} {...form.register('description')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onBack} className="sm:mr-auto">
          <ArrowLeft aria-hidden="true" />
          {t.back}
        </Button>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={create.isPending} data-testid="preset-submit">
          {t.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

export type PresetGalleryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** mọi quy trình đang có, để báo trùng tên */
  templates: readonly TemplateSummary[];
};

/**
 * Thư viện mẫu có sẵn: chọn một mẫu, đặt tên, tạo bản nháp của tổ chức rồi mở trình thiết kế.
 * Mẫu được chép nguyên định nghĩa; bản gốc trong thư viện không bao giờ bị sửa.
 */
export function PresetGalleryDialog({ open, onOpenChange, templates }: PresetGalleryDialogProps) {
  const [picked, setPicked] = useState<TemplatePreset | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPicked(null);
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg" data-testid="preset-gallery">
        {picked ? (
          <NameStep
            preset={picked}
            templates={templates}
            onBack={() => setPicked(null)}
            onClose={() => {
              setPicked(null);
              onOpenChange(false);
            }}
          />
        ) : (
          <PickStep onPick={setPicked} />
        )}
      </DialogContent>
    </Dialog>
  );
}
