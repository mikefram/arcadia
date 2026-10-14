import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Ban, Check, Circle, CircleDot, Flag, GitBranch, Hourglass, Mail, Play, SkipForward, Stamp, Timer, TriangleAlert, UserRoundX, Webhook, X, type LucideIcon } from 'lucide-react';
import type { NodeKind, RunDetail, StepStateName, StepView, TemplateVersion } from '@mihato/domain';
import { fmt, formatDate, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { personName } from '@/lib/person';

const t = vi.admin.runs.detail.diagram;

/** Định nghĩa của một phiên bản quy trình, đúng như `templates.version` trả về (nút ở dạng lỏng). */
type Definition = TemplateVersion['definition'];

/** Kích thước ô dùng khi tự xếp chỗ (định nghĩa không kèm `layout`). */
const COLUMN_GAP = 296;
const ROW_GAP = 140;

/** Màu vẽ cạnh: lấy đúng token của khung (primary, line). */
const EDGE_REACHED = '#1d5b43';
const EDGE_IDLE = '#6f6657';

type Tone = 'done' | 'late' | 'active' | 'ready' | 'unassigned' | 'pending' | 'rejected' | 'closed';

const STATE_ICON: Record<StepStateName, LucideIcon> = {
  pending: Hourglass,
  unassigned: UserRoundX,
  ready: Circle,
  in_progress: CircleDot,
  done: Check,
  rejected: X,
  skipped: SkipForward,
  cancelled: Ban,
};

function toneOf(state: StepStateName, isOverdue: boolean): Tone {
  if (isOverdue) return 'late';
  if (state === 'done') return 'done';
  if (state === 'in_progress') return 'active';
  if (state === 'ready') return 'ready';
  if (state === 'unassigned') return 'unassigned';
  if (state === 'rejected') return 'rejected';
  if (state === 'pending') return 'pending';
  return 'closed';
}

/** Khung của ô theo trạng thái. Mỗi trạng thái khác nhau cả ở chữ, hình và nét viền, không chỉ ở màu. */
const TONE_BOX: Record<Tone, string> = {
  done: 'border-primary/50 bg-primary-tint',
  late: 'border-late bg-late-bg',
  active: 'border-2 border-primary bg-surface',
  ready: 'border-line bg-surface',
  unassigned: 'border-warn bg-warn-bg',
  pending: 'border-dashed border-line bg-canvas',
  rejected: 'border-2 border-ink bg-surface',
  closed: 'border-dotted border-line bg-surface-alt',
};

const TONE_STATUS: Record<Tone, string> = {
  done: 'text-on-primary-tint',
  late: 'text-late',
  active: 'text-primary',
  ready: 'text-ink',
  unassigned: 'text-warn',
  pending: 'text-ink-sub',
  rejected: 'text-ink',
  closed: 'text-ink-sub',
};

type StepNodeData = {
  title: string;
  kind: 'task' | 'approval';
  state: StepStateName;
  step: StepView | null;
  onOpen: ((stepId: string) => void) | null;
};
type MarkNodeData = { label: string; kind: NodeKind; state: StepStateName };
type StepFlowNode = Node<StepNodeData, 'step'>;
type MarkFlowNode = Node<MarkNodeData, 'mark'>;

const hiddenHandle = 'size-px! min-h-0! min-w-0! border-0! bg-transparent! opacity-0';

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className={hiddenHandle} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={hiddenHandle} />
    </>
  );
}

function statusLabel(state: StepStateName, step: StepView | null): string {
  if (step?.isOverdue) return step.lateWorkingDays > 0 ? fmt(t.late, { n: step.lateWorkingDays }) : t.lateToday;
  return vi.common.stepState[state];
}

