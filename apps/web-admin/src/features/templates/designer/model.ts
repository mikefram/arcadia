import type { AssigneeRule, DraftDefinition, DraftNode, DueRule, Duration, Edge, Expr, FormField, PersonRef, StarterRule } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { personName } from '@/lib/person';

/**
 * Mô hình của trình thiết kế: các hàm thuần biến đổi `DraftDefinition` (SPEC 4.2) và dựng câu tóm tắt.
 * Mọi hàm trả về bản mới, không sửa bản cũ, để hoàn tác và làm lại chỉ cần giữ các bản đã qua.
 */

const t = vi.admin.designer.editor;

/** `contribute` là bước duyệt có cách xử lý "Góp nội dung" (`action: 'contribute'`); trên khối nút nó là một loại riêng cho dễ thêm. */
export type StepKind = 'task' | 'approval' | 'contribute' | 'condition' | 'timer' | 'notify';
export type AddableKind = StepKind | 'end';
export const STEP_KINDS: readonly StepKind[] = ['task', 'approval', 'contribute', 'condition', 'timer', 'notify'];

/** Nhánh "Còn lại" của nút rẽ nhánh (SPEC 4.2: cạnh `else` bắt buộc). */
export const ELSE = 'else';
/** Cổng ra tạm cho đường nối chưa gắn kết quả duyệt hoặc nhánh (bản vẽ cũ hoặc vừa xoá nhánh). */
export const NO_HANDLE = '__none';

/** Bề rộng cố định của thẻ bước trên sơ đồ (ô Bắt đầu và Hoàn tất hẹp hơn). */
export const NODE_WIDTH = 224;

export type XY = { x: number; y: number };
export type Size = { width: number; height: number };
export type CompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export const COMPARE_OPS: readonly CompareOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
export type Branch = NonNullable<DraftNode['branches']>[number];

// ───────────────────────── Tra cứu ─────────────────────────

export function findNode(def: DraftDefinition, id: string | null | undefined): DraftNode | undefined {
  return id ? def.nodes.find((n) => n.id === id) : undefined;
}

export function outEdges(def: DraftDefinition, nodeId: string): Edge[] {
  return def.edges.filter((e) => e.from === nodeId);
}

export function inEdges(def: DraftDefinition, nodeId: string): Edge[] {
  return def.edges.filter((e) => e.to === nodeId);
}

/** Số việc (việc và bước duyệt) của bản vẽ. */
export function stepCount(def: DraftDefinition): number {
  return def.nodes.filter((n) => n.type === 'task' || n.type === 'approval').length;
}

/** Bản vẽ mới tinh: chỉ có Bắt đầu và Hoàn tất, chưa nối gì. */
export function isBlank(def: DraftDefinition): boolean {
  return def.edges.length === 0 && def.nodes.every((n) => n.type === 'start' || n.type === 'end');
}

/** Bước duyệt ở cách xử lý "Góp nội dung": mỗi người gửi phần của mình, không có "Chưa đồng ý". */
export function isContribute(node: DraftNode | undefined): boolean {
  return node?.type === 'approval' && node.action === 'contribute';
}

/** Tên loại của một khối nút hoặc loại bước thêm được: Việc, Duyệt, Góp nội dung, Rẽ nhánh… */
export function kindLabel(kind: AddableKind): string {
  return kind === 'contribute' ? t.kinds.contribute : vi.common.nodeKind[kind];
}

/** Tên loại của một bước đã có trên sơ đồ; bước duyệt ở cách "Góp nội dung" mang tên riêng. */
export function nodeKindLabel(node: DraftNode): string {
  return isContribute(node) ? t.kinds.contribute : vi.common.nodeKind[node.type];
}

export function nodeTitle(node: DraftNode): string {
  const label = node.label.trim();
  if (label) return label;
  return (node.title ?? '').trim() || nodeKindLabel(node);
}

// ───────────────────────── Sinh mã ─────────────────────────

