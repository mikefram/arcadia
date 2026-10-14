import { ApiError, UserPrefsSchema, newId, type Action, type Me, type Platform, type RoleGrant } from '@mihato/domain';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { compactVerify, importJWK, type JWK } from 'jose';
import { authenticator } from 'otplib';
import { audit } from '../audit';
import { clock } from '../clock';
import { loadOrgContext, type OrgContext } from '../context';
import { schema, withOrg, withoutOrg, type Tx } from '../db/client';
import { env, runtimeFlags } from '../env';
import { loadEffectivePermissions } from '../permissions';
import type { Viewer } from '../views';
import { hashPassword, newOpaqueToken, orgOfToken, sha256, signToken, verifyPassword, verifyToken } from './crypto';

/** LỚP XÁC THỰC TẠM, chờ Q12 (xem auth/crypto.ts và docs/DECISIONS.md). Hợp đồng theo SPEC 10.2. */

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000;
export const MFA_TTL_S = 5 * 60;
export const STEP_UP_TTL_S = 60;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
/** vai trò dùng app Chủ tịch (SPEC 2.1): đường dẫn kích hoạt của họ mở app đó */
const EXECUTIVE_APP_ROLES = ['chairman', 'director', 'deputy'];
/** vai trò bắt buộc TOTP trên web (SPEC 11.2) */
// Thêm `chairman` ngoài ba vai của SPEC 11.2: Chủ tịch toàn quyền (docs/DECISIONS.md, 04/10/2026) nên tài khoản web của
// Chủ tịch giữ quyền quản trị cao nhất và không được yếu hơn các vai quản trị. Chỉ áp cho phiên web; app dùng thiết bị và PIN.
export const MFA_ROLES = ['chairman', 'it_admin', 'office_admin', 'process_designer'];

export type RequestMeta = { ip?: string | null; userAgent?: string | null };
export type SessionGrant = { token: string; csrfToken: string; expiresAt: Date; orgId: string; userId: string };

// ───────────────────────── Hồ sơ ─────────────────────────

export function buildMe(ctx: OrgContext, userId: string): Me {
  const u = ctx.users.get(userId);
  if (!u) throw new ApiError('unauthenticated');
  const now = clock.now();
  const activeDelegations = ctx.delegations
    .filter((d) => (d.fromUserId === userId || d.toUserId === userId) && d.validFrom <= now && d.validTo > now)
    .map((d) => ({
      id: d.id,
      fromUser: ctx.person(d.fromUserId)!,
      toUser: ctx.person(d.toUserId)!,
      validFrom: d.validFrom.toISOString(),
      validTo: d.validTo.toISOString(),
      scope: d.scope as 'all' | 'process' | 'role',
      scopeRef: d.scopeRef,
      active: true,
    }));
  const ai = ctx.settings.ai;
  return {
    id: u.id,
    orgId: ctx.orgId,
    orgCode: ctx.org.code,
    orgName: ctx.org.name,
    fullName: u.fullName,
    givenName: u.givenName,
    honorific: (u.honorific as Me['honorific']) ?? null,
    email: u.email,
    phone: u.phone,
    unitId: u.unitId,
    unitName: u.unitId ? (ctx.units.get(u.unitId)?.name ?? null) : null,
    isUnitHead: ctx.headedUnitIds(userId).size > 0,
    roles: u.roles,
    permissions: u.permissions,
    uiProfile: u.uiProfile as Me['uiProfile'],
    prefs: UserPrefsSchema.parse(u.prefs ?? {}),
    activeDelegations,
    officePhone: ctx.settings.officePhone,
    greeting: ctx.settings.greeting,
    calendar: { workdays: ctx.settings.workdays, workStart: ctx.settings.workStart, workEnd: ctx.settings.workEnd },
    ai: { enabled: ai.enabled, stt: ai.stt, llm: ai.llm, tts: ai.tts },
    mfaEnabled: u.totpEnabled,
    mfaRequired: !u.totpEnabled && u.roles.some((r) => MFA_ROLES.includes(r.role)),
    mfaEnforced: runtimeFlags.enforceMfa,
  };
}

