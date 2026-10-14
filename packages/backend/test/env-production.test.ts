import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { productionEnvProblems, type EnvSource } from '../src/env-check';

/**
 * Cấu hình production (docker-1, config-3, config-4, config-11, config-5): chạy hàm kiểm thuần trên nhiều cấu hình,
 * và chạy env.ts thật trong tiến trình con với NODE_ENV=production để chắc nó ném lỗi lúc nạp.
 */

const ecKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const tmp = mkdtempSync(join(tmpdir(), 'mihato-env-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const good: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://app_user:Zq81kd0aPw3nVx7m2Lc9@postgres:5432/mihato',
  DATABASE_URL_OWNER: 'postgres://app_owner:Rt52hs8bYe1cUa6n4Jd3@postgres:5432/mihato',
  DATABASE_URL_SCAN: 'postgres://app_scan:Wm47gf2eKo9iBz5x1Hq8@postgres:5432/mihato',
  AUTH_SECRET: 'k3Jp9sLw2VxQm8Tn5Rb7Yc1Zd4Fg6Hh0Aa2Ee3Uu5Oo7Ii9Pp1Ll',
  INTERNAL_SERVICE_TOKEN: 'Zx9Cv8Bn7Mq6Ws5Ed4Rf3Tg2Yh1Uj0Ik9Ol8Ap7Sd6Fg5Hj4Kl',
  WEB_ORIGIN: 'https://dieuhanh.vrg.example.vn',
  PUBLIC_API_URL: 'https://dieuhanh.vrg.example.vn',
  PUBLIC_SCRIBE_WS_URL: 'wss://dieuhanh.vrg.example.vn/scribe/ws',
  FILE_STORAGE_DIR: '/data/files',
  SCRIBE_JWT_PRIVATE_KEY: ecKey.replace(/\n/g, '\\n'),
  STT_PROVIDER: 'deepgram',
  LLM_PROVIDER: 'anthropic',
  TTS_PROVIDER: 'vbee',
  PUSH_PROVIDER: 'expo',
  ANTHROPIC_API_KEY: 'k',
  DEEPGRAM_API_KEY: 'k',
  VBEE_APP_ID: 'a',
  VBEE_TOKEN: 't',
};
const names = (src: EnvSource, opts = {}) => productionEnvProblems(src, { requireDatabaseUrls: ['DATABASE_URL', 'DATABASE_URL_OWNER', 'DATABASE_URL_SCAN'], requireScribeKey: true, requireProviderKeys: true, ...opts }).map((p) => p.name);
const without = (...keys: string[]) => Object.fromEntries(Object.entries(good).filter(([k]) => !keys.includes(k)));

describe('productionEnvProblems', () => {
  it('cấu hình đủ và đúng thì không có vấn đề', () => {
    expect(productionEnvProblems(good, { requireDatabaseUrls: ['DATABASE_URL', 'DATABASE_URL_OWNER', 'DATABASE_URL_SCAN'], requireScribeKey: true, requireProviderKeys: true })).toEqual([]);
  });

  it('PUBLIC_SCRIBE_WS_URL thiếu hoặc không phải wss:// bị từ chối', () => {
    expect(names(without('PUBLIC_SCRIBE_WS_URL'))).toEqual(['PUBLIC_SCRIBE_WS_URL']);
    expect(names({ ...good, PUBLIC_SCRIBE_WS_URL: 'ws://dieuhanh.vrg.example.vn/scribe/ws' })).toEqual(['PUBLIC_SCRIBE_WS_URL']);
    expect(names({ ...good, PUBLIC_SCRIBE_WS_URL: 'wss://localhost/scribe/ws' })).toEqual(['PUBLIC_SCRIBE_WS_URL']);
  });

  it('WEB_ORIGIN và PUBLIC_API_URL phải là https://; WEB_ORIGIN không có dấu / cuối', () => {
    expect(names({ ...good, WEB_ORIGIN: 'http://dieuhanh.vrg.example.vn' })).toEqual(['WEB_ORIGIN']);
    expect(names({ ...good, PUBLIC_API_URL: 'http://dieuhanh.vrg.example.vn' })).toEqual(['PUBLIC_API_URL']);
    expect(names({ ...good, WEB_ORIGIN: 'https://dieuhanh.vrg.example.vn/' })).toEqual(['WEB_ORIGIN']);
    expect(names(without('WEB_ORIGIN', 'PUBLIC_API_URL'))).toEqual(['WEB_ORIGIN', 'PUBLIC_API_URL']);
  });

  it('AUTH_SECRET và INTERNAL_SERVICE_TOKEN: thiếu, ngắn, giá trị mẫu hoặc trùng nhau đều bị từ chối', () => {
    expect(names(without('AUTH_SECRET'))).toEqual(['AUTH_SECRET']);
    expect(names({ ...good, AUTH_SECRET: 'ngan' })).toEqual(['AUTH_SECRET']);
    expect(names({ ...good, INTERNAL_SERVICE_TOKEN: 'dev-internal-service-token-change-me' })).toEqual(['INTERNAL_SERVICE_TOKEN']);
    expect(names({ ...good, AUTH_SECRET: `${'a'.repeat(40)}change-me` })).toEqual(['AUTH_SECRET']);
    expect(names({ ...good, INTERNAL_SERVICE_TOKEN: good.AUTH_SECRET })).toEqual(['INTERNAL_SERVICE_TOKEN']);
  });

  it('FILE_STORAGE_DIR thiếu hoặc không tuyệt đối bị từ chối', () => {
    expect(names(without('FILE_STORAGE_DIR'))).toEqual(['FILE_STORAGE_DIR']);
    expect(names({ ...good, FILE_STORAGE_DIR: 'storage' })).toEqual(['FILE_STORAGE_DIR']);
  });

  it('SCRIBE_JWT_PRIVATE_KEY: thiếu khi Scribe bật, sai loại khoá, hoặc đọc không được', () => {
    expect(names(without('SCRIBE_JWT_PRIVATE_KEY'))).toEqual(['SCRIBE_JWT_PRIVATE_KEY']);
    expect(names({ ...without('SCRIBE_JWT_PRIVATE_KEY'), SCRIBE_ENABLED: 'false' })).toEqual([]);
    expect(names({ ...good, SCRIBE_JWT_PRIVATE_KEY: rsaKey })).toEqual(['SCRIBE_JWT_PRIVATE_KEY']);
    expect(names({ ...good, SCRIBE_JWT_PRIVATE_KEY: 'khong-phai-pem' })).toEqual(['SCRIBE_JWT_PRIVATE_KEY']);
    // không đòi khoá ở tiến trình không ký token (worker, migrate)
    expect(names(without('SCRIBE_JWT_PRIVATE_KEY'), { requireScribeKey: false })).toEqual([]);
    // khoá dạng nhiều dòng thật cũng đọc được
    expect(names({ ...good, SCRIBE_JWT_PRIVATE_KEY: ecKey })).toEqual([]);
  });

  it('nhà cung cấp fake (kể cả để trống) bị từ chối nếu không có ALLOW_FAKE_PROVIDERS=true', () => {
    expect(names({ ...good, PUSH_PROVIDER: 'fake' })).toEqual(['PUSH_PROVIDER']);
    expect(names(without('STT_PROVIDER', 'TTS_PROVIDER'), { requireProviderKeys: false })).toEqual(['STT_PROVIDER, TTS_PROVIDER']);
    expect(names({ ...good, PUSH_PROVIDER: 'fake', ALLOW_FAKE_PROVIDERS: 'true' })).toEqual([]);
    expect(names({ ...good, LLM_PROVIDER: 'openai' })).toEqual(['LLM_PROVIDER']);
  });

  it('thiếu khoá API của nhà cung cấp thật được chọn thì báo (khi kiểm đủ)', () => {
    expect(names(without('ANTHROPIC_API_KEY'))).toEqual(['ANTHROPIC_API_KEY']);
    expect(names(without('VBEE_TOKEN'))).toEqual(['VBEE_TOKEN']);
    expect(names(without('DEEPGRAM_API_KEY'), { requireProviderKeys: false })).toEqual([]);
  });

  it('thư là tuỳ chọn ở môi trường (cấu hình ở web quản trị); chọn resend ở môi trường thì phải đủ khoá và địa chỉ gửi', () => {
    expect(names(good)).toEqual([]);
    expect(names({ ...good, EMAIL_PROVIDER: 'fake' })).toEqual([]);
    expect(names({ ...good, EMAIL_PROVIDER: 'resend' })).toEqual(['RESEND_API_KEY', 'EMAIL_FROM']);
    expect(names({ ...good, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_k', EMAIL_FROM: 'MIHATO <thu@dieuhanh.vrg.example.vn>' })).toEqual([]);
    expect(names({ ...good, EMAIL_PROVIDER: 'sendgrid' })).toEqual(['EMAIL_PROVIDER']);
  });

  it('DATABASE_URL còn mật khẩu mặc định *_dev hoặc tên CSDL *_dev bị từ chối', () => {
    expect(names({ ...good, DATABASE_URL: 'postgres://app_user:app_user_dev@postgres:5432/mihato' })).toEqual(['DATABASE_URL']);
    expect(names({ ...good, DATABASE_URL_SCAN: 'postgres://app_scan:app_scan_dev@postgres:5432/mihato' })).toEqual(['DATABASE_URL_SCAN']);
    expect(names({ ...good, DATABASE_URL_OWNER: 'postgres://app_owner:Rt52hs8bYe1cUa6n4Jd3@postgres:5432/mihato_dev' })).toEqual(['DATABASE_URL_OWNER']);
    expect(names(without('DATABASE_URL'))).toEqual(['DATABASE_URL']);
    // không đòi biến mà vai trò không dùng
    expect(names(without('DATABASE_URL_OWNER', 'DATABASE_URL_SCAN'), { requireDatabaseUrls: ['DATABASE_URL'] })).toEqual([]);
  });

  it('thông báo lỗi không chứa giá trị bí mật', () => {
    const bad = { ...good, AUTH_SECRET: 'dev-bi-mat-ngan', DATABASE_URL: 'postgres://app_user:matkhau_dev@postgres:5432/mihato' };
    const text = JSON.stringify(productionEnvProblems(bad));
    expect(text).not.toContain('dev-bi-mat-ngan');
    expect(text).not.toContain('matkhau_dev');
  });
});

/** Chạy env.ts thật với NODE_ENV=production trong tiến trình con (môi trường sạch, không kế thừa .env hay VITEST). */
function loadEnvInChild(vars: Record<string, string>): { ok: boolean; stderr: string } {
  const envTs = fileURLToPath(new URL('../src/env.ts', import.meta.url));
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(envTs)}); console.log('loaded')`], {
      env: { PATH: process.env.PATH ?? '', HOME: tmp, ...vars },
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String((err as { stderr?: Buffer }).stderr ?? err) };
  }
}

describe('env.ts nạp ở production (tiến trình con)', () => {
  it('cấu hình đủ thì nạp được', () => {
    const r = loadEnvInChild({ ...good, FILE_STORAGE_DIR: join(tmp, 'files') });
    expect(r.stderr).toBe('');
    expect(r.ok).toBe(true);
  });

  it('thiếu PUBLIC_SCRIBE_WS_URL, WEB_ORIGIN http:// và AUTH_SECRET mẫu: ném lỗi nêu tên cả ba biến', () => {
    const r = loadEnvInChild({ ...without('PUBLIC_SCRIBE_WS_URL', 'WEB_ORIGIN'), WEB_ORIGIN: 'http://x.vn', AUTH_SECRET: 'dev-auth-secret-change-me-0123456789abcdef' });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('Cấu hình production không hợp lệ');
    for (const name of ['PUBLIC_SCRIBE_WS_URL', 'WEB_ORIGIN', 'AUTH_SECRET']) expect(r.stderr).toContain(name);
    expect(r.stderr).not.toContain('dev-auth-secret-change-me-0123456789abcdef');
  });

  it('nhà cung cấp fake không có ALLOW_FAKE_PROVIDERS thì không khởi động', () => {
    const r = loadEnvInChild({ ...good, STT_PROVIDER: 'fake', PUSH_PROVIDER: 'fake' });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('ALLOW_FAKE_PROVIDERS');
  });

  it('assertRuntime("api") báo FILE_STORAGE_DIR không ghi được', () => {
    const envTs = fileURLToPath(new URL('../src/env.ts', import.meta.url));
    const ro = join(tmp, 'chi-doc');
    writeFileSync(ro, 'khong phai thu muc'); // đường dẫn là một tệp thường: mkdir thất bại
    chmodSync(ro, 0o444);
    let stderr = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const m = await import(${JSON.stringify(envTs)}); m.assertRuntime('api')`], {
        env: { PATH: process.env.PATH ?? '', HOME: tmp, ...good, FILE_STORAGE_DIR: join(ro, 'con') },
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? err);
    }
    expect(stderr).toContain('FILE_STORAGE_DIR không ghi được');
  });
});