/** Mã kế tiếp dạng `<tiền tố><số>`, lớn hơn mọi số đang dùng để mã đã xoá không bị dùng lại. */
function nextNumbered(taken: Iterable<string>, prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of taken) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/**
 * Mã ô biểu mẫu sinh từ tên ô: bỏ dấu, chữ thường, nối bằng gạch dưới ("Ngày đoàn đến" → `ngay_doan_den`).
 * Người vẽ không phải gõ mã. Mã giữ nguyên khi đổi tên ô, vì các bước khác tham chiếu tới mã.
 */
export function slugKey(label: string, taken: ReadonlySet<string>): string {
  let base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!/^[a-z]/.test(base)) base = base ? `o_${base}` : 'o';
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

// ───────────────────────── Tạo và sửa nút ─────────────────────────

/** Hạn mặc định: có mốc đích thì tính lùi 7 ngày làm việc, không thì 3 ngày làm việc sau khi tới lượt. */
export function defaultDue(def: DraftDefinition): DueRule {
  return def.targetField
    ? { anchor: 'run_target', offset: { value: -7, unit: 'working_day' } }
    : { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
}

/** Điều kiện còn trống của một nhánh mới: `validate()` báo thiếu cho tới khi người vẽ điền. */
export const EMPTY_WHEN: Expr = { op: 'eq', left: { ref: '' }, right: { value: '' } };

/** Ô mẫu của bước góp nội dung: một ô nhiều dòng bắt buộc để mỗi người gõ phần của mình. */
export function contributeField(): FormField {
  return { key: 'noiDung', label: t.panel.approval.contribute.defaultFieldLabel, type: 'longtext', required: true };
}

export function createNode(def: DraftDefinition, kind: AddableKind): DraftNode {
  const ids = def.nodes.map((n) => n.id);
  if (kind === 'end') {
    const id = ids.includes('end') ? nextNumbered(ids, 'end') : 'end';
    return { id, type: 'end', label: vi.common.nodeKind.end };
  }
  const id = nextNumbered(ids, 's');
  switch (kind) {
    case 'task':
      return { id, type: 'task', label: t.defaults.task, title: '', due: defaultDue(def), reminders: { preset: 'standard' } };
    case 'approval':
      return { id, type: 'approval', label: t.defaults.approval, title: '', approvers: [], mode: 'any', due: defaultDue(def), reminders: { preset: 'standard' } };
    case 'contribute':
      return {
        id,
        type: 'approval',
        label: t.defaults.contribute,
        title: '',
        approvers: [],
        mode: 'all',
        action: 'contribute',
        due: defaultDue(def),
        reminders: { preset: 'standard' },
        form: [contributeField()],
      };
    case 'condition':
      return { id, type: 'condition', label: t.defaults.condition, branches: [{ id: 'b1', when: EMPTY_WHEN }] };
    case 'timer':
      return { id, type: 'timer', label: t.defaults.timer, wait: { value: 1, unit: 'working_day' } };
    case 'notify':
      return { id, type: 'notify', label: t.defaults.notify, to: [], template: '' };
  }
}

/** Tên mặc định của một loại bước; tên ngắn trên sơ đồ đi theo tên việc cho tới khi người vẽ tự đặt. */
export function defaultLabel(type: DraftNode['type'], action?: DraftNode['action']): string {
  switch (type) {
    case 'task':
      return t.defaults.task;
    case 'approval':
      return action === 'contribute' ? t.defaults.contribute : t.defaults.approval;
    case 'condition':
      return t.defaults.condition;
    case 'timer':
      return t.defaults.timer;
    case 'notify':
      return t.defaults.notify;
    default:
      return vi.common.nodeKind[type];
  }
}

/** Gộp thay đổi vào một nút; khoá có giá trị `undefined` thì xoá hẳn để JSON lưu đi không còn khoá thừa. */
export function patchNode(def: DraftDefinition, nodeId: string, patch: Partial<DraftNode>): DraftDefinition {
  let changed = false;
  const nodes = def.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const next: Record<string, unknown> = { ...n };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        if (key in next) {
          delete next[key];
          changed = true;
        }
      } else if (next[key] !== value) {
        next[key] = value;
        changed = true;
      }
    }
    return changed ? (next as DraftNode) : n;
  });
  return changed ? { ...def, nodes } : def;
}