async function loadViewer(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<{ id: string; unitId: string | null; roles: RoleGrant[]; permissions: Action[]; totpEnabled: boolean } | null> {
  const [u] = await tx
    .select({ id: schema.users.id, unitId: schema.users.unitId, status: schema.users.status, totpEnabled: schema.users.totpEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!u || u.status === 'disabled') return null;
  const roles = await tx.select({ role: schema.userRoles.role, unitId: schema.userRoles.unitId }).from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  void orgId;
  return { id: u.id, unitId: u.unitId, roles: roles as RoleGrant[], permissions: await loadEffectivePermissions(tx, u.id, roles as RoleGrant[]), totpEnabled: u.totpEnabled };
}

/**
 * Phiên web của vai trò bắt buộc TOTP (SPEC 11.2) mà chưa bật TOTP, khi cờ ENFORCE_MFA đang bật: chỉ được bật TOTP,
 * xem hồ sơ và đăng xuất. Mọi route khác (kể cả luồng SSE) trả 403 `mfa_required`.
 */
export function mfaPending(viewer: Pick<Viewer, 'via' | 'mfaEnrolled' | 'roles'>): boolean {
  return runtimeFlags.enforceMfa && viewer.via === 'cookie' && viewer.mfaEnrolled === false && viewer.roles.some((r) => MFA_ROLES.includes(r.role));
}

/** Route còn dùng được khi `mfaPending`. */
export const MFA_SETUP_ROUTES: ReadonlySet<string> = new Set(['me.get', 'auth.logout', 'auth.totpSetup', 'auth.totpEnable']);

// ───────────────────────── Web: mật khẩu, TOTP, phiên ─────────────────────────

export async function createSession(tx: Tx, orgId: string, userId: string, meta: RequestMeta): Promise<SessionGrant> {
  const token = newOpaqueToken(orgId);
  const csrfToken = newOpaqueToken(orgId).slice(37);
  const expiresAt = new Date(clock.now().getTime() + SESSION_TTL_MS);
  await tx.insert(schema.sessions).values({
    id: newId(),
    orgId,
    userId,
    tokenHash: sha256(token),
    csrfToken,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    createdAt: clock.now(),
  });
  return { token, csrfToken, expiresAt, orgId, userId };
}

export type LoginOutcome = { mfaRequired: true; mfaToken: string } | { mfaRequired: false; session: SessionGrant };

/**
 * Đếm sai và khoá tạm theo người dùng: dùng chung cho mật khẩu, TOTP lúc đăng nhập, nâng quyền và bật TOTP
 * (MAX_FAILED_LOGINS lần sai thì khoá LOCK_MS). Chạy trong giao dịch của người gọi, đã khoá dòng người dùng.
 */
async function bumpFailure(tx: Tx, u: { id: string; failedLogins: number }, now: Date): Promise<boolean> {
  const failed = u.failedLogins + 1;
  const lock = failed >= MAX_FAILED_LOGINS;
  await tx
    .update(schema.users)
    .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MS) : null })
    .where(eq(schema.users.id, u.id));
  return lock;
}

/**
 * Ghi một lần sai ở lượt xác thực lần hai (nâng quyền, bật TOTP) trong giao dịch RIÊNG: handler của route ném lỗi
 * làm giao dịch chính quay lui nên bộ đếm không được nằm trong đó.
 */
async function recordSecondFactorFailure(orgId: string, userId: string, action: string, meta: RequestMeta): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const [u] = await tx.select({ id: schema.users.id, failedLogins: schema.users.failedLogins }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
    if (!u) return;
    const locked = await bumpFailure(tx, u, clock.now());
    await audit(tx, { orgId, action, actorUserId: userId, targetType: 'user', targetId: userId, ip: meta.ip, userAgent: meta.userAgent, detail: locked ? { locked: true } : {} });
  });
}

