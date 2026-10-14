import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { ApiError, type EmailSettingsPut, type EmailSettingsView } from '@mihato/domain';
import { FakeEmail, ResendEmail, type EmailProvider } from '@mihato/providers/email';
import { eq } from 'drizzle-orm';
import { audit } from '../audit';
import type { RequestMeta } from '../auth/service';
import { clock } from '../clock';
import { schema, type Tx } from '../db/client';
import { env } from '../env';
import type { Viewer } from '../views';

/**
 * Cấu hình gửi thư của tổ chức, đặt ở web quản trị thay cho biến môi trường. Biến môi trường (EMAIL_PROVIDER,
 * RESEND_API_KEY, EMAIL_FROM) chỉ còn là DỰ PHÒNG khi tổ chức chưa đặt gì.
 *
 * Khoá API là bí mật: lưu mã hoá AES-256-GCM (khoá dẫn xuất từ SECRETS_ENCRYPTION_KEY, hoặc từ AUTH_SECRET nếu không đặt),
 * gắn org_id làm dữ liệu xác thực kèm theo nên bản mã chép sang tổ chức khác không giải được. Không có đường nào đọc khoá ra
 * API, nhật ký hay báo lỗi; chỉ worker giải mã lúc gửi. Đổi khoá mã hoá thì khoá API đã lưu không giải được nữa và
 * quản trị nhập lại.
 */

const SECRETS_SALT = 'mihato-org-secrets-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: { source: string; key: Buffer } | null = null;
function encryptionKey(): Buffer {
  const source = env.secretsEncryptionKey || env.authSecret;
  if (cachedKey?.source !== source) {
    cachedKey = { source, key: Buffer.from(hkdfSync('sha256', source, SECRETS_SALT, 'org-email-settings', 32)) };
  }
  return cachedKey.key;
}

