import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { REGISTER_DIRECTIONS, type RegisterView } from '@mihato/domain';
import { fmt, vi, vnParts } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { useApiMutation } from '@/lib/query';
import {
  appendToken,
  COLUMN_LIMIT,
  EMPTY_REGISTER_VALUES,
  PATTERN_TOKENS,
  previewNumbers,
  registerFormSchema,
  toUpsert,
  valuesFromRegister,
  type RegisterFormValues,
} from './register-form';

const t = vi.admin.documents.config;

export type RegisterConfigTarget =
  /** thêm sổ; `initial` điền sẵn (ví dụ sổ khuyến nghị), bỏ trống là biểu mẫu trắng */
  | { mode: 'create'; initial?: RegisterFormValues }
  | { mode: 'edit'; register: RegisterView };

export type RegisterConfigDialogProps = {
  /** null = đóng */
  target: RegisterConfigTarget | null;
  onOpenChange: (open: boolean) => void;
  /** mã mọi sổ đang có, để chặn tạo trùng mã */
  takenCodes: readonly string[];
  /** gọi sau khi lưu xong, kèm mã sổ vừa tạo hoặc sửa */
  onSaved: (code: string) => void;
};

function ConfigForm({ target, takenCodes, onOpenChange, onSaved }: Omit<RegisterConfigDialogProps, 'target'> & { target: RegisterConfigTarget }) {
  const mode = target.mode;
  const register = target.mode === 'edit' ? target.register : null;
  const defaults = target.mode === 'edit' ? valuesFromRegister(target.register) : (target.initial ?? EMPTY_REGISTER_VALUES);
  const schema = useMemo(() => registerFormSchema(mode, takenCodes), [mode, takenCodes]);
  const form = useForm<RegisterFormValues>({ resolver: zodResolver(schema), defaultValues: defaults });
  const columns = useFieldArray({ control: form.control, name: 'columns' });
  const save = useApiMutation('registers.upsert', { toastError: false, invalidate: ['registers.list', 'registers.entries'] });
  const errors = form.formState.errors;
  const pattern = useWatch({ control: form.control, name: 'pattern' });
  const direction = useWatch({ control: form.control, name: 'direction' });
  const year = vnParts(Date.now()).year;
  const preview = previewNumbers(pattern, year);
  // Số kế tiếp thật của sổ chỉ đúng khi mẫu chưa đổi.
  const nextNumber = register && pattern.trim() === register.pattern ? register.nextNumber : null;

  const submit = form.handleSubmit((values) => {
    const code = register ? register.code : values.code.trim();
    const body = toUpsert(values);
    save.mutate(
      { params: { code }, body },
      {
        onSuccess: (saved) => {
          toast.success(fmt(mode === 'create' ? t.created : t.saved, { sổ: saved.name }));
          onOpenChange(false);
          onSaved(saved.code);
        },
      },
    );
  });

  const directionChoice = (value: (typeof REGISTER_DIRECTIONS)[number]) => (
    <label
      key={value}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary',
        direction === value ? 'border-primary bg-primary-tint' : 'border-line bg-surface hover:bg-surface-alt',
      )}
    >
      <input type="radio" value={value} {...form.register('direction')} className="size-4 accent-primary outline-none" />
      <span className="font-medium">{vi.admin.documents.direction[value]}</span>
    </label>
  );

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col" data-testid="register-form">
      <DialogHeader>
        <DialogTitle>{register ? fmt(t.titleEdit, { sổ: register.name }) : t.titleCreate}</DialogTitle>
        <DialogDescription>{register ? t.introEdit : t.introCreate}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {save.error ? <Callout tone="error">{errorMessage(save.error)}</Callout> : null}

        <Field label={t.code} hint={register ? undefined : t.codeHint} required={register === null} error={errors.code?.message}>
          {register ? <Input value={register.code} readOnly disabled data-testid="register-code" /> : <Input autoFocus placeholder={t.codePlaceholder} data-testid="register-code" {...form.register('code')} />}
        </Field>

        <Field label={t.name} required error={errors.name?.message}>
          <Input autoFocus={register !== null} placeholder={t.namePlaceholder} data-testid="register-name" {...form.register('name')} />
        </Field>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-base font-medium">{t.direction}</legend>
          <div className="grid gap-2 sm:grid-cols-3">{REGISTER_DIRECTIONS.map(directionChoice)}</div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <Field label={t.pattern} hint={t.patternHint} required error={errors.pattern?.message}>
            <Input placeholder={t.patternPlaceholder} spellCheck={false} autoComplete="off" data-testid="register-pattern" {...form.register('pattern')} />
          </Field>
          <div role="group" aria-label={t.tokens} className="flex flex-wrap items-center gap-1.5">
            <span aria-hidden="true" className="text-sm text-ink-sub">
              {t.tokens}:
            </span>
            {PATTERN_TOKENS.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="secondary"
                aria-label={fmt(t.insertToken, { dấu: item.token, nghĩa: item.meaning })}
                title={item.meaning}
                onClick={() => {
                  form.setValue('pattern', appendToken(form.getValues('pattern'), item.token), { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
                  form.setFocus('pattern');
                }}
              >
                {item.token}
              </Button>
            ))}
          </div>
          <div aria-live="polite" data-testid="pattern-preview" className="rounded-lg border border-hairline bg-surface-alt px-3.5 py-2.5 text-base">
            <p className="text-sm font-medium text-ink-sub">{t.previewLabel}</p>
            {preview ? (
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5">
                <dt className="text-ink-sub">{fmt(t.previewFirst, { năm: year })}</dt>
                <dd className="tabular font-semibold break-all" data-testid="preview-first">
                  {preview.first}
                </dd>
                <dt className="text-ink-sub">{fmt(t.previewLater, { thứ: preview.laterSeq })}</dt>
                <dd className="tabular font-semibold break-all">{preview.later}</dd>
                {nextNumber ? (
                  <>
                    <dt className="text-ink-sub">{t.previewNext}</dt>
                    <dd className="tabular font-semibold break-all">{nextNumber}</dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="text-ink-sub">{t.previewNone}</p>
            )}
          </div>
        </div>

        <Controller
          control={form.control}
          name="resetYearly"
          render={({ field }) => (
            <div className="flex items-start gap-3">
              <Switch id="register-reset" checked={field.value} onCheckedChange={field.onChange} data-testid="register-reset" aria-describedby="register-reset-hint" className="mt-0.5" />
              <div>
                <label htmlFor="register-reset" className="font-medium">
                  {t.reset}
                </label>
                <p id="register-reset-hint" className="text-sm text-ink-sub">
                  {t.resetHint}
                </p>
              </div>
            </div>
          )}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-base font-medium">{t.columns}</legend>
          <p className="text-sm text-ink-sub">{t.columnsHint}</p>
          {columns.fields.length === 0 ? <p className="text-sm text-ink-sub">{t.columnsNone}</p> : null}
          {columns.fields.length > 0 ? (
            <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2 text-sm font-medium text-ink-sub sm:grid">
              <span>{t.columnKey}</span>
              <span>{t.columnLabel}</span>
              <span />
            </div>
          ) : null}
          <ul className="flex flex-col gap-2" data-testid="register-columns">
            {columns.fields.map((item, i) => (
              <li key={item.id} className="grid grid-cols-[minmax(0,1fr)_2rem] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]">
                <Field label={fmt(t.columnKeyOf, { số: i + 1 })} hideLabel error={errors.columns?.[i]?.key?.message} className="col-start-1">
                  <Input placeholder={t.columnKeyPlaceholder} spellCheck={false} autoComplete="off" {...form.register(`columns.${i}.key`)} />
                </Field>
                <Field label={fmt(t.columnLabelOf, { số: i + 1 })} hideLabel error={errors.columns?.[i]?.label?.message} className="col-start-1 sm:col-start-2">
                  <Input placeholder={t.columnLabelPlaceholder} {...form.register(`columns.${i}.label`)} />
                </Field>
                <Button variant="ghost" size="icon-sm" aria-label={fmt(t.removeColumn, { số: i + 1 })} onClick={() => columns.remove(i)} className="col-start-2 row-start-1 mt-1 sm:col-start-3 sm:row-start-auto">
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" variant="secondary" disabled={columns.fields.length >= COLUMN_LIMIT} onClick={() => columns.append({ key: '', label: '' })} data-testid="register-add-column">
              <Plus aria-hidden="true" />
              {t.addColumn}
            </Button>
          </div>
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={save.isPending} data-testid="register-submit">
          {register ? t.submitEdit : t.submitCreate}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Hộp thoại thêm sổ hoặc sửa cấu hình một sổ văn bản (chỉ người có `org.settings`). Biểu mẫu dựng lại mỗi lần mở. */
export function RegisterConfigDialog({ target, onOpenChange, takenCodes, onSaved }: RegisterConfigDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="register-config-dialog">
        {target ? <ConfigForm target={target} takenCodes={takenCodes} onOpenChange={onOpenChange} onSaved={onSaved} /> : null}
      </DialogContent>
    </Dialog>
  );
}