/** Đang khoá tạm thì 423: chỉ dùng cho người đã qua mật khẩu (có phiên hoặc mfaToken), không lộ email có tồn tại. */
function assertNotLocked(u: { lockedUntil: Date | null }): void {
  if (u.lockedUntil && u.lockedUntil > clock.now()) throw new ApiError('account_locked');
}

/**
 * Mọi lỗi đăng nhập trả cùng một mã, không cho biết email có tồn tại hay không (SPEC 11.2). Tài khoản đang bị khoá
 * cũng trả invalid_credentials trừ khi mật khẩu ĐÚNG: kẻ dò chỉ nhận 423 khi đã biết mật khẩu, nên 423 không lộ email.
 */
export async function login(input: { email: string; password: string; org?: string }, meta: RequestMeta): Promise<LoginOutcome> {
  const candidates = await withoutOrg(async (tx) => {
    const res = await tx.execute<{ org_id: string; user_id: string }>(sql`select org_id, user_id from auth_find_login(${input.email}, ${input.org ?? null})`);
    return res.rows;
  });
  for (const c of candidates) {
    const outcome = await withOrg(c.org_id, async (tx): Promise<LoginOutcome | 'locked' | null> => {
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, c.user_id)).for('update');
      if (!u || u.status === 'disabled' || !u.passwordHash) return null;
      const now = clock.now();
      const isLocked = !!u.lockedUntil && u.lockedUntil > now;
      const ok = await verifyPassword(u.passwordHash, input.password);
      if (isLocked) {
        // Đang khoá: không đếm thêm, không kéo dài khoá; ghi vết để điều tra.
        await audit(tx, { orgId: c.org_id, action: 'login_failed', actorType: 'system', targetType: 'user', targetId: u.id, ip: meta.ip, userAgent: meta.userAgent, detail: { locked: true } });
        return ok ? 'locked' : null;
      }
      if (!ok) {
        await bumpFailure(tx, u, now);
        await audit(tx, { orgId: c.org_id, action: 'login_failed', actorType: 'system', targetType: 'user', targetId: u.id, ip: meta.ip, userAgent: meta.userAgent });
        return null;
      }
      if (u.totpEnabled) {
        // Chưa xoá bộ đếm: chỉ xoá khi qua cả TOTP, để kẻ biết mật khẩu không đặt lại bộ đếm sai TOTP bằng cách đăng nhập lại.
        const { token } = await signToken('mfa', { sub: u.id, org: c.org_id }, MFA_TTL_S);
        return { mfaRequired: true, mfaToken: token };
      }
      await tx.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, u.id));
      const session = await createSession(tx, c.org_id, u.id, meta);
      await audit(tx, { orgId: c.org_id, action: 'login', actorUserId: u.id, ip: meta.ip, userAgent: meta.userAgent });
      return { mfaRequired: false, session };
    });
    if (outcome === 'locked') throw new ApiError('account_locked');
    if (outcome) return outcome;
  }
  // Băm một mật khẩu giả để thời gian phản hồi không lộ việc email không tồn tại.
  if (candidates.length === 0) await hashPassword(input.password);
  throw new ApiError('invalid_credentials');
}

