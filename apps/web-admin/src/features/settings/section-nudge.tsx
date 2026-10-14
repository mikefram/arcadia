import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { DEFAULT_NUDGE_TEMPLATES, OrgSettingsSchema } from '@mihato/domain';
import { renderNudge, type NudgeRelation } from '@mihato/domain/nudge';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { personName } from '@/lib/person';
import { changedKeys, SectionFrame, useReportDirty, useSectionSave, type SectionProps } from './section';

const t = vi.admin.org.settings.nudge;

/** Các biến của mẫu lời nhắc (SPEC 4.7), đúng thứ tự hiện trong bảng chú thích. */
const VARIABLES = ['honorific', 'Honorific', 'tên', 'việc', 'n'] as const;
const RELATIONS = ['down', 'peer', 'up'] as const satisfies readonly NudgeRelation[];
const MAX_TEMPLATE = 500;
const SAMPLE_LATE_DAYS = 2;

/** Tên biến lạ đầu tiên trong mẫu (ví dụ gõ nhầm `{ten}`), hoặc null khi mẫu chỉ dùng biến hợp lệ. */
function unknownVariable(template: string): string | null {
  for (const m of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!(VARIABLES as readonly string[]).includes(m[1] ?? '')) return m[0];
  }
  return null;
}

const NudgeSchema = OrgSettingsSchema.pick({ nudgeTemplates: true }).superRefine((v, ctx) => {
  const templates = v.nudgeTemplates;
  if (!templates) return;
  for (const relation of RELATIONS) {
    const text = templates[relation];
    if (text.trim() === '') ctx.addIssue({ code: 'custom', path: ['nudgeTemplates', relation], message: 'required' });
    else if (text.length > MAX_TEMPLATE) ctx.addIssue({ code: 'custom', path: ['nudgeTemplates', relation], message: 'long' });
    else if (unknownVariable(text)) ctx.addIssue({ code: 'custom', path: ['nudgeTemplates', relation], message: 'variable' });
  }
  if (templates.senderName.trim() === '') ctx.addIssue({ code: 'custom', path: ['nudgeTemplates', 'senderName'], message: 'required' });
  if (templates.aiDisclosure.trim() === '') ctx.addIssue({ code: 'custom', path: ['nudgeTemplates', 'aiDisclosure'], message: 'required' });
});
type NudgeInput = z.input<typeof NudgeSchema>;
type NudgeOutput = z.output<typeof NudgeSchema>;

export const NUDGE_ID = 'loi-nhac';

/**
 * Ma trận xưng hô của lời đi thúc (SPEC 4.7): ba mẫu theo quan hệ, danh tính người gửi, dòng nhỏ khi Trợ lý AI soạn.
 * Phần xem trước dùng chính hàm `renderNudge` của máy chủ, nên câu hiện ở đây là câu người nhận sẽ thấy.
 */
export function NudgeSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ nudgeTemplates: settings.nudgeTemplates }), [settings.nudgeTemplates]);
  const form = useForm<NudgeInput, unknown, NudgeOutput>({ resolver: zodResolver(NudgeSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.title);
  useReportDirty(NUDGE_ID, isDirty, onDirtyChange);
  const [person, setPerson] = useState<PersonOption | null>(null);

  const draft = form.watch('nudgeTemplates') ?? settings.nudgeTemplates;
  const recipient = person ?? { ...t.previewSample, honorific: 'chi' as const };
  const isDefault = RELATIONS.every((r) => draft[r] === DEFAULT_NUDGE_TEMPLATES[r]) && draft.senderName === DEFAULT_NUDGE_TEMPLATES.senderName && draft.aiDisclosure === DEFAULT_NUDGE_TEMPLATES.aiDisclosure;

  const submit = form.handleSubmit((next) => {
    const nudgeTemplates = changedKeys(next.nudgeTemplates, values.nudgeTemplates);
    section.save(Object.keys(nudgeTemplates).length > 0 ? { nudgeTemplates } : {});
  });

  const templateError = (relation: NudgeRelation): string | undefined => {
    const error = errors.nudgeTemplates?.[relation];
    if (!error) return undefined;
    if (error.message === 'long') return t.tooLong;
    if (error.message === 'variable') return fmt(t.unknownVariable, { biến: unknownVariable(draft[relation]) ?? '' });
    return t.required;
  };

  return (
    <SectionFrame
      id={NUDGE_ID}
      title={t.title}
      description={t.description}
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
      <div className="rounded-lg border border-hairline bg-canvas px-4 py-3">
        <p className="font-medium">{t.variablesTitle}</p>
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {VARIABLES.map((name) => (
            <div key={name} className="contents">
              <dt className="tabular font-semibold">{`{${name}}`}</dt>
              <dd className="text-ink-sub">{t.variables[name]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Field label={t.previewPerson} hint={t.previewIntro} className="w-full sm:w-80">
          <PersonPicker value={person} onChange={setPerson} placeholder={t.previewPersonPlaceholder} />
        </Field>
        <p className="pb-2 text-sm text-ink-sub">
          {fmt(t.previewContext, { tên: personName(recipient, 'full'), việc: t.previewSample.stepTitle, n: SAMPLE_LATE_DAYS })}
        </p>
      </div>

      {RELATIONS.map((relation) => (
        <div key={relation} className="grid items-start gap-x-5 gap-y-2 lg:grid-cols-2">
          <Field label={t[relation]} error={templateError(relation)}>
            <Textarea rows={4} {...form.register(`nudgeTemplates.${relation}`)} />
          </Field>
          <figure aria-label={`${t.previewTitle}: ${t[relation]}`} className="rounded-lg border border-hairline bg-canvas px-4 py-3 lg:mt-[1.875rem]">
            <figcaption className="text-sm font-semibold">{draft.senderName || t.senderName}</figcaption>
            <p className="mt-1" data-testid={`nudge-preview-${relation}`}>
              {renderNudge(draft[relation], { honorific: recipient.honorific, givenName: recipient.givenName, stepTitle: t.previewSample.stepTitle, lateDays: SAMPLE_LATE_DAYS })}
            </p>
            <p className="mt-1.5 text-sm text-ink-sub">{draft.aiDisclosure}</p>
          </figure>
        </div>
      ))}

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field label={t.senderName} hint={t.senderNameHint} error={errors.nudgeTemplates?.senderName ? t.senderRequired : undefined}>
          <Input {...form.register('nudgeTemplates.senderName')} />
        </Field>
        <Field label={t.aiDisclosure} hint={t.aiDisclosureHint} error={errors.nudgeTemplates?.aiDisclosure ? t.disclosureRequired : undefined}>
          <Input {...form.register('nudgeTemplates.aiDisclosure')} />
        </Field>
      </div>

      {isDefault ? null : (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => form.setValue('nudgeTemplates', DEFAULT_NUDGE_TEMPLATES, { shouldDirty: true, shouldValidate: form.formState.isSubmitted })}>
          {t.useDefault}
        </Button>
      )}
    </SectionFrame>
  );
}
