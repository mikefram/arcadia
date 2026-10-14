/** Thống kê nhỏ cho phép đo khử tiếng vọng. Hàm thuần, không phụ thuộc thư viện. */

export type Stats = { n: number; p50: number; p90: number; p95: number; max: number };

/**
 * Phân vị `p` (0 đến 100), nội suy tuyến tính giữa hai hạng gần nhất (cách mặc định của numpy).
 * `sorted` đã sắp tăng dần; rỗng thì trả NaN.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] ?? Number.NaN;
  const b = sorted[high] ?? Number.NaN;
  return a + (b - a) * (rank - low);
}

/** Tóm tắt một dãy mức âm. Bỏ giá trị không hữu hạn; không còn giá trị nào thì trả `null`. */
export function summarize(values: readonly number[]): Stats | null {
  const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (sorted.length === 0) return null;
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}
