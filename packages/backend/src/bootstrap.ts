import { OrgSettingsSchema, newId } from '@mihato/domain';
import { eq, sql } from 'drizzle-orm';
import { audit } from './audit';
import { createPasswordLink } from './auth/service';
import { clock } from './clock';
import { listOrgIds, schema, withOrg } from './db/client';

/**
 * Khởi tạo một tổ chức thật không qua seed (docs/ops/runbook.md): tạo tổ chức với cấu hình mặc định, một đơn vị gốc
 * và một người dùng `it_admin`; trả đường dẫn đặt mật khẩu dùng một lần. KHÔNG tạo dữ liệu mẫu nào.
 * Chạy lại với cùng mã tổ chức không tạo trùng; chỉ tạo thêm quản trị viên nếu email chưa có trong tổ chức.
 */

export type BootstrapInput = {
  /** mã ngắn, chữ thường, ví dụ 'vrg' */
  orgCode: string;
  orgName: string;
  /** tên đơn vị gốc; bỏ trống thì lấy tên tổ chức */
  rootUnitName?: string;
  adminEmail: string;
  adminFullName: string;
  /** cấp lại đường dẫn đặt mật khẩu cho quản trị viên đã có (mất đường dẫn lần đầu) */
  reissueLink?: boolean;
};

export type BootstrapResult = {
  orgId: string;
  userId: string;
  orgCreated: boolean;
  adminCreated: boolean;
  /** chỉ có khi vừa tạo quản trị viên hoặc yêu cầu cấp lại; mã gốc không lưu ở đâu khác */
  passwordLink: { url: string; expiresAt: Date } | null;
};

const CODE_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBootstrapInput(input: BootstrapInput): string[] {
  const errors: string[] = [];
  if (!CODE_RE.test(input.orgCode)) errors.push('ORG_CODE: 2 đến 32 ký tự, chữ thường, số, gạch ngang hoặc gạch dưới, bắt đầu bằng chữ cái');
  if (!input.orgName.trim()) errors.push('ORG_NAME: thiếu');
  if (!EMAIL_RE.test(input.adminEmail.trim())) errors.push('ADMIN_EMAIL: không phải địa chỉ email hợp lệ');
  if (!input.adminFullName.trim()) errors.push('ADMIN_FULL_NAME: thiếu');
  return errors;
}

/** Tên gọi là từ cuối của họ tên (cách gọi người Việt). */
const givenNameOf = (fullName: string): string => fullName.trim().split(/\s+/).at(-1) ?? fullName.trim();

async function findOrgIdByCode(code: string): Promise<string | null> {
  // RLS: không đặt tổ chức thì không đọc được bảng organizations; lần lượt vào từng tổ chức (tối đa vài tổ chức).
  for (const id of await listOrgIds()) {
    const found = await withOrg(id, async (tx) => {
      const [org] = await tx.select({ code: schema.organizations.code }).from(schema.organizations).where(eq(schema.organizations.id, id));
      return org?.code === code;
    });
    if (found) return id;
  }
  return null;
}

export async function bootstrapOrg(input: BootstrapInput): Promise<BootstrapResult> {
  const errors = validateBootstrapInput(input);
  if (errors.length > 0) throw new Error(`Thông tin khởi tạo không hợp lệ:\n  - ${errors.join('\n  - ')}`);
  const code = input.orgCode.trim();
  const email = input.adminEmail.trim().toLowerCase();

  const existingId = await findOrgIdByCode(code);
  const orgId = existingId ?? newId();
  const orgCreated = existingId === null;

  return withOrg(orgId, async (tx) => {
    // Khoá theo mã tổ chức: hai lần chạy song song không cùng tạo (cột code còn ràng buộc duy nhất làm lưới cuối).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bootstrap:${code}`}))`);

    if (orgCreated) {
      await tx.insert(schema.organizations).values({ id: orgId, code, name: input.orgName.trim(), settings: OrgSettingsSchema.parse({}), createdAt: clock.now() });
    }

    const units = await tx.select({ id: schema.units.id }).from(schema.units).limit(1);
    const unitId = units[0]?.id ?? newId();
    if (units.length === 0) await tx.insert(schema.units).values({ id: unitId, orgId, name: (input.rootUnitName ?? input.orgName).trim() });

    const [existingUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    let userId = existingUser?.id ?? '';
    const adminCreated = !existingUser;
    if (adminCreated) {
      userId = newId();
      await tx.insert(schema.users).values({
        id: userId,
        orgId,
        fullName: input.adminFullName.trim(),
        givenName: givenNameOf(input.adminFullName),
        email,
        unitId,
        uiProfile: 'standard',
        status: 'invited',
        createdAt: clock.now(),
      });
      await tx.insert(schema.userRoles).values({ id: newId(), orgId, userId, role: 'it_admin', unitId: null });
      await audit(tx, { orgId, action: 'user_created', targetType: 'user', targetId: userId, detail: { roles: ['it_admin'], via: 'bootstrap' } });
    }
    if (orgCreated) await audit(tx, { orgId, action: 'org_bootstrapped', detail: { code } });

    let passwordLink: BootstrapResult['passwordLink'] = null;
    if (adminCreated || input.reissueLink) {
      const link = await createPasswordLink(tx, null, orgId, userId);
      passwordLink = { url: link.url, expiresAt: link.expiresAt };
    }
    return { orgId, userId, orgCreated, adminCreated, passwordLink };
  });
}
