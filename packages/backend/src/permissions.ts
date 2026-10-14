import { effectivePermissions, roleAdjustsOf, userAdjustsOf, type Action, type RoleGrant } from '@mihato/domain';
import { and, eq, or } from 'drizzle-orm';
import { schema, type Tx } from './db/client';

/**
 * Quyền hiệu lực của MỘT người, tính từ vai trò đang giữ cộng chỉnh của tổ chức và chỉnh riêng (docs/DECISIONS.md, 05/10/2026).
 * Dùng khi dựng `Viewer` lúc xác thực, trước khi có `OrgContext`. `tx` đã đặt `app.org_id`, nên RLS giới hạn ở đúng tổ chức.
 */
export async function loadEffectivePermissions(tx: Tx, userId: string, roles: readonly RoleGrant[]): Promise<Action[]> {
  const p = schema.permissionRules;
  const rows = await tx
    .select()
    .from(p)
    .where(or(eq(p.subjectType, 'role'), and(eq(p.subjectType, 'user'), eq(p.subject, userId))));
  return effectivePermissions(roles, roleAdjustsOf(rows), userAdjustsOf(rows).get(userId));
}
