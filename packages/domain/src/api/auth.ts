import { z } from 'zod';
import { IdSchema, InstantSchema, PlatformSchema } from '../enums';
import { DeviceViewSchema, MeSchema } from './org';

/** SPEC 10.2. Mọi phản hồi lỗi đăng nhập dùng cùng một mã, không cho biết email có tồn tại hay không (SPEC 11.2). */
export const LoginRequestSchema = z.object({
  /** mã tổ chức ('mihato', 'vrg'); bỏ trống khi email chỉ thuộc một tổ chức */
  org: z.string().optional(),
  email: z.email(),
  password: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  mfaRequired: z.boolean(),
  /** sống 5 phút; chỉ có khi mfaRequired */
  mfaToken: z.string().optional(),
  me: MeSchema.optional(),
});

export const MfaVerifySchema = z.object({ mfaToken: z.string(), code: z.string().regex(/^\d{6}$/) });

export const TotpSetupSchema = z.object({ secret: z.string(), otpauthUrl: z.string() });
export const TotpEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const PasswordSetSchema = z.object({
  token: z.string().min(20),
  /** tối thiểu 12 ký tự (SPEC 11.2) */
  password: z.string().min(12).max(200),
});

export const DeviceActivateSchema = z.object({
  activationToken: z.string().min(20),
  deviceName: z.string().max(80),
  platform: PlatformSchema,
  pushToken: z.string().optional(),
  /** khoá công khai của thiết bị (JWK, ES256) để ký assertion nâng quyền (SPEC 10.2, [GIẢ ĐỊNH] chờ Q16) */
  stepUpPublicKey: z.record(z.string(), z.unknown()).optional(),
});

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** hạn của access token */
  expiresAt: InstantSchema,
});

export const DeviceActivateResponseSchema = TokenPairSchema.extend({
  device: DeviceViewSchema,
  me: MeSchema,
});

export const RefreshRequestSchema = z.object({ refreshToken: z.string() });

/**
 * Nâng quyền (SPEC 10.2). App: thiết bị ký thử thách bằng khoá ES256 sau khi mở khoá sinh trắc học hoặc PIN
 * [GIẢ ĐỊNH, Q16]. Web: nhập lại mật khẩu hoặc mã TOTP (bổ sung ngoài SPEC để duyệt việc có tiền trên web).
 */
export const StepUpRequestSchema = z.union([
  z.object({ deviceId: IdSchema, assertion: z.string().min(1) }),
  z.object({ password: z.string().min(1) }),
  z.object({ totpCode: z.string().regex(/^\d{6}$/) }),
]);
export const StepUpResponseSchema = z.object({ stepUpToken: z.string(), expiresAt: InstantSchema });
export const StepUpChallengeSchema = z.object({ challenge: z.string(), expiresAt: InstantSchema });

export const PushTokenSchema = z.object({ pushToken: z.string().min(1) });