/**
 * Đổi cách xử lý của một bước duyệt. Sang "Góp nội dung": bước không còn "Chưa đồng ý" nên các đường "Chưa đồng ý" đi ra bị bỏ,
 * cần mọi người cùng góp (mode = all) và phải có biểu mẫu (thêm sẵn ô "Nội dung" nếu chưa có). Về lại "Duyệt": giữ nguyên biểu mẫu.
 * Tên ngắn trên sơ đồ còn là tên mặc định của cách cũ thì đổi sang tên mặc định của cách mới.
 */
export function setApprovalAction(def: DraftDefinition, nodeId: string, action: 'approve' | 'contribute'): DraftDefinition {
  const node = findNode(def, nodeId);
  if (!node || node.type !== 'approval') return def;
  if ((node.action ?? 'approve') === action) return def;
  const label = node.label === defaultLabel('approval', node.action) ? defaultLabel('approval', action === 'contribute' ? 'contribute' : undefined) : node.label;
  if (action === 'approve') return patchNode(def, nodeId, { action: undefined, label });
  const patched = patchNode(def, nodeId, { action: 'contribute', mode: 'all', label, form: node.form && node.form.length > 0 ? node.form : [contributeField()] });
  return { ...patched, edges: patched.edges.filter((e) => !(e.from === nodeId && e.outcome === 'rejected')) };
}

export function setPositions(def: DraftDefinition, positions: Record<string, XY>): DraftDefinition {
  const layout = { ...(def.layout ?? {}) };
  let changed = false;
  for (const [id, p] of Object.entries(positions)) {
    const old = layout[id];
    const next = { x: Math.round(p.x), y: Math.round(p.y) };
    if (!old || old.x !== next.x || old.y !== next.y) {
      layout[id] = next;
      changed = true;
    }
  }
  return changed ? { ...def, layout } : def;
}

// ───────────────────────── Đường nối ─────────────────────────

/** Cổng ra mà một đường nối xuất phát: kết quả duyệt, mã nhánh, hoặc null với nút chỉ có một cổng ra. */
export function sourceHandleOf(def: DraftDefinition, edge: Edge): string | null {
  const from = findNode(def, edge.from);
  if (from?.type === 'approval') {
    // Bước góp nội dung không có cổng "Chưa đồng ý": đường cũ còn sót đi vào cổng tạm để người vẽ thấy và gỡ.
    if (isContribute(from) && edge.outcome !== 'approved') return NO_HANDLE;
    return edge.outcome ?? NO_HANDLE;
  }
  if (from?.type === 'condition') {
    const known = edge.branch === ELSE || (from.branches ?? []).some((b) => b.id === edge.branch);
    return known && edge.branch ? edge.branch : NO_HANDLE;
  }
  return null;
}

/** Các cổng ra của một nút, theo thứ tự hiện trên nút. */
export function sourceHandles(node: DraftNode): string[] | null {
  // Bước góp nội dung chỉ có một đường ra: khi đã góp đủ.
  if (node.type === 'approval') return isContribute(node) ? ['approved'] : ['approved', 'rejected'];
  if (node.type === 'condition') return [...(node.branches ?? []).map((b) => b.id), ELSE];
  return null;
}

/** Cổng ra còn trống đầu tiên, để nút "thêm bước kế tiếp" biết nối từ đâu. */
export function firstFreeHandle(def: DraftDefinition, node: DraftNode): string | null {
  const handles = sourceHandles(node);
  if (!handles) return null;
  const used = new Set(outEdges(def, node.id).map((e) => sourceHandleOf(def, e)));
  return handles.find((h) => !used.has(h)) ?? handles[0] ?? null;
}