/** iv(12) + thẻ xác thực(16) + bản mã. */
export function encryptSecret(plain: string, orgId: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(orgId, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Trả null khi không giải được (sai khoá mã hoá, sai tổ chức, dữ liệu hỏng): bên gọi coi như chưa có khoá. */
export function decryptSecret(blob: Buffer, orgId: string): string | null {
  if (blob.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), blob.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(orgId, 'utf8'));
    decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** `thu@ten-mien.vn` hoặc `Tên hiển thị <thu@ten-mien.vn>`. */
const FROM_PATTERN = /^(?:[^<>\r\n]{1,100}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;
export const isValidFromAddress = (value: string): boolean => FROM_PATTERN.test(value.trim());

const fieldError = (path: string, code: string) => new ApiError('input_invalid', { errors: [{ path, code }] });
const fakeEmail = new FakeEmail();

/** Nhà cung cấp theo biến môi trường của máy chủ (dự phòng). Thiếu khoá thì rơi về bản giả, không ném lỗi. */
export function envEmailProvider(): EmailProvider {
  if (env.providers.email === 'resend' && env.resendApiKey && env.emailFrom) return new ResendEmail({ apiKey: env.resendApiKey, from: env.emailFrom });
  return fakeEmail;
}

type Source = EmailSettingsView['active'];

/** Ở production, bản giả không tính là cấu hình (thư sẽ biến mất mà người dùng tưởng đã gửi). */
const fakeAllowed = () => !env.isProd || env.allowFakeProviders;

async function loadRow(tx: Tx, orgId: string) {
  const [row] = await tx.select().from(schema.orgEmailSettings).where(eq(schema.orgEmailSettings.orgId, orgId));
  return row ?? null;
}

/** Chọn nhà cung cấp để gửi: cấu hình của tổ chức trước, rồi tới môi trường. null = chưa có cấu hình dùng được. */
export async function resolveEmailProvider(tx: Tx, orgId: string, fallback?: EmailProvider): Promise<{ provider: EmailProvider; source: Exclude<Source, 'none'> } | null> {
  const row = await loadRow(tx, orgId);
  if (row?.apiKeyEnc) {
    const apiKey = decryptSecret(row.apiKeyEnc, orgId);
    if (apiKey) return { provider: new ResendEmail({ apiKey, from: row.fromAddress }), source: 'org' };
  }
  const base = fallback ?? envEmailProvider();
  if (base instanceof FakeEmail) return fakeAllowed() ? { provider: base, source: 'fake' } : null;
  return { provider: base, source: 'env' };
}

function viewOf(row: Awaited<ReturnType<typeof loadRow>>, active: Source): EmailSettingsView {
  return {
    provider: 'resend',
    fromAddress: row?.fromAddress ?? '',
    hasApiKey: Boolean(row?.apiKeyEnc),
    apiKeyHint: row?.apiKeyHint ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    active,
  };
}

export async function getEmailSettings(tx: Tx, orgId: string): Promise<EmailSettingsView> {
  const row = await loadRow(tx, orgId);
  const resolved = await resolveEmailProvider(tx, orgId);
  return viewOf(row, resolved?.source ?? 'none');
}

/** Đặt cấu hình. Khoá bỏ trống thì giữ khoá cũ; chưa có khoá cũ thì bắt buộc nhập. Nhật ký chỉ ghi TÊN trường đã đổi. */
export async function putEmailSettings(tx: Tx, viewer: Viewer, body: EmailSettingsPut, meta: RequestMeta = {}): Promise<EmailSettingsView> {
  const fromAddress = (body.fromAddress ?? '').trim();
  if (!isValidFromAddress(fromAddress)) throw fieldError('body.fromAddress', 'invalid');
  const existing = await loadRow(tx, viewer.orgId);
  const apiKey = body.apiKey?.trim() || undefined;
  if (!apiKey && !existing?.apiKeyEnc) throw fieldError('body.apiKey', 'required');

  const values = {
    provider: body.provider ?? 'resend',
    fromAddress,
    ...(apiKey ? { apiKeyEnc: encryptSecret(apiKey, viewer.orgId), apiKeyHint: apiKey.slice(-4) } : {}),
    updatedBy: viewer.id,
    updatedAt: clock.now(),
  };
  await tx
    .insert(schema.orgEmailSettings)
    .values({ orgId: viewer.orgId, ...values })
    .onConflictDoUpdate({ target: schema.orgEmailSettings.orgId, set: values });

  const fields = [...(existing?.fromAddress === fromAddress ? [] : ['fromAddress']), ...(apiKey ? ['apiKey'] : [])];
  await audit(tx, { orgId: viewer.orgId, action: 'email_settings_changed', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'org', targetId: viewer.orgId, ip: meta.ip, detail: { fields } });
  return getEmailSettings(tx, viewer.orgId);
}

export async function clearEmailSettings(tx: Tx, viewer: Viewer, meta: RequestMeta = {}): Promise<EmailSettingsView> {
  const removed = await tx.delete(schema.orgEmailSettings).where(eq(schema.orgEmailSettings.orgId, viewer.orgId)).returning({ orgId: schema.orgEmailSettings.orgId });
  if (removed.length > 0) {
    await audit(tx, { orgId: viewer.orgId, action: 'email_settings_cleared', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'org', targetId: viewer.orgId, ip: meta.ip });
  }
  return getEmailSettings(tx, viewer.orgId);
}

/** Gửi thư thử bằng cấu hình đang dùng. Lỗi trả trong kết quả, không ném: quản trị cần thấy lý do ngay tại màn cài đặt. */
export async function sendTestEmail(tx: Tx, viewer: Viewer, to: string, meta: RequestMeta = {}): Promise<{ ok: boolean; error: 'not_configured' | 'transient' | 'permanent' | null }> {
  const resolved = await resolveEmailProvider(tx, viewer.orgId);
  let result: { ok: boolean; error: 'not_configured' | 'transient' | 'permanent' | null };
  if (!resolved) result = { ok: false, error: 'not_configured' };
  else {
    const sent = await resolved.provider.send({
      to,
      subject: 'Thư thử từ hệ thống điều hành công việc',
      text: 'Đây là thư thử. Nếu nhận được thư này thì cấu hình gửi thư đã dùng được.',
      html: '<p>Đây là thư thử. Nếu nhận được thư này thì cấu hình gửi thư đã dùng được.</p>',
    });
    result = sent.ok ? { ok: true, error: null } : { ok: false, error: sent.error };
  }
  await audit(tx, { orgId: viewer.orgId, action: 'email_test_sent', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'org', targetId: viewer.orgId, ip: meta.ip, detail: { ok: result.ok, error: result.error } });
  return result;
}
