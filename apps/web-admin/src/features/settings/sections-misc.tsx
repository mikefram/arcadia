import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { OrgSettingsSchema } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { changedKeys, emptyToNull, SectionFrame, useReportDirty, useSectionSave, type SectionProps } from './section';

const t = vi.admin.org.settings;

// ───────────────────────── Văn phòng ─────────────────────────

const OfficeSchema = OrgSettingsSchema.pick({ officePhone: true, greeting: true }).superRefine((v, ctx) => {
  if (v.officePhone && !/^\+?\d[\d .]{6,18}\d$/.test(v.officePhone)) ctx.addIssue({ code: 'custom', path: ['officePhone'], message: 'phone' });
  if (v.greeting && v.greeting.length > 300) ctx.addIssue({ code: 'custom', path: ['greeting'], message: 'long' });
});
type OfficeInput = z.input<typeof OfficeSchema>;
type OfficeOutput = z.output<typeof OfficeSchema>;

export const OFFICE_ID = 'van-phong';

/** Số điện thoại cho nút "Nhờ Văn phòng" (SPEC 7.7) và lời chúc dịp Tết, lễ do Văn phòng soạn (SPEC 7.5). */
export function OfficeSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ officePhone: settings.officePhone, greeting: settings.greeting }), [settings.officePhone, settings.greeting]);
  const form = useForm<OfficeInput, unknown, OfficeOutput>({ resolver: zodResolver(OfficeSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.office.title);
  useReportDirty(OFFICE_ID, isDirty, onDirtyChange);
  const submit = form.handleSubmit((next) => section.save(changedKeys(next, values)));

  return (
    <SectionFrame
      id={OFFICE_ID}
      title={t.office.title}
      description={t.office.description}
      dirty={isDirty}
      saving={section.saving}
      savedAt={section.savedAt}
      error={section.error}
      onSubmit={(e) => void submit(e)}
      onDiscard={() => {
        section.clearError();
        form.reset(values);
      }}
    >
      <Field label={t.office.phone} hint={t.office.phoneHint} error={errors.officePhone ? t.office.phoneInvalid : undefined}>
        <Input type="tel" inputMode="tel" autoComplete="off" className="tabular max-w-64" {...form.register('officePhone', { setValueAs: emptyToNull })} />
      </Field>
      <Field label={t.office.greeting} hint={t.office.greetingHint} error={errors.greeting ? t.office.greetingTooLong : undefined}>
        <Textarea rows={2} {...form.register('greeting', { setValueAs: emptyToNull })} />
      </Field>
    </SectionFrame>
  );
}

// ───────────────────────── Phiên bản ứng dụng tối thiểu ─────────────────────────

const VersionSchema = OrgSettingsSchema.pick({ minAppVersion: true }).superRefine((v, ctx) => {
  if (v.minAppVersion && !/^\d+(\.\d+){0,3}$/.test(v.minAppVersion)) ctx.addIssue({ code: 'custom', path: ['minAppVersion'], message: 'version' });
});
type VersionInput = z.input<typeof VersionSchema>;
type VersionOutput = z.output<typeof VersionSchema>;

export const VERSION_ID = 'phien-ban';

/** `minAppVersion`: app thấp hơn mức này nhận 426 và được yêu cầu cập nhật (SPEC 10.1). */
export function AppVersionSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ minAppVersion: settings.minAppVersion }), [settings.minAppVersion]);
  const form = useForm<VersionInput, unknown, VersionOutput>({ resolver: zodResolver(VersionSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.appVersion.title);
  useReportDirty(VERSION_ID, isDirty, onDirtyChange);
  const submit = form.handleSubmit((next) => section.save(changedKeys(next, values)));

  return (
    <SectionFrame
      id={VERSION_ID}
      title={t.appVersion.title}
      description={t.appVersion.description}
      dirty={isDirty}
      saving={section.saving}
      savedAt={section.savedAt}
      error={section.error}
      onSubmit={(e) => void submit(e)}
      onDiscard={() => {
        section.clearError();
        form.reset(values);
      }}
    >
      <Field label={t.appVersion.label} hint={t.appVersion.hint} error={errors.minAppVersion ? t.appVersion.invalid : undefined}>
        <Input autoComplete="off" spellCheck={false} className="tabular max-w-40" {...form.register('minAppVersion', { setValueAs: emptyToNull })} />
      </Field>
    </SectionFrame>
  );
}

// ───────────────────────── Thời hạn lưu dữ liệu ─────────────────────────

const RETENTION_FIELDS = [
  { key: 'transcriptDays', unit: 'days' },
  { key: 'briefingAudioDays', unit: 'days' },
  { key: 'notificationDays', unit: 'days' },
  { key: 'auditLogMonths', unit: 'months' },
  { key: 'aiUsageMonths', unit: 'months' },
] as const;

const RetentionFormSchema = OrgSettingsSchema.pick({ retention: true }).superRefine((v, ctx) => {
  if (!v.retention) return;
  for (const { key } of RETENTION_FIELDS) {
    const value = v.retention[key];
    if (value !== undefined && value < 1) ctx.addIssue({ code: 'custom', path: ['retention', key], message: 'min' });
  }
});
type RetentionInput = z.input<typeof RetentionFormSchema>;
type RetentionOutput = z.output<typeof RetentionFormSchema>;

export const RETENTION_ID = 'luu-du-lieu';

/** Thời hạn lưu từng loại dữ liệu (SPEC 11.6): hội thoại, âm thanh bản tin, thông báo, nhật ký, số liệu dùng Trợ lý AI. */
export function RetentionSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ retention: settings.retention }), [settings.retention]);
  const form = useForm<RetentionInput, unknown, RetentionOutput>({ resolver: zodResolver(RetentionFormSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.retention.title);
  useReportDirty(RETENTION_ID, isDirty, onDirtyChange);
  const submit = form.handleSubmit((next) => {
    const retention = changedKeys(next.retention, values.retention);
    section.save(Object.keys(retention).length > 0 ? { retention } : {});
  });

  return (
    <SectionFrame
      id={RETENTION_ID}
      title={t.retention.title}
      description={t.retention.description}
      dirty={isDirty}
      saving={section.saving}
      savedAt={section.savedAt}
      error={section.error}
      onSubmit={(e) => void submit(e)}
      onDiscard={() => {
        section.clearError();
        form.reset(values);
      }}
    >
      <div className="grid items-start gap-x-6 gap-y-4 sm:grid-cols-2">
        {RETENTION_FIELDS.map(({ key, unit }) => (
          <Field key={key} label={t.retention[key]} error={errors.retention?.[key] ? t.retention.invalid : undefined}>
            <div className="flex items-center gap-2">
              <Input type="number" inputMode="numeric" min={1} step={1} className="tabular w-28" {...form.register(`retention.${key}`, { valueAsNumber: true })} />
              <span className="text-ink-sub">{t.retention[unit]}</span>
            </div>
          </Field>
        ))}
      </div>
    </SectionFrame>
  );
}

// ───────────────────────── Đầu mối bảo vệ dữ liệu ─────────────────────────

const ContactSchema = OrgSettingsSchema.pick({ dataContact: true }).superRefine((v, ctx) => {
  if (v.dataContact && v.dataContact.length > 300) ctx.addIssue({ code: 'custom', path: ['dataContact'], message: 'long' });
});
type ContactInput = z.input<typeof ContactSchema>;
type ContactOutput = z.output<typeof ContactSchema>;

export const CONTACT_ID = 'dau-moi-du-lieu';

/** Đầu mối bảo vệ dữ liệu của tổ chức (SPEC 11.8). */
export function DataContactSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ dataContact: settings.dataContact }), [settings.dataContact]);
  const form = useForm<ContactInput, unknown, ContactOutput>({ resolver: zodResolver(ContactSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.dataContact.title);
  useReportDirty(CONTACT_ID, isDirty, onDirtyChange);
  const submit = form.handleSubmit((next) => section.save(changedKeys(next, values)));

  return (
    <SectionFrame
      id={CONTACT_ID}
      title={t.dataContact.title}
      description={t.dataContact.description}
      dirty={isDirty}
      saving={section.saving}
      savedAt={section.savedAt}
      error={section.error}
      onSubmit={(e) => void submit(e)}
      onDiscard={() => {
        section.clearError();
        form.reset(values);
      }}
    >
      <Field label={t.dataContact.label} hint={t.dataContact.hint} error={errors.dataContact ? t.dataContact.tooLong : undefined}>
        <Textarea rows={2} {...form.register('dataContact', { setValueAs: emptyToNull })} />
      </Field>
    </SectionFrame>
  );
}