function edgeMarks(from: DraftNode, handle: string | null): Pick<Edge, 'outcome' | 'branch'> {
  if (from.type === 'approval' && (handle === 'approved' || handle === 'rejected')) return { outcome: handle };
  if (from.type === 'condition' && handle && handle !== NO_HANDLE) return { branch: handle };
  return {};
}

export function canConnect(def: DraftDefinition, from: string, to: string, handle: string | null): boolean {
  if (from === to) return false;
  const a = findNode(def, from);
  const b = findNode(def, to);
  if (!a || !b || a.type === 'end' || b.type === 'start') return false;
  const marks = edgeMarks(a, handle);
  return !def.edges.some((e) => e.from === from && e.to === to && e.outcome === marks.outcome && e.branch === marks.branch);
}

export function addEdge(def: DraftDefinition, from: string, to: string, handle: string | null): { def: DraftDefinition; edgeId: string | null } {
  if (!canConnect(def, from, to, handle)) return { def, edgeId: null };
  const source = findNode(def, from) as DraftNode;
  const id = nextNumbered(
    def.edges.map((e) => e.id),
    'e',
  );
  return { def: { ...def, edges: [...def.edges, { id, from, to, ...edgeMarks(source, handle) }] }, edgeId: id };
}

/** Đổi kết quả duyệt hoặc nhánh của một đường nối (bảng thuộc tính của đường nối). */
export function setEdgeHandle(def: DraftDefinition, edgeId: string, handle: string): DraftDefinition {
  const edge = def.edges.find((e) => e.id === edgeId);
  const from = edge ? findNode(def, edge.from) : undefined;
  if (!edge || !from) return def;
  const next: Edge = { id: edge.id, from: edge.from, to: edge.to, ...edgeMarks(from, handle) };
  return { ...def, edges: def.edges.map((e) => (e.id === edgeId ? next : e)) };
}

/** Thêm một nút ở vị trí cho trước; có `from` thì nối luôn từ nút đó. */
export function addNodeAt(
  def: DraftDefinition,
  kind: AddableKind,
  position: XY,
  from?: { nodeId: string; handle: string | null },
): { def: DraftDefinition; nodeId: string } {
  const node = createNode(def, kind);
  let next: DraftDefinition = {
    ...def,
    nodes: [...def.nodes, node],
    layout: { ...(def.layout ?? {}), [node.id]: { x: Math.round(position.x), y: Math.round(position.y) } },
  };
  if (from) next = addEdge(next, from.nodeId, node.id, from.handle).def;
  return { def: next, nodeId: node.id };
}

/** Xoá nút và đường nối. Nút Bắt đầu không xoá được; đường nối dính vào nút bị xoá cũng mất theo. */
export function removeElements(def: DraftDefinition, nodeIds: readonly string[], edgeIds: readonly string[]): DraftDefinition {
  const gone = new Set(nodeIds.filter((id) => findNode(def, id)?.type !== 'start'));
  const goneEdges = new Set(edgeIds);
  const nodes = def.nodes.filter((n) => !gone.has(n.id));
  const edges = def.edges.filter((e) => !goneEdges.has(e.id) && !gone.has(e.from) && !gone.has(e.to));
  if (nodes.length === def.nodes.length && edges.length === def.edges.length) return def;
  const layout = { ...(def.layout ?? {}) };
  for (const id of gone) delete layout[id];
  return { ...def, nodes, edges, layout };
}

// ───────────────────────── Nhánh của nút rẽ nhánh ─────────────────────────

export function addBranch(def: DraftDefinition, nodeId: string): DraftDefinition {
  const node = findNode(def, nodeId);
  if (!node) return def;
  const branches = node.branches ?? [];
  const id = nextNumbered(
    branches.map((b) => b.id),
    'b',
  );
  return patchNode(def, nodeId, { branches: [...branches, { id, when: EMPTY_WHEN }] });
}

export function updateBranch(def: DraftDefinition, nodeId: string, branchId: string, patch: Partial<Branch>): DraftDefinition {
  const node = findNode(def, nodeId);
  if (!node) return def;
  const branches = (node.branches ?? []).map((b) => {
    if (b.id !== branchId) return b;
    const next: Branch = { ...b, ...patch };
    if (!next.label) delete next.label;
    return next;
  });
  return patchNode(def, nodeId, { branches });
}

