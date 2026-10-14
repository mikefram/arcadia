import { useState } from 'react';
import { X } from 'lucide-react';
import { ROLES, type Role, type StarterRule } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PersonPicker } from '@/components/person-picker';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { UnitSelect } from '@/components/unit-select';
import { personName } from '@/lib/person';
import { Select } from '@/features/templates/field-select';
import { useDesigner } from './context';
import { addStarter, removeStarters } from './form-model';
import { startersMode, startersSummary, type StartersMode } from './model';
import { IconButton } from './ui';

const t = vi.admin.designer.editor.panel.starters;

const MODES: readonly StartersMode[] = ['default', 'everyone', 'custom'];
const MODE_OPTIONS = MODES.map((mode) => ({ value: mode, label: t.modes[mode] }));

function isMode(v: string | null): v is StartersMode {
  return v !== null && (MODES as readonly string[]).includes(v);
}

/**
 * "Ai được khởi chạy": mặc định theo quyền khởi chạy; hoặc mọi cán bộ; hoặc chọn cụ thể theo vai trò, đơn vị, từng người
 * (`ProcessDefinition.starters`). Ghi vào bản vẽ, nên hoàn tác và xuất bản cùng các thuộc tính khác của quy trình.
 */
export function StartersEditor() {
  const { def, change, lookups } = useDesigner();
  const derived = startersMode(def.starters);
  // "Chọn cụ thể" khi chưa có dòng nào: bản vẽ vẫn là mặc định, nên cách chọn đang hiện chỉ sống ở giao diện.
  const [pickedCustom, setPickedCustom] = useState(false);
  const mode: StartersMode = derived !== 'default' ? derived : pickedCustom ? 'custom' : 'default';
  const rules = def.starters ?? [];

  const write = (next: readonly StarterRule[]) =>
    change((d) => {
      const out = { ...d };
      if (next.length > 0) out.starters = [...next];
      else delete out.starters;
      return out;
    });

  const pickMode = (next: StartersMode) => {
    setPickedCustom(next === 'custom');
    if (next === 'everyone') write([{ kind: 'everyone' }]);
    else if (next === 'default') write([]);
    else if (derived !== 'custom') write([]);
  };

  const selectedRoles = new Set(rules.flatMap((r) => (r.kind === 'role' ? [r.role] : [])));
  const units = rules.flatMap((r) => (r.kind === 'unit' ? [r.unitId] : []));
  const users = rules.flatMap((r) => (r.kind === 'user' ? [r.userId] : []));
  const hasPermission = rules.some((r) => r.kind === 'permission');
  const toggleRole = (role: Role, on: boolean) => write(on ? addStarter(rules, { kind: 'role', role }) : removeStarters(rules, (r) => r.kind === 'role' && r.role === role));

  return (
    <div className="flex flex-col gap-3" data-testid="starters">
      <Field label={t.mode} hint={t.modeHints[mode]}>
        <div data-testid="starters-mode" data-mode={mode}>
          <Select value={mode} options={MODE_OPTIONS} onValueChange={(v) => isMode(v) && pickMode(v)} />
        </div>
      </Field>

      {mode === 'custom' ? (
        <div className="flex flex-col gap-3">
          {rules.length === 0 ? <p className="rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm">{t.customEmpty}</p> : null}

          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="text-base font-medium">{t.roles}</legend>
            <p className="text-sm text-ink-sub">{t.rolesHint}</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {ROLES.map((role) => {
                const id = `starter-role-${role}`;
                return (
                  <span key={role} className="flex items-center gap-1.5">
                    <Checkbox id={id} checked={selectedRoles.has(role)} aria-label={fmt(t.roleOf, { 'vai trò': vi.common.role[role] })} onCheckedChange={(checked) => toggleRole(role, checked === true)} />
                    <label htmlFor={id} className="text-sm">
                      {vi.common.role[role]}
                    </label>
                  </span>
                );
              })}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <h4 className="text-base font-medium">{t.units}</h4>
            <p className="text-sm text-ink-sub">{t.unitsHint}</p>
            {units.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {units.map((unitId) => {
                  const name = lookups.unitName(unitId) ?? t.unknownUnit;
                  return (
                    <li key={unitId} className="flex items-center gap-2 rounded-lg border border-hairline bg-canvas py-1 pr-1 pl-2.5 text-sm">
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <IconButton label={fmt(t.unitRemove, { tên: name })} onClick={() => write(removeStarters(rules, (r) => r.kind === 'unit' && r.unitId === unitId))}>
                        <X aria-hidden="true" />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <UnitSelect aria-label={t.unitAdd} value={null} onValueChange={(unitId) => unitId && write(addStarter(rules, { kind: 'unit', unitId }))} />
          </div>

          <div className="flex flex-col gap-1.5">
            <h4 className="text-base font-medium">{t.users}</h4>
            <p className="text-sm text-ink-sub">{t.usersHint}</p>
            {users.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {users.map((userId) => {
                  const person = lookups.person(userId);
                  const name = person ? personName(person, 'full') : vi.admin.designer.editor.assignee.unknownPerson;
                  return (
                    <li key={userId} className="flex items-center gap-2 rounded-lg border border-hairline bg-canvas py-1 pr-1 pl-2.5 text-sm">
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <IconButton label={fmt(t.userRemove, { tên: name })} onClick={() => write(removeStarters(rules, (r) => r.kind === 'user' && r.userId === userId))}>
                        <X aria-hidden="true" />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <PersonPicker
              aria-label={t.userAdd}
              value={null}
              excludeIds={users}
              onChange={(person) => {
                if (!person) return;
                lookups.remember(person);
                write(addStarter(rules, { kind: 'user', userId: person.id }));
              }}
            />
          </div>

          <span className="flex items-start gap-2">
            <Checkbox
              id="starter-permission"
              className="mt-0.5"
              checked={hasPermission}
              aria-describedby="starter-permission-hint"
              onCheckedChange={(checked) => write(checked === true ? addStarter(rules, { kind: 'permission' }) : removeStarters(rules, (r) => r.kind === 'permission'))}
            />
            <span className="flex flex-col">
              <label htmlFor="starter-permission" className="text-sm font-medium">
                {t.permission}
              </label>
              <span id="starter-permission-hint" className="text-sm text-ink-sub">
                {t.permissionHint}
              </span>
            </span>
          </span>
        </div>
      ) : null}

      <p className="rounded-lg bg-surface-alt px-3 py-2 text-sm" data-testid="starters-summary">
        <span className="font-medium">{t.summaryLabel}: </span>
        {startersSummary(def.starters, lookups)}
      </p>
    </div>
  );
}