/** Sai TOTP đếm và khoá như sai mật khẩu (cùng failed_logins, locked_until); đúng mã thì xoá bộ đếm. */
export async function verifyMfa(input: { mfaToken: string; code: string }, meta: RequestMeta): Promise<SessionGrant> {
  const claims = await verifyToken('mfa', input.mfaToken);
  const orgId = String(claims.org);
  const userId = String(claims.sub);
  const res = await withOrg(orgId, async (tx): Promise<SessionGrant | 'invalid' | 'locked'> => {
    const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).for('update');
    if (!u || u.status === 'disabled' || !u.totpSecret) {
      await audit(tx, { orgId, action: 'login_failed', actorType: 'system', targetType: 'user', targetId: userId, ip: meta.ip, detail: { step: 'mfa' } });
      return 'invalid';
    }
    const now = clock.now();
    if (u.lockedUntil && u.lockedUntil > now) return 'locked';
    if (!authenticator.check(input.code, u.totpSecret)) {
      const locked = await bumpFailure(tx, u, now);
      await audit(tx, { orgId, action: 'login_failed', actorType: 'system', targetType: 'user', targetId: userId, ip: meta.ip, detail: locked ? { step: 'mfa', locked: true } : { step: 'mfa' } });
      return 'invalid';
    }
    await tx.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, userId));
    const session = await createSession(tx, orgId, userId, meta);
    await audit(tx, { orgId, action: 'login', actorUserId: userId, ip: meta.ip, userAgent: meta.userAgent, detail: { mfa: true } });
    return session;
  });
  // Ném sau khi giao dịch đã commit để bộ đếm sai và audit không bị hoàn lại.
  if (res === 'locked') throw new ApiError('account_locked');
  if (res === 'invalid') throw new ApiError('invalid_credentials');
  return res;
}

/** Xác thực cookie phiên. Yêu cầu ghi phải kèm X-CSRF-Token trùng với phiên (SPEC 10.1). */
export async function authenticateCookie(token: string, opts: { csrfHeader: string | undefined; isWrite: boolean }): Promise<Viewer> {
  const orgId = orgOfToken(token);
  if (!orgId) throw new ApiError('unauthenticated');
  return withOrg(orgId, async (tx) => {
    const [s] = await tx.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
    if (!s || s.revokedAt || s.expiresAt <= clock.now()) throw new ApiError('unauthenticated');
    if (opts.isWrite && opts.csrfHeader !== s.csrfToken) throw new ApiError('csrf_invalid');
    const v = await loadViewer(tx, orgId, s.userId);
    if (!v) throw new ApiError('unauthenticated');
    return { id: v.id, unitId: v.unitId, roles: v.roles, permissions: v.permissions, orgId, deviceId: null, sessionId: s.id, via: 'cookie', mfaEnrolled: v.totpEnabled };
  });
}

// Thu hồi có hiệu lực không quá 1 phút: mỗi yêu cầu kiểm devices.revoked_at qua bộ nhớ đệm sống tối đa 30 giây.
const deviceCache = new Map<string, { revoked: boolean; at: number }>();
const DEVICE_CACHE_MS = 30_000;

export function forgetDeviceCache(deviceId?: string): void {
  if (deviceId) deviceCache.delete(deviceId);
  else deviceCache.clear();
}

export async function authenticateBearer(token: string): Promise<Viewer> {
  const claims = await verifyToken('access', token);
  const orgId = String(claims.org);
  const userId = String(claims.sub);
  const deviceId = String(claims.did);
  const cached = deviceCache.get(deviceId);
  const fresh = cached && Date.now() - cached.at < DEVICE_CACHE_MS;
  if (fresh && cached.revoked) throw new ApiError('device_revoked');
  return withOrg(orgId, async (tx) => {
    if (!fresh) {
      const [d] = await tx.select({ revokedAt: schema.devices.revokedAt }).from(schema.devices).where(eq(schema.devices.id, deviceId));
      const revoked = !d || d.revokedAt !== null;
      deviceCache.set(deviceId, { revoked, at: Date.now() });
      if (revoked) throw new ApiError('device_revoked');
      await tx.update(schema.devices).set({ lastSeenAt: clock.now() }).where(eq(schema.devices.id, deviceId));
    }
    const v = await loadViewer(tx, orgId, userId);
    if (!v) throw new ApiError('device_revoked');
    return { id: v.id, unitId: v.unitId, roles: v.roles, permissions: v.permissions, orgId, deviceId, sessionId: null, via: 'bearer' };
  });
}

export async function logout(viewer: Viewer, meta: RequestMeta): Promise<void> {
  await withOrg(viewer.orgId, async (tx) => {
    if (viewer.sessionId) await tx.update(schema.sessions).set({ revokedAt: clock.now() }).where(eq(schema.sessions.id, viewer.sessionId));
    if (viewer.deviceId) {
      await tx.update(schema.devices).set({ revokedAt: clock.now(), pushToken: null }).where(eq(schema.devices.id, viewer.deviceId));
      forgetDeviceCache(viewer.deviceId);
    }
    await audit(tx, { orgId: viewer.orgId, action: 'logout', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, ip: meta.ip });
  });
}

