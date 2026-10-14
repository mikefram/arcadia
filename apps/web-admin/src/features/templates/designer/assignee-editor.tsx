import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { ROLES, type AssigneeRule, type Role } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker, type PickedPerson } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/features/templates/field-select';
import { flattenUnits } from '@/components/unit-select';
import { useApiQuery } from '@/lib/query';
import { useDesigner } from './context';
import { inputPersonFields, stepFieldOptions } from './form-sources';
import { nodeTitle, slugKey } from './model';

const t = vi.admin.designer.editor.assignee;

type Kind = AssigneeRule['kind'];
const KINDS: readonly Kind[] = ['user', 'role', 'unit_head', 'initiator', 'initiator_manager', 'form_field', 'step_field'];
const KIND_OPTIONS = KINDS.map((kind) => ({ value: kind, label: t.kinds[kind] }));
const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: vi.common.role[role] }));
const LEVEL_OPTIONS = [
  { value: '1', label: t.levels.l1 },
  { value: '2', label: t.levels.l2 },
  { value: '3', label: t.levels.l3 },
];

function isKind(v: string | null): v is Kind {
  return v !== null && (KINDS as readonly string[]).includes(v);
}
function isRole(v: string | null): v is Role {
  return v !== null && (ROLES as readonly string[]).includes(v);
}

export type AssigneeEditorProps = {
  /** nhãn của ô chọn cách giao: "Người nhận", "Người duyệt 1"… */
  label: string;
  hint?: string;
  value: AssigneeRule | undefined;
  /** `undefined`: quy tắc còn dở (chưa chọn người, chưa chọn vai trò); validate() sẽ nhắc */
  onChange: (rule: AssigneeRule | undefined) => void;
  hideLabel?: boolean;
  /** bước đang sửa: để liệt kê các bước đứng trước cho cách "Người được chọn ở bước trước" */
  nodeId?: string;
  /** nơi nhận nhiều người (bước duyệt, góp nội dung, thông báo): cho chọn cả ô "Chọn nhiều người"; việc chỉ nhận một người */
  multi?: boolean;
};

/**
 * Chọn người nhận bằng lời dễ hiểu, sinh ra một trong bảy quy tắc `AssigneeRule` (SPEC 4.2).
 * Cách chọn mặc định là "Một người cụ thể" vì đó là cách dùng nhiều nhất.
 */
