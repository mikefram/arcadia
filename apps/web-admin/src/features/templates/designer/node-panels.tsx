import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { AssigneeRule, DraftNode, Duration, ReminderPolicy } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { AssigneeEditor } from './assignee-editor';
import { CompileEditor } from './compile-editor';
import { ConditionEditor } from './condition-editor';
import { useDesigner } from './context';
import { DueEditor, UNIT_OPTIONS } from './due-editor';
import { FormFieldsEditor } from './form-fields-editor';
import {
  addBranch,
  addEdge,
  canConnect,
  defaultLabel,
  ELSE,
  findNode,
  firstFreeHandle,
  handleLabel,
  inEdges,
  isContribute,
  kindLabel,
  nodeKindLabel,
  nodeTitle,
  NO_HANDLE,
  outEdges,
  patchNode,
  removeBranch,
  removeElements,
  setApprovalAction,
  sourceHandleOf,
  sourceHandles,
  STEP_KINDS,
  updateBranch,
  type AddableKind,
} from './model';
import { IconButton, NumberInput, Section } from './ui';

const t = vi.admin.designer.editor;
const p = t.panel;

type PanelProps = { node: DraftNode };

/** Ghi một phần của nút; `coalesce` gộp các lần gõ liền nhau vào cùng một ô thành một bước hoàn tác. */
function useNodePatch(nodeId: string) {
  const { change } = useDesigner();
  return (patch: Partial<DraftNode>, field?: string) => change((d) => patchNode(d, nodeId, patch), field ? { coalesce: `node:${nodeId}:${field}` } : undefined);
}

// ───────────────────────── Tên bước ─────────────────────────

/**
 * Tên việc và tên ngắn trên sơ đồ. Người vẽ chỉ cần gõ tên việc; tên ngắn tự đi theo cho tới khi được đặt riêng.
 */
function TitleFields({ node, titleLabel, placeholder }: PanelProps & { titleLabel: string; placeholder: string }) {
  const { change } = useDesigner();
  const title = node.title ?? '';
  const fallback = defaultLabel(node.type, node.action);
  const follows = !node.label.trim() || node.label === title || node.label === fallback;

  const setTitle = (next: string) =>
    change(
      (d) => {
        const n = findNode(d, node.id);
        if (!n) return d;
        const linked = !n.label.trim() || n.label === (n.title ?? '') || n.label === fallback;
        return patchNode(d, node.id, { title: next, ...(linked ? { label: next.trim() ? next : fallback } : {}) });
      },
      { coalesce: `node:${node.id}:title` },
    );
  const setLabel = (next: string) => change((d) => patchNode(d, node.id, { label: next.trim() ? next : title.trim() ? title : fallback }), { coalesce: `node:${node.id}:label` });

  return (
    <>
      <Field label={titleLabel} required>
        <Input data-autofocus value={title} placeholder={placeholder} onChange={(e) => setTitle(e.target.value)} data-testid="node-title" />
      </Field>
      <Field label={p.stepLabel} hint={p.stepLabelHint}>
        <Input value={follows ? '' : node.label} placeholder={title} onChange={(e) => setLabel(e.target.value)} data-testid="node-label" />
      </Field>
    </>
  );
}

