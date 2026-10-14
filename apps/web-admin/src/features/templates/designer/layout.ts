import dagre from '@dagrejs/dagre';
import type { DraftDefinition } from '@mihato/domain';
import { edgeLabel, estimateSize, type Size, type XY } from './model';

/**
 * Tự sắp xếp theo chiều ngang (SPEC 9.3) bằng dagre: Bắt đầu ở trái, Hoàn tất ở phải, các nhánh song song xếp dọc.
 * Trả toạ độ góc trên trái của từng nút để ghi vào `definition.layout`.
 *
 * Mỗi bước được đặt ở cột sớm nhất có thể (ngay sau bước đứng trước nó), như cách người ta vẫn vẽ quy trình.
 * Bộ xếp hạng 'longest-path' của dagre lại đẩy nút về phía cuối, nên ở đây dựng đồ thị ĐẢO chiều rồi vẽ từ phải sang trái:
 * "muộn nhất về phía Bắt đầu" trên đồ thị đảo chính là "sớm nhất" trên đồ thị thật.
 */
export function autoLayout(def: DraftDefinition, sizes: (id: string) => Size | undefined): Record<string, XY> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'RL', ranker: 'longest-path', nodesep: 28, ranksep: 72, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of def.nodes) {
    const size = sizes(n.id) ?? estimateSize(n);
    g.setNode(n.id, { width: size.width, height: size.height });
  }
  const ids = new Set(def.nodes.map((n) => n.id));
  const forward = new Map<string, string[]>();
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (forward.get(from) ?? []).some((next) => reaches(next, to, seen));
  };
  const usable = def.edges.filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to));
  // Đường "Chưa đồng ý" xét sau cùng: nếu nó quay ngược về một bước đứng trước (vòng làm lại) thì bỏ qua,
  // để nó không kéo lệch thứ tự các cột.
  for (const e of [...usable.filter((x) => x.outcome !== 'rejected'), ...usable.filter((x) => x.outcome === 'rejected')]) {
    if (e.outcome === 'rejected' && reaches(e.to, e.from)) continue;
    forward.set(e.from, [...(forward.get(e.from) ?? []), e.to]);
    // Đường nối có nhãn (Đồng ý, tên nhánh…) cần thêm chỗ giữa hai cột để nhãn không đè lên nút.
    const label = edgeLabel(def, e);
    if (label) g.setEdge(e.to, e.from, { width: Math.min(160, 18 + label.length * 6.5), height: 22, labelpos: 'c' });
    else g.setEdge(e.to, e.from);
  }
  dagre.layout(g);

  const out: Record<string, XY> = {};
  let minX = Infinity;
  let minY = Infinity;
  for (const n of def.nodes) {
    const p = g.node(n.id);
    const size = sizes(n.id) ?? estimateSize(n);
    const x = p.x - size.width / 2;
    const y = p.y - size.height / 2;
    out[n.id] = { x, y };
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  for (const id of Object.keys(out)) {
    const p = out[id] as XY;
    out[id] = { x: Math.round(p.x - minX), y: Math.round(p.y - minY) };
  }
  return out;
}

/**
 * Bản vẽ thiếu toạ độ (tạo qua API, hoặc bản cũ) được xếp bằng dagre với kích thước ước lượng; nút đã có toạ độ thì giữ nguyên.
 * Bản vẽ đã đủ toạ độ thì trả lại đúng đối tượng cũ.
 */
export function ensureLayout(def: DraftDefinition): DraftDefinition {
  if (def.nodes.every((n) => def.layout?.[n.id])) return def;
  return { ...def, layout: { ...autoLayout(def, () => undefined), ...(def.layout ?? {}) } };
}