export function AssigneeEditor({ label, hint, value, onChange, hideLabel, nodeId, multi = false }: AssigneeEditorProps) {
  const { def, lookups, change, readOnly } = useDesigner();
  // Cách chọn đang hiện khi quy tắc còn dở (ví dụ đã chọn "Người giữ vai trò" nhưng chưa chọn vai trò nào).
  const [pendingKind, setPendingKind] = useState<Kind>('user');
  const kind = value?.kind ?? pendingKind;

  const units = useApiQuery('units.list', {}, { staleTime: 5 * 60_000, enabled: kind === 'role' || kind === 'unit_head' });
  const unitOptions = useMemo(() => flattenUnits(units.data?.items ?? []), [units.data]);
  const userFields = inputPersonFields(def, multi);
  const stepOptions = useMemo(() => (nodeId ? stepFieldOptions(def, nodeId, multi) : []), [def, nodeId, multi]);
  const stepNodes = useMemo(() => [...new Map(stepOptions.map((o) => [o.node.id, o.node])).values()], [stepOptions]);
  // Bước đã chọn nhưng ô chưa chọn: giữ ở giao diện, vì quy tắc chỉ hợp lệ khi có cả bước lẫn ô.
  const [pendingStep, setPendingStep] = useState<string | null>(null);
  const chosenStep = value?.kind === 'step_field' ? value.node : pendingStep && stepNodes.some((n) => n.id === pendingStep) ? pendingStep : (stepNodes.length === 1 ? (stepNodes[0]?.id ?? null) : null);
  const stepFields = stepOptions.filter((o) => o.node.id === chosenStep).map((o) => o.field);

  const pickKind = (next: Kind) => {
    setPendingKind(next);
    const only = stepOptions.length === 1 ? stepOptions[0] : undefined;
    if (next === 'initiator') onChange({ kind: 'initiator' });
    else if (next === 'initiator_manager') onChange({ kind: 'initiator_manager' });
    else if (next === 'unit_head') onChange({ kind: 'unit_head' });
    else if (next === 'form_field' && userFields.length === 1 && userFields[0]) onChange({ kind: 'form_field', field: userFields[0].key });
    else if (next === 'step_field' && only) onChange({ kind: 'step_field', node: only.node.id, field: only.field.key });
    else onChange(undefined);
  };
  const pickStep = (stepId: string | null) => {
    setPendingStep(stepId);
    const fields = stepOptions.filter((o) => o.node.id === stepId);
    const only = fields.length === 1 ? fields[0] : undefined;
    onChange(stepId && only ? { kind: 'step_field', node: stepId, field: only.field.key } : undefined);
  };
  const fieldOption = (f: { key: string; label: string; type: string }) => ({ value: f.key, label: f.type === 'users' ? fmt(t.fieldMany, { tên: f.label }) : f.label });

  let person: PickedPerson | null = null;
  if (value?.kind === 'user') {
    const found = lookups.person(value.userId);
    person = found
      ? { id: value.userId, fullName: found.fullName, givenName: found.givenName, honorific: found.honorific }
      : { id: value.userId, fullName: t.unknownPerson, givenName: t.unknownPerson, honorific: null };
  }

  /** Thêm sẵn ô "Người phụ trách" vào biểu mẫu khởi chạy và dùng luôn ô đó. */
  const addUserField = () => {
    const key = slugKey(t.fieldDefaultLabel, new Set(def.inputs.map((f) => f.key)));
    change((d) => ({ ...d, inputs: [...d.inputs, { key, label: t.fieldDefaultLabel, type: 'user', required: true }] }));
    onChange({ kind: 'form_field', field: key });
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint} hideLabel={hideLabel}>
        <Select value={kind} onValueChange={(v) => isKind(v) && pickKind(v)} options={KIND_OPTIONS} />
      </Field>

      {kind === 'user' ? (
        <PersonPicker
          aria-label={`${label}: ${t.person}`}
          value={person}
          disabled={readOnly}
          onChange={(p) => {
            if (p) lookups.remember(p);
            onChange(p ? { kind: 'user', userId: p.id } : undefined);
          }}
        />
      ) : null}

      {kind === 'role' ? (
        <div className="grid grid-cols-2 gap-2">
          <Select
            aria-label={`${label}: ${t.role}`}
            placeholder={t.rolePlaceholder}
            value={value?.kind === 'role' ? value.role : null}
            onValueChange={(v) => isRole(v) && onChange({ kind: 'role', role: v, ...(value?.kind === 'role' && value.unitId ? { unitId: value.unitId } : {}) })}
            options={ROLE_OPTIONS}
          />
          <Select
            aria-label={`${label}: ${t.unit}`}
            value={value?.kind === 'role' ? (value.unitId ?? null) : null}
            disabled={value?.kind !== 'role'}
            onValueChange={(unitId) => value?.kind === 'role' && onChange(unitId ? { kind: 'role', role: value.role, unitId } : { kind: 'role', role: value.role })}
            options={unitOptions}
            emptyOption={t.unitAny}
          />
        </div>
      ) : null}

      {kind === 'unit_head' ? (
        <Select
          aria-label={`${label}: ${t.unit}`}
          value={value?.kind === 'unit_head' ? (value.unitId ?? null) : null}
          onValueChange={(unitId) => onChange(unitId ? { kind: 'unit_head', unitId } : { kind: 'unit_head' })}
          options={unitOptions}
          emptyOption={t.unitOfInitiator}
        />
      ) : null}

      {kind === 'initiator_manager' ? (
        <Select
          aria-label={`${label}: ${t.level}`}
          value={String(value?.kind === 'initiator_manager' ? (value.level ?? 1) : 1)}
          onValueChange={(v) => {
            const level = Number(v);
            onChange(level > 1 ? { kind: 'initiator_manager', level } : { kind: 'initiator_manager' });
          }}
          options={LEVEL_OPTIONS}
        />
      ) : null}

      {kind === 'form_field' ? (
        userFields.length > 0 ? (
          <Select
            aria-label={`${label}: ${t.field}`}
            placeholder={t.fieldPlaceholder}
            value={value?.kind === 'form_field' && userFields.some((f) => f.key === value.field) ? value.field : null}
            onValueChange={(field) => onChange(field ? { kind: 'form_field', field } : undefined)}
            options={userFields.map(fieldOption)}
          />
        ) : (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm">
            <p>{multi ? t.fieldNoneMany : t.fieldNone}</p>
            <Button size="sm" onClick={addUserField}>
              <Plus aria-hidden="true" />
              {t.fieldAdd}
            </Button>
          </div>
        )
      ) : null}

      {kind === 'step_field' ? (
        stepOptions.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="step-field-picker">
            <Select
              aria-label={`${label}: ${t.step}`}
              placeholder={t.stepPlaceholder}
              value={chosenStep && stepNodes.some((n) => n.id === chosenStep) ? chosenStep : null}
              onValueChange={pickStep}
              options={stepNodes.map((n) => ({ value: n.id, label: nodeTitle(n) }))}
            />
            <Select
              aria-label={`${label}: ${t.stepField}`}
              placeholder={t.stepFieldPlaceholder}
              disabled={!chosenStep}
              value={value?.kind === 'step_field' && stepFields.some((f) => f.key === value.field) ? value.field : null}
              onValueChange={(field) => chosenStep && onChange(field ? { kind: 'step_field', node: chosenStep, field } : undefined)}
              options={stepFields.map(fieldOption)}
            />
            <p className="text-sm text-ink-sub">{t.stepHint}</p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-1 rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm" data-testid="step-field-none">
            <p>{multi ? t.stepNoneMany : t.stepNone}</p>
            <p className="text-ink-sub">{t.stepHint}</p>
          </div>
        )
      ) : null}
    </div>
  );
}
