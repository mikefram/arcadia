import { ApiError } from '@mihato/api-client';
import { vi } from '@mihato/i18n';

/**
 * Đổi lỗi bất kỳ thành câu tiếng Việt (SPEC 10.1). App KHÔNG BAO GIỜ hiện `detail` hay `title` của máy chủ:
 * chỉ tra `ApiError.code` trong `vi.errors.staff`.
 */
function lookup(code: string): string | null {
  const table: Record<string, string> = vi.errors.staff;
  const text = table[code];
  return typeof text === 'string' && text.length > 0 ? text : null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return lookup(err.code) ?? vi.errors.staff.internal_error;
  // `fetch` ném TypeError khi không tới được máy chủ.
  if (err instanceof TypeError) return vi.staff.feedback.network;
  return vi.errors.staff.internal_error;
}

export function codeMessage(code: string): string {
  if (code === 'network') return vi.staff.feedback.network;
  return lookup(code) ?? vi.errors.staff.internal_error;
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}
