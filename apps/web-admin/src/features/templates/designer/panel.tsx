import { useEffect, useRef } from 'react';
import { Trash2, X } from 'lucide-react';
import { TEMPLATE_CATEGORIES, type DraftDefinition, type DraftNode, type Edge, type FormField, type TemplateCategory } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';
import { NO_SELECTION, useDesigner } from './context';
import { iconOf, KIND_TINT } from './flow-node';
import { FormFieldsEditor } from './form-fields-editor';
import { findNode, handleLabel, nodeTitle, removeElements, setEdgeHandle, sourceHandleOf, sourceHandles, stepCount } from './model';
import { ApprovalPanel, branchOptions, ConditionPanel, EndPanel, NotifyPanel, StartPanel, TaskPanel, TimerPanel } from './node-panels';
import { StartersEditor } from './starters-editor';
import { IconButton, Section } from './ui';

const t = vi.admin.designer.editor;
const p = t.panel;

// ───────────────────────── Thuộc tính của quy trình ─────────────────────────

/**
 * Ghi biểu mẫu khởi chạy. Bỏ mốc đích khi ô của nó bị xoá hoặc đổi sang loại khác; ô mốc đích luôn bắt buộc (validate() đòi vậy).
 * Ô ngày đầu tiên của biểu mẫu được chọn sẵn làm mốc đích: phần lớn quy trình tính lùi hạn từ đúng ngày đó.
 */
function withInputs(def: DraftDefinition, inputs: FormField[]): DraftDefinition {
  const target = inputs.find((f) => f.key === def.targetField);
  const next: DraftDefinition = { ...def, inputs };
  if (def.targetField !== undefined && target?.type !== 'date') delete next.targetField;
  const added = inputs.length === def.inputs.length + 1 ? inputs.at(-1) : undefined;
  if (next.targetField === undefined && added?.type === 'date' && !def.inputs.some((f) => f.type === 'date')) next.targetField = added.key;
  if (next.targetField !== undefined) next.inputs = inputs.map((f) => (f.key === next.targetField && !f.required ? { ...f, required: true } : f));
  return next;
}

function withTarget(def: DraftDefinition, key: string | null): DraftDefinition {
  const next: DraftDefinition = { ...def };
  if (key === null) {
    delete next.targetField;
    return next;
  }
  next.targetField = key;
  next.inputs = def.inputs.map((f) => (f.key === key ? { ...f, required: true } : f));
  return next;
}

const CATEGORY_OPTIONS = TEMPLATE_CATEGORIES.map((category) => ({ value: category, label: p.process.categories[category] }));

function isCategory(v: string | null): v is TemplateCategory {
  return v !== null && (TEMPLATE_CATEGORIES as readonly string[]).includes(v);
}

type ProcessPanelProps = {
  description: string;
  onDescriptionChange: (value: string) => void;
  category: TemplateCategory;
  onCategoryChange: (value: TemplateCategory) => void;
};

