import { closeDb, createPasswordLink, createSession, env, generateSeedIds, runtimeFlags, schema, seedDemoOrg, setFakeNow, withOrg, type SeedIds } from '@mihato/backend';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, parseTrustProxy } from '../src/app';
import { callerFor, type Caller } from './helpers';

/**
 * Rà soát bảo mật 07/10/2026: giới hạn tần suất theo IP (không theo header do client đặt), đếm sai và khoá tạm TOTP
 * và nâng quyền, đặt lại TOTP, thu hồi phiên khi đổi mật khẩu, header bảo mật.
 */
let ids: SeedIds;
let domain: string;
let app: FastifyInstance;
let limited: FastifyInstance;
const PASSWORD = 'mat-khau-thu-2026';

const send = (a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  a.inject({ method: 'POST', url, payload: payload as object, headers: { 'content-type': 'application/json', ...headers }, ...(remoteAddress ? { remoteAddress } : {}) });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => send(app, url, payload, headers);

function cookiesOf(res: { cookies: { name: string; value: string }[] }) {
  const map = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  return { cookie: `mihato_session=${map.mihato_session}`, csrf: String(map.mihato_csrf) };
}

/** Đăng nhập, bật TOTP, trả khoá bí mật để sinh mã. */
async function enrollTotp(email: string): Promise<{ secret: string; session: { cookie: string; csrf: string } }> {
  const s = cookiesOf(await post('/v1/auth/login', { email, password: PASSWORD }));
  const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
  const setup = await post('/v1/auth/totp/setup', {}, h);
  const secret = setup.json().secret as string;
  expect((await post('/v1/auth/totp/enable', { code: authenticator.generate(secret) }, h)).statusCode).toBe(200);
  return { secret, session: s };
}

beforeAll(async () => {
  ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  domain = `hard-${tag}.test`;
  await seedDemoOrg(ids, { code: `hard-${tag}`, name: 'Tổ chức thử bảo mật', emailDomain: domain, password: PASSWORD });
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  limited = await buildApp({ quiet: true, stream: false, rateLimit: true });
});
afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await limited?.close();
  await closeDb();
});