export async function totpSetup(tx: Tx, ctx: OrgContext, viewer: Viewer): Promise<{ secret: string; otpauthUrl: string }> {
  const u = ctx.users.get(viewer.id);
  if (!u) throw new ApiError('unauthenticated');
  if (u.totpEnabled) throw new ApiError('state_conflict');
  const secret = authenticator.generateSecret();
  await tx.update(schema.users).set({ totpSecret: secret }).where(eq(schema.users.id, viewer.id));
  return { secret, otpauthUrl: authenticator.keyuri(u.email ?? u.fullName, `Điều hành ${ctx.org.name}`, secret) };
}

export async function totpEnable(tx: Tx, viewer: Viewer, code: string, meta: RequestMeta = {}): Promise<void> {
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, viewer.id));
  if (!u) throw new ApiError('unauthenticated');
  assertNotLocked(u);
  if (!u.totpSecret || !authenticator.check(code, u.totpSecret)) {
    await recordSecondFactorFailure(viewer.orgId, viewer.id, 'totp_enable_failed', meta);
    throw new ApiError('input_invalid', { errors: [{ path: 'code', code: 'totp_mismatch' }] });
  }
  await tx.update(schema.users).set({ totpEnabled: true, failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, viewer.id));
  await audit(tx, { orgId: viewer.orgId, action: 'mfa_enabled', actorUserId: viewer.id });
}

/**
 * Quản trị đặt lại TOTP cho người mất máy xác thực (SPEC 11.2): tắt TOTP, xoá khoá bí mật, thu hồi phiên web của
 * người đó. Người đó phải bật lại ở lần đăng nhập kế (ENFORCE_MFA). Cần nâng quyền và không tự đặt lại cho mình.
 * audit_log không chứa khoá bí mật.
 */
export async function resetTotp(tx: Tx, viewer: Viewer, targetUserId: string, stepUpToken: string | undefined, meta: RequestMeta = {}): Promise<void> {
  await requireStepUp(viewer, stepUpToken);
  if (targetUserId === viewer.id) throw new ApiError('forbidden');
  const [u] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, targetUserId)).for('update');
  if (!u) throw new ApiError('not_found');
  await tx.update(schema.users).set({ totpEnabled: false, totpSecret: null }).where(eq(schema.users.id, targetUserId));
  const revoked = await revokeUserSessions(tx, targetUserId);
  await audit(tx, { orgId: viewer.orgId, action: 'mfa_reset', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'user', targetId: targetUserId, ip: meta.ip, userAgent: meta.userAgent, detail: { sessionsRevoked: revoked } });
}

