import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { OrgSettingsSchema } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Callout } from '@/components/ui/callout';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { changedKeys, SectionFrame, useReportDirty, useSectionSave, type SectionProps } from './section';

const t = vi.admin.org.settings;

// ───────────────────────── Lịch làm việc ─────────────────────────

const CalendarSchema = OrgSettingsSchema.pick({ workdays: true, workStart: true, workEnd: true }).superRefine((v, ctx) => {
  if (v.workStart >= v.workEnd) ctx.addIssue({ code: 'custom', path: ['workEnd'], message: 'order' });
});
type CalendarInput = z.input<typeof CalendarSchema>;
type CalendarOutput = z.output<typeof CalendarSchema>;

/** ISO: 1 = Thứ Hai … 7 = Chủ Nhật, đúng thứ tự của `weekdays` trong kho chuỗi. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export const CALENDAR_ID = 'lich-lam-viec';

/** Tuần làm việc và giờ làm việc (SPEC 4.5): nền của mọi phép tính hạn. */
export function CalendarSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ workdays: settings.workdays, workStart: settings.workStart, workEnd: settings.workEnd }), [settings.workdays, settings.workStart, settings.workEnd]);
  const form = useForm<CalendarInput, unknown, CalendarOutput>({ resolver: zodResolver(CalendarSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.calendar.title);
  useReportDirty(CALENDAR_ID, isDirty, onDirtyChange);

  const submit = form.handleSubmit((next) => section.save(changedKeys({ ...next, workdays: [...next.workdays].sort((a, b) => a - b) }, values)));

  return (
    <SectionFrame
      id={CALENDAR_ID}
      title={t.calendar.title}
      description={t.calendar.description}
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
      <Controller
        control={form.control}
        name="workdays"
        render={({ field }) => {
          const selected = new Set(field.value ?? []);
          return (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-base font-medium">{t.calendar.workdays}</legend>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((day) => {
                  const checked = selected.has(day);
                  return (
                    <label
                      key={day}
                      className={cn(
                        'flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 font-medium transition-colors',
                        checked ? 'border-primary bg-primary-tint text-on-primary-tint' : 'border-line bg-surface text-ink hover:bg-surface-alt',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const next = new Set(selected);
                          if (v === true) next.add(day);
                          else next.delete(day);
                          field.onChange([...next].sort((a, b) => a - b));
                        }}
                      />
                      {t.calendar.weekdays[day - 1]}
                    </label>
                  );
                })}
              </div>
              {errors.workdays ? <FieldError>{t.calendar.workdaysRequired}</FieldError> : null}
            </fieldset>
          );
        }}
      />
      <div className="grid max-w-md items-start gap-4 sm:grid-cols-2">
        <Field label={t.calendar.workStart} error={errors.workStart ? t.timeInvalid : undefined}>
          <Input type="time" {...form.register('workStart')} />
        </Field>
        <Field label={t.calendar.workEnd} error={errors.workEnd ? (errors.workEnd.message === 'order' ? t.calendar.endBeforeStart : t.timeInvalid) : undefined}>
          <Input type="time" {...form.register('workEnd')} />
        </Field>
      </div>
      <p className="-mt-1 text-sm text-ink-sub">{t.calendar.workEndHint}</p>
    </SectionFrame>
  );
}

// ───────────────────────── Giờ yên tĩnh ─────────────────────────

const QuietSchema = OrgSettingsSchema.pick({ quietHours: true }).superRefine((v, ctx) => {
  if (v.quietHours && v.quietHours.start === v.quietHours.end) ctx.addIssue({ code: 'custom', path: ['quietHours', 'end'], message: 'same' });
});
type QuietInput = z.input<typeof QuietSchema>;
type QuietOutput = z.output<typeof QuietSchema>;

export const QUIET_ID = 'gio-yen-tinh';

/**
 * Giờ yên tĩnh (SPEC 4.6): không đẩy thông báo, dời tới giờ kết thúc. Mặc định KHÔNG DÙNG (docs/DECISIONS.md, 04/10/2026):
 * với công việc, giao việc hay đi thúc lúc 2 giờ sáng là bình thường. Bật thì mới có khoảng giờ.
 */
const DEFAULT_QUIET = { start: '21:00', end: '07:00' } as const;

