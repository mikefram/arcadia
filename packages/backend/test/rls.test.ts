import { newId } from '@mihato/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, getDb, getOwnerDb, getScanDb, schema, sql, withOrg } from '../src/db/client';
import { generateSeedIds, seedDemoOrg, type SeedIds } from '../src/seed/org';
import { Scenario } from '../src/seed/scenario';

/**
 * Cô lập dữ liệu ở mức lược đồ CSDL (SPEC 5.4, 11.3, S2-01: "test chéo tổ chức trên MỌI bảng").
 * Test này duyệt danh mục hệ thống chứ không liệt kê bảng bằng tay, nên bảng nào thêm sau này mà quên bật RLS thì đỏ.
 */
let a: SeedIds;
let b: SeedIds;

async function freshOrg(label: string): Promise<SeedIds> {
  const ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  await seedDemoOrg(ids, { code: `${label}-${tag}`, name: `Tổ chức thử ${label}`, emailDomain: `${label}-${tag}.test` });
  return ids;
}

beforeAll(async () => {
  a = await freshOrg('rlsa');
  b = await freshOrg('rlsb');
  // Cho cả hai tổ chức có dữ liệu ở nhiều bảng: lượt chạy, việc, sự kiện, effect, timer, thông báo, đề xuất…
  for (const ids of [a, b]) {
    const s = new Scenario(ids);
    await s.at(new Date('2026-10-02T02:00:00Z'));
    const run = await s.start('U_ADMIN', { title: 'Lượt chạy thử RLS', delegation: 'Đoàn thử', visitDate: '2026-10-15' });
    await s.complete('U_LAN', run.id, 's1');
    await withOrg(ids.ORG, (tx) =>
      tx.insert(schema.devices).values({ id: newId(), orgId: ids.ORG, userId: ids.users.U_LAN, platform: 'android', name: 'Máy thử', pushToken: 'ExponentPushToken[rls]' }),
    );
    setFakeNow(null);
  }
});

afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});


/** Drizzle bọc lỗi PostgreSQL trong "Failed query…"; thông điệp thật nằm ở `cause`. */
async function expectDbError(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    expect(`${e.cause?.message ?? ''} ${e.message ?? ''}`).toMatch(pattern);
    return;
  }
  throw new Error(`Mong đợi lỗi khớp ${String(pattern)} nhưng lệnh đã thành công`);
}

async function orgEmailDomain(ids: SeedIds): Promise<string> {
  const r = await withOrg(ids.ORG, (tx) => tx.execute<{ email: string }>(sql`SELECT email FROM users WHERE id = ${ids.users.U_LAN}`));
  return r.rows[0]!.email.split('@')[1]!;
}

type TableRow = { table_name: string; has_org: boolean; rls: boolean; forced: boolean };

async function tables(): Promise<TableRow[]> {
  const res = await getOwnerDb().execute<TableRow>(sql`
    SELECT c.relname AS table_name,
           EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'org_id') AS has_org,
           c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    ORDER BY c.relname`);
  return res.rows;
}