/** Thu hồi mọi phiên web còn hiệu lực của một người. Trả số phiên đã thu hồi. */
async function revokeUserSessions(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .update(schema.sessions)
    .set({ revokedAt: clock.now() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
    .returning({ id: schema.sessions.id });
  return rows.length;
}

export async function createPasswordLink(tx: Tx, viewer: Viewer | null, orgId: string, userId: string): Promise<{ url: string; token: string; expiresAt: Date }> {
  const token = newOpaqueToken(orgId);
  const expiresAt = new Date(clock.now().getTime() + ACTIVATION_TTL_MS);
  await tx.insert(schema.passwordTokens).values({ id: newId(), orgId, userId, tokenHash: sha256(token), expiresAt, createdBy: viewer?.id ?? null, createdAt: clock.now() });
  return { url: `${env.webOrigin}/dat-mat-khau?token=${encodeURIComponent(token)}`, token, expiresAt };
}

export async function setPassword(input: { token: string; password: string }): Promise<void> {
  const orgId = orgOfToken(input.token);
  if (!orgId) throw new ApiError('invalid_credentials');
  await withOrg(orgId, async (tx) => {
    const [t] = await tx
      .select()
      .from(schema.passwordTokens)
      .where(and(eq(schema.passwordTokens.tokenHash, sha256(input.token)), isNull(schema.passwordTokens.usedAt), gt(schema.passwordTokens.expiresAt, clock.now())))
      .for('update');
    if (!t) throw new ApiError('invalid_credentials');
    await tx.update(schema.passwordTokens).set({ usedAt: clock.now() }).where(eq(schema.passwordTokens.id, t.id));
    await tx
      .update(schema.users)
      .set({ passwordHash: await hashPassword(input.password), failedLogins: 0, lockedUntil: null, status: sql`CASE WHEN ${schema.users.status} = 'invited' THEN 'active' ELSE ${schema.users.status} END` })
      .where(eq(schema.users.id, t.userId));
    // Đổi mật khẩu phải thu hồi phiên web cũ: người đặt lại vì nghi bị chiếm tài khoản không thể để phiên của kẻ chiếm sống tiếp.
    // Thiết bị của app không phụ thuộc mật khẩu (kích hoạt bằng mã một lần) nên giữ nguyên; thu hồi riêng bằng devices.revoke.
    const revoked = await revokeUserSessions(tx, t.userId);
    await audit(tx, { orgId, action: 'password_set', actorUserId: t.userId, detail: { sessionsRevoked: revoked } });
  });
}

// ───────────────────────── App: kích hoạt thiết bị, token, nâng quyền ─────────────────────────

export async function createActivation(
  tx: Tx,
  orgId: string,
  userId: string,
  createdBy: string,
  app?: 'staff' | 'executive',
): Promise<{ url: string; qrPayload: string; token: string; expiresAt: Date }> {
  const token = newOpaqueToken(orgId);
  const expiresAt = new Date(clock.now().getTime() + ACTIVATION_TTL_MS);
  await tx.insert(schema.activationTokens).values({ id: newId(), orgId, userId, tokenHash: sha256(token), expiresAt, createdBy, createdAt: clock.now() });
  await audit(tx, { orgId, action: 'activation_created', actorUserId: createdBy, targetType: 'user', targetId: userId });
  // Hai app riêng (SPEC 1.1 quyết định 6): người điều hành kích hoạt app Chủ tịch, người khác kích hoạt app nhân viên.
  const roles = await tx.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  // Giám đốc, Phó giám đốc cũng có thể dùng app nhân viên (SPEC 8.6 điều 4): quản trị chọn `app` khi cấp máy.
  const executive = app ? app === 'executive' : roles.some((r) => EXECUTIVE_APP_ROLES.includes(r.role));
  const scheme = executive ? `${env.appScheme}-exec` : env.appScheme;
  const url = `${scheme}://activate?token=${encodeURIComponent(token)}&api=${encodeURIComponent(env.publicApiUrl)}`;
  return { url, qrPayload: url, token, expiresAt };
}

async function issueTokenPair(tx: Tx, orgId: string, userId: string, deviceId: string) {
  const access = await signToken('access', { sub: userId, org: orgId, did: deviceId }, ACCESS_TTL_S);
  const refreshToken = newOpaqueToken(orgId);
  await tx.insert(schema.refreshTokens).values({
    id: newId(),
    orgId,
    deviceId,
    userId,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(clock.now().getTime() + REFRESH_TTL_MS),
    createdAt: clock.now(),
  });
  return { accessToken: access.token, refreshToken, expiresAt: access.expiresAt.toISOString() };
}

export async function activateDevice(
  input: { activationToken: string; deviceName: string; platform: Platform; pushToken?: string; stepUpPublicKey?: Record<string, unknown> },
  meta: RequestMeta,
) {
  const orgId = orgOfToken(input.activationToken);
  if (!orgId) throw new ApiError('invalid_credentials');
  return withOrg(orgId, async (tx) => {
    const [t] = await tx
      .select()
      .from(schema.activationTokens)
      .where(and(eq(schema.activationTokens.tokenHash, sha256(input.activationToken)), isNull(schema.activationTokens.usedAt), gt(schema.activationTokens.expiresAt, clock.now())))
      .for('update');
    if (!t) throw new ApiError('invalid_credentials');
    const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, t.userId));
    if (!u || u.status === 'disabled') throw new ApiError('invalid_credentials');
    await tx.update(schema.activationTokens).set({ usedAt: clock.now() }).where(eq(schema.activationTokens.id, t.id));
    const deviceId = newId();
    const now = clock.now();
    await tx.insert(schema.devices).values({
      id: deviceId,
      orgId,
      userId: u.id,
      platform: input.platform,
      name: input.deviceName,
      pushToken: input.pushToken ?? null,
      stepUpPublicKey: input.stepUpPublicKey ?? null,
      enrolledAt: now,
      lastSeenAt: now,
    });
    if (u.status === 'invited') await tx.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, u.id));
    await audit(tx, { orgId, action: 'device_activated', actorUserId: u.id, actorDeviceId: deviceId, ip: meta.ip, userAgent: meta.userAgent, detail: { platform: input.platform } });
    const tokens = await issueTokenPair(tx, orgId, u.id, deviceId);
    const ctx = await loadOrgContext(tx, orgId);
    return {
      ...tokens,
      device: {
        id: deviceId,
        userId: u.id,
        userName: u.fullName,
        platform: input.platform,
        name: input.deviceName,
        hasPushToken: !!input.pushToken,
        enrolledAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        revokedAt: null,
      },
      me: buildMe(ctx, u.id),
    };
  });
}