/** Xoá một nhánh thì đường nối của nhánh đó cũng mất. */
export function removeBranch(def: DraftDefinition, nodeId: string, branchId: string): DraftDefinition {
  const node = findNode(def, nodeId);
  if (!node) return def;
  const next = patchNode(def, nodeId, { branches: (node.branches ?? []).filter((b) => b.id !== branchId) });
  return { ...next, edges: next.edges.filter((e) => !(e.from === nodeId && e.branch === branchId)) };
}

// ───────────────────────── Điều kiện đơn giản ↔ Expr ─────────────────────────

export type SimpleCondition = { ref: string; op: CompareOp; value: string | number | boolean };

/** Một lựa chọn cho vế trái của điều kiện: ô của biểu mẫu khởi chạy hoặc ô kết quả của một việc. */
export type OperandOption = { ref: string; label: string; field: FormField };

/**
 * Đọc `Expr` thành điều kiện một dòng (vế trái là tham chiếu, vế phải là giá trị).
 * Trả 'complex' với biểu thức and/or/not hoặc so hai tham chiếu: loại này không sửa được bằng biểu mẫu.
 */
export function toSimple(expr: Expr | undefined): SimpleCondition | 'complex' {
  if (!expr) return { ref: '', op: 'eq', value: '' };
  if ('args' in expr || 'arg' in expr) return 'complex';
  if (!('ref' in expr.left) || !('value' in expr.right)) return 'complex';
  return { ref: expr.left.ref, op: expr.op, value: expr.right.value };
}

export function fromSimple(c: SimpleCondition): Expr {
  return { op: c.op, left: { ref: c.ref }, right: { value: c.value } };
}

/** Danh sách người và danh sách tệp không so sánh "bằng" với một giá trị được, nên không đưa vào điều kiện rẽ nhánh. */
const comparable = (f: FormField): boolean => f.type !== 'users' && f.type !== 'file';

export function operandOptions(def: DraftDefinition): OperandOption[] {
  const out: OperandOption[] = [];
  for (const f of def.inputs) {
    if (comparable(f)) out.push({ ref: `inputs.${f.key}`, label: fmt(t.panel.condition.operandInput, { tên: f.label }), field: f });
  }
  for (const n of def.nodes) {
    if (n.type !== 'task') continue;
    for (const f of n.form ?? []) {
      if (comparable(f)) out.push({ ref: `steps.${n.id}.result.${f.key}`, label: fmt(t.panel.condition.operandStep, { việc: nodeTitle(n), tên: f.label }), field: f });
    }
  }
  return out;
}

const groupThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Câu tóm tắt điều kiện của một nhánh: "Số tiền đề nghị ≥ 50.000.000". Trả null khi chưa đặt xong. */
export function conditionSummary(def: DraftDefinition, expr: Expr | undefined): string | null {
  const c = toSimple(expr);
  if (c === 'complex' || !c.ref) return null;
  const option = operandOptions(def).find((o) => o.ref === c.ref);
  if (!option) return null;
  let value: string;
  if (typeof c.value === 'number') value = groupThousands(c.value);
  else if (typeof c.value === 'boolean') value = c.value ? t.panel.condition.boolTrue : t.panel.condition.boolFalse;
  else if (option.field.type === 'select') value = option.field.options?.find((o) => o.value === c.value)?.label ?? c.value;
  else value = c.value;
  if (value === '') return null;
  return `${option.field.label} ${t.panel.condition.opSymbols[c.op]} ${value}`;
}

export function branchName(def: DraftDefinition, node: DraftNode, branchId: string): string {
  if (branchId === ELSE) return t.node.branchElse;
  const branches = node.branches ?? [];
  const index = branches.findIndex((b) => b.id === branchId);
  const branch = branches[index];
  if (!branch) return t.node.unlabelled;
  return branch.label?.trim() || conditionSummary(def, branch.when) || fmt(t.node.branchUnnamed, { n: index + 1 });
}