function ProcessPanel({ description, onDescriptionChange, category, onCategoryChange }: ProcessPanelProps) {
  const { def, change } = useDesigner();
  const dateFields = def.inputs.filter((f) => f.type === 'date');
  const steps = def.nodes.filter((n) => n.type !== 'start' && n.type !== 'end').length;
  return (
    <>
      <Section title={p.process.heading}>
        <Field label={p.process.name} required>
          <Input value={def.name} maxLength={200} onChange={(e) => change((d) => ({ ...d, name: e.target.value }), { coalesce: 'process:name' })} data-testid="process-name" />
        </Field>
        <Field label={p.process.description} hint={p.process.descriptionHint}>
          <Textarea rows={2} maxLength={2000} value={description} onChange={(e) => onDescriptionChange(e.target.value)} />
        </Field>
        <Field label={p.process.category} hint={p.process.categoryHint}>
          <div data-testid="process-category" data-category={category}>
            <Select value={category} options={CATEGORY_OPTIONS} onValueChange={(v) => isCategory(v) && onCategoryChange(v)} />
          </div>
        </Field>
      </Section>
      <Section title={p.starters.heading} hint={p.starters.hint}>
        <StartersEditor />
      </Section>
      <Section title={p.process.inputs} hint={p.process.inputsHint}>
        <FormFieldsEditor
          testId="inputs"
          fields={def.inputs}
          targetKey={def.targetField}
          emptyText={p.process.inputsEmpty}
          onChange={(inputs) => change((d) => withInputs(d, inputs), { coalesce: 'process:inputs' })}
        />
      </Section>
      <Section title={p.process.target} hint={p.process.targetHint}>
        {dateFields.length === 0 ? (
          <p className="rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm">{p.process.targetNoDate}</p>
        ) : (
          <Field label={p.process.target} hideLabel>
            <Select
              value={def.targetField && dateFields.some((f) => f.key === def.targetField) ? def.targetField : null}
              options={dateFields.map((f) => ({ value: f.key, label: f.label }))}
              emptyOption={p.process.targetNone}
              onValueChange={(key) => change((d) => withTarget(d, key))}
            />
          </Field>
        )}
      </Section>
      <div className="flex flex-col gap-1 border-t border-hairline px-4 py-3.5 text-sm text-ink-sub">
        <p>{fmt(p.process.summary, { việc: stepCount(def), bước: steps })}</p>
        <p>{p.process.tip}</p>
      </div>
    </>
  );
}

// ───────────────────────── Thuộc tính của đường nối ─────────────────────────

/** Kết quả chọn được cho một đường đi ra từ bước duyệt; bước góp nội dung chỉ có "Đã góp đủ", trừ đường cũ còn sót thì vẫn hiện để đổi hoặc xoá. */
function outcomeHandles(from: DraftNode, edge: Edge): string[] {
  const handles = sourceHandles(from) ?? [];
  return edge.outcome && !handles.includes(edge.outcome) ? [...handles, edge.outcome] : handles;
}

function EdgePanel({ edge }: { edge: Edge }) {
  const { def, change, select, readOnly } = useDesigner();
  const from = findNode(def, edge.from);
  const to = findNode(def, edge.to);
  const handle = sourceHandleOf(def, edge);
  return (
    <Section title={p.edge.heading}>
      <p className="text-base">{fmt(p.edge.fromTo, { từ: from ? nodeTitle(from) : edge.from, đến: to ? nodeTitle(to) : edge.to })}</p>
      {from?.type === 'approval' ? (
        <Field label={p.edge.outcome}>
          <Select
            value={edge.outcome ?? null}
            placeholder={p.edge.branchPlaceholder}
            options={outcomeHandles(from, edge).map((h) => ({ value: h, label: handleLabel(def, from, h) }))}
            onValueChange={(v) => v && change((d) => setEdgeHandle(d, edge.id, v))}
          />
        </Field>
      ) : from?.type === 'condition' ? (
        <Field label={p.edge.branch}>
          <Select
            value={handle && branchOptions(from, () => '').some((o) => o.value === handle) ? handle : null}
            placeholder={p.edge.branchPlaceholder}
            options={branchOptions(from, (h) => handleLabel(def, from, h))}
            onValueChange={(v) => v && change((d) => setEdgeHandle(d, edge.id, v))}
          />
        </Field>
      ) : (
        <p className="text-sm text-ink-sub">
          {p.edge.plain} {p.edge.parallelNote}
        </p>
      )}
      {readOnly ? null : (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => {
            change((d) => removeElements(d, [], [edge.id]));
            select(NO_SELECTION);
          }}
          data-testid="delete-edge"
        >
          <Trash2 aria-hidden="true" />
          {p.deleteEdge}
        </Button>
      )}
    </Section>
  );
}

// ───────────────────────── Bảng thuộc tính ─────────────────────────