/** Xoay vòng refresh token. Dùng lại một token cũ thì thu hồi cả thiết bị và ghi audit_log (SPEC 10.2). */
export async function refresh(refreshToken: string, meta: RequestMeta) {
  const orgId = orgOfToken(refreshToken);
  if (!orgId) throw new ApiError('unauthenticated');
  const result = await withOrg(orgId, async (tx) => {
    const [t] = await tx.select().from(schema.refreshTokens).where(eq(schema.refreshTokens.tokenHash, sha256(refreshToken))).for('update');
    if (!t || t.expiresAt <= clock.now()) return { error: 'unauthenticated' as const };
    const [d] = await tx.select().from(schema.devices).where(eq(schema.devices.id, t.deviceId));
    if (!d || d.revokedAt) return { error: 'device_revoked' as const };
    if (t.usedAt) {
      await tx.update(schema.devices).set({ revokedAt: clock.now(), pushToken: null }).where(eq(schema.devices.id, t.deviceId));
      await audit(tx, { orgId, action: 'refresh_reuse', actorType: 'system', actorDeviceId: t.deviceId, targetType: 'device', targetId: t.deviceId, ip: meta.ip });
      forgetDeviceCache(t.deviceId);
      return { error: 'device_revoked' as const };
    }
    const [u] = await tx.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, t.userId));
    if (!u || u.status === 'disabled') return { error: 'device_revoked' as const };
    await tx.update(schema.refreshTokens).set({ usedAt: clock.now() }).where(eq(schema.refreshTokens.id, t.id));
    return { tokens: await issueTokenPair(tx, orgId, t.userId, t.deviceId) };
  });
  // Ném lỗi sau khi giao dịch đã commit để việc thu hồi thiết bị không bị hoàn lại.
  if ('error' in result) throw new ApiError(result.error!);
  return result.tokens;
}

export async function revokeDevice(tx: Tx, viewer: Viewer, deviceId: string, meta: RequestMeta): Promise<void> {
  const rows = await tx
    .update(schema.devices)
    .set({ revokedAt: clock.now(), pushToken: null })
    .where(and(eq(schema.devices.id, deviceId), isNull(schema.devices.revokedAt)))
    .returning({ id: schema.devices.id });
  if (rows.length === 0) {
    const [d] = await tx.select({ id: schema.devices.id }).from(schema.devices).where(eq(schema.devices.id, deviceId));
    if (!d) throw new ApiError('not_found');
    return;
  }
  forgetDeviceCache(deviceId);
  await audit(tx, { orgId: viewer.orgId, action: 'device_revoked', actorUserId: viewer.id, targetType: 'device', targetId: deviceId, ip: meta.ip });
}

