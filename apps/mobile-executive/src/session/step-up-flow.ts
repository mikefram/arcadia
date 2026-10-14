import { api, session, stepUpSigner } from '../services';
import { requestReauth } from './reauth';
import { StepUpUnsupportedError } from './step-up';

/**
 * Lấy mã nâng quyền sống 60 giây (SPEC 10.2) sau khi người dùng đã xác thực lại trên máy bằng sinh trắc học hoặc PIN:
 * xin thử thách, ký bằng khoá của thiết bị, đổi lấy `stepUpToken` để gửi ở header `X-Step-Up-Token`.
 */
export async function obtainStepUpToken(): Promise<string> {
  const deviceId = session.getSnapshot().deviceId;
  if (!deviceId || !stepUpSigner.supported) throw new StepUpUnsupportedError();
  const { challenge } = await api.call('auth.stepUpChallenge', {});
  const assertion = await stepUpSigner.sign(challenge);
  const { stepUpToken } = await api.call('auth.stepUp', { body: { deviceId, assertion } });
  return stepUpToken;
}

export type StepUpOutcome = { ok: true; token: string } | { ok: false; reason: 'cancelled' | 'unsupported' };

/**
 * Trọn một lần nâng quyền cho việc quan trọng (duyệt có số tiền, dừng lượt, ủy quyền): hỏi vân tay, khuôn mặt hoặc
 * PIN ngay trên máy, rồi mới ký thử thách. Máy không ký được thì báo rõ để màn hình nói "cần duyệt trên web".
 */
export async function stepUpWithReauth(title: string): Promise<StepUpOutcome> {
  if (!stepUpSigner.supported) return { ok: false, reason: 'unsupported' };
  if (!(await requestReauth(title))) return { ok: false, reason: 'cancelled' };
  try {
    return { ok: true, token: await obtainStepUpToken() };
  } catch (err) {
    if (err instanceof StepUpUnsupportedError) return { ok: false, reason: 'unsupported' };
    throw err;
  }
}
