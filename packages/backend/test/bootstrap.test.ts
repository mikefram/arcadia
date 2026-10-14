import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newId } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { login, setPassword } from '../src/auth/service';
import { bootstrapOrg, validateBootstrapInput } from '../src/bootstrap';
import { closeDb, listOrgIds, schema, withOrg } from '../src/db/client';
import { devOnlyViolation, isLocalDatabaseHost } from '../scripts/guard';

afterAll(closeDb);

const uniq = () => `t${newId().replaceAll('-', '').slice(-12)}`;

describe('bootstrapOrg (khởi tạo tổ chức không qua seed)', () => {
  it('tạo tổ chức, đơn vị gốc, một it_admin và đường dẫn đặt mật khẩu; không có dữ liệu mẫu', async () => {
    const code = uniq();
    const email = `Admin.${code}@Vrg.Example.vn`;
    const r = await bootstrapOrg({ orgCode: code, orgName: 'Tổ chức thử', adminEmail: email, adminFullName: 'Nguyễn Văn An' });
    expect(r.orgCreated).toBe(true);
    expect(r.adminCreated).toBe(true);
    expect(r.passwordLink?.url).toContain('/dat-mat-khau?token=');
    expect(await listOrgIds()).toContain(r.orgId);

    await withOrg(r.orgId, async (tx) => {
      const [org] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, r.orgId));
      expect(org?.code).toBe(code);
      expect(await tx.select().from(schema.units)).toHaveLength(1);
      const users = await tx.select().from(schema.users);
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ email: email.toLowerCase(), fullName: 'Nguyễn Văn An', givenName: 'An', status: 'invited', unitId: expect.any(String) });
      const roles = await tx.select().from(schema.userRoles);
      expect(roles.map((x) => x.role)).toEqual(['it_admin']);
      // không có dữ liệu mẫu
      expect(await tx.select().from(schema.processTemplates)).toHaveLength(0);
      expect(await tx.select().from(schema.processRuns)).toHaveLength(0);
      // nhật ký không chứa tên người hay tên tổ chức
      const audits = await tx.select().from(schema.auditLog);
      expect(audits.map((a) => a.action).sort()).toEqual(['org_bootstrapped', 'user_created']);
      expect(JSON.stringify(audits)).not.toContain('Nguyễn');
      expect(JSON.stringify(audits)).not.toContain('Tổ chức thử');
    });

    // đường dẫn dùng được: đặt mật khẩu rồi đăng nhập web
    const token = new URL(r.passwordLink!.url).searchParams.get('token')!;
    await setPassword({ token, password: 'Mat-khau-thu-nghiem-2026!' });
    const outcome = await login({ email: email.toLowerCase(), password: 'Mat-khau-thu-nghiem-2026!', org: code }, {});
    expect(outcome).toBeTruthy();
    // dùng một lần
    await expect(setPassword({ token, password: 'Mat-khau-khac-2026!!' })).rejects.toBeTruthy();
  });

  it('chạy lại cùng mã không tạo trùng và không cấp đường dẫn mới; --reissue-link cấp lại', async () => {
    const code = uniq();
    const input = { orgCode: code, orgName: 'Tổ chức hai', adminEmail: `a@${code}.example.vn`, adminFullName: 'Trần Thị B' };
    const first = await bootstrapOrg(input);
    const again = await bootstrapOrg(input);
    expect(again.orgId).toBe(first.orgId);
    expect(again.userId).toBe(first.userId);
    expect(again.orgCreated).toBe(false);
    expect(again.adminCreated).toBe(false);
    expect(again.passwordLink).toBeNull();
    const reissued = await bootstrapOrg({ ...input, reissueLink: true });
    expect(reissued.passwordLink?.url).toContain('/dat-mat-khau?token=');
    expect(reissued.passwordLink?.url).not.toBe(first.passwordLink?.url);
    await withOrg(first.orgId, async (tx) => {
      expect(await tx.select().from(schema.units)).toHaveLength(1);
      expect(await tx.select().from(schema.users)).toHaveLength(1);
      expect(await tx.select().from(schema.userRoles)).toHaveLength(1);
    });
  });

  it('hai tổ chức khởi tạo riêng không thấy nhau (RLS)', async () => {
    const a = await bootstrapOrg({ orgCode: uniq(), orgName: 'A', adminEmail: `a@${uniq()}.example.vn`, adminFullName: 'Người A' });
    const b = await bootstrapOrg({ orgCode: uniq(), orgName: 'B', adminEmail: `b@${uniq()}.example.vn`, adminFullName: 'Người B' });
    await withOrg(a.orgId, async (tx) => {
      const users = await tx.select().from(schema.users);
      expect(users.map((u) => u.id)).toEqual([a.userId]);
    });
    expect(a.orgId).not.toBe(b.orgId);
  });

  it('từ chối đầu vào sai', async () => {
    const bad = { orgCode: 'A B', orgName: ' ', adminEmail: 'khong-phai-email', adminFullName: '' };
    expect(validateBootstrapInput(bad)).toHaveLength(4);
    await expect(bootstrapOrg(bad)).rejects.toThrow(/ORG_CODE/);
  });
});