/** Nhãn hiện trên một đường nối: "Đồng ý", "Chưa đồng ý", tên nhánh, "Còn lại"; null với đường nối thường. */
export function edgeLabel(def: DraftDefinition, edge: Edge): string | null {
  const from = findNode(def, edge.from);
  if (!from) return null;
  if (from.type === 'approval') {
    if (edge.outcome === 'approved') return isContribute(from) ? t.node.contributeDone : vi.common.actions.approve;
    if (edge.outcome === 'rejected') return vi.common.actions.reject;
    return t.node.unlabelled;
  }
  if (from.type === 'condition') {
    const handle = sourceHandleOf(def, edge);
    return handle === NO_HANDLE || handle === null ? t.node.unlabelled : branchName(def, from, handle);
  }
  return null;
}

export function handleLabel(def: DraftDefinition, node: DraftNode, handle: string): string {
  if (node.type === 'approval') {
    if (handle === 'approved') return isContribute(node) ? t.node.contributeDone : vi.common.actions.approve;
    return handle === 'rejected' ? vi.common.actions.reject : t.node.unlabelled;
  }
  if (node.type === 'condition') return handle === NO_HANDLE ? t.node.unlabelled : branchName(def, node, handle);
  return '';
}

// ───────────────────────── Câu tóm tắt trên nút ─────────────────────────

export function durationText(d: Duration): string {
  return fmt(t.duration.text, { n: Math.abs(d.value), 'đơn vị': t.due.units[d.unit] });
}

/** "7 ngày làm việc trước mốc đích" (SPEC 9.3). Giờ cụ thể thì thêm ", lúc 10:00". */
export function dueSummary(due: DueRule | undefined): string | null {
  if (!due) return null;
  const s = t.due.summary;
  const vars = { n: Math.abs(due.offset.value), 'đơn vị': t.due.units[due.offset.unit] };
  let text: string;
  if (due.anchor === 'run_target') {
    text = due.offset.value === 0 ? s.on_target : fmt(due.offset.value < 0 ? s.before_target : s.after_target, vars);
  } else if (due.anchor === 'activation') {
    text = due.offset.value === 0 ? s.activation_zero : fmt(s.activation, vars);
  } else {
    text = due.offset.value === 0 ? s.run_start_zero : fmt(s.run_start, vars);
  }
  if (due.atTime && due.atTime !== 'end_of_workday' && due.offset.unit !== 'hour') return fmt(s.at, { hạn: text, giờ: due.atTime });
  return text;
}

export type Lookups = {
  person: (id: string) => Pick<PersonRef, 'fullName' | 'givenName' | 'honorific'> | undefined;
  unitName: (id: string) => string | undefined;
};

/** Người nhận viết bằng lời: "chị Nguyễn Thu Lan", "Trưởng Phòng Kế toán", "Người khởi chạy"… */
export function assigneeSummary(def: DraftDefinition, rule: AssigneeRule | undefined, lookups: Lookups): string | null {
  if (!rule) return null;
  const s = t.assignee.summary;
  switch (rule.kind) {
    case 'user': {
      const person = lookups.person(rule.userId);
      return person ? personName(person, 'full') : t.assignee.unknownPerson;
    }
    case 'role': {
      const role = vi.common.role[rule.role];
      const unit = rule.unitId ? lookups.unitName(rule.unitId) : undefined;
      return unit ? fmt(s.roleInUnit, { 'vai trò': role, 'đơn vị': unit }) : fmt(s.role, { 'vai trò': role });
    }
    case 'unit_head': {
      const unit = rule.unitId ? lookups.unitName(rule.unitId) : undefined;
      return unit ? fmt(s.unitHead, { 'đơn vị': unit }) : s.unitHeadOfInitiator;
    }
    case 'initiator':
      return s.initiator;
    case 'initiator_manager':
      return rule.level && rule.level > 1 ? fmt(s.managerLevel, { n: rule.level }) : s.manager;
    case 'form_field': {
      const field = def.inputs.find((f) => f.key === rule.field);
      return fmt(field?.type === 'users' ? s.formFieldMany : s.formField, { tên: field?.label ?? t.assignee.unknownField });
    }
    case 'step_field': {
      const step = findNode(def, rule.node);
      const field = step?.form?.find((f) => f.key === rule.field);
      if (!step || !field) return t.assignee.unknownField;
      return fmt(field.type === 'users' ? s.stepFieldMany : s.stepField, { tên: field.label, bước: nodeTitle(step) });
    }
  }
}

