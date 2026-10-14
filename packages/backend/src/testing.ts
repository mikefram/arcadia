import { defaultPermissions, newId, type Role, type RoleGrant } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { clock } from './clock';
import { loadOrgContext, type OrgContext } from './context';
import { schema, withOrg, type Tx } from './db/client';
import type { Viewer } from './views';

/**
 * Trợ giúp cho test tích hợp (SPEC 13.1): mỗi test tạo MỘT tổ chức riêng (id mới, mã ngẫu nhiên) nên các tệp test
 * chạy song song trên cùng CSDL `mihato_test` mà không giẫm lên nhau, và mọi test đều tự kiểm RLS: dữ liệu của
 * tổ chức khác luôn có mặt trong CSDL nhưng không bao giờ được thấy.
 * Tên người là tên giả. Không dùng ngoài test.
 */

export const TEST_USER_KEYS = ['chairman', 'director', 'deputy', 'officeAdmin', 'designer', 'itAdmin', 'head', 'employee', 'employee2'] as const;
export type TestUserKey = (typeof TEST_USER_KEYS)[number];
export const TEST_UNIT_KEYS = ['board', 'office', 'sales'] as const;
export type TestUnitKey = (typeof TEST_UNIT_KEYS)[number];

type TestUserSpec = {
  fullName: string;
  givenName: string;
  honorific: string | null;
  role: Role;
  unit: TestUnitKey;
  manager: TestUserKey | null;
  uiProfile: 'senior' | 'standard';
};

