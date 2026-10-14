import { fmt, vi } from '@mihato/i18n';
import { errorMessage, isApiError } from '@/lib/errors';

/** Logic thuần của hộp thoại Đặt lại TOTP. */

const t = vi.admin.org.users.totpReset;
const s = vi.admin.runs.myTasks.stepUp;

/** Nút "Đặt lại TOTP" chỉ hiện cho quản trị viên có quyền user.manage, ở người đã bật TOTP, và không bao giờ ở chính mình. */
export function canResetTotp(opts: { canManage: boolean; meId: string; user: { id: string; mfaEnabled: boolean } }): boolean {
  return opts.canManage && opts.user.id !== opts.meId && opts.user.mfaEnabled;
}

/** Ô xác nhận danh tính hợp lệ: mã gồm đúng 6 chữ số (khi quản trị viên đã bật TOTP) hoặc mật khẩu không rỗng. */
export function stepUpSecretError(secret: string, useTotp: boolean): string | null {
  if (useTotp) return /^\d{6}$/.test(secret.trim()) ? null : s.totpInvalid;
  return secret.length > 0 ? null : s.passwordRequired;
}

/** Câu báo lỗi của bước xác nhận lại danh tính (auth.stepUp). */
export function stepUpErrorMessage(err: unknown, useTotp: boolean): string {
  if (isApiError(err, 'invalid_credentials')) return useTotp ? s.wrongTotp : s.wrongPassword;
  if (isApiError(err, 'account_locked')) return t.locked;
  return errorMessage(err);
}

/** Lỗi của chính lần đặt lại: 403 forbidden (tự đặt cho mình hoặc thiếu quyền), 404, 423 khoá tài khoản, 429 quá nhanh. */
export function resetErrorMessage(err: unknown): string {
  if (isApiError(err, 'forbidden')) return t.forbidden;
  if (isApiError(err, 'not_found')) return t.notFound;
  if (isApiError(err, 'account_locked')) return t.locked;
  return errorMessage(err);
}

/** Mã nâng quyền thiếu hoặc hết hạn (403 step_up_required): phải hỏi lại. */
export function needsStepUp(err: unknown): boolean {
  return isApiError(err, 'step_up_required');
}

export function resetDoneMessage(name: string): string {
  return fmt(t.done, { tên: name });
}
