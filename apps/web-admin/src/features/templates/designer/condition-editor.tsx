import { useMemo } from 'react';
import type { Expr, FormField } from '@mihato/domain';
import { formatMoney, vi } from '@mihato/i18n';
import { PersonPicker, type PickedPerson } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { useDesigner } from './context';
import { COMPARE_OPS, EMPTY_WHEN, fromSimple, operandOptions, toSimple, type CompareOp, type SimpleCondition } from './model';
import { NumberInput } from './ui';

const t = vi.admin.designer.editor.panel.condition;

/** Chữ, lựa chọn và người chỉ so "bằng" hoặc "khác"; số, tiền và ngày so được lớn nhỏ. */
function opsFor(type: FormField['type'] | undefined): readonly CompareOp[] {
  return type === 'number' || type === 'money' || type === 'date' ? COMPARE_OPS : ['eq', 'ne'];
}

function defaultValue(type: FormField['type']): SimpleCondition['value'] {
  return type === 'number' || type === 'money' ? 0 : '';
}

/**
 * Một điều kiện đơn giản dựng bằng biểu mẫu: [ô cần xét] [phép so sánh] [giá trị], sinh ra `Expr` an toàn
 * dạng `{ op, left: { ref }, right: { value } }` (SPEC 4.2). Không có ô gõ biểu thức, không eval.
 */
export function ConditionEditor({ label, value, onChange }: { label: string; value: Expr | undefined; onChange: (expr: Expr) => void }) {
  const { def, lookups, readOnly } = useDesigner();
  const options = useMemo(() => operandOptions(def), [def]);
  const simple = toSimple(value);

  if (simple === 'complex') {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm">
        <p>{t.complex}</p>
        <Button size="sm" onClick={() => onChange(EMPTY_WHEN)}>
          {t.complexReset}
        </Button>
      </div>
    );
  }
  if (options.length === 0) return <p className="rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm">{t.noOperands}</p>;

  const operand = options.find((o) => o.ref === simple.ref);
  const type = operand?.field.type;
  const ops = opsFor(type);
  const set = (patch: Partial<SimpleCondition>) => onChange(fromSimple({ ...simple, ...patch }));

  let person: PickedPerson | null = null;
  if (type === 'user' && typeof simple.value === 'string' && simple.value) {
    const found = lookups.person(simple.value);
    const unknown = vi.admin.designer.editor.assignee.unknownPerson;
    person = { id: simple.value, fullName: found?.fullName ?? unknown, givenName: found?.givenName ?? unknown, honorific: found?.honorific ?? null };
  }

  return (
    <div className="flex flex-col gap-2">
      <Select
        aria-label={`${label}: ${t.left}`}
        placeholder={t.leftPlaceholder}
        value={operand ? simple.ref : null}
        options={options.map((o) => ({ value: o.ref, label: o.label }))}
        onValueChange={(ref) => {
          const next = options.find((o) => o.ref === ref);
          if (!next) return;
          const nextOps = opsFor(next.field.type);
          onChange(fromSimple({ ref: next.ref, op: nextOps.includes(simple.op) ? simple.op : 'eq', value: defaultValue(next.field.type) }));
        }}
      />
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
        <Select
          aria-label={`${label}: ${t.op}`}
          value={ops.includes(simple.op) ? simple.op : 'eq'}
          disabled={!operand}
          options={ops.map((op) => ({ value: op, label: t.ops[op] }))}
          onValueChange={(op) => {
            const next = COMPARE_OPS.find((o) => o === op);
            if (next) set({ op: next });
          }}
        />
        {type === 'number' || type === 'money' ? (
          <NumberInput aria-label={`${label}: ${t.value}`} value={typeof simple.value === 'number' ? simple.value : 0} onValueChange={(n) => set({ value: n })} />
        ) : type === 'date' ? (
          <Input type="date" aria-label={`${label}: ${t.value}`} value={typeof simple.value === 'string' ? simple.value : ''} onChange={(e) => set({ value: e.target.value })} />
        ) : type === 'select' ? (
          <Select
            aria-label={`${label}: ${t.value}`}
            placeholder={t.valuePlaceholder}
            value={typeof simple.value === 'string' && simple.value ? simple.value : null}
            options={operand?.field.options ?? []}
            onValueChange={(v) => set({ value: v ?? '' })}
          />
        ) : type === 'user' ? (
          <PersonPicker
            aria-label={`${label}: ${t.value}`}
            value={person}
            disabled={readOnly}
            onChange={(p) => {
              if (p) lookups.remember(p);
              set({ value: p?.id ?? '' });
            }}
          />
        ) : (
          <Input
            aria-label={`${label}: ${t.value}`}
            placeholder={t.valuePlaceholder}
            disabled={!operand}
            value={typeof simple.value === 'string' ? simple.value : String(simple.value)}
            onChange={(e) => set({ value: e.target.value })}
          />
        )}
      </div>
      {type === 'money' && typeof simple.value === 'number' ? <p className="tabular text-sm text-ink-sub">{formatMoney(simple.value)}</p> : null}
    </div>
  );
}
