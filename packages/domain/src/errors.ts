import { z } from 'zod';

/**
 * Bảng mã lỗi dùng chung (SPEC 10.1). Mã ổn định, snake_case.
 * App không bao giờ hiện `detail`; app tra `code` trong packages/i18n. CI kiểm mỗi mã có chuỗi tiếng Việt.
 */
export const ERROR_CODES = {
  unauthenticated: 401,
  invalid_credentials: 401,
  device_revoked: 401,
  token_expired: 401,
  forbidden: 403,
  step_up_required: 403,
  /** vai trò bắt buộc TOTP (SPEC 11.2) mà chưa bật: máy chủ chỉ cho phép bật TOTP, xem hồ sơ và đăng xuất */
  mfa_required: 403,
  csrf_invalid: 403,
  not_found: 404,
  state_conflict: 409,
  request_in_progress: 409,
  nudge_throttled: 409,
  proposal_not_pending: 409,
  undo_window_closed: 409,
  proposal_expired: 410,
  precondition_failed: 412,
  input_invalid: 422,
  template_invalid: 422,
  batch_not_allowed: 422,
  idempotency_key_reuse: 422,
  idempotency_key_required: 422,
  account_locked: 423,
  app_update_required: 426,
  rate_limited: 429,
  quota_exceeded: 429,
  ai_disabled: 503,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

/** RFC 9457 Problem Details, thêm `code`, `requestId`, `errors[]`. */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  /** kèm theo nudge_throttled */
  nextAllowedAt: z.string().optional(),
  /** kèm theo state_conflict: trạng thái hiện tại của việc hoặc lượt chạy */
  currentState: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

/** Lỗi nghiệp vụ ném ở máy chủ, và cũng là lỗi client nhận về sau khi phân tích Problem. */
export class ApiError extends Error {
  readonly code: ErrorCode | (string & {});
  readonly status: number;
  readonly extra: Partial<Problem>;
  constructor(code: ErrorCode | (string & {}), extra: Partial<Problem> = {}, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = extra.status ?? (ERROR_CODES as Record<string, number>)[code] ?? 500;
    this.extra = extra;
  }
}
