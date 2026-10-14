import { ApiError } from '@mihato/api-client';
import { vi } from '@mihato/i18n';

const t = vi.admin.shell.errors;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function lookup(table: unknown, code: string): string | null {
  if (!isRecord(table)) return null;
  const value = table[code];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Câu tiếng Việt của một mã lỗi: ưu tiên vi.errors.admin, rồi câu của khung, cuối cùng là câu chung. */
export function codeMessage(code: string): string {
  const errors: unknown = vi.errors;
  const admin = isRecord(errors) ? errors.admin : undefined;
  return lookup(admin, code) ?? lookup(t.byCode, code) ?? t.generic;
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

/** Các mã con (path, code) mà `input_invalid` hoặc `state_conflict` (ví dụ register_has_numbers) kèm theo; rỗng với lỗi khác. */
export function problemFields(err: unknown): { path: string; code: string }[] {
  return err instanceof ApiError && (err.code === 'input_invalid' || err.code === 'state_conflict') ? (err.extra.errors ?? []) : [];
}

/** Câu riêng của một mã con (ví dụ file_too_large), hoặc null khi bảng chưa có câu riêng cho mã đó. */
export function subCodeMessage(code: string): string | null {
  return code === 'input_invalid' ? null : lookup(t.byCode, code);
}

/**
 * Đổi lỗi bất kỳ thành câu tiếng Việt để hiện cho người dùng (SPEC 10.1).
 * KHÔNG bao giờ hiện `detail` hay `title` của máy chủ: chỉ tra theo `code`.
 * Lỗi `input_invalid` có mã con đã biết (tệp quá lớn, cần xuất tệp trước…) thì nói rõ bằng câu của mã con.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    for (const item of problemFields(err)) {
      const specific = subCodeMessage(item.code);
      if (specific) return specific;
    }
    return codeMessage(err.code);
  }
  // fetch ném TypeError khi không tới được máy chủ; AbortError khi huỷ yêu cầu.
  if (err instanceof TypeError) return t.network;
  return t.generic;
}

/** Thời điểm được nhắc lại, kèm theo lỗi nudge_throttled. */
export function nextAllowedAt(err: unknown): string | null {
  return err instanceof ApiError && typeof err.extra.nextAllowedAt === 'string' ? err.extra.nextAllowedAt : null;
}