export async function stepUpChallenge(viewer: Viewer): Promise<{ challenge: string; expiresAt: string }> {
  const { token, expiresAt } = await signToken('stepup-challenge', { sub: viewer.id, org: viewer.orgId, did: viewer.deviceId ?? undefined, nonce: newId() }, STEP_UP_TTL_S);
  return { challenge: token, expiresAt: expiresAt.toISOString() };
}

/**
 * Đổi bằng chứng vừa mở khoá lấy stepUpToken sống 60 giây, gắn với người dùng (và thiết bị).
 * App: `assertion` là JWS dạng compact (ES256) do thiết bị ký trên chuỗi thử thách, kiểm bằng khoá công khai
 * đã đăng ký lúc kích hoạt [GIẢ ĐỊNH, Q16]. Web: mật khẩu hoặc mã TOTP.
 */
export async function stepUp(
  tx: Tx,
  viewer: Viewer,
  body: { deviceId: string; assertion: string } | { password: string } | { totpCode: string },
  meta: RequestMeta = {},
): Promise<{ stepUpToken: string; expiresAt: string }> {
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, viewer.id));
  if (!u) throw new ApiError('unauthenticated');
  // Mật khẩu và TOTP dò được nên đếm sai và khoá tạm như đăng nhập; assertion ES256 của thiết bị không dò được.
  const guessable = !('assertion' in body);
  if (guessable) assertNotLocked(u);
  let ok = false;
  if ('assertion' in body) {
    if (viewer.deviceId !== body.deviceId) throw new ApiError('forbidden');
    const [d] = await tx.select().from(schema.devices).where(eq(schema.devices.id, body.deviceId));
    if (!d || d.revokedAt) throw new ApiError('device_revoked');
    if (d.stepUpPublicKey) {
      try {
        const keyLike = await importJWK(d.stepUpPublicKey as JWK, 'ES256');
        const { payload } = await compactVerify(body.assertion, keyLike, { algorithms: ['ES256'] });
        const challenge = new TextDecoder().decode(payload);
        const claims = await verifyToken('stepup-challenge', challenge);
        ok = claims.sub === viewer.id && claims.did === viewer.deviceId;
      } catch {
        ok = false;
      }
    }
  } else if ('password' in body) {
    ok = !!u.passwordHash && (await verifyPassword(u.passwordHash, body.password));
  } else {
    ok = !!u.totpSecret && u.totpEnabled && authenticator.check(body.totpCode, u.totpSecret);
  }
  if (!ok) {
    if (guessable) await recordSecondFactorFailure(viewer.orgId, viewer.id, 'step_up_failed', meta);
    throw new ApiError('step_up_required');
  }
  if (guessable && u.failedLogins > 0) await tx.update(schema.users).set({ failedLogins: 0 }).where(eq(schema.users.id, viewer.id));
  const { token, expiresAt } = await signToken('stepup', { sub: viewer.id, org: viewer.orgId, did: viewer.deviceId ?? undefined }, STEP_UP_TTL_S);
  await audit(tx, { orgId: viewer.orgId, action: 'step_up_issued', actorUserId: viewer.id, actorDeviceId: viewer.deviceId });
  return { stepUpToken: token, expiresAt: expiresAt.toISOString() };
}

/** Kiểm X-Step-Up-Token: thiếu, hết hạn hoặc của người khác thì 403 step_up_required. */
export async function requireStepUp(viewer: Viewer, headerToken: string | undefined): Promise<void> {
  if (!headerToken) throw new ApiError('step_up_required');
  const claims = await verifyToken('stepup', headerToken);
  if (claims.sub !== viewer.id || (claims.did ?? null) !== (viewer.deviceId ?? null)) throw new ApiError('step_up_required');
}