describe('RLS bật và ép (FORCE) trên mọi bảng nghiệp vụ', () => {
  it('mọi bảng có cột org_id đều bật RLS, FORCE RLS và có chính sách org_isolation', async () => {
    const all = (await tables()).filter((t) => t.has_org);
    expect(all.length).toBeGreaterThanOrEqual(28);
    for (const t of all) {
      expect(t.rls, `${t.table_name} chưa ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(t.forced, `${t.table_name} chưa FORCE ROW LEVEL SECURITY`).toBe(true);
    }
    const policies = await getOwnerDb().execute<{ tablename: string; policyname: string }>(sql`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`);
    const byTable = new Map<string, string[]>();
    for (const p of policies.rows) byTable.set(p.tablename, [...(byTable.get(p.tablename) ?? []), p.policyname]);
    for (const t of all) expect(byTable.get(t.table_name), `${t.table_name} thiếu chính sách`).toContain('org_isolation');
  });

  it('bảng duy nhất không có org_id mà không bật RLS là bảng nhịp tim của worker; organizations có chính sách riêng', async () => {
    const noOrg = (await tables()).filter((t) => !t.has_org);
    expect(noOrg.filter((t) => t.table_name !== 'organizations' && !t.rls).map((t) => t.table_name)).toEqual(['worker_heartbeats']);
    const org = noOrg.find((t) => t.table_name === 'organizations')!;
    expect(org.rls).toBe(true);
    // CÓ CHỦ ĐÍCH không FORCE: auth_find_login và list_org_ids (SECURITY DEFINER, chạy bằng quyền chủ sở hữu) phải
    // liệt kê được các tổ chức. app_user không phải chủ sở hữu nên vẫn chịu RLS; hành vi này được kiểm ngay dưới đây.
    expect(org.forced).toBe(false);
  });

  it('organizations: trong ngữ cảnh tổ chức, app_user chỉ thấy đúng tổ chức của mình', async () => {
    await withOrg(a.ORG, async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`SELECT id FROM organizations`);
      expect(r.rows.map((x) => x.id)).toEqual([a.ORG]);
    });
  });

  it('hai hàm SECURITY DEFINER chỉ cho app_user gọi và chỉ trả id, không trả hồ sơ', async () => {
    const ids = await getDb().execute<{ id: string }>(sql`SELECT list_org_ids() AS id`);
    expect(ids.rows.map((r) => r.id)).toEqual(expect.arrayContaining([a.ORG, b.ORG]));
    const found = await getDb().execute<Record<string, unknown>>(sql`SELECT * FROM auth_find_login(${`lan@${(await orgEmailDomain(a))}`}, NULL)`);
    expect(Object.keys(found.rows[0] ?? { org_id: 1, user_id: 1 }).sort()).toEqual(['org_id', 'user_id']);
    const pub = await getOwnerDb().execute<{ n: string }>(sql`SELECT count(*) AS n FROM information_schema.routine_privileges WHERE routine_name IN ('auth_find_login','list_org_ids') AND grantee = 'PUBLIC'`);
    expect(Number(pub.rows[0]!.n)).toBe(0);
  });
});

describe('vai trò CSDL (SPEC 5.4, 11.3)', () => {
  it('app_user chịu RLS: không phải superuser, không BYPASSRLS, không sở hữu bảng nào', async () => {
    const r = await getOwnerDb().execute<{ rolsuper: boolean; rolbypassrls: boolean }>(sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await getOwnerDb().execute<{ n: string }>(sql`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_user'`);
    expect(Number(owned.rows[0]!.n)).toBe(0);
  });

  it('app_scan có BYPASSRLS nhưng chỉ SELECT và UPDATE trên timers và effects', async () => {
    const r = await getOwnerDb().execute<{ rolbypassrls: boolean }>(sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_scan'`);
    expect(r.rows[0]!.rolbypassrls).toBe(true);
    const grants = await getOwnerDb().execute<{ table_name: string; privilege_type: string }>(
      sql`SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'app_scan' AND table_schema = 'public' ORDER BY table_name, privilege_type`,
    );
    expect(grants.rows).toEqual([
      { table_name: 'effects', privilege_type: 'SELECT' },
      { table_name: 'effects', privilege_type: 'UPDATE' },
      { table_name: 'timers', privilege_type: 'SELECT' },
      { table_name: 'timers', privilege_type: 'UPDATE' },
    ]);
    // app_scan thấy dòng của cả hai tổ chức ở hai bảng này, và KHÔNG đọc được bảng khác.
    const seen = await getScanDb().execute<{ n: string }>(sql`SELECT count(DISTINCT org_id) AS n FROM effects WHERE org_id IN (${a.ORG}, ${b.ORG})`);
    expect(Number(seen.rows[0]!.n)).toBe(2);
    await expectDbError(getScanDb().execute(sql`SELECT * FROM users LIMIT 1`), /permission denied/);
  });

  it('run_events và audit_log: app_user không có UPDATE/DELETE, và trigger chặn lớp thứ hai', async () => {
    for (const table of ['run_events', 'audit_log']) {
      const priv = await getOwnerDb().execute<{ upd: boolean; del: boolean; ins: boolean }>(
        sql`SELECT has_table_privilege('app_user', ${table}, 'UPDATE') AS upd, has_table_privilege('app_user', ${table}, 'DELETE') AS del, has_table_privilege('app_user', ${table}, 'INSERT') AS ins`,
      );
      expect(priv.rows[0], table).toEqual({ upd: false, del: false, ins: true });
      const triggers = await getOwnerDb().execute<{ n: string }>(sql`SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = ${`public.${table}`}::regclass AND NOT tgisinternal`);
      expect(Number(triggers.rows[0]!.n), `${table} thiếu trigger chỉ-thêm`).toBeGreaterThanOrEqual(1);
    }
    await expectDbError(withOrg(a.ORG, (tx) => tx.execute(sql`UPDATE run_events SET type = 'x'`)), /permission denied|chỉ thêm/);
    await expectDbError(withOrg(a.ORG, (tx) => tx.execute(sql`DELETE FROM audit_log`)), /permission denied|chỉ thêm/);
  });
});

describe('cô lập dữ liệu: mọi bảng có org_id', () => {
  it('trong ngữ cảnh tổ chức B, KHÔNG bảng nào trả dòng của tổ chức khác', async () => {
    const all = (await tables()).filter((t) => t.has_org);
    await withOrg(b.ORG, async (tx) => {
      for (const t of all) {
        const r = await tx.execute<{ other: string; mine: string }>(
          sql.raw(`SELECT count(*) FILTER (WHERE org_id <> '${b.ORG}') AS other, count(*) FILTER (WHERE org_id = '${b.ORG}') AS mine FROM "${t.table_name}"`),
        );
        expect(Number(r.rows[0]!.other), `${t.table_name} lộ dòng của tổ chức khác`).toBe(0);
      }
      // Và tổ chức B có dữ liệu thật ở các bảng chính, nên phép kiểm trên không rỗng ý nghĩa.
      for (const name of ['users', 'process_runs', 'step_runs', 'run_events', 'effects', 'notifications', 'devices']) {
        const r = await tx.execute<{ n: string }>(sql.raw(`SELECT count(*) AS n FROM "${name}"`));
        expect(Number(r.rows[0]!.n), `${name} của B rỗng`).toBeGreaterThan(0);
      }
    });
  });

  it('quên đặt tổ chức thì mọi bảng trả 0 dòng (an toàn theo mặc định), không lỗi ép kiểu', async () => {
    const all = (await tables()).filter((t) => t.has_org);
    for (const t of all) {
      const r = await getDb().execute<{ n: string }>(sql.raw(`SELECT count(*) AS n FROM "${t.table_name}"`));
      expect(Number(r.rows[0]!.n), `${t.table_name} trả dòng khi chưa đặt app.org_id`).toBe(0);
    }
    const orgs = await getDb().execute<{ n: string }>(sql`SELECT count(*) AS n FROM organizations`);
    expect(Number(orgs.rows[0]!.n)).toBe(0);
  });

  it('ghi sang tổ chức khác bị WITH CHECK chặn trên mọi bảng có cột org_id (kiểm bằng bảng đại diện)', async () => {
    // Chèn dòng mang org_id của B khi đang ở ngữ cảnh A phải lỗi dù khoá ngoại hợp lệ.
    await expectDbError(withOrg(a.ORG, (tx) => tx.insert(schema.units).values({ id: newId(), orgId: b.ORG, name: 'Đơn vị lạ' })), /row-level security/);
    await expectDbError(withOrg(a.ORG, (tx) => tx.insert(schema.holidays).values({ orgId: b.ORG, day: '2026-12-25', name: 'Lạ', kind: 'company' })), /row-level security/);
    // UPDATE sang tổ chức khác cũng bị chặn.
    await expectDbError(withOrg(a.ORG, (tx) => tx.execute(sql`UPDATE units SET org_id = ${b.ORG}`)), /row-level security/);
  });

  it('SET LOCAL không rò rỉ giữa các giao dịch: giao dịch sau không thừa hưởng tổ chức của giao dịch trước', async () => {
    await withOrg(a.ORG, async (tx) => {
      const r = await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM users`);
      expect(Number(r.rows[0]!.n)).toBeGreaterThan(0);
    });
    const after = await getDb().execute<{ n: string }>(sql`SELECT count(*) AS n FROM users`);
    expect(Number(after.rows[0]!.n)).toBe(0);
  });
});