function LabelField({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  const fallback = defaultLabel(node.type, node.action);
  return (
    <Field label={p.stepLabelPlain}>
      <Input data-autofocus value={node.label} onChange={(e) => patch({ label: e.target.value }, 'label')} onBlur={() => !node.label.trim() && patch({ label: fallback })} data-testid="node-label" />
    </Field>
  );
}

// ───────────────────────── Danh sách người (người duyệt, người nhận tin) ─────────────────────────

function RuleList({
  nodeId,
  rules,
  onChange,
  labelOf,
  removeLabelOf,
  addLabel,
}: {
  /** bước đang sửa, để cách chọn "Người được chọn ở bước trước" biết bước nào đứng trước */
  nodeId: string;
  rules: readonly AssigneeRule[];
  onChange: (rules: AssigneeRule[]) => void;
  labelOf: (n: number) => string;
  removeLabelOf: (n: number) => string;
  addLabel: string;
}) {
  // Dòng còn dở (chưa chọn xong người) chỉ sống ở giao diện; bản vẽ chỉ giữ quy tắc đã đủ.
  const [pending, setPending] = useState(rules.length === 0 ? 1 : 0);
  const rows: (AssigneeRule | undefined)[] = [...rules, ...Array.from({ length: pending }, () => undefined)];

  const setRow = (index: number, rule: AssigneeRule | undefined) => {
    if (index < rules.length) {
      if (rule) onChange(rules.map((r, i) => (i === index ? rule : r)));
      else {
        onChange(rules.filter((_, i) => i !== index));
        setPending((n) => n + 1);
      }
    } else if (rule) {
      onChange([...rules, rule]);
      setPending((n) => Math.max(0, n - 1));
    }
  };
  const removeRow = (index: number) => {
    if (index < rules.length) {
      onChange(rules.filter((_, i) => i !== index));
      if (rules.length === 1 && pending === 0) setPending(1);
    } else setPending((n) => Math.max(rules.length === 0 ? 1 : 0, n - 1));
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.map((rule, i) => (
        // Dòng thứ i giữ nguyên chỗ khi vừa chọn xong người, nên khoá theo thứ tự là đủ.
        <div key={i} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <AssigneeEditor label={labelOf(i + 1)} value={rule} onChange={(r) => setRow(i, r)} hideLabel={rows.length === 1} nodeId={nodeId} multi />
          </div>
          {rows.length > 1 ? (
            <IconButton label={removeLabelOf(i + 1)} onClick={() => removeRow(i)} className={rows.length === 1 ? undefined : 'mt-7'}>
              <X aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ))}
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setPending((n) => n + 1)}>
        <Plus aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}

// ───────────────────────── Danh sách kiểm ─────────────────────────

function ChecklistEditor({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  const [draft, setDraft] = useState('');
  const items = node.checklist ?? [];
  const write = (next: string[]) => patch({ checklist: next.length > 0 ? next : undefined }, 'checklist');
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    write([...items, text]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input aria-label={fmt(p.task.checklistItem, { n: i + 1 })} value={item} onChange={(e) => write(items.map((x, j) => (j === i ? e.target.value : x)))} className="h-9" />
          <IconButton label={fmt(p.task.checklistRemove, { n: i + 1 })} onClick={() => write(items.filter((_, j) => j !== i))}>
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          aria-label={p.task.checklistAdd}
          placeholder={p.task.checklistPlaceholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className="h-9"
        />
        <IconButton label={p.task.checklistAdd} onClick={add}>
          <Plus aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

// ───────────────────────── Bộ nhắc, hợp nhánh ─────────────────────────

const PRESETS: readonly ReminderPolicy['preset'][] = ['standard', 'strict', 'none'];
const PRESET_OPTIONS = PRESETS.map((preset) => ({ value: preset, label: t.reminders.presets[preset] }));

function RemindersField({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  const preset = node.reminders?.preset ?? 'standard';
  return (
    <Field label={t.reminders.label} hint={t.reminders.hints[preset]}>
      <Select
        value={preset}
        options={PRESET_OPTIONS}
        onValueChange={(v) => {
          const next = PRESETS.find((x) => x === v);
          if (next) patch({ reminders: { ...node.reminders, preset: next } });
        }}
      />
    </Field>
  );
}

const JOIN_OPTIONS = [
  { value: 'all', label: p.join.all },
  { value: 'any', label: p.join.any },
];

/** Cách hợp nhánh chỉ có nghĩa khi có từ hai đường nối tới; ẩn đi ở các bước còn lại để bảng đỡ rối. */
function JoinField({ node }: PanelProps) {
  const { def } = useDesigner();
  const patch = useNodePatch(node.id);
  if (inEdges(def, node.id).length < 2 && node.join !== 'any') return null;
  return (
    <Section title={p.sectionAdvanced} collapsible defaultOpen={node.join === 'any'}>
      <Field label={p.join.label}>
        <Select value={node.join ?? 'all'} options={JOIN_OPTIONS} onValueChange={(v) => patch({ join: v === 'any' ? 'any' : undefined })} />
      </Field>
    </Section>
  );
}

// ───────────────────────── Bước tiếp theo (nối bằng bàn phím) ─────────────────────────

const KIND_OPTIONS: { value: AddableKind; label: string }[] = [...STEP_KINDS.map((k) => ({ value: k, label: kindLabel(k) })), { value: 'end', label: vi.common.nodeKind.end }];

/**
 * Các đường nối đi ra từ bước này, cùng cách nối không cần chuột: chọn bước đích trong danh sách
 * hoặc thêm thẳng một bước mới. Trên khung vẽ, việc tương ứng là kéo từ chấm tròn bên phải.
 */
function ConnectSection({ node }: PanelProps) {
  const { def, change, addAfter, readOnly } = useDesigner();
  const handles = sourceHandles(node);
  const [handle, setHandle] = useState<string | null>(null);
  const via = handles ? (handle && handles.includes(handle) ? handle : firstFreeHandle(def, node)) : null;
  const edges = outEdges(def, node.id);
  const targets = def.nodes.filter((n) => canConnect(def, node.id, n.id, via)).map((n) => ({ value: n.id, label: `${nodeKindLabel(n)}: ${nodeTitle(n)}` }));

  return (
    <Section title={p.connect.heading} collapsible defaultOpen={false} badge={<Badge tone="muted">{edges.length}</Badge>}>
      {edges.length === 0 ? <p className="text-sm text-ink-sub">{p.connect.none}</p> : null}
      {edges.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {edges.map((e) => {
            const to = findNode(def, e.to);
            const name = to ? nodeTitle(to) : e.to;
            const h = sourceHandleOf(def, e);
            return (
              <li key={e.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-canvas py-1 pr-1 pl-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  {h ? <span className="mr-1.5 font-medium">{handleLabel(def, node, h)}:</span> : null}
                  {fmt(p.connect.to, { tên: name })}
                </span>
                <IconButton label={fmt(p.connect.remove, { tên: name })} onClick={() => change((d) => removeElements(d, [], [e.id]))}>
                  <X aria-hidden="true" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      ) : null}
      {readOnly ? null : (
        <>
          {handles ? (
            <Field label={p.connect.via}>
              <Select value={via} options={handles.filter((h) => h !== NO_HANDLE).map((h) => ({ value: h, label: handleLabel(def, node, h) }))} onValueChange={setHandle} />
            </Field>
          ) : null}
          <Field label={p.connect.add}>
            <Select value={null} placeholder={p.connect.addPlaceholder} options={targets} disabled={targets.length === 0} onValueChange={(to) => to && change((d) => addEdge(d, node.id, to, via).def)} />
          </Field>
          <Field label={p.connect.newStep}>
            <Select
              value={null}
              placeholder={t.canvas.quickAddNewTitle}
              options={KIND_OPTIONS}
              onValueChange={(kind) => {
                const picked = KIND_OPTIONS.find((k) => k.value === kind);
                if (picked) addAfter(node.id, via, picked.value);
              }}
            />
          </Field>
        </>
      )}
    </Section>
  );
}

// ───────────────────────── Bảng theo loại nút ─────────────────────────

export function TaskPanel({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  const [customEscalate, setCustomEscalate] = useState(node.escalateTo !== undefined);
  return (
    <>
      <Section title={vi.common.nodeKind.task}>
        <TitleFields node={node} titleLabel={p.task.title} placeholder={p.task.titlePlaceholder} />
        <AssigneeEditor label={p.task.assignee} value={node.assignee} onChange={(rule) => patch({ assignee: rule })} nodeId={node.id} />
        <DueEditor label={p.task.due} value={node.due} onChange={(due) => patch({ due }, 'due')} />
        <Field label={p.task.description} hint={p.task.descriptionHint}>
          <Textarea rows={2} value={node.description ?? ''} onChange={(e) => patch({ description: e.target.value || undefined }, 'description')} />
        </Field>
      </Section>
      <Section title={p.task.checklist} hint={p.task.checklistHint} collapsible defaultOpen={(node.checklist?.length ?? 0) > 0} badge={<Badge tone="muted">{node.checklist?.length ?? 0}</Badge>}>
        <ChecklistEditor node={node} />
      </Section>
      <Section title={p.task.form} hint={`${p.task.formHint} ${p.task.formResultHint}`} collapsible defaultOpen={(node.form?.length ?? 0) > 0} badge={<Badge tone="muted">{node.form?.length ?? 0}</Badge>}>
        <FormFieldsEditor testId="result-form" fields={node.form ?? []} emptyText={p.task.formEmpty} onChange={(form) => patch({ form: form.length > 0 ? form : undefined }, 'form')} />
      </Section>
      <Section title={p.task.compile.heading} hint={p.task.compile.hint} collapsible defaultOpen={node.compile !== undefined} badge={node.compile ? <Badge tone="muted">{p.task.compile.layouts[node.compile.layout]}</Badge> : undefined}>
        <CompileEditor nodeId={node.id} value={node.compile} onChange={(compile) => patch({ compile }, 'compile')} />
      </Section>
      <Section title={p.task.reminders} collapsible defaultOpen={false} badge={<Badge tone="muted">{t.reminders.presets[node.reminders?.preset ?? 'standard']}</Badge>}>
        <RemindersField node={node} />
        <Field label={p.task.escalate} hint={p.task.escalateHint}>
          <Select
            value={customEscalate ? 'custom' : 'default'}
            options={[
              { value: 'default', label: p.task.escalateDefault },
              { value: 'custom', label: p.task.escalateCustom },
            ]}
            onValueChange={(v) => {
              setCustomEscalate(v === 'custom');
              if (v !== 'custom') patch({ escalateTo: undefined });
            }}
          />
        </Field>
        {customEscalate ? <AssigneeEditor label={p.task.escalate} hideLabel value={node.escalateTo} onChange={(rule) => patch({ escalateTo: rule })} nodeId={node.id} /> : null}
      </Section>
      <ConnectSection node={node} />
      <JoinField node={node} />
    </>
  );
}

const MODE_OPTIONS = [
  { value: 'any', label: p.approval.modeAny },
  { value: 'all', label: p.approval.modeAll },
];
const CONTRIBUTE_MODE_OPTIONS = [
  { value: 'any', label: p.approval.contribute.modeAny },
  { value: 'all', label: p.approval.contribute.modeAll },
];
const ACTION_OPTIONS = [
  { value: 'approve', label: p.approval.actions.approve },
  { value: 'contribute', label: p.approval.actions.contribute },
];

export function ApprovalPanel({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  const { def, change, readOnly } = useDesigner();
  const contribute = isContribute(node);
  const text = contribute ? p.approval.contribute : p.approval;
  const formCount = node.form?.length ?? 0;

  const setAction = (action: string | null) => {
    if (action !== 'approve' && action !== 'contribute') return;
    const dropped = action === 'contribute' ? outEdges(def, node.id).filter((e) => e.outcome === 'rejected').length : 0;
    change((d) => setApprovalAction(d, node.id, action));
    if (dropped > 0) toast.info(p.approval.actionSwitched);
  };

  return (
    <>
      <Section title={nodeKindLabel(node)}>
        <Field label={p.approval.action} hint={p.approval.actionHints[contribute ? 'contribute' : 'approve']}>
          <div data-testid="approval-action" data-action={contribute ? 'contribute' : 'approve'}>
            <Select value={contribute ? 'contribute' : 'approve'} options={ACTION_OPTIONS} onValueChange={setAction} />
          </div>
        </Field>
        <TitleFields node={node} titleLabel={text.title} placeholder={text.titlePlaceholder} />
      </Section>
      <Section title={text.approvers}>
        <RuleList
          nodeId={node.id}
          rules={node.approvers ?? []}
          onChange={(approvers) => patch({ approvers })}
          labelOf={(n) => fmt(text.approver, { n })}
          removeLabelOf={(n) => fmt(text.removeApprover, { n })}
          addLabel={text.addApprover}
        />
        {(node.approvers?.length ?? 0) > 1 ? (
          <Field label={text.mode}>
            <Select value={node.mode ?? 'any'} options={contribute ? CONTRIBUTE_MODE_OPTIONS : MODE_OPTIONS} onValueChange={(v) => patch({ mode: v === 'all' ? 'all' : 'any' })} />
          </Field>
        ) : null}
      </Section>
      <Section title={text.due}>
        <DueEditor label={text.due} hideLabel value={node.due} onChange={(due) => patch({ due }, 'due')} />
        {/* Lời chỉ cách kéo đường nối là dành cho người vẽ; người chỉ xem không cần. */}
        {readOnly ? null : <p className="text-sm text-ink-sub">{text.outcomesHint}</p>}
      </Section>
      <Section
        title={contribute ? p.approval.contribute.form : p.approval.form}
        hint={contribute ? p.approval.contribute.formHint : p.approval.formHint}
        collapsible={!contribute}
        defaultOpen={contribute || formCount > 0}
        badge={<Badge tone="muted">{formCount}</Badge>}
      >
        <FormFieldsEditor
          testId="approval-form"
          fields={node.form ?? []}
          emptyText={contribute ? p.approval.contribute.formEmpty : p.approval.formEmpty}
          excludeTypes={['autonumber']}
          onChange={(form) => patch({ form: form.length > 0 ? form : undefined }, 'form')}
        />
      </Section>
      <Section title={p.task.reminders} collapsible defaultOpen={false} badge={<Badge tone="muted">{t.reminders.presets[node.reminders?.preset ?? 'standard']}</Badge>}>
        <RemindersField node={node} />
        <Field label={text.description}>
          <Textarea rows={2} value={node.description ?? ''} onChange={(e) => patch({ description: e.target.value || undefined }, 'description')} />
        </Field>
      </Section>
      <ConnectSection node={node} />
      <JoinField node={node} />
    </>
  );
}

export function ConditionPanel({ node }: PanelProps) {
  const { change } = useDesigner();
  const branches = node.branches ?? [];
  return (
    <>
      <Section title={vi.common.nodeKind.condition} hint={p.condition.intro}>
        <LabelField node={node} />
      </Section>
      <Section title={p.condition.branches}>
        {branches.map((b, i) => {
          const name = fmt(p.condition.branch, { n: i + 1 });
          return (
            <div key={b.id} className="flex flex-col gap-2 rounded-lg border border-hairline bg-canvas p-2.5" data-testid="branch">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{name}</p>
                <IconButton label={fmt(p.condition.removeBranch, { n: i + 1 })} onClick={() => change((d) => removeBranch(d, node.id, b.id))}>
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </div>
              <Input
                aria-label={`${name}: ${p.condition.branchName}`}
                placeholder={p.condition.branchNamePlaceholder}
                value={b.label ?? ''}
                onChange={(e) => change((d) => updateBranch(d, node.id, b.id, { label: e.target.value }), { coalesce: `node:${node.id}:branch:${b.id}:label` })}
                className="h-9"
              />
              <p className="text-sm font-medium">{p.condition.when}</p>
              <ConditionEditor label={name} value={b.when} onChange={(when) => change((d) => updateBranch(d, node.id, b.id, { when }), { coalesce: `node:${node.id}:branch:${b.id}:when` })} />
            </div>
          );
        })}
        <Button size="sm" variant="ghost" className="self-start" onClick={() => change((d) => addBranch(d, node.id))}>
          <Plus aria-hidden="true" />
          {p.condition.addBranch}
        </Button>
        <div className="rounded-lg border border-hairline bg-surface-alt px-3 py-2.5">
          <p className="text-sm font-semibold">{p.condition.elseTitle}</p>
          <p className="text-sm text-ink-sub">{p.condition.elseBody}</p>
        </div>
      </Section>
      <ConnectSection node={node} />
      <JoinField node={node} />
    </>
  );
}

export function TimerPanel({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  const wait: Duration = node.wait ?? { value: 1, unit: 'working_day' };
  return (
    <>
      <Section title={vi.common.nodeKind.timer}>
        <LabelField node={node} />
        <div className="flex flex-col gap-1.5">
          <p className="text-base font-medium">{p.timer.wait}</p>
          <p className="-mt-0.5 text-sm text-ink-sub">{p.timer.waitHint}</p>
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
            <NumberInput aria-label={`${p.timer.wait}: ${t.duration.amount}`} min={1} max={999} value={wait.value} onValueChange={(value) => patch({ wait: { ...wait, value } }, 'wait')} />
            <Select
              aria-label={`${p.timer.wait}: ${t.duration.unit}`}
              value={wait.unit}
              options={UNIT_OPTIONS}
              onValueChange={(v) => {
                const unit = UNIT_OPTIONS.find((u) => u.value === v)?.value;
                if (unit) patch({ wait: { ...wait, unit } });
              }}
            />
          </div>
        </div>
      </Section>
      <ConnectSection node={node} />
      <JoinField node={node} />
    </>
  );
}

export function NotifyPanel({ node }: PanelProps) {
  const patch = useNodePatch(node.id);
  return (
    <>
      <Section title={vi.common.nodeKind.notify}>
        <LabelField node={node} />
        <Field label={p.notify.template} hint={p.notify.templateHint} required>
          <Textarea rows={3} placeholder={p.notify.templatePlaceholder} value={node.template ?? ''} onChange={(e) => patch({ template: e.target.value }, 'template')} />
        </Field>
      </Section>
      <Section title={p.notify.to}>
        <RuleList
          nodeId={node.id}
          rules={node.to ?? []}
          onChange={(to) => patch({ to })}
          labelOf={(n) => fmt(p.notify.recipient, { n })}
          removeLabelOf={(n) => fmt(p.notify.removeRecipient, { n })}
          addLabel={p.notify.addRecipient}
        />
      </Section>
      <ConnectSection node={node} />
      <JoinField node={node} />
    </>
  );
}

export function StartPanel({ node }: PanelProps) {
  return (
    <>
      <Section title={p.start.heading} hint={p.start.body}>
        <LabelField node={node} />
      </Section>
      <ConnectSection node={node} />
    </>
  );
}

export function EndPanel({ node }: PanelProps) {
  return (
    <>
      <Section title={p.end.heading} hint={p.end.body}>
        <LabelField node={node} />
      </Section>
      <JoinField node={node} />
    </>
  );
}

/** Nhánh "Còn lại" luôn có sẵn: xuất ra để bảng đường nối dùng chung danh sách nhánh. */
export function branchOptions(node: DraftNode, label: (handle: string) => string): { value: string; label: string }[] {
  return [...(node.branches ?? []).map((b) => b.id), ELSE].map((id) => ({ value: id, label: label(id) }));
}
