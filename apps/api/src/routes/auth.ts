import { UserPrefsSchema } from '@mihato/domain';
import {
  activateDevice,
  buildMe,
  env,
  loadOrgContext,
  login,
  logout,
  resetTotp,
  refresh,
  schema,
  setPassword,
  stepUp,
  stepUpChallenge,
  totpEnable,
  totpSetup,
  verifyMfa,
  withOrg,
  type SessionGrant,
} from '@mihato/backend';
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { CSRF_COOKIE, SESSION_COOKIE, type Registrar } from '../registrar';

/** Cookie phiên httpOnly, Secure, SameSite=Strict; cookie CSRF đọc được bằng JS để gửi lại ở header (SPEC 10.1). */
function setSessionCookies(reply: FastifyReply, s: SessionGrant): void {
  const base = { path: '/', sameSite: 'strict' as const, secure: env.isProd, expires: s.expiresAt };
  reply.setCookie(SESSION_COOKIE, s.token, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, s.csrfToken, { ...base, httpOnly: false });
}

async function meOf(s: SessionGrant) {
  return withOrg(s.orgId, async (tx) => buildMe(await loadOrgContext(tx, s.orgId), s.userId));
}

/** SPEC 10.2: xác thực, thiết bị, hồ sơ. */
export function registerAuthRoutes(r: Registrar): void {
  r.open('auth.login', async ({ input, meta, reply }) => {
    const res = await login(input.body, meta);
    if (res.mfaRequired) return { mfaRequired: true, mfaToken: res.mfaToken };
    setSessionCookies(reply, res.session);
    return { mfaRequired: false, me: await meOf(res.session) };
  });

  r.open('auth.mfaVerify', async ({ input, meta, reply }) => {
    const session = await verifyMfa(input.body, meta);
    setSessionCookies(reply, session);
    return { mfaRequired: false, me: await meOf(session) };
  });

  r.user('auth.logout', async ({ viewer, meta, reply }) => {
    await logout(viewer, meta);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  r.open('auth.refresh', async ({ input, meta }) => refresh(input.body.refreshToken, meta));
  r.open('auth.passwordSet', async ({ input }) => {
    await setPassword(input.body);
    return { ok: true };
  });
  r.open('devices.activate', async ({ input, meta }) => activateDevice(input.body, meta));

  r.user('auth.stepUpChallenge', async ({ viewer }) => stepUpChallenge(viewer));
  r.user('auth.stepUp', async ({ tx, viewer, input, meta }) => stepUp(tx, viewer, input.body, meta));
  r.user('auth.totpSetup', async ({ tx, ctx, viewer }) => totpSetup(tx, ctx, viewer));
  r.user('auth.totpEnable', async ({ tx, viewer, input, meta }) => {
    await totpEnable(tx, viewer, input.body.code, meta);
    return { ok: true };
  });
  // Quản trị đặt lại TOTP cho người mất máy xác thực (quyền user.manage đã được registrar kiểm từ bảng hợp đồng).
  r.user('users.totpReset', async ({ tx, viewer, input, stepUpToken, meta }) => {
    await resetTotp(tx, viewer, input.params.id, stepUpToken, meta);
    return { ok: true };
  });

  r.user('me.get', async ({ ctx, viewer }) => buildMe(ctx, viewer.id));

  r.user('me.prefs', async ({ tx, ctx, viewer, input, rawBody }) => {
    const current = UserPrefsSchema.parse(ctx.users.get(viewer.id)?.prefs ?? {});
    // Chỉ áp các khoá người gọi thật sự gửi (Zod 4 điền mặc định cho khoá vắng mặt).
    const patch = Object.fromEntries(Object.entries(input.body).filter(([k]) => k in rawBody));
    const next = UserPrefsSchema.parse({ ...current, ...patch });
    await tx.update(schema.users).set({ prefs: next }).where(eq(schema.users.id, viewer.id));
    return buildMe(await loadOrgContext(tx, viewer.orgId), viewer.id);
  });

  r.user('me.pushTokenPut', async ({ tx, viewer, input }) => {
    if (viewer.deviceId) await tx.update(schema.devices).set({ pushToken: input.body.pushToken }).where(eq(schema.devices.id, viewer.deviceId));
    return { ok: true };
  });
  r.user('me.pushTokenDelete', async ({ tx, viewer }) => {
    if (viewer.deviceId) await tx.update(schema.devices).set({ pushToken: null }).where(eq(schema.devices.id, viewer.deviceId));
    return { ok: true };
  });
}
