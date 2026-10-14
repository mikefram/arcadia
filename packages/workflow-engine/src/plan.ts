import type { ProcessDefinition, WorkCalendar } from '@mihato/domain';
import { addDuration, computeDue } from '@mihato/domain/calendar';
import { evalExpr, exprRefs, parseRef } from './expr';
import { buildGraph } from './graph';

/**
 * Lịch dự kiến của một lượt chạy, dùng chung cho `simulate()` và phần cảnh báo của `validate()`.
 * Giả định: mỗi việc xong đúng hạn của nó (hạn đã qua lúc việc tới lượt thì coi như xong ngay lúc tới lượt),
 * nút duyệt được đồng ý, nút timer chờ đủ thời gian. Hàm thuần, không ghi gì.
 */
export type PlanRow = {
  nodeId: string;
  kind: 'task' | 'approval';
  title: string;
  /** lúc việc dự kiến tới lượt */
  activationAt: Date;
  dueAt: Date | null;
  /** việc đứng ngay trước (bỏ qua các nút hệ thống ở giữa) có hạn muộn nhất, và hạn đó */
  predecessorNodeId: string | null;
  predecessorDueAt: Date | null;
};

type Info = {
  skipped: boolean;
  /** lúc xong dự kiến (ms) */
  finish: number;
  lastDue: number | null;
  lastDueNode: string | null;
  /** nhánh nút rẽ nhánh sẽ chọn; null = chưa biết, coi như mọi nhánh đều có thể chạy */
  branch: string | null;
};

export function planSchedule(
  def: ProcessDefinition,
  opts: {
    now: Date;
    targetAt: Date | null;
    cal: WorkCalendar;
    /** biểu mẫu khởi chạy; null khi chưa có (validate): mọi nhánh rẽ đều được tính */
    inputs: Record<string, unknown> | null;
  },
): PlanRow[] {
  const graph = buildGraph(def);
  const nowMs = opts.now.getTime();
  const info = new Map<string, Info>();
  const rows: PlanRow[] = [];

  // Thứ tự tô-pô trên đồ thị không có cạnh quay lại; nút cùng bậc đi theo thứ tự trong định nghĩa.
  const indegree = new Map<string, number>();
  for (const id of graph.order) indegree.set(id, (graph.incoming.get(id) ?? []).length);
  const pending = new Set(graph.order);
  for (;;) {
    const nodeId = graph.order.find((id) => pending.has(id) && indegree.get(id) === 0);
    if (nodeId === undefined) break;
    pending.delete(nodeId);
    for (const e of graph.forwardOut.get(nodeId) ?? []) indegree.set(e.to, (indegree.get(e.to) ?? 1) - 1);

    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    if (node.type === 'start') {
      info.set(nodeId, { skipped: false, finish: nowMs, lastDue: null, lastDueNode: null, branch: null });
      continue;
    }

    // Các cạnh đến sẽ "xong" theo giả định của bản dự kiến.
    const live: Info[] = [];
    for (const e of graph.incoming.get(nodeId) ?? []) {
      const source = graph.nodes.get(e.from);
      const sourceInfo = info.get(e.from);
      if (!source || !sourceInfo || sourceInfo.skipped) continue;
      if (source.type === 'approval' && e.outcome === 'rejected') continue;
      if (source.type === 'condition' && sourceInfo.branch !== null && (e.branch ?? 'else') !== sourceInfo.branch) continue;
      live.push(sourceInfo);
    }
    if (live.length === 0) {
      info.set(nodeId, { skipped: true, finish: nowMs, lastDue: null, lastDueNode: null, branch: null });
      continue;
    }
    const any = (node.join ?? 'all') === 'any';
    let at = (live[0] as Info).finish;
    for (const s of live) at = any ? Math.min(at, s.finish) : Math.max(at, s.finish);
    let lastDue: number | null = null;
    let lastDueNode: string | null = null;
    for (const s of live) {
      if (any && s.finish !== at) continue;
      if (s.lastDue !== null && (lastDue === null || s.lastDue > lastDue)) {
        lastDue = s.lastDue;
        lastDueNode = s.lastDueNode;
      }
    }

    const next: Info = { skipped: false, finish: at, lastDue, lastDueNode, branch: null };
    if (node.type === 'task' || node.type === 'approval') {
      const due = computeDue(node.due, { activation: new Date(at), runStart: opts.now, runTarget: opts.targetAt }, opts.cal);
      rows.push({
        nodeId,
        kind: node.type,
        title: node.title,
        activationAt: new Date(at),
        dueAt: due,
        predecessorNodeId: lastDueNode,
        predecessorDueAt: lastDue === null ? null : new Date(lastDue),
      });
      if (due) {
        next.finish = Math.max(at, due.getTime());
        next.lastDue = due.getTime();
        next.lastDueNode = nodeId;
      }
    } else if (node.type === 'timer') {
      next.finish = Math.max(at, addDuration(new Date(at), node.wait, opts.cal).getTime());
    } else if (node.type === 'condition') {
      const inputs = opts.inputs;
      const dependsOnSteps = node.branches.some((b) => exprRefs(b.when).some((r) => parseRef(r)?.kind !== 'input'));
      if (inputs !== null && !dependsOnSteps) {
        const scope = { inputs, stepResult: () => null };
        next.branch = node.branches.find((b) => evalExpr(b.when, scope))?.id ?? 'else';
      }
    }
    info.set(nodeId, next);
  }
  return rows;
}