describe('chốt chặn seed và reset', () => {
  const dev = 'postgres://app_owner:x@127.0.0.1:5455/mihato_dev';
  it('devOnlyViolation: production, CSDL không đuôi _dev/_test đều bị từ chối', () => {
    expect(devOnlyViolation({ isProd: false, nodeEnv: 'development', databaseUrl: dev })).toBeNull();
    expect(devOnlyViolation({ isProd: false, nodeEnv: 'test', databaseUrl: 'postgres://u:p@h/mihato_test' })).toBeNull();
    expect(devOnlyViolation({ isProd: true, nodeEnv: 'production', databaseUrl: dev })).toMatch(/production/);
    expect(devOnlyViolation({ isProd: false, nodeEnv: 'development', databaseUrl: 'postgres://u:p@h/mihato' })).toMatch(/_dev hoặc _test/);
    expect(devOnlyViolation({ isProd: false, nodeEnv: 'development', databaseUrl: 'postgres://u:p@h/mihato_prod' })).toMatch(/_dev hoặc _test/);
  });

  it('reset chỉ coi máy phát triển là hợp lệ', () => {
    expect(isLocalDatabaseHost(dev)).toBe(true);
    expect(isLocalDatabaseHost('postgres://u:p@db.vrg.example.vn:5432/mihato_dev')).toBe(false);
  });

  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const run = (script: string, env: Record<string, string>, args: string[] = []): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, ['--import', 'tsx', `scripts/${script}`, ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      return { code: 0, out: out.toString() };
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  it('seed từ chối khi CSDL không có đuôi _dev/_test (chưa chạm CSDL)', () => {
    const r = run('seed.ts', { NODE_ENV: 'development', DATABASE_URL: 'postgres://app_user:x@127.0.0.1:1/mihato' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Từ chối seed');
  });

  it('seed từ chối ở production kể cả khi cấu hình production thiếu', () => {
    const r = run('seed.ts', { NODE_ENV: 'production' });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('Dữ liệu mẫu đã sẵn sàng');
  });

  it('reset từ chối khi CSDL không có đuôi _dev/_test và khi thiếu --yes', () => {
    const noSuffix = run('reset.ts', { NODE_ENV: 'development', DATABASE_URL_OWNER: 'postgres://app_owner:x@127.0.0.1:1/mihato' });
    expect(noSuffix.code).toBe(1);
    expect(noSuffix.out).toContain('Từ chối xoá');
    const noYes = run('reset.ts', { NODE_ENV: 'development', DATABASE_URL_OWNER: 'postgres://app_owner:x@127.0.0.1:1/mihato_dev' });
    expect(noYes.code).toBe(1);
    expect(noYes.out).toContain('Chưa xác nhận');
    const remote = run('reset.ts', { NODE_ENV: 'development', DATABASE_URL_OWNER: 'postgres://app_owner:x@db.vrg.example.vn:5432/mihato_dev' }, ['--yes']);
    expect(remote.code).toBe(1);
    expect(remote.out).toContain('không phải máy phát triển');
  });
});
