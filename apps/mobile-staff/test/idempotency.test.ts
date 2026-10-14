import { ApiError } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { createDelegationFlow } from '../src/features/delegation-flow';
import { IdempotencyKeys, shouldRotateKey } from '../src/features/idempotency';

const counter = () => {
  let n = 0;
  return () => `key-${++n}`;
};

describe('khoá chống lặp: giữ khi chưa có phản hồi, đổi khi máy chủ đã trả lời', () => {
  it('lỗi mạng và 5xx giữ khoá; thành công và mọi 4xx đổi khoá', () => {
    expect(shouldRotateKey({ ok: false, error: new TypeError('Network request failed') })).toBe(false);
    expect(shouldRotateKey({ ok: false, error: new ApiError('internal_error') })).toBe(false);
    expect(shouldRotateKey({ ok: true })).toBe(true);
    expect(shouldRotateKey({ ok: false, error: new ApiError('step_up_required') })).toBe(true);
    expect(shouldRotateKey({ ok: false, error: new ApiError('input_invalid') })).toBe(true);
    expect(shouldRotateKey({ ok: false, error: new ApiError('idempotency_key_reuse') })).toBe(true);
  });

  it('get trả cùng khoá cho tới khi settle đổi', () => {
    const keys = new IdempotencyKeys<'approve' | 'reject'>(counter());
    const first = keys.get('approve');
    expect(keys.get('approve')).toBe(first);
    expect(keys.settle('approve', { ok: false, error: new TypeError('x') })).toBe(false);
    expect(keys.get('approve')).toBe(first);
    expect(keys.settle('approve', { ok: false, error: new ApiError('input_invalid') })).toBe(true);
    expect(keys.get('approve')).not.toBe(first);
    // hai thao tác độc lập: đổi khoá "approve" không động tới "reject"
    expect(keys.get('reject')).not.toBe(keys.get('approve'));
  });

  it('kịch bản staff-4: gõ quá dài bị 400, sửa lại rồi gửi thì dùng khoá mới (không còn idempotency_key_reuse)', () => {
    const keys = new IdempotencyKeys<'approve'>(counter());
    const used: string[] = [];
    used.push(keys.get('approve'));
    keys.settle('approve', { ok: false, error: new ApiError('input_invalid') });
    used.push(keys.get('approve'));
    expect(new Set(used).size).toBe(2);
  });
});

describe('createDelegationFlow (staff-2)', () => {
  const stepUp = (err: unknown) => err instanceof ApiError && err.code === 'step_up_required';

  it('vai điều hành: 403 step_up_required rồi gửi lại bằng khoá KHÁC và có mã nâng quyền', async () => {
    const calls: Array<{ idempotencyKey: string; stepUpToken?: string }> = [];
    const result = await createDelegationFlow({
      keys: new IdempotencyKeys<'create'>(counter()),
      call: async (options) => {
        calls.push(options);
        if (!options.stepUpToken) throw new ApiError('step_up_required');
      },
      isStepUpRequired: stepUp,
      reauth: async () => true,
      obtainStepUpToken: async () => 'token-1',
    });
    expect(result).toBe('created');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.stepUpToken).toBeUndefined();
    expect(calls[1]?.stepUpToken).toBe('token-1');
    expect(calls[1]?.idempotencyKey).not.toBe(calls[0]?.idempotencyKey);
  });

  it('máy chủ lưu phản hồi theo khoá (như registrar): gửi lại cùng khoá sẽ nhận lại 403; khoá mới thì qua', async () => {
    const stored = new Map<string, ApiError>();
    const result = await createDelegationFlow({
      keys: new IdempotencyKeys<'create'>(counter()),
      call: async ({ idempotencyKey, stepUpToken }) => {
        const replay = stored.get(idempotencyKey);
        if (replay) throw replay;
        if (!stepUpToken) {
          const err = new ApiError('step_up_required');
          stored.set(idempotencyKey, err);
          throw err;
        }
      },
      isStepUpRequired: stepUp,
      reauth: async () => true,
      obtainStepUpToken: async () => 'token-1',
    });
    expect(result).toBe('created');
  });

  it('người dùng bỏ ở bước xác thực lại: không gửi lần hai', async () => {
    let calls = 0;
    const result = await createDelegationFlow({
      keys: new IdempotencyKeys<'create'>(counter()),
      call: async () => {
        calls += 1;
        throw new ApiError('step_up_required');
      },
      isStepUpRequired: stepUp,
      reauth: async () => false,
      obtainStepUpToken: async () => 'x',
    });
    expect(result).toBe('cancelled');
    expect(calls).toBe(1);
  });

  it('lỗi khác (không phải nâng quyền) được ném lại, khoá đổi nếu là 4xx và giữ nếu là mất mạng', async () => {
    const keys = new IdempotencyKeys<'create'>(counter());
    const first = keys.get('create');
    await expect(
      createDelegationFlow({ keys, call: async () => { throw new TypeError('offline'); }, isStepUpRequired: stepUp, reauth: async () => true, obtainStepUpToken: async () => 'x' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(keys.get('create')).toBe(first);
    await expect(
      createDelegationFlow({ keys, call: async () => { throw new ApiError('input_invalid'); }, isStepUpRequired: stepUp, reauth: async () => true, obtainStepUpToken: async () => 'x' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(keys.get('create')).not.toBe(first);
  });
});