/** Đủ bảy vai trò, thêm một trưởng đơn vị (`head`) và nhân viên thứ hai để test giao lại và tầm nhìn. */
export const TEST_USERS: Record<TestUserKey, TestUserSpec> = {
  chairman: { fullName: 'Trần Đức Minh', givenName: 'Minh', honorific: 'ong', role: 'chairman', unit: 'board', manager: null, uiProfile: 'senior' },
  director: { fullName: 'Lê Thanh Sơn', givenName: 'Sơn', honorific: 'ong', role: 'director', unit: 'board', manager: 'chairman', uiProfile: 'standard' },
  deputy: { fullName: 'Phạm Quang Huy', givenName: 'Huy', honorific: 'ong', role: 'deputy', unit: 'board', manager: 'director', uiProfile: 'standard' },
  officeAdmin: { fullName: 'Đỗ Thị Hạnh', givenName: 'Hạnh', honorific: 'chi', role: 'office_admin', unit: 'office', manager: 'director', uiProfile: 'standard' },
  designer: { fullName: 'Vũ Minh Khôi', givenName: 'Khôi', honorific: 'anh', role: 'process_designer', unit: 'office', manager: 'officeAdmin', uiProfile: 'standard' },
  itAdmin: { fullName: 'Ngô Văn Tài', givenName: 'Tài', honorific: 'anh', role: 'it_admin', unit: 'office', manager: 'officeAdmin', uiProfile: 'standard' },
  head: { fullName: 'Đặng Quốc Bảo', givenName: 'Bảo', honorific: 'anh', role: 'employee', unit: 'sales', manager: 'deputy', uiProfile: 'standard' },
  employee: { fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi', role: 'employee', unit: 'sales', manager: 'head', uiProfile: 'standard' },
  employee2: { fullName: 'Bùi Quốc Tuấn', givenName: 'Tuấn', honorific: 'anh', role: 'employee', unit: 'sales', manager: 'head', uiProfile: 'standard' },
};

const TEST_UNITS: Record<TestUnitKey, { name: string; head: TestUserKey }> = {
  board: { name: 'Ban Giám đốc', head: 'director' },
  office: { name: 'Văn phòng', head: 'officeAdmin' },
  sales: { name: 'Phòng Kinh doanh', head: 'head' },
};

const ROLE_USER: Record<Role, TestUserKey> = {
  chairman: 'chairman',
  director: 'director',
  deputy: 'deputy',
  office_admin: 'officeAdmin',
  process_designer: 'designer',
  it_admin: 'itAdmin',
  employee: 'employee',
};

export type TestOrg = {
  orgId: string;
  code: string;
  users: Record<TestUserKey, string>;
  units: Record<TestUnitKey, string>;
  /** Dựng `Viewer` của một người mẫu, theo khoá (`'head'`) hoặc theo vai trò (`'office_admin'`). */
  viewer(who: TestUserKey | Role): Viewer;
  /** Chạy `fn` trong một giao dịch đã đặt app.org_id của tổ chức này, với danh bạ vừa nạp: giống một handler của API. */
  run<T>(fn: (tx: Tx, ctx: OrgContext) => Promise<T>): Promise<T>;
};

export type CreateTestOrgOptions = {
  name?: string;
  /** ghi thẳng vào organizations.settings (khoá vắng mặt dùng mặc định của OrgSettingsSchema) */
  settings?: Record<string, unknown>;
};

const isUserKey = (who: string): who is TestUserKey => (TEST_USER_KEYS as readonly string[]).includes(who);

/** Tạo một tổ chức riêng cùng ba đơn vị và chín người mẫu ở trạng thái `active`. */
export async function createTestOrg(opts: CreateTestOrgOptions = {}): Promise<TestOrg> {
  const orgId = newId();
  const code = `test-${orgId.replace(/-/g, '').slice(-12)}`;
  const users = Object.fromEntries(TEST_USER_KEYS.map((k) => [k, newId()])) as Record<TestUserKey, string>;
  const units = Object.fromEntries(TEST_UNIT_KEYS.map((k) => [k, newId()])) as Record<TestUnitKey, string>;
  const now = clock.now();

  await withOrg(orgId, async (tx) => {
    await tx.insert(schema.organizations).values({ id: orgId, code, name: opts.name ?? `Tổ chức thử ${code}`, settings: opts.settings ?? {}, createdAt: now });
    // Đơn vị và người tham chiếu lẫn nhau (trưởng đơn vị, người quản lý): chèn trước, nối sau.
    await tx.insert(schema.units).values(TEST_UNIT_KEYS.map((k) => ({ id: units[k], orgId, name: TEST_UNITS[k].name })));
    await tx.insert(schema.users).values(
      TEST_USER_KEYS.map((k, i) => {
        const u = TEST_USERS[k];
        return {
          id: users[k],
          orgId,
          fullName: u.fullName,
          givenName: u.givenName,
          honorific: u.honorific,
          email: `${k.toLowerCase()}@${code}.test`,
          unitId: units[u.unit],
          uiProfile: u.uiProfile,
          displayOrder: i,
          status: 'active',
          createdAt: now,
        };
      }),
    );
    for (const k of TEST_USER_KEYS) {
      const manager = TEST_USERS[k].manager;
      if (manager) await tx.update(schema.users).set({ managerId: users[manager] }).where(eq(schema.users.id, users[k]));
    }
    for (const k of TEST_UNIT_KEYS) await tx.update(schema.units).set({ headUserId: users[TEST_UNITS[k].head] }).where(eq(schema.units.id, units[k]));
    await tx.insert(schema.userRoles).values(TEST_USER_KEYS.map((k) => ({ id: newId(), orgId, userId: users[k], role: TEST_USERS[k].role, unitId: null })));
  });

  return {
    orgId,
    code,
    users,
    units,
    viewer(who) {
      const key = isUserKey(who) ? who : ROLE_USER[who];
      const spec = TEST_USERS[key];
      const roles: RoleGrant[] = [{ role: spec.role, unitId: null }];
      return { id: users[key], orgId, roles, permissions: defaultPermissions(roles), unitId: units[spec.unit], deviceId: null, sessionId: null, via: 'cookie' };
    },
    run(fn) {
      return withOrg(orgId, async (tx) => fn(tx, await loadOrgContext(tx, orgId)));
    },
  };
}
