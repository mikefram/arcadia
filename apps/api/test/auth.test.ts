import { closeDb, createActivation, forgetDeviceCache, generateSeedIds, runtimeFlags, schema, seedDemoOrg, setFakeNow, withOrg, type SeedIds } from '@mihato/backend';
import { newId } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

/**
 * Xác thực, thiết bị, phiên (SPEC 10.2, 10.11 điều 4, 11.2). Lớp xác thực hiện là lớp tạm chờ Q12;
 * các test này kiểm HỢP ĐỒNG ở mục 10.2, nên vẫn dùng được khi đổi thư viện.
 */
let app: FastifyInstance;
let ids: SeedIds;
let domain: string;
const PASSWORD = 'mat-khau-thu-2026';

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers: { 'content-type': 'application/json', ...headers } });

function cookiesOf(res: { cookies: { name: string; value: string }[] }) {
  const map = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  return { cookie: `mihato_session=${map.mihato_session}`, csrf: String(map.mihato_csrf) };
}

beforeAll(async () => {
  ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  domain = `auth-${tag}.test`;
  await seedDemoOrg(ids, { code: `auth-${tag}`, name: 'Tổ chức thử xác thực', emailDomain: domain, password: PASSWORD });
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
});
afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await closeDb();
});

describe('đăng nhập web', () => {
  it('đúng mật khẩu: đặt cookie phiên httpOnly, SameSite=Strict và cookie CSRF; yêu cầu ghi thiếu X-CSRF-Token bị từ chối', async () => {
    const res = await post('/v1/auth/login', { email: `lan@${domain}`, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const session = res.cookies.find((c) => c.name === 'mihato_session')!;
    expect(session.httpOnly).toBe(true);
    expect(String(session.sameSite).toLowerCase()).toBe('strict');
    const { cookie, csrf } = cookiesOf(res);

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().fullName).toBe('Nguyễn Thu Lan');

    const noCsrf = await app.inject({ method: 'PATCH', url: '/v1/me/prefs', headers: { cookie, 'idempotency-key': newId(), 'content-type': 'application/json' }, payload: { speechRate: 'slow' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('csrf_invalid');
    const ok = await app.inject({ method: 'PATCH', url: '/v1/me/prefs', headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': newId(), 'content-type': 'application/json' }, payload: { speechRate: 'slow' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().prefs.speechRate).toBe('slow');
    // PATCH chỉ áp khoá đã gửi: các khoá khác giữ mặc định, không bị ghi đè.
    expect(ok.json().prefs.fontScale).toBe('large');

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('mọi lỗi đăng nhập trả cùng một mã, không cho biết email có tồn tại hay không', async () => {
    const wrongPassword = await post('/v1/auth/login', { email: `hung@${domain}`, password: 'sai-mat-khau-0000' });
    const noSuchUser = await post('/v1/auth/login', { email: `khong-co@${domain}`, password: 'sai-mat-khau-0000' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(wrongPassword.json().code).toBe('invalid_credentials');
    expect(noSuchUser.json().code).toBe(wrongPassword.json().code);
  });

  it('khoá tạm 15 phút sau 5 lần sai liên tiếp', async () => {
    const email = `tuan@${domain}`;
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/login', { email, password: `sai-${i}-xxxxxxxxxx` })).statusCode).toBe(401);
    const locked = await post('/v1/auth/login', { email, password: PASSWORD });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().code).toBe('account_locked');
    setFakeNow(new Date(Date.now() + 16 * 60_000));
    expect((await post('/v1/auth/login', { email, password: PASSWORD })).statusCode).toBe(200);
    setFakeNow(null);
  });

  it('TOTP: bật xong thì đăng nhập trả mfaRequired và mfaToken; sai mã bị từ chối, đúng mã tạo phiên', async () => {
    const first = await post('/v1/auth/login', { email: `it@${domain}`, password: PASSWORD });
    expect(first.json().me.mfaRequired).toBe(true);
    const { cookie, csrf } = cookiesOf(first);
    const h = { cookie, 'x-csrf-token': csrf };
    const setup = await post('/v1/auth/totp/setup', {}, h);
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;
    expect((await post('/v1/auth/totp/enable', { code: '000000' }, h)).statusCode).toBe(422);
    expect((await post('/v1/auth/totp/enable', { code: authenticator.generate(secret) }, h)).statusCode).toBe(200);

    const login = await post('/v1/auth/login', { email: `it@${domain}`, password: PASSWORD });
    expect(login.json().mfaRequired).toBe(true);
    expect(login.cookies.find((c) => c.name === 'mihato_session')).toBeUndefined();
    const bad = await post('/v1/auth/mfa/verify', { mfaToken: login.json().mfaToken, code: '000000' });
    expect(bad.statusCode).toBe(401);
    const good = await post('/v1/auth/mfa/verify', { mfaToken: login.json().mfaToken, code: authenticator.generate(secret) });
    expect(good.statusCode).toBe(200);
    expect(good.json().me.mfaEnabled).toBe(true);
  });
});

describe('thiết bị: kích hoạt, làm mới, thu hồi', () => {
  const activate = async (code: keyof SeedIds['users']) => {
    const a = await withOrg(ids.ORG, (tx) => createActivation(tx, ids.ORG, ids.users[code], ids.users.U_IT));
    const res = await post('/v1/devices/activate', { activationToken: a.token, deviceName: 'Máy thử', platform: 'android' });
    return { activation: a, res };
  };

  it('mã kích hoạt dùng một lần; người điều hành nhận đường dẫn của app Chủ tịch', async () => {
    const { activation, res } = await activate('U_PHUONG');
    expect(res.statusCode).toBe(200);
    expect(activation.url.startsWith('mihato://activate')).toBe(true);
    const again = await post('/v1/devices/activate', { activationToken: activation.token, deviceName: 'Máy khác', platform: 'ios' });
    expect(again.statusCode).toBe(401);
    const chairman = await withOrg(ids.ORG, (tx) => createActivation(tx, ids.ORG, ids.users.U_CHAIRMAN, ids.users.U_IT));
    expect(chairman.url.startsWith('mihato-exec://activate')).toBe(true);
    const bearer = { authorization: `Bearer ${res.json().accessToken}` };
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer })).json().fullName).toBe('Đặng Mai Phương');
  });

  it('mã kích hoạt hết hạn sau 72 giờ', async () => {
    const a = await withOrg(ids.ORG, (tx) => createActivation(tx, ids.ORG, ids.users.U_HUNG, ids.users.U_IT));
    setFakeNow(new Date(Date.now() + 72 * 3_600_000 + 60_000));
    const res = await post('/v1/devices/activate', { activationToken: a.token, deviceName: 'Máy thử', platform: 'android' });
    setFakeNow(null);
    expect(res.statusCode).toBe(401);
  });

  it('access token hết hạn sau 15 phút: 401 token_expired; refresh xoay vòng; dùng lại refresh token cũ thì thu hồi cả thiết bị', async () => {
    const { res } = await activate('U_NGOCANH');
    const first = res.json() as { accessToken: string; refreshToken: string; device: { id: string } };
    const t0 = Date.now();
    setFakeNow(new Date(t0 + 16 * 60_000));
    const expired = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${first.accessToken}` } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('token_expired');

    const rotated = await post('/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json() as { accessToken: string; refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${second.accessToken}` } })).statusCode).toBe(200);

    // Kẻ lấy được refresh token cũ dùng lại: thu hồi cả thiết bị và ghi audit_log (SPEC 10.2).
    const reuse = await post('/v1/auth/refresh', { refreshToken: first.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('device_revoked');
    forgetDeviceCache();
    const after = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${second.accessToken}` } });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('device_revoked');
    expect((await post('/v1/auth/refresh', { refreshToken: second.refreshToken })).statusCode).toBe(401);
    const audits = await withOrg(ids.ORG, (tx) => tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'refresh_reuse')));
    expect(audits.some((a) => a.targetId === first.device.id)).toBe(true);
    setFakeNow(null);
  });

  it('it_admin thu hồi thiết bị: yêu cầu kế tiếp nhận 401 device_revoked sau khi bộ nhớ đệm 30 giây hết', async () => {
    const { res } = await activate('U_LAN2');
    const body = res.json() as { accessToken: string; device: { id: string } };
    const bearer = { authorization: `Bearer ${body.accessToken}` };
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer })).statusCode).toBe(200);

    const admin = cookiesOf(await post('/v1/auth/login', { email: `giamdoc@${domain}`, password: PASSWORD }));
    // Giám đốc không có quyền quản lý thiết bị.
    const denied = await post(`/v1/devices/${body.device.id}/revoke`, {}, { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'idempotency-key': newId() });
    expect(denied.statusCode).toBe(403);

    await withOrg(ids.ORG, (tx) => tx.update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, body.device.id)));
    // Trong 30 giây đệm, token cũ có thể còn dùng được; hết đệm thì bị từ chối (tổng không quá 1 phút, SPEC 10.2).
    forgetDeviceCache(body.device.id);
    const revoked = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe('device_revoked');
  });
});

describe('bắt buộc TOTP cho vai trò quản trị (SPEC 11.2, cờ ENFORCE_MFA)', () => {
  beforeAll(() => {
    runtimeFlags.enforceMfa = true;
  });
  afterAll(() => {
    runtimeFlags.enforceMfa = false;
  });

  it('office_admin chưa bật TOTP chỉ xem được hồ sơ, bật TOTP và đăng xuất; mọi route khác 403 mfa_required cho tới khi bật xong', async () => {
    const login = await post('/v1/auth/login', { email: `vanphong@${domain}`, password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const { cookie, csrf } = cookiesOf(login);
    const h = { cookie, 'x-csrf-token': csrf };

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().mfaRequired).toBe(true);
    expect(me.json().mfaEnforced).toBe(true);

    for (const url of ['/v1/overview', '/v1/runs', '/v1/steps', '/v1/notifications', '/v1/holidays?year=2026']) {
      const blocked = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(blocked.statusCode, url).toBe(403);
      expect(blocked.json().code, url).toBe('mfa_required');
    }
    const write = await post('/v1/nudges/drafts', { stepIds: [newId()] }, { ...h, 'idempotency-key': newId() });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe('mfa_required');

    const setup = await post('/v1/auth/totp/setup', {}, h);
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret as string;
    expect((await post('/v1/auth/totp/enable', { code: authenticator.generate(secret) }, h)).statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/v1/overview', headers: { cookie } });
    expect(after.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json().mfaRequired).toBe(false);
  });

  it('không ảnh hưởng nhân viên, Giám đốc, và thiết bị (app) của vai trò quản trị; Chủ tịch toàn quyền nên bị như vai quản trị khi dùng web', async () => {
    const employee = cookiesOf(await post('/v1/auth/login', { email: `lan@${domain}`, password: PASSWORD }));
    expect((await app.inject({ method: 'GET', url: '/v1/steps?assignee=me', headers: { cookie: employee.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: employee.cookie } })).json().mfaEnforced).toBe(true);

    const director = cookiesOf(await post('/v1/auth/login', { email: `giamdoc@${domain}`, password: PASSWORD }));
    expect((await app.inject({ method: 'GET', url: '/v1/overview', headers: { cookie: director.cookie } })).statusCode).toBe(200);

    // Chủ tịch giữ quyền quản trị cao nhất (docs/DECISIONS.md, 04/10/2026) nên phiên web chưa bật TOTP bị chặn như office_admin.
    const chair = cookiesOf(await post('/v1/auth/login', { email: `chutich@${domain}`, password: PASSWORD }));
    const chairBlocked = await app.inject({ method: 'GET', url: '/v1/overview', headers: { cookie: chair.cookie } });
    expect(chairBlocked.statusCode).toBe(403);
    expect(chairBlocked.json().code).toBe('mfa_required');
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: chair.cookie } })).json().mfaRequired).toBe(true);
    // App của Chủ tịch dùng thiết bị và PIN, không có TOTP: không bị chặn.
    const chairActivation = await withOrg(ids.ORG, (tx) => createActivation(tx, ids.ORG, ids.users.U_CHAIRMAN, ids.users.U_IT));
    const chairDevice = await post('/v1/devices/activate', { activationToken: chairActivation.token, deviceName: 'Máy Chủ tịch', platform: 'ios' });
    expect(chairDevice.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/overview', headers: { authorization: `Bearer ${chairDevice.json().accessToken}` } })).statusCode).toBe(200);

    // process_designer chưa bật TOTP bị chặn như office_admin; thiết bị của chính người này thì không (app không có TOTP).
    const designer = cookiesOf(await post('/v1/auth/login', { email: `thietke@${domain}`, password: PASSWORD }));
    const blocked = await app.inject({ method: 'GET', url: '/v1/templates', headers: { cookie: designer.cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('mfa_required');
    const activation = await withOrg(ids.ORG, (tx) => createActivation(tx, ids.ORG, ids.users.U_DESIGNER, ids.users.U_IT));
    const device = await post('/v1/devices/activate', { activationToken: activation.token, deviceName: 'Máy thử', platform: 'android' });
    expect(device.statusCode).toBe(200);
    const viaDevice = await app.inject({ method: 'GET', url: '/v1/templates', headers: { authorization: `Bearer ${device.json().accessToken}` } });
    expect(viaDevice.statusCode).toBe(200);
  });

  it('cờ tắt (mặc định ở phát triển và thử nghiệm): vai trò quản trị chưa bật TOTP vẫn dùng được', async () => {
    runtimeFlags.enforceMfa = false;
    try {
      const designer = cookiesOf(await post('/v1/auth/login', { email: `thietke@${domain}`, password: PASSWORD }));
      expect((await app.inject({ method: 'GET', url: '/v1/templates', headers: { cookie: designer.cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: designer.cookie } })).json().mfaEnforced).toBe(false);
    } finally {
      runtimeFlags.enforceMfa = true;
    }
  });
});
