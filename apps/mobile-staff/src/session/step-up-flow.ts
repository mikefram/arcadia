import { api, session, stepUpSigner } from '../services';
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
