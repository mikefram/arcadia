import { getBezierPath, type Position } from '@xyflow/react';

/**
 * Đường đi của một đường nối trên sơ đồ. Bình thường là một đường cong mềm từ cổng ra tới cổng vào.
 * Khi đường thẳng giữa hai cổng đâm xuyên qua một nút khác (ví dụ nhánh "Còn lại" nối thẳng tới Hoàn tất,
 * băng qua bước duyệt nằm giữa), đường nối đi vòng lên trên hoặc xuống dưới nút đó, và nhãn đặt trên đoạn vòng
 * để không bị nút che.
 */
export type Rect = { x: number; y: number; width: number; height: number };
export type Route = { path: string; labelX: number; labelY: number };

/** Khoảng hở giữa đường vòng và nút bị tránh. */
const CLEARANCE = 26;
/** Lề coi như thuộc về nút khi xét đường nối có đâm vào nút không. */
const MARGIN = 10;

/** Đoạn thẳng (x1,y1)–(x2,y2) có cắt hình chữ nhật không (đã nới thêm lề). */
function segmentHits(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const left = r.x - MARGIN;
  const right = r.x + r.width + MARGIN;
  const top = r.y - MARGIN;
  const bottom = r.y + r.height + MARGIN;
  const from = Math.max(Math.min(x1, x2), left);
  const to = Math.min(Math.max(x1, x2), right);
  if (from > to) return false;
  if (x1 === x2) return Math.max(Math.min(y1, y2), top) <= Math.min(Math.max(y1, y2), bottom);
  const yAt = (x: number) => y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  const ya = yAt(from);
  const yb = yAt(to);
  return Math.max(Math.min(ya, yb), top) <= Math.min(Math.max(ya, yb), bottom);
}

export function routeEdge(
  ends: { sourceX: number; sourceY: number; targetX: number; targetY: number; sourcePosition: Position; targetPosition: Position },
  obstacles: readonly Rect[],
): Route {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = ends;
  const plain = (): Route => {
    const [path, labelX, labelY] = getBezierPath(ends);
    return { path, labelX, labelY };
  };
  // Chỉ đi vòng với đường nối đi tới (trái sang phải) và đủ dài; đường quay ngược giữ nguyên đường cong mặc định.
  if (tx - sx < 80) return plain();

  let blocking = obstacles.filter((r) => segmentHits(sx, sy, tx, ty, r));
  if (blocking.length === 0) return plain();

  let detourY = sy;
  let left = sx;
  let right = tx;
  // Đoạn vòng có thể lại gặp nút khác: gom thêm các nút đó rồi tính lại, tối đa vài lượt.
  for (let pass = 0; pass < 4; pass += 1) {
    const top = Math.min(...blocking.map((r) => r.y)) - CLEARANCE;
    const bottom = Math.max(...blocking.map((r) => r.y + r.height)) + CLEARANCE;
    const middle = (sy + ty) / 2;
    detourY = Math.abs(middle - top) <= Math.abs(middle - bottom) ? top : bottom;
    left = Math.max(Math.min(...blocking.map((r) => r.x)) - CLEARANCE, sx + 28);
    right = Math.min(Math.max(...blocking.map((r) => r.x + r.width)) + CLEARANCE, tx - 28);
    if (left > right) left = right = (left + right) / 2;
    const more = obstacles.filter((r) => !blocking.includes(r) && segmentHits(left, detourY, right, detourY, r));
    if (more.length === 0) break;
    blocking = [...blocking, ...more];
  }

  const bendIn = Math.max((left - sx) / 2, 16);
  const bendOut = Math.max((tx - right) / 2, 16);
  const path = [
    `M ${sx},${sy}`,
    `C ${sx + bendIn},${sy} ${left - bendIn},${detourY} ${left},${detourY}`,
    `L ${right},${detourY}`,
    `C ${right + bendOut},${detourY} ${tx - bendOut},${ty} ${tx},${ty}`,
  ].join(' ');
  return { path, labelX: (left + right) / 2, labelY: detourY };
}
