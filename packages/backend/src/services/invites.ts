import { ApiError, type Honorific } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import type { EmailMessage, EmailProvider } from '@mihato/providers/email';
import { audit } from '../audit';
import { createPasswordLink } from '../auth/service';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import type { Tx } from '../db/client';
import { insertEffect } from '../engine/runner';
import { env } from '../env';

/**
 * Thư kích hoạt tài khoản: khi thêm người dùng có email (POST /v1/users, nhập CSV) hệ thống xếp một effect
 * `email.invite`; worker tạo đường dẫn đặt mật khẩu web (dùng một lần, 72 giờ) ĐÚNG LÚC GỬI rồi gửi thư qua
 * EmailProvider (Resend hoặc bản giả). Mã gốc của đường dẫn chỉ nằm trong thư, không nằm trong payload của effect
 * hay nhật ký. Gửi lỗi thì ném lỗi để giao dịch hoàn lại (không để lại mã chưa dùng) và hàng effect thử lại theo backoff.
 */

export const INVITE_EMAIL_EFFECT = 'email.invite';

export type InviteEmailPayload = { userId: string; reason: 'created' | 'resend' };

/** Xếp hàng gửi thư khi vừa tạo người dùng. Không có email thì không xếp (quản trị cấp đường dẫn tay như trước). */
export async function queueInviteEmailOnCreate(tx: Tx, orgId: string, user: { id: string; email: string | null }, actorUserId: string | null): Promise<boolean> {
  if (!user.email) return false;
  const payload: InviteEmailPayload = { userId: user.id, reason: 'created' };
  const queued = await insertEffect(tx, orgId, { kind: INVITE_EMAIL_EFFECT, dedupeKey: `${INVITE_EMAIL_EFFECT}:${user.id}:created`, payload });
  if (queued) await audit(tx, { orgId, action: 'invite_email_queued', actorUserId, targetType: 'user', targetId: user.id, detail: { reason: 'created' } });
  return queued;
}

/**
 * Quản trị bấm "Gửi lại": một thư mỗi phút cho mỗi người (khoá dedupe theo phút) để bấm nhiều lần không thành nhiều thư.
 * Người bị vô hiệu hoá thì 409; chưa có email thì lỗi trường `user.email`.
 */
export async function requeueInviteEmail(
  tx: Tx,
  orgId: string,
  user: { id: string; email: string | null; status: string },
  actor: { id: string; deviceId: string | null; ip?: string | null },
): Promise<{ queued: boolean }> {
  if (user.status === 'disabled') throw new ApiError('state_conflict', { currentState: 'disabled' });
  if (!user.email) throw new ApiError('input_invalid', { errors: [{ path: 'user.email', code: 'required' }] });
  const minute = Math.floor(clock.now().getTime() / 60_000);
  const payload: InviteEmailPayload = { userId: user.id, reason: 'resend' };
  const queued = await insertEffect(tx, orgId, { kind: INVITE_EMAIL_EFFECT, dedupeKey: `${INVITE_EMAIL_EFFECT}:${user.id}:resend:${minute}`, payload });
  if (queued) {
    await audit(tx, { orgId, action: 'invite_email_queued', actorUserId: actor.id, actorDeviceId: actor.deviceId, targetType: 'user', targetId: user.id, ip: actor.ip, detail: { reason: 'resend' } });
  }
  return { queued };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function nameWithHonorific(user: { fullName: string; honorific: string | null }): string {
  const label = user.honorific ? vi.common.honorific[user.honorific as Honorific] : '';
  return label ? `${label} ${user.fullName}` : user.fullName;
}

/** Dựng thư từ mẫu ở packages/i18n (CLAUDE.md luật 7). Xuất ra để test ảnh chụp và để kiểm không rò mã. */
export function composeInviteEmail(input: { to: string; orgName: string; recipient: { fullName: string; honorific: string | null }; url: string; expiresAt: Date }): EmailMessage {
  const t = vi.server.inviteEmail;
  const vars = { tên: nameWithHonorific(input.recipient), 'tổ chức': input.orgName, hạn: formatDateTime(input.expiresAt), web: env.webOrigin };
  const lines = [fmt(t.greeting, vars), '', fmt(t.intro, vars), '', fmt(t.action, vars), input.url, '', fmt(t.afterwards, vars), fmt(t.expired, vars), '', fmt(t.ignore, vars), '', fmt(t.signature, vars)];
  const p = (s: string) => `<p style="margin:0 0 12px">${escapeHtml(s)}</p>`;
  const html = [
    '<!doctype html><html lang="vi"><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">',
    p(fmt(t.greeting, vars)),
    p(fmt(t.intro, vars)),
    p(fmt(t.action, vars)),
    `<p style="margin:0 0 20px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-weight:bold">${escapeHtml(t.button)}</a></p>`,
    `<p style="margin:0 0 12px;font-size:13px;color:#555;word-break:break-all">${escapeHtml(input.url)}</p>`,
    p(fmt(t.afterwards, vars)),
    p(fmt(t.expired, vars)),
    p(fmt(t.ignore, vars)),
    `<p style="margin:24px 0 0;color:#555">${escapeHtml(fmt(t.signature, vars))}</p>`,
    '</body></html>',
  ].join('');
  return { to: input.to, subject: fmt(t.subject, vars), text: lines.join('\n'), html };
}

/**
 * Xử lý effect `email.invite` trong giao dịch của worker. Người đã bị vô hiệu hoá hoặc không còn email thì bỏ qua (done).
 * Lỗi gửi thì ném để giao dịch hoàn lại và hàng effect thử lại; thông điệp lỗi chỉ mang mã, không mang địa chỉ.
 */
export async function sendInviteEmail(tx: Tx, ctx: OrgContext, payload: Record<string, unknown>, email: EmailProvider): Promise<void> {
  const userId = String(payload.userId ?? '');
  const user = ctx.users.get(userId);
  if (!user || user.status === 'disabled' || !user.email) return;
  const link = await createPasswordLink(tx, null, ctx.orgId, user.id);
  const message = composeInviteEmail({ to: user.email, orgName: ctx.org.name, recipient: user, url: link.url, expiresAt: link.expiresAt });
  const result = await email.send(message);
  if (!result.ok) throw new Error(`invite_email_${result.error}:${(result.message ?? '').replace(/[^\w:. -]/g, '').slice(0, 80)}`);
  await audit(tx, { orgId: ctx.orgId, action: 'invite_email_sent', actorUserId: null, targetType: 'user', targetId: user.id, detail: { reason: String(payload.reason ?? 'created') } });
}