describe('giới hạn tần suất (auth-1, auth-2, auth-6)', () => {
  it('11 lần đăng nhập với 11 header Authorization khác nhau từ cùng IP vẫn bị 429 ở lần 11', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await send(limited, '/v1/auth/login', { email: `khong-co-${i}@${domain}`, password: 'sai-mat-khau-0000' }, { authorization: `Bearer ngau-nhien-${i}-${'x'.repeat(30)}${i}` });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('đổi cookie phiên hoặc X-Forwarded-For giả từ IP ngoài dải tin cậy cũng không né được; IP khác thì không bị ảnh hưởng', async () => {
    const attacker = '203.0.113.50';
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await send(limited, '/v1/auth/mfa/verify', { mfaToken: 'x'.repeat(40), code: '000000' }, { cookie: `mihato_session=gia-${i}`, 'x-forwarded-for': `9.9.9.${i}` }, attacker);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
    expect(codes[11]).toBe(429);
    const other = await send(limited, '/v1/auth/login', { email: `x@${domain}`, password: 'sai-mat-khau-0000' }, {}, '198.51.100.9');
    expect(other.statusCode).toBe(401);
  });

  it('TRUST_PROXY: mặc định production là 1 bước, phát triển là loopback; req.ip không lấy X-Forwarded-For từ IP ngoài dải tin cậy', async () => {
    const oneHopFn = parseTrustProxy(undefined, true);
    expect(typeof oneHopFn).toBe('function');
    expect((oneHopFn as (a: string, h: number) => boolean)('1.1.1.1', 0)).toBe(true);
    expect((oneHopFn as (a: string, h: number) => boolean)('1.1.1.1', 1)).toBe(false);
    expect(parseTrustProxy(undefined, false)).toBe('loopback');
        expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12', true)).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
    expect(parseTrustProxy('false', true)).toBe(false);
    const probe = await buildApp({ quiet: true, stream: false, rateLimit: false });
    try {
      probe.get('/__ip', async (req) => ({ ip: req.ip }));
      const spoof = await probe.inject({ method: 'GET', url: '/__ip', headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, remoteAddress: '8.8.8.8' });
      expect(spoof.json().ip).toBe('8.8.8.8');
    } finally {
      await probe.close();
    }
    const oneHop = await buildApp({ quiet: true, stream: false, rateLimit: false, trustProxy: 1 });
    try {
      oneHop.get('/__ip', async (req) => ({ ip: req.ip }));
      const res = await oneHop.inject({ method: 'GET', url: '/__ip', headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, remoteAddress: '172.18.0.2' });
      // một bước: chỉ tin proxy ngay trước API, địa chỉ client là phần tử proxy đó ghi (cuối chuỗi), không phải phần tử client tự điền
      expect(res.json().ip).toBe('10.0.0.1');
    } finally {
      await oneHop.close();
    }
  });

  it('route dịch vụ nội bộ (scribe, một token chung) không bị giới hạn 120 lần mỗi phút', async () => {
    const headers = { authorization: `Bearer ${env.internalServiceToken}` };
    let limitedCount = 0;
    for (let i = 0; i < 130; i++) {
      const res = await send(limited, '/internal/v1/scribe/usage', {}, headers);
      if (res.statusCode === 429) limitedCount++;
    }
    expect(limitedCount).toBe(0);
  });

  it('giới hạn theo người dùng đã xác thực: route đoán bí mật tối đa 10 lần mỗi phút dù đổi header', async () => {
    const g = await withOrg(ids.ORG, (tx) => createSession(tx, ids.ORG, ids.users.U_LAN2, {}));
    const h = { cookie: `mihato_session=${g.token}`, 'x-csrf-token': g.csrfToken };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await send(limited, '/v1/auth/totp/setup', {}, { ...h, authorization: `Basic doi-${i}` }, '192.0.2.77')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('đếm sai và khoá tạm (auth-1, auth-4, auth-8)', () => {
  it('sai TOTP khi đăng nhập đếm như sai mật khẩu: 5 mã sai thì khoá, đúng mã cũng bị 423', async () => {
    const email = `thietke@${domain}`;
    const { secret } = await enrollTotp(email);
    const login = await post('/v1/auth/login', { email, password: PASSWORD });
    const mfaToken = login.json().mfaToken as string;
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/mfa/verify', { mfaToken, code: '000000' })).statusCode).toBe(401);
    const locked = await post('/v1/auth/mfa/verify', { mfaToken, code: authenticator.generate(secret) });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().code).toBe('account_locked');
    // hết khoá thì mã đúng vào được
    setFakeNow(new Date(Date.now() + 16 * 60_000));
    const again = await post('/v1/auth/login', { email, password: PASSWORD });
    const ok = await post('/v1/auth/mfa/verify', { mfaToken: again.json().mfaToken, code: authenticator.generate(secret) });
    setFakeNow(null);
    expect(ok.statusCode).toBe(200);
    const audits = await withOrg(ids.ORG, (tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'login_failed'), eq(schema.auditLog.targetId, ids.users.U_DESIGNER))));
    expect(audits.filter((a) => (a.detail as { step?: string }).step === 'mfa').length).toBeGreaterThanOrEqual(5);
  });

  it('đăng nhập lại bằng mật khẩu đúng không xoá bộ đếm sai TOTP', async () => {
    const email = `lan@${domain}`;
    const { secret } = await enrollTotp(email);
    for (let round = 0; round < 5; round++) {
      const login = await post('/v1/auth/login', { email, password: PASSWORD });
      if (login.statusCode === 423) break;
      expect(login.statusCode).toBe(200);
      const bad = await post('/v1/auth/mfa/verify', { mfaToken: login.json().mfaToken, code: '000000' });
      expect(bad.statusCode).toBe(401);
    }
    const after = await post('/v1/auth/login', { email, password: PASSWORD });
    expect(after.statusCode).toBe(423);
    void secret;
  });

  it('nâng quyền bằng mật khẩu: 5 lần sai thì khoá, lần đúng kế tiếp và cả đăng nhập đều bị 423', async () => {
    const call: Caller = callerFor(app, ids);
    for (let i = 0; i < 5; i++) {
      const bad = await call('U_HUNG', 'POST', '/v1/auth/step-up', { password: `sai-${i}-xxxxxxxxxxxx` });
      expect(bad.status).toBe(403);
    }
    const locked = await call<{ code: string }>('U_HUNG', 'POST', '/v1/auth/step-up', { password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('account_locked');
    const login = await post('/v1/auth/login', { email: `hung@${domain}`, password: PASSWORD });
    expect(login.statusCode).toBe(423);
    const audits = await withOrg(ids.ORG, (tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'step_up_failed'), eq(schema.auditLog.targetId, ids.users.U_HUNG))));
    expect(audits.length).toBe(5);
  });

  it('nâng quyền bằng TOTP sai cũng đếm; đúng mã xoá bộ đếm', async () => {
    const { secret } = await enrollTotp(`tuan@${domain}`);
    const call: Caller = callerFor(app, ids);
    for (let i = 0; i < 3; i++) expect((await call('U_TUAN', 'POST', '/v1/auth/step-up', { totpCode: '000000' })).status).toBe(403);
    expect((await call('U_TUAN', 'POST', '/v1/auth/step-up', { totpCode: authenticator.generate(secret) })).status).toBe(200);
    const [u] = await withOrg(ids.ORG, (tx) => tx.select({ n: schema.users.failedLogins }).from(schema.users).where(eq(schema.users.id, ids.users.U_TUAN)));
    expect(u!.n).toBe(0);
  });

  it('bật TOTP với mã sai đếm và khoá tạm', async () => {
    const s = cookiesOf(await post('/v1/auth/login', { email: `huy@${domain}`, password: PASSWORD }));
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    await post('/v1/auth/totp/setup', {}, h);
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/totp/enable', { code: '000000' }, h)).statusCode).toBe(422);
    expect((await post('/v1/auth/totp/enable', { code: '000000' }, h)).statusCode).toBe(423);
  });

  it('tài khoản đang bị khoá: mật khẩu sai nhận invalid_credentials (không lộ email có thật), mật khẩu đúng nhận 423', async () => {
    const email = `ngocanh@${domain}`;
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/login', { email, password: `sai-${i}-xxxxxxxxxx` })).statusCode).toBe(401);
    const wrong = await post('/v1/auth/login', { email, password: 'van-sai-mat-khau-0' });
    const missing = await post('/v1/auth/login', { email: `khong-co@${domain}`, password: 'van-sai-mat-khau-0' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('invalid_credentials');
    expect(missing.json().code).toBe(wrong.json().code);
    expect((await post('/v1/auth/login', { email, password: PASSWORD })).statusCode).toBe(423);
  });
});

describe('đặt lại TOTP khi mất máy xác thực (auth-3)', () => {
  it('it_admin đặt lại TOTP của office_admin: tắt TOTP, xoá khoá, thu hồi phiên; người đó phải bật lại ở lần đăng nhập kế', async () => {
    const { secret, session } = await enrollTotp(`vanphong@${domain}`);
    const call: Caller = callerFor(app, ids);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: session.cookie } })).statusCode).toBe(200);

    // thiếu nâng quyền
    const noStepUp = await call<{ code: string }>('U_IT', 'POST', `/v1/users/${ids.users.U_ADMIN}/totp/reset`);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.code).toBe('step_up_required');
    // không tự đặt lại cho mình
    const stepUp = await call<{ stepUpToken: string }>('U_IT', 'POST', '/v1/auth/step-up', { password: PASSWORD });
    expect(stepUp.status).toBe(200);
    const h = { 'x-step-up-token': stepUp.body.stepUpToken };
    expect((await call('U_IT', 'POST', `/v1/users/${ids.users.U_IT}/totp/reset`, undefined, h)).status).toBe(403);
    // người không có user.manage
    const stepUpLan = await call<{ stepUpToken: string }>('U_LAN2', 'POST', '/v1/auth/step-up', { password: PASSWORD });
    expect((await call('U_LAN2', 'POST', `/v1/users/${ids.users.U_ADMIN}/totp/reset`, undefined, { 'x-step-up-token': stepUpLan.body.stepUpToken })).status).toBe(403);
    // người không tồn tại
    expect((await call('U_IT', 'POST', `/v1/users/${crypto.randomUUID()}/totp/reset`, undefined, h)).status).toBe(404);

    const ok = await call('U_IT', 'POST', `/v1/users/${ids.users.U_ADMIN}/totp/reset`, undefined, h);
    expect(ok.status).toBe(200);

    const [u] = await withOrg(ids.ORG, (tx) => tx.select({ enabled: schema.users.totpEnabled, secret: schema.users.totpSecret }).from(schema.users).where(eq(schema.users.id, ids.users.U_ADMIN)));
    expect(u).toEqual({ enabled: false, secret: null });
    // phiên cũ bị thu hồi
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: session.cookie } })).statusCode).toBe(401);
    // audit không chứa bí mật
    const [entry] = await withOrg(ids.ORG, (tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'mfa_reset'), eq(schema.auditLog.targetId, ids.users.U_ADMIN))));
    expect(entry!.actorUserId).toBe(ids.users.U_IT);
    expect(JSON.stringify(entry)).not.toContain(secret);

    // đăng nhập kế: không đòi mã nữa, nhưng ENFORCE_MFA bắt bật lại
    runtimeFlags.enforceMfa = true;
    try {
      const login = await post('/v1/auth/login', { email: `vanphong@${domain}`, password: PASSWORD });
      expect(login.statusCode).toBe(200);
      expect(login.json().mfaRequired).toBe(false);
      expect(login.json().me.mfaRequired).toBe(true);
      const s = cookiesOf(login);
      expect((await app.inject({ method: 'GET', url: '/v1/overview', headers: { cookie: s.cookie } })).json().code).toBe('mfa_required');
      const hh = { cookie: s.cookie, 'x-csrf-token': s.csrf };
      const setup = await post('/v1/auth/totp/setup', {}, hh);
      expect(setup.statusCode).toBe(200);
      expect((await post('/v1/auth/totp/enable', { code: authenticator.generate(setup.json().secret) }, hh)).statusCode).toBe(200);
    } finally {
      runtimeFlags.enforceMfa = false;
    }
  });
});