/** Dòng "người nhận" của một nút duyệt hoặc thông báo có nhiều người. */
export function assigneesSummary(def: DraftDefinition, rules: readonly AssigneeRule[] | undefined, lookups: Lookups): string | null {
  const first = rules?.[0];
  if (!rules || !first) return null;
  const name = assigneeSummary(def, first, lookups) ?? '';
  return rules.length > 1 ? fmt(t.node.approversMore, { tên: name, n: rules.length - 1 }) : name;
}

// ───────────────────────── Ai được khởi chạy ─────────────────────────

/** Cách chọn người khởi chạy trên bảng thuộc tính: theo quyền (mặc định), mọi cán bộ, hoặc chọn cụ thể. */
export type StartersMode = 'default' | 'everyone' | 'custom';

/** Bỏ trống, hoặc chỉ có dòng "người có quyền khởi chạy", là cách mặc định. */
export function startersMode(starters: readonly StarterRule[] | undefined): StartersMode {
  if (!starters || starters.length === 0) return 'default';
  if (starters.some((r) => r.kind === 'everyone')) return 'everyone';
  if (starters.every((r) => r.kind === 'permission')) return 'default';
  return 'custom';
}

/** "Chỉ Chủ tịch", "Mọi cán bộ", "Văn phòng, Mọi người thuộc Phòng Kế toán"… */
export function startersSummary(starters: readonly StarterRule[] | undefined, lookups: Lookups): string {
  const s = t.panel.starters.summary;
  const mode = startersMode(starters);
  if (mode === 'default') return s.default;
  if (mode === 'everyone') return s.everyone;
  const rules = starters ?? [];
  const parts = rules.map((rule) => {
    switch (rule.kind) {
      case 'role':
        return vi.common.role[rule.role];
      case 'user': {
        const person = lookups.person(rule.userId);
        return person ? personName(person, 'full') : t.assignee.unknownPerson;
      }
      case 'unit':
        return fmt(s.unit, { 'đơn vị': lookups.unitName(rule.unitId) ?? t.panel.starters.unknownUnit });
      default:
        return s.permission;
    }
  });
  const joined = [...new Set(parts)].join(s.join);
  return rules.every((r) => r.kind === 'role' || r.kind === 'user') ? fmt(s.only, { ai: joined }) : joined;
}

// ───────────────────────── Vị trí của nút mới ─────────────────────────

/** Kích thước ước lượng của một nút khi React Flow chưa đo (dùng cho tự sắp xếp và tìm chỗ trống). */
export function estimateSize(node: DraftNode): Size {
  switch (node.type) {
    case 'start':
    case 'end':
      return { width: 132, height: 44 };
    case 'task':
      return { width: NODE_WIDTH, height: node.compile ? 138 : 112 };
    case 'approval':
      return { width: NODE_WIDTH, height: isContribute(node) ? 142 : 172 };
    case 'condition':
      return { width: NODE_WIDTH, height: 70 + 30 * ((node.branches?.length ?? 0) + 1) };
    case 'notify':
      return { width: NODE_WIDTH, height: 92 };
    default:
      return { width: NODE_WIDTH, height: 72 };
  }
}

const GAP_X = 72;
const GAP_Y = 28;

export function positionOf(def: DraftDefinition, nodeId: string): XY {
  return def.layout?.[nodeId] ?? { x: 0, y: 0 };
}