export function QuietHoursSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ quietHours: settings.quietHours }), [settings.quietHours]);
  const form = useForm<QuietInput, unknown, QuietOutput>({ resolver: zodResolver(QuietSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.quiet.title);
  useReportDirty(QUIET_ID, isDirty, onDirtyChange);

  const enabled = form.watch('quietHours') !== null;
  const [start, end] = form.watch(['quietHours.start', 'quietHours.end']);
  const summary = enabled && start && end && start !== end ? fmt(start > end ? t.quiet.summaryOvernight : t.quiet.summarySameDay, { từ: start, đến: end }) : null;

  const submit = form.handleSubmit((next) => {
    if (next.quietHours === null) {
      section.save(values.quietHours === null ? {} : { quietHours: null });
      return;
    }
    // Từ "không có" sang "có" thì gửi đủ hai đầu; đã có thì chỉ gửi đầu nào đổi.
    const quietHours = values.quietHours === null ? next.quietHours : changedKeys(next.quietHours, values.quietHours);
    section.save(Object.keys(quietHours).length > 0 ? { quietHours } : {});
  });

  return (
    <SectionFrame
      id={QUIET_ID}
      title={t.quiet.title}
      description={t.quiet.description}
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
      <label className="flex w-fit items-center gap-2 text-sm text-ink">
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => form.setValue('quietHours', v === true ? { ...DEFAULT_QUIET } : null, { shouldDirty: true, shouldValidate: true })}
        />
        {t.quiet.enable}
      </label>
      {enabled ? (
        <div className="grid max-w-md items-start gap-4 sm:grid-cols-2">
          <Field label={t.quiet.start} error={errors.quietHours?.start ? t.timeInvalid : undefined}>
            <Input type="time" {...form.register('quietHours.start')} />
          </Field>
          <Field label={t.quiet.end} error={errors.quietHours?.end ? (errors.quietHours.end.message === 'same' ? t.quiet.sameTime : t.timeInvalid) : undefined}>
            <Input type="time" {...form.register('quietHours.end')} />
          </Field>
        </div>
      ) : (
        <p className="text-sm text-ink-sub">{t.quiet.off}</p>
      )}
      {summary ? <p className="-mt-1 text-sm text-ink-sub">{summary}</p> : null}
    </SectionFrame>
  );
}

// ───────────────────────── Bộ nhắc mặc định ─────────────────────────

const ReminderSchema = OrgSettingsSchema.pick({ reminderPreset: true });
type ReminderInput = z.input<typeof ReminderSchema>;
type ReminderOutput = z.output<typeof ReminderSchema>;
const PRESETS = ['standard', 'strict', 'none'] as const;

export const REMINDERS_ID = 'bo-nhac';

/** Bộ nhắc mặc định của tổ chức (SPEC 4.6): chuẩn, chặt, hoặc không nhắc; các mốc được giải thích bằng lời. */
export function RemindersSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ reminderPreset: settings.reminderPreset }), [settings.reminderPreset]);
  const form = useForm<ReminderInput, unknown, ReminderOutput>({ resolver: zodResolver(ReminderSchema), values });
  const { isDirty } = form.formState;
  const section = useSectionSave(t.reminders.title);
  useReportDirty(REMINDERS_ID, isDirty, onDirtyChange);

  const submit = form.handleSubmit((next) => section.save(changedKeys(next, values)));

  return (
    <SectionFrame
      id={REMINDERS_ID}
      title={t.reminders.title}
      description={t.reminders.description}
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
      <fieldset className="flex min-w-0 flex-col gap-2.5">
        <legend className="sr-only">{t.reminders.legend}</legend>
        {PRESETS.map((preset) => (
          <label
            key={preset}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-4 py-3 transition-colors hover:bg-canvas has-checked:border-primary has-checked:bg-primary-tint/50 has-checked:hover:bg-primary-tint/50"
          >
            <input type="radio" value={preset} className="mt-1 size-4 shrink-0 accent-primary" {...form.register('reminderPreset')} />
            <span className="min-w-0">
              <span className="block font-semibold">{t.reminders.presets[preset].name}</span>
              {/* <label> chỉ chứa nội dung dạng chữ, nên các mốc là các dòng <span> thay cho <ul>. */}
              <span className="mt-1 flex flex-col gap-0.5 text-ink-sub">
                {t.reminders.presets[preset].steps.map((line) => (
                  <span key={line} className={cn('block', t.reminders.presets[preset].steps.length > 1 && "relative pl-4 before:absolute before:left-0 before:content-['•']")}>
                    {line}
                  </span>
                ))}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-ink-sub">{t.reminders.rules}</p>
      {settings.reminderSteps ? <Callout tone="info">{t.reminders.customSteps}</Callout> : null}
    </SectionFrame>
  );
}
