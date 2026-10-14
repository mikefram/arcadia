/**
 * Điều gì được ghi xuống máy (SPEC 7.8): CHỈ bản tiến độ gần nhất (M4, M5 và thẻ số tổng quan) để xem khi mất mạng.
 * Việc cần quyết (có số tiền), đề xuất, bản tin, hồ sơ và mọi thứ của hội thoại KHÔNG được lưu.
 * Tệp thuần TypeScript để test được.
 */

/** Khoá đầu của các truy vấn tiến độ. */
export const PROGRESS_KEY = 'progress';

export function shouldPersistQuery(query: { queryKey: readonly unknown[]; state: { status: string } }): boolean {
  return query.queryKey[0] === PROGRESS_KEY && query.state.status === 'success';
}