/** Chỗ chừa cho dải báo lỗi dưới thẻ: bước vừa thêm hầu như luôn có (còn thiếu người nhận, chưa nối). */
const ISSUE_ROOM = 48;

/** Kích thước đã đo của một nút; chưa đo (vừa thêm, React Flow chưa kịp vẽ) thì ước lượng kèm chỗ cho dải báo lỗi, để bước thêm liền sau không đè lên. */
function roomyOf(node: DraftNode, sizes: (id: string) => Size | undefined): Size {
  const measured = sizes(node.id);
  if (measured) return measured;
  const guess = estimateSize(node);
  return { width: guess.width, height: guess.height + ISSUE_ROOM };
}

/** Dời xuống cho tới khi không đè lên nút nào khác. */
export function freeSpot(def: DraftDefinition, wanted: XY, size: Size, sizes: (id: string) => Size | undefined): XY {
  const spot = { ...wanted };
  for (let guard = 0; guard < 60; guard += 1) {
    const hit = def.nodes.find((n) => {
      const p = positionOf(def, n.id);
      const s = roomyOf(n, sizes);
      return spot.x < p.x + s.width + 16 && spot.x + size.width + 16 > p.x && spot.y < p.y + s.height + GAP_Y && spot.y + size.height + GAP_Y > p.y;
    });
    if (!hit) return spot;
    const p = positionOf(def, hit.id);
    const s = roomyOf(hit, sizes);
    spot.y = p.y + s.height + GAP_Y;
  }
  return spot;
}

/** Chỗ đặt bước kế tiếp: bên phải nút nguồn, cùng hàng nếu còn trống. */
export function spotAfter(def: DraftDefinition, fromId: string, kind: AddableKind, sizes: (id: string) => Size | undefined): XY {
  const from = findNode(def, fromId);
  const p = positionOf(def, fromId);
  const s = (from && (sizes(fromId) ?? estimateSize(from))) || { width: NODE_WIDTH, height: 72 };
  const size = estimateSize(createNode(def, kind));
  // Canh giữa theo chiều dọc với nút nguồn khi nút nguồn thấp (ô Bắt đầu), để đường nối đầu tiên đi thẳng.
  const y = s.height < 60 ? p.y + s.height / 2 - size.height / 2 : p.y;
  // Bước mới thường còn thiếu thông tin nên hiện thêm dải báo lỗi: chừa chỗ để không đè lên nút bên dưới.
  const roomy = { width: size.width, height: size.height + (kind === 'end' ? 0 : 48) };
  return freeSpot(def, { x: p.x + s.width + GAP_X, y }, roomy, sizes);
}

/** Khung bao của cả sơ đồ, tính từ toạ độ trong bản vẽ và kích thước đã đo (hoặc ước lượng) của từng nút. */
export function graphBounds(def: DraftDefinition, sizes: (id: string) => Size | undefined): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of def.nodes) {
    const p = positionOf(def, n.id);
    const s = sizes(n.id) ?? estimateSize(n);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/** Mức thu nhỏ còn đọc được chữ trên nút. Sơ đồ rộng hơn thì không tự thu nhỏ thêm, người vẽ tự kéo hoặc bấm "Vừa khung". */
export const READABLE_ZOOM = 0.6;
/** Lề quanh sơ đồ khi đưa cả sơ đồ vào khung: trên chừa thanh công cụ, phải chừa nút dấu cộng. */
const FRAME = { top: 64, right: 60, bottom: 36, left: 36 };

/**
 * Khung nhìn hiện trọn sơ đồ ở mức còn đọc được (tối đa 100%). Trả null khi sơ đồ quá rộng so với khung vẽ.
 */
export function frameAll(box: Size, bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number; zoom: number } | null {
  const w = box.width - FRAME.left - FRAME.right;
  const h = box.height - FRAME.top - FRAME.bottom;
  if (w <= 0 || h <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const zoom = Math.min(w / bounds.width, h / bounds.height, 1);
  if (zoom < READABLE_ZOOM) return null;
  return {
    zoom,
    x: FRAME.left + (w - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: FRAME.top + (h - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}