function NodeBody({ node }: { node: DraftNode }) {
  switch (node.type) {
    case 'task':
      return <TaskPanel node={node} />;
    case 'approval':
      return <ApprovalPanel node={node} />;
    case 'condition':
      return <ConditionPanel node={node} />;
    case 'timer':
      return <TimerPanel node={node} />;
    case 'notify':
      return <NotifyPanel node={node} />;
    case 'start':
      return <StartPanel node={node} />;
    default:
      return <EndPanel node={node} />;
  }
}

export type PropertiesPanelProps = {
  description: string;
  onDescriptionChange: (value: string) => void;
  category: TemplateCategory;
  onCategoryChange: (value: TemplateCategory) => void;
  /** tăng lên mỗi lần vừa thêm một bước: đưa con trỏ vào ô tên để người vẽ gõ luôn */
  focusToken: number;
};

/**
 * Cột phải (SPEC 9.3): thuộc tính của nút đang chọn, của đường nối đang chọn, hoặc của cả quy trình khi chưa chọn gì.
 * Ở chế độ chỉ xem, toàn bộ ô nhập bị khoá bằng <fieldset disabled>.
 */
export function PropertiesPanel({ description, onDescriptionChange, category, onCategoryChange, focusToken }: PropertiesPanelProps) {
  const { def, selection, select, change, readOnly, nodeIssue } = useDesigner();
  const ref = useRef<HTMLDivElement>(null);

  const node = selection.nodes.length === 1 && selection.edges.length === 0 ? findNode(def, selection.nodes[0]) : undefined;
  const edge = !node && selection.edges.length === 1 && selection.nodes.length === 0 ? def.edges.find((e) => e.id === selection.edges[0]) : undefined;

  useEffect(() => {
    if (focusToken === 0) return;
    const field = ref.current?.querySelector<HTMLInputElement>('[data-autofocus]');
    field?.focus();
    field?.select();
  }, [focusToken]);

  const Icon = node ? iconOf(node) : null;
  const issue = node ? nodeIssue(node.id) : undefined;

  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col" data-testid="properties-panel">
      {node && Icon ? (
        <div className="flex items-center gap-2 border-b border-hairline py-2 pr-2 pl-4">
          <span className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md', KIND_TINT[node.type])}>
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold" title={nodeTitle(node)}>
            {nodeTitle(node)}
          </h2>
          {!readOnly && node.type !== 'start' ? (
            <IconButton
              label={p.deleteStep}
              onClick={() => {
                change((d) => removeElements(d, [node.id], []));
                select(NO_SELECTION);
              }}
              data-testid="delete-node"
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton label={p.close} onClick={() => select(NO_SELECTION)} data-testid="panel-close">
            <X aria-hidden="true" />
          </IconButton>
        </div>
      ) : edge ? (
        <div className="flex items-center gap-2 border-b border-hairline py-2 pr-2 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{p.edge.heading}</h2>
          <IconButton label={p.close} onClick={() => select(NO_SELECTION)}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {issue ? (
          <div
            role={issue.level === 'error' ? 'alert' : 'status'}
            className={cn('mx-4 mt-3 rounded-lg border px-3 py-2 text-sm', issue.level === 'error' ? 'border-ink font-medium' : 'border-warn/40 bg-warn-bg text-warn')}
          >
            <ul className={cn(issue.messages.length > 1 && 'list-disc space-y-0.5 pl-4')}>
              {issue.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <fieldset disabled={readOnly} className="min-w-0">
          {node ? <NodeBody key={node.id} node={node} /> : edge ? <EdgePanel key={edge.id} edge={edge} /> : <ProcessPanel description={description} onDescriptionChange={onDescriptionChange} category={category} onCategoryChange={onCategoryChange} />}
        </fieldset>
        {node ? <p className="px-4 pt-1 pb-4 text-xs text-ink-sub">{fmt(p.idNote, { mã: node.id })}</p> : null}
      </div>
    </div>
  );
}