/** Ô của một việc hoặc một bước duyệt: dòng trạng thái (hình + chữ), tên việc, người nhận và hạn. */
function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step, state } = data;
  const tone = toneOf(state, step?.isOverdue ?? false);
  const Icon = step?.isOverdue ? TriangleAlert : STATE_ICON[state];
  const status = statusLabel(state, step);
  const meta = [step?.assignee ? personName(step.assignee, 'short') : null, step?.dueAt ? fmt(t.due, { ngày: formatDate(step.dueAt).slice(0, 5) }) : null].filter(Boolean).join(', ');

  const body = (
    <>
      <span className={cn('flex items-center gap-1.5 text-sm font-semibold', TONE_STATUS[tone])}>
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{status}</span>
        {data.kind === 'approval' ? <Stamp aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-gold" /> : null}
      </span>
      <span className={cn('mt-1 line-clamp-2 block leading-snug font-medium', tone === 'pending' || tone === 'closed' ? 'text-ink-sub' : 'text-ink')}>{data.title}</span>
      {meta ? <span className="mt-1 block truncate text-sm text-ink-sub">{meta}</span> : null}
    </>
  );
  // Cùng bề rộng với ô của trình thiết kế (224px) để toạ độ `layout` do trình thiết kế lưu không làm các ô chồng nhau.
  const box = cn('block w-[224px] rounded-xl border px-3 py-2.5 text-left text-base', TONE_BOX[tone]);

  return (
    <>
      <Handles />
      {step && data.onOpen ? (
        <button
          type="button"
          // `nodrag nopan`: bấm vào ô là mở chi tiết, không kéo sơ đồ.
          className={cn(box, 'nodrag nopan cursor-pointer transition-shadow hover:shadow-pop')}
          aria-label={fmt(t.openStep, { việc: data.title, 'trạng thái': status })}
          onClick={() => data.onOpen?.(step.id)}
        >
          {body}
        </button>
      ) : (
        <div className={box}>{body}</div>
      )}
    </>
  );
}

const MARK_ICON: Partial<Record<NodeKind, LucideIcon>> = { start: Play, end: Flag, condition: GitBranch, timer: Timer, notify: Mail, webhook: Webhook };

