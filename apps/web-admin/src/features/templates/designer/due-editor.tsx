import { useState } from 'react';
import type { DueRule, Duration } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { useDesigner } from './context';
import { defaultDue, dueSummary } from './model';
import { NumberInput } from './ui';

const t = vi.admin.designer.editor.due;

type AnchorChoice = 'before_target' | 'after_target' | 'activation' | 'run_start';
const ANCHORS: readonly AnchorChoice[] = ['before_target', 'after_target', 'activation', 'run_start'];
const ANCHOR_OPTIONS = ANCHORS.map((a) => ({ value: a, label: t.anchors[a] }));
const UNITS: readonly Duration['unit'][] = ['working_day', 'calendar_day', 'hour'];
export const UNIT_OPTIONS = UNITS.map((u) => ({ value: u, label: t.units[u] }));
const TIME_OPTIONS = [
  { value: 'end', label: t.endOfWorkday },
  { value: 'at', label: t.atSpecific },
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isUnit(v: string | null): v is Duration['unit'] {
  return v !== null && (UNITS as readonly string[]).includes(v);
}

function choiceOf(rule: DueRule, afterTarget: boolean): AnchorChoice {
  if (rule.anchor === 'activation') return 'activation';
  if (rule.anchor === 'run_start') return 'run_start';
  if (rule.offset.value > 0) return 'after_target';
  return rule.offset.value === 0 && afterTarget ? 'after_target' : 'before_target';
}

/**
 * Đặt hạn bằng lời (SPEC 4.2, 4.5): mốc neo, số, đơn vị, giờ trong ngày.
 * "Trước mốc đích 7 ngày làm việc" lưu thành `{ anchor: 'run_target', offset: { value: -7, unit: 'working_day' } }`.
 */
export function DueEditor({ label, value, onChange, hideLabel }: { label: string; value: DueRule | undefined; onChange: (rule: DueRule) => void; hideLabel?: boolean }) {
  const { def } = useDesigner();
  // Khi số ngày là 0, "trước" và "sau" mốc đích lưu giống nhau; nhớ lựa chọn để ô chọn không tự nhảy.
  const [afterTarget, setAfterTarget] = useState(false);

  if (!value) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        {hideLabel ? null : <p className="text-base font-medium">{label}</p>}
        <Button size="sm" onClick={() => onChange(defaultDue(def))}>
          {t.set}
        </Button>
      </div>
    );
  }

  const choice = choiceOf(value, afterTarget);
  const amount = Math.abs(value.offset.value);
  const unit = value.offset.unit;
  const specific = value.atTime !== undefined && value.atTime !== 'end_of_workday';

  const build = (nextChoice: AnchorChoice, nextAmount: number, nextUnit: Duration['unit'], atTime: DueRule['atTime']): DueRule => {
    const anchor = nextChoice === 'activation' ? 'activation' : nextChoice === 'run_start' ? 'run_start' : 'run_target';
    const signed = nextChoice === 'before_target' && nextAmount !== 0 ? -nextAmount : nextAmount;
    const rule: DueRule = { anchor, offset: { value: signed, unit: nextUnit } };
    // Đơn vị giờ cộng thẳng từ mốc nên không có "giờ trong ngày" (SPEC 4.5).
    if (atTime !== undefined && atTime !== 'end_of_workday' && nextUnit !== 'hour') rule.atTime = atTime;
    return rule;
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hideLabel={hideLabel}>
        <Select
          value={choice}
          options={ANCHOR_OPTIONS}
          onValueChange={(v) => {
            const next = ANCHORS.find((a) => a === v);
            if (!next) return;
            setAfterTarget(next === 'after_target');
            onChange(build(next, amount, unit, value.atTime));
          }}
        />
      </Field>
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
        <NumberInput aria-label={`${label}: ${t.amount}`} min={0} max={999} value={amount} onValueChange={(n) => onChange(build(choice, n, unit, value.atTime))} />
        <Select aria-label={`${label}: ${t.unit}`} value={unit} options={UNIT_OPTIONS} onValueChange={(v) => isUnit(v) && onChange(build(choice, amount, v, value.atTime))} />
      </div>
      {unit !== 'hour' ? (
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
          <Select
            aria-label={`${label}: ${t.atTime}`}
            value={specific ? 'at' : 'end'}
            options={TIME_OPTIONS}
            onValueChange={(v) => onChange(build(choice, amount, unit, v === 'at' ? '17:00' : undefined))}
          />
          {specific ? (
            <Input
              type="time"
              aria-label={`${label}: ${t.time}`}
              value={value.atTime}
              onChange={(e) => {
                if (TIME_RE.test(e.target.value)) onChange(build(choice, amount, unit, e.target.value as DueRule['atTime']));
              }}
            />
          ) : null}
        </div>
      ) : null}
      {value.anchor === 'run_target' && !def.targetField ? (
        <p className="text-sm text-ink-sub">{t.noTarget}</p>
      ) : (
        <p className="text-sm text-ink-sub">{fmt(t.preview, { hạn: dueSummary(value) ?? '' })}</p>
      )}
    </div>
  );
}
