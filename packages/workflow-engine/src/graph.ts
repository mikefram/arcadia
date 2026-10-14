import type { Edge, ProcessDefinition, ProcessNode, StepState } from '@mihato/domain';

/**
 * Đồ thị của một định nghĩa quy trình (SPEC 4.2), dựng một lần cho mỗi định nghĩa.
 *
 * "Cạnh quay lại" là cạnh `outcome: 'rejected'` trỏ về một nút đứng TRƯỚC nút duyệt (đích đi tới được
 * nút duyệt qua các cạnh không phải `rejected`). Đây là chu trình duy nhất được phép (vòng làm lại,
 * giai đoạn 3). Cạnh quay lại không tham gia điều kiện hợp nhánh của nút đích, nếu không nút đích
 * sẽ chờ mãi một nút duyệt đứng sau chính nó.
 */
export type Graph = {
  nodes: Map<string, ProcessNode>;
  /** thứ tự nút trong định nghĩa: mọi vòng lặp của engine đi theo thứ tự này để tất định */
  order: string[];
  /** mọi cạnh đi ra, kể cả cạnh quay lại */
  out: Map<string, Edge[]>;
  /** cạnh đến, KHÔNG gồm cạnh quay lại */
  incoming: Map<string, Edge[]>;
  /** cạnh đi ra, KHÔNG gồm cạnh quay lại */
  forwardOut: Map<string, Edge[]>;
  /** cạnh quay lại theo nút duyệt nguồn */
  backOut: Map<string, Edge[]>;
  backEdgeIds: Set<string>;
};

export type EdgeStatus = 'open' | 'done' | 'skipped';

const cache = new WeakMap<ProcessDefinition, Graph>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Tập nút đi tới được từ `from` (gồm cả `from`) theo bảng kề cho trước. */
export function reachable(from: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Các cạnh `rejected` trỏ về nút đứng trước nút duyệt. Dùng chung cho engine và validate(). */
export function findBackEdges(edges: readonly Edge[]): Set<string> {
  const nonRejected = new Map<string, string[]>();
  for (const e of edges) if (e.outcome !== 'rejected') push(nonRejected, e.from, e.to);
  const back = new Set<string>();
  for (const e of edges) {
    if (e.outcome !== 'rejected') continue;
    if (reachable(e.to, nonRejected).has(e.from)) back.add(e.id);
  }
  return back;
}

export function buildGraph(def: ProcessDefinition): Graph {
  const cached = cache.get(def);
  if (cached) return cached;

  const nodes = new Map<string, ProcessNode>();
  const order: string[] = [];
  for (const n of def.nodes) {
    if (nodes.has(n.id)) continue;
    nodes.set(n.id, n);
    order.push(n.id);
  }
  const edges = def.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  const backEdgeIds = findBackEdges(edges);

  const out = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const forwardOut = new Map<string, Edge[]>();
  const backOut = new Map<string, Edge[]>();
  for (const e of edges) {
    push(out, e.from, e);
    if (backEdgeIds.has(e.id)) {
      push(backOut, e.from, e);
    } else {
      push(incoming, e.to, e);
      push(forwardOut, e.from, e);
    }
  }
  const graph: Graph = { nodes, order, out, incoming, forwardOut, backOut, backEdgeIds };
  cache.set(def, graph);
  return graph;
}

/**
 * Trạng thái của một cạnh, dẫn xuất từ trạng thái lần thử mới nhất của nút nguồn (SPEC 4.2):
 * - nguồn `done`: cạnh xong. Nút duyệt: chỉ cạnh `approved` và cạnh không ghi outcome; cạnh `rejected` bị bỏ qua.
 *   Nút rẽ nhánh: chỉ nhánh được chọn (lưu ở `result.branch`), các nhánh khác bị bỏ qua.
 * - nguồn `rejected`: cạnh `rejected` xong, cạnh khác bị bỏ qua.
 * - nguồn `skipped` do rẽ nhánh: cạnh bị bỏ qua (lan truyền đường chết).
 * - nguồn `skipped` do Văn phòng cho qua (`result.skippedManually`): coi như nguồn đã xong để luồng đi tiếp
 *   [GIẢ ĐỊNH]: "cho qua có lý do" nghĩa là việc không cần làm nhưng quy trình vẫn tiếp tục.
 *   Việc bị cho qua khi còn `pending` (chưa tới lượt, `activatedAt` còn trống) thì cạnh ra vẫn mở cho tới khi
 *   luồng đi tới nó: engine ghi `activatedAt` lúc đó. Nhờ vậy việc đứng sau không chạy trước việc đứng trước.
 */
export function edgeStatus(edge: Edge, source: ProcessNode, sourceStep: StepState): EdgeStatus {
  const asDone = (): EdgeStatus => {
    if (source.type === 'approval') return edge.outcome === 'rejected' ? 'skipped' : 'done';
    if (source.type === 'condition') {
      const chosen = sourceStep.result?.['branch'];
      return (edge.branch ?? 'else') === chosen ? 'done' : 'skipped';
    }
    return 'done';
  };
  switch (sourceStep.state) {
    case 'done':
      return asDone();
    case 'rejected':
      return edge.outcome === 'rejected' ? 'done' : 'skipped';
    case 'skipped':
      if (!isManualSkip(sourceStep)) return 'skipped';
      return sourceStep.activatedAt !== null ? asDone() : 'open';
    default:
      return 'open';
  }
}

/** Việc được Văn phòng cho qua (SkipStep), khác với việc bị bỏ qua do rẽ nhánh. */
export function isManualSkip(step: StepState): boolean {
  return step.state === 'skipped' && step.result?.['skippedManually'] === true;
}

/** Các nút nằm trên mọi đường (không qua cạnh quay lại) từ `from` tới `to`, gồm cả hai đầu. */
export function nodesBetween(graph: Graph, from: string, to: string): Set<string> {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const [id, list] of graph.forwardOut) {
    for (const e of list) {
      push(forward, id, e.to);
      push(backward, e.to, id);
    }
  }
  const down = reachable(from, forward);
  const up = reachable(to, backward);
  const result = new Set<string>();
  for (const id of down) if (up.has(id)) result.add(id);
  return result;
}