/** Ô không giao cho người: bắt đầu, hoàn tất, rẽ nhánh, hẹn giờ, thông báo. Ghi rõ đã tới hay chưa. */
function MarkNode({ data }: NodeProps<MarkFlowNode>) {
  const reached = data.state === 'done';
  const running = data.state === 'ready' || data.state === 'in_progress';
  const skipped = data.state === 'skipped' || data.state === 'cancelled';
  const Icon = MARK_ICON[data.kind] ?? Circle;
  const terminal = data.kind === 'start' || data.kind === 'end';
  const stateText = reached ? t.reached : running ? vi.common.stepState.in_progress : skipped ? vi.common.stepState[data.state] : t.notReached;
  return (
    <>
      <Handles />
      <div
        className={cn(
          'flex min-w-[124px] flex-col px-4 py-1.5 text-base',
          terminal ? 'rounded-full' : 'max-w-[176px] rounded-lg',
          reached ? 'border border-primary bg-primary text-on-primary' : running ? 'border-2 border-primary bg-surface text-ink' : 'border border-dashed border-line bg-canvas text-ink-sub',
        )}
      >
        <span className="flex items-center gap-1.5 font-semibold">
          {reached ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
          <span className="truncate">{data.label}</span>
        </span>
        <span className={cn('text-xs', reached ? 'text-on-primary/85' : 'text-ink-sub')}>{stateText}</span>
      </div>
    </>
  );
}

const NODE_TYPES = { step: StepNode, mark: MarkNode };

/**
 * Tự xếp chỗ khi định nghĩa không kèm `layout`: cột là quãng đường dài nhất tính từ nút bắt đầu
 * (quy trình không có vòng lặp, SPEC 4.2), hàng là thứ tự trong cột.
 */
function autoLayout(definition: Definition): Record<string, { x: number; y: number }> {
  const incoming = new Map<string, string[]>();
  for (const e of definition.edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  const depth = new Map<string, number>();
  const visit = (id: string, trail: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    trail.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length === 0 ? 0 : Math.max(...parents.map((p) => visit(p, trail))) + 1;
    trail.delete(id);
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const node of definition.nodes) {
    const column = visit(node.id, new Set());
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    out[node.id] = { x: column * COLUMN_GAP, y: row * ROW_GAP };
  }
  return out;
}

const ARIA_LABELS = {
  'controls.ariaLabel': t.title,
  'controls.zoomIn.ariaLabel': t.zoomIn,
  'controls.zoomOut.ariaLabel': t.zoomOut,
  'controls.fitView.ariaLabel': t.fit,
};

export type RunDiagramProps = {
  definition: Definition;
  nodeStates: RunDetail['nodeStates'];
  steps: readonly StepView[];
  /** bấm một việc trên sơ đồ để mở chi tiết */
  onOpenStep?: (stepId: string) => void;
};

/**
 * Sơ đồ quy trình chỉ đọc (React Flow), tô theo `nodeStates` của lượt chạy (SPEC 9.2).
 * Toạ độ lấy từ `definition.layout` do trình thiết kế lưu; thiếu thì tự xếp theo tầng.
 * Mỗi ô ghi trạng thái bằng chữ và hình; việc quá hạn dùng màu `late`.
 */
export default function RunDiagram({ definition, nodeStates, steps, onOpenStep }: RunDiagramProps) {
  const { nodes, edges } = useMemo(() => {
    const stepByNode = new Map(steps.map((s) => [s.nodeId, s]));
    const hasLayout = definition.nodes.every((n) => definition.layout?.[n.id]);
    const layout = hasLayout ? (definition.layout ?? {}) : autoLayout(definition);
    const stateOf = (id: string): StepStateName => nodeStates[id]?.state ?? 'pending';

    const flowNodes: (StepFlowNode | MarkFlowNode)[] = definition.nodes.map((n) => {
      const position = layout[n.id] ?? { x: 0, y: 0 };
      const base = { id: n.id, position, draggable: false, selectable: false, focusable: false };
      if (n.type === 'task' || n.type === 'approval') {
        const step = stepByNode.get(n.id) ?? null;
        const title = step?.title ?? (typeof n.title === 'string' && n.title ? n.title : n.label);
        return { ...base, type: 'step', data: { title, kind: n.type, state: stateOf(n.id), step, onOpen: onOpenStep ?? null } };
      }
      return { ...base, type: 'mark', data: { label: n.label || vi.common.nodeKind[n.type], kind: n.type, state: stateOf(n.id) } };
    });

    const branchLabels = new Map<string, string>();
    for (const n of definition.nodes) {
      if (!Array.isArray(n.branches)) continue;
      for (const b of n.branches as unknown[]) {
        if (typeof b !== 'object' || b === null) continue;
        const { id, label } = b as { id?: unknown; label?: unknown };
        if (typeof id === 'string') branchLabels.set(`${n.id}:${id}`, typeof label === 'string' && label ? label : id);
      }
    }

    const flowEdges: Edge[] = definition.edges.map((e) => {
      // Cạnh "đã đi qua": nút nguồn đã xong và nút đích đã tới lượt (không còn chờ, không bị bỏ qua).
      const target = stateOf(e.to);
      const passed = stateOf(e.from) === 'done' && target !== 'pending' && target !== 'skipped' && target !== 'cancelled';
      const color = passed ? EDGE_REACHED : EDGE_IDLE;
      const label =
        e.outcome === 'approved' ? t.outcomeApproved : e.outcome === 'rejected' ? t.outcomeRejected : e.branch === 'else' ? t.branchElse : e.branch ? branchLabels.get(`${e.from}:${e.branch}`) : undefined;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        focusable: false,
        selectable: false,
        label,
        labelStyle: { fill: '#4a423a', fontSize: 12, fontWeight: 500 },
        labelBgStyle: { fill: '#faf6ee' },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        style: { stroke: color, strokeWidth: passed ? 2 : 1.25, strokeDasharray: passed ? undefined : '5 4' },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      };
    });
    return { nodes: flowNodes, edges: flowEdges };
  }, [definition, nodeStates, steps, onOpenStep]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      ariaLabelConfig={ARIA_LABELS}
      className="bg-canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#ddd5c5" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
