import type { IdempotencyKeys } from './idempotency';

export type DelegationFlowDeps = {
  keys: IdempotencyKeys<'create'>;
  /** gửi `delegations.create` với khoá và mã nâng quyền (nếu có); ném ApiError khi máy chủ từ chối */
  call: (options: { idempotencyKey: string; stepUpToken?: string }) => Promise<void>;
  /** lỗi này có phải 403 `step_up_required` mà máy này ký được không */
  isStepUpRequired: (err: unknown) => boolean;
  /** xác thực lại trên máy (sinh trắc học hoặc PIN); false nếu người dùng bỏ */
  reauth: () => Promise<boolean>;
  obtainStepUpToken: () => Promise<string>;
};

/**
 * Tạo ủy quyền (S9). Vai điều hành tự ủy quyền phải có mã nâng quyền: lần đầu gửi không mã, nhận 403
 * `step_up_required`, xác thực lại rồi gửi lại. Máy chủ lưu cả phản hồi 403 theo `Idempotency-Key`, nên lần gửi
 * lại PHẢI dùng khoá mới, nếu không sẽ nhận lại đúng 403 cũ mãi mãi (rà soát 07/10/2026, staff-2).
 * Trả `cancelled` khi người dùng bỏ ở bước xác thực lại; các lỗi khác được ném lại.
 */
export async function createDelegationFlow(deps: DelegationFlowDeps): Promise<'created' | 'cancelled'> {
  const send = async (stepUpToken?: string): Promise<void> => {
    try {
      await deps.call({ idempotencyKey: deps.keys.get('create'), stepUpToken });
      deps.keys.settle('create', { ok: true });
    } catch (error) {
      deps.keys.settle('create', { ok: false, error });
      throw error;
    }
  };
  try {
    await send();
  } catch (err) {
    if (!deps.isStepUpRequired(err)) throw err;
    if (!(await deps.reauth())) return 'cancelled';
    await send(await deps.obtainStepUpToken());
  }
  return 'created';
}
