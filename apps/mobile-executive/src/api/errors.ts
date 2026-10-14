import { ApiError } from '@mihato/api-client';
import { fmtExecutive, vi } from '@mihato/i18n';

/**
 * Đổi lỗi bất kỳ thành câu tiếng Việt (SPEC 10.1, 7.2 điều 8). App KHÔNG BAO GIỜ hiện `detail` hay `title` của
 * máy chủ: chỉ tra `ApiError.code` trong `vi.errors.executive`. Lỗi luôn nhận về phía hệ thống và có bước tiếp theo.
 */
function lookup(code: string): string | null {
  const table: Record<string, string> = vi.errors.executive;
  const text = table[code];
  return typeof text === 'string' && text.length > 0 ? text : null;
}

export function errorMessage(err: unknown, address: string): string {
  if (err instanceof ApiError) return fmtExecutive(lookup(err.code) ?? vi.executive.status.failed, {}, address);
  // `fetch` ném TypeError khi không tới được máy chủ.
  if (err instanceof TypeError) return fmtExecutive(vi.executive.status.offlineAction, {}, address);
  return fmtExecutive(vi.executive.status.failed, {}, address);
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}