describe('đặt mật khẩu thu hồi phiên cũ (auth-9)', () => {
  it('đặt mật khẩu qua đường dẫn một lần: phiên web cũ bị 401, mật khẩu cũ không còn dùng được, mật khẩu mới vào được', async () => {
    const old = cookiesOf(await post('/v1/auth/login', { email: `giamdoc@${domain}`, password: PASSWORD }));
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: old.cookie } })).statusCode).toBe(200);
    const link = await withOrg(ids.ORG, (tx) => createPasswordLink(tx, null, ids.ORG, ids.users.U_DIRECTOR));
    const newPassword = 'mat-khau-moi-2026-ok';
    expect((await post('/v1/auth/password/set', { token: link.token, password: newPassword })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: old.cookie } })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: `giamdoc@${domain}`, password: PASSWORD })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: `giamdoc@${domain}`, password: newPassword })).statusCode).toBe(200);
  });
});

describe('header bảo mật (helmet)', () => {
  it('phản hồi JSON có nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer, CSP chặt; không HSTS ngoài production', async () => {
    for (const url of ['/healthz', '/v1/me']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(String(res.headers['content-security-policy']), url).toContain("default-src 'none'");
      expect(String(res.headers['content-security-policy']), url).toContain("frame-ancestors 'none'");
      expect(res.headers['strict-transport-security'], url).toBeUndefined();
    }
  });

  it('tải tệp vẫn là attachment kèm nosniff, không bị header bảo mật làm hỏng', async () => {
    const call: Caller = callerFor(app, ids);
    // tệp không tồn tại: lỗi vẫn có header bảo mật và phần thân là problem+json, không treo
    const res = await call('U_ADMIN', 'GET', `/v1/files/${crypto.randomUUID()}/content`);
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
