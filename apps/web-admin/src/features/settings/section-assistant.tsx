import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { OrgSettingsSchema } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { changedKeys, SectionFrame, useReportDirty, useSectionSave, type SectionProps } from './section';

const t = vi.admin.org.settings.assistant;

const AssistantSchema = OrgSettingsSchema.pick({ ai: true });
type AssistantInput = z.input<typeof AssistantSchema>;
type AssistantOutput = z.output<typeof AssistantSchema>;

const options = <K extends string>(labels: Record<K, string>) => (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));
const STT_OPTIONS = options(t.sttOptions);
const LLM_OPTIONS = options(t.llmOptions);
const TTS_OPTIONS = options(t.ttsOptions);

export const ASSISTANT_ID = 'tro-ly';

/**
 * Công tắc AI theo tổ chức [QUYẾT ĐỊNH, SPEC 11.7] và hạn mức (SPEC 6.11, 12.6). Nói rõ hai điều dễ hiểu lầm:
 * tắt Trợ lý thì mọi thao tác chạm vẫn dùng được; vượt ngân sách chỉ cảnh báo, không tự cắt.
 */
export function AssistantSection({ settings, onDirtyChange }: SectionProps) {
  const values = useMemo(() => ({ ai: settings.ai }), [settings.ai]);
  const form = useForm<AssistantInput, unknown, AssistantOutput>({ resolver: zodResolver(AssistantSchema), values });
  const { errors, isDirty } = form.formState;
  const section = useSectionSave(t.title);
  useReportDirty(ASSISTANT_ID, isDirty, onDirtyChange);

  const [enabled, llm] = form.watch(['ai.enabled', 'ai.llm']);
  const off = enabled === false || llm === 'off';

  const submit = form.handleSubmit((next) => {
    const ai = changedKeys(next.ai, values.ai);
    section.save(Object.keys(ai).length > 0 ? { ai } : {});
  });

  return (
    <SectionFrame
      id={ASSISTANT_ID}
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
      <Controller
        control={form.control}
        name="ai.enabled"
        render={({ field }) => (
          <div className="flex items-center gap-3">
            <Switch id="ai-enabled" checked={field.value ?? true} onCheckedChange={field.onChange} />
            <label htmlFor="ai-enabled" className="font-medium">
              {t.enabled}
            </label>
            <span aria-hidden="true" className="text-sm text-ink-sub">
              {field.value === false ? t.stateOff : t.stateOn}
            </span>
          </div>
        )}
      />

      <Callout tone={off ? 'warn' : 'info'} title={t.offTitle}>
        <ul className="list-disc pl-4">
          {t.offEffects.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {llm === 'off' && enabled !== false ? <p className="mt-1.5">{t.llmOffNote}</p> : null}
      </Callout>

      <div className="grid items-start gap-4 sm:grid-cols-3">
        <Field label={t.stt}>
          <Controller control={form.control} name="ai.stt" render={({ field }) => <Select value={field.value ?? null} onValueChange={(v) => v && field.onChange(v)} options={STT_OPTIONS} />} />
        </Field>
        <Field label={t.llm}>
          <Controller control={form.control} name="ai.llm" render={({ field }) => <Select value={field.value ?? null} onValueChange={(v) => v && field.onChange(v)} options={LLM_OPTIONS} />} />
        </Field>
        <Field label={t.tts}>
          <Controller control={form.control} name="ai.tts" render={({ field }) => <Select value={field.value ?? null} onValueChange={(v) => v && field.onChange(v)} options={TTS_OPTIONS} />} />
        </Field>
      </div>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field label={t.dailyLimit} hint={t.dailyLimitHint} error={errors.ai?.dailyCallLimit ? t.dailyLimitInvalid : undefined}>
          <Input type="number" inputMode="numeric" min={0} step={1} className="tabular max-w-40" {...form.register('ai.dailyCallLimit', { valueAsNumber: true })} />
        </Field>
        <Field label={t.budget} hint={t.budgetHint} error={errors.ai?.monthlyBudgetUsd ? t.budgetInvalid : undefined}>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder={t.budgetPlaceholder}
            className="tabular max-w-52"
            {...form.register('ai.monthlyBudgetUsd', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v)) })}
          />
        </Field>
      </div>
    </SectionFrame>
  );
}
