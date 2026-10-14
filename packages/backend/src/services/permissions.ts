import {
  ACTIONS,
  ACTION_GROUPS,
  ApiError,
  LOCKED_ACTIONS,
  POLICY,
  ROLES,
  adjustFromAllowed,
  effectivePermissions,
  normalizeAdjust,
  permissionsFromRoles,
  rolePermissions,
  type Action,
  type Adjust,
  type PermissionMatrix,
  type PermissionRoleView,
  type Role,
  type RoleAdjusts,
  type UserPermissionsView,
} from '@mihato/domain';
import { and, eq } from 'drizzle-orm';
import { audit } from '../audit';
import type { RequestMeta } from '../auth/service';
import { loadOrgContext, type OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import type { Viewer } from '../views';

/**
 * Chỉnh quyền (docs/DECISIONS.md, 05/10/2026): tổ chức tự quyết vai trò nào làm được gì (`permission_rules`, đối tượng là vai trò),
 * và chỉnh riêng từng người (đối tượng là người) mà không đổi vai trò. Lưu THƯA: chỉ phần khác bảng mặc định ở packages/domain.
 * Mọi thay đổi ghi nhật ký (chỉ tên vai trò, id người và khoá quyền; không tên người, CLAUDE.md luật 6).
 */

/**
 * Những quyền mà tổ chức luôn phải còn ít nhất một người đang dùng được giữ. Không có người giữ `permission.manage` thì không ai
 * sửa được bảng quyền nữa; không có người giữ `user.manage` thì không ai thêm, sửa hay vô hiệu hoá được người dùng.
 */
export const REQUIRED_HOLDERS: readonly Action[] = ['permission.manage', 'user.manage'];

const fieldError = (path: string, code: string): ApiError => new ApiError('input_invalid', { errors: [{ path, code }] });

/** Sự thay đổi dự định, để kiểm trước khi ghi: quy tắc mới, vai trò mới của một người, hoặc một người sắp bị vô hiệu hoá. */
export type PlannedChange = {
  roleAdjusts?: RoleAdjusts;
  userAdjusts?: Map<string, Adjust>;
  rolesOf?: { userId: string; roles: readonly { role: Role; unitId: string | null }[] };
  disabling?: string;
};

/**
 * Sau thay đổi này vẫn phải còn người đang dùng được giữ từng quyền trong `REQUIRED_HOLDERS`; nếu không thì từ chối (422).
 * Gọi trước khi ghi: chỉnh quyền, đổi vai trò một người, vô hiệu hoá một người.
 */
export async function assertManagersRemain(tx: Tx, orgId: string, change: PlannedChange, known?: OrgContext): Promise<void> {
  const ctx = known ?? (await loadOrgContext(tx, orgId));
  const roleAdjusts = change.roleAdjusts ?? ctx.roleAdjusts;
  const userAdjusts = change.userAdjusts ?? ctx.userAdjusts;
  for (const action of REQUIRED_HOLDERS) {
    // Tổ chức vốn đã không còn ai giữ quyền này (dữ liệu cũ, thử nghiệm): không để việc đó chặn các thay đổi không liên quan.
    const now = [...ctx.users.values()].some((u) => u.status === 'active' && u.permissions.includes(action));
    if (!now) continue;
    let holders = 0;
    for (const u of ctx.users.values()) {
      if (u.status !== 'active' || u.id === change.disabling) continue;
      const roles = change.rolesOf && change.rolesOf.userId === u.id ? change.rolesOf.roles : u.roles;
      if (effectivePermissions(roles, roleAdjusts, userAdjusts.get(u.id)).includes(action)) holders++;
    }
    if (holders === 0) throw fieldError('body', action === 'permission.manage' ? 'last_permission_manager' : 'last_user_manager');
  }
}

const sameSet = (a: readonly Action[], b: readonly Action[]) => a.length === b.length && a.every((x) => b.includes(x));
const diff = (before: readonly Action[], after: readonly Action[]) => ({ added: ACTIONS.filter((a) => after.includes(a) && !before.includes(a)), removed: ACTIONS.filter((a) => before.includes(a) && !after.includes(a)) });

function roleView(ctx: OrgContext, role: Role, adjusts: RoleAdjusts): PermissionRoleView {
  const defaults = ACTIONS.filter((a) => POLICY[role].includes(a));
  const allowed = rolePermissions(role, adjusts);
  let holders = 0;
  for (const u of ctx.users.values()) if (u.status !== 'disabled' && u.roles.some((r) => r.role === role)) holders++;
  return { role, defaults, allowed, customized: !sameSet(defaults, allowed), holders };
}

/** Bảng quyền của tổ chức: mỗi vai trò có quyền mặc định, quyền thật, và số người đang giữ. */
export function getPermissionMatrix(ctx: OrgContext): PermissionMatrix {
  return {
    groups: ACTION_GROUPS.map((g) => ({ id: g.id, actions: [...g.actions] })),
    locked: [...LOCKED_ACTIONS],
    required: [...REQUIRED_HOLDERS],
    roles: ROLES.map((role) => roleView(ctx, role, ctx.roleAdjusts)),
  };
}

async function replaceRoleRules(tx: Tx, viewer: Viewer, role: Role, adj: { grants: readonly Action[]; revokes: readonly Action[] }): Promise<void> {
  const p = schema.permissionRules;
  await tx.delete(p).where(and(eq(p.subjectType, 'role'), eq(p.subject, role)));
  const rows = [
    ...adj.grants.map((action) => ({ action, effect: 'grant' })),
    ...adj.revokes.map((action) => ({ action, effect: 'revoke' })),
  ];
  if (rows.length === 0) return;
  await tx.insert(p).values(rows.map((r) => ({ orgId: viewer.orgId, subjectType: 'role', subject: role, action: r.action, effect: r.effect, updatedBy: viewer.id })));
}

/** Đặt bộ quyền của một vai trò. `allowed` là bộ mong muốn; chỉ phần khác bảng mặc định được lưu. */
export async function setRolePermissions(tx: Tx, ctx: OrgContext, viewer: Viewer, role: Role, allowed: readonly Action[], meta: RequestMeta = {}): Promise<PermissionRoleView> {
  const adj = adjustFromAllowed(role, allowed);
  const next: RoleAdjusts = { ...ctx.roleAdjusts, [role]: adj };
  const before = rolePermissions(role, ctx.roleAdjusts);
  const after = rolePermissions(role, next);
  if (sameSet(before, after)) return roleView(ctx, role, ctx.roleAdjusts);
  await assertManagersRemain(tx, viewer.orgId, { roleAdjusts: next }, ctx);
  await replaceRoleRules(tx, viewer, role, adj);
  await audit(tx, { orgId: viewer.orgId, action: 'permission_role_changed', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'role', ip: meta.ip, detail: { role, ...diff(before, after) } });
  return roleView(ctx, role, next);
}

/** Khôi phục quyền mặc định của một vai trò: xoá mọi chỉnh của tổ chức cho vai trò đó. */
export async function resetRolePermissions(tx: Tx, ctx: OrgContext, viewer: Viewer, role: Role, meta: RequestMeta = {}): Promise<PermissionRoleView> {
  const before = rolePermissions(role, ctx.roleAdjusts);
  const next: RoleAdjusts = { ...ctx.roleAdjusts };
  delete next[role];
  const after = rolePermissions(role, next);
  if (!ctx.roleAdjusts[role]) return roleView(ctx, role, ctx.roleAdjusts);
  await assertManagersRemain(tx, viewer.orgId, { roleAdjusts: next }, ctx);
  await replaceRoleRules(tx, viewer, role, { grants: [], revokes: [] });
  await audit(tx, { orgId: viewer.orgId, action: 'permission_role_reset', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'role', ip: meta.ip, detail: { role, ...diff(before, after) } });
  return roleView(ctx, role, next);
}

function userView(ctx: OrgContext, userId: string): UserPermissionsView {
  const u = ctx.users.get(userId);
  if (!u) throw new ApiError('not_found');
  const own = ctx.userAdjusts.get(userId) ?? { grants: [], revokes: [] };
  return {
    fromRoles: permissionsFromRoles(u.roles, ctx.roleAdjusts),
    grants: ACTIONS.filter((a) => own.grants.includes(a)),
    revokes: ACTIONS.filter((a) => own.revokes.includes(a)),
    effective: u.permissions,
    locked: [...LOCKED_ACTIONS],
  };
}

/** Quyền của một người: từ vai trò (đã tính chỉnh của tổ chức), chỉnh riêng đang lưu, và quyền thật. */
export function getUserPermissions(ctx: OrgContext, userId: string): UserPermissionsView {
  return userView(ctx, userId);
}

/**
 * Đặt chỉnh riêng của một người so với quyền từ vai trò của họ. Chỉ lưu phần có tác dụng: thêm quyền vai trò đã có, hay bớt quyền
 * vai trò không có, là thừa nên bỏ. Cùng một quyền vừa thêm vừa bớt, hoặc bớt quyền bị khoá, là 422. Không đổi vai trò của người đó.
 */
export async function setUserPermissions(tx: Tx, ctx: OrgContext, viewer: Viewer, userId: string, body: Adjust, meta: RequestMeta = {}): Promise<UserPermissionsView> {
  const user = ctx.users.get(userId);
  if (!user) throw new ApiError('not_found');
  const base = permissionsFromRoles(user.roles, ctx.roleAdjusts);
  const norm = normalizeAdjust(base, body);
  if (!norm.ok) {
    const field = norm.reason === 'both' ? 'grants' : 'revokes';
    throw new ApiError('input_invalid', { errors: norm.actions.map((a) => ({ path: `body.${field}.${a}`, code: norm.reason === 'both' ? 'grant_and_revoke' : 'locked' })) });
  }
  const before = user.permissions;
  const nextAdjusts = new Map(ctx.userAdjusts);
  if (norm.value.grants.length === 0 && norm.value.revokes.length === 0) nextAdjusts.delete(userId);
  else nextAdjusts.set(userId, norm.value);
  const after = effectivePermissions(user.roles, ctx.roleAdjusts, nextAdjusts.get(userId));
  if (sameSet(before, after) && sameSet(ctx.userAdjusts.get(userId)?.grants ?? [], norm.value.grants) && sameSet(ctx.userAdjusts.get(userId)?.revokes ?? [], norm.value.revokes)) return userView(ctx, userId);
  await assertManagersRemain(tx, viewer.orgId, { userAdjusts: nextAdjusts }, ctx);

  const p = schema.permissionRules;
  await tx.delete(p).where(and(eq(p.subjectType, 'user'), eq(p.subject, userId)));
  const rows = [...norm.value.grants.map((action) => ({ action, effect: 'grant' })), ...norm.value.revokes.map((action) => ({ action, effect: 'revoke' }))];
  if (rows.length > 0) await tx.insert(p).values(rows.map((r) => ({ orgId: viewer.orgId, subjectType: 'user', subject: userId, action: r.action, effect: r.effect, updatedBy: viewer.id })));
  await audit(tx, { orgId: viewer.orgId, action: 'permission_user_changed', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'user', targetId: userId, ip: meta.ip, detail: { grants: norm.value.grants, revokes: norm.value.revokes, ...diff(before, after) } });

  // Nạp lại để trả đúng quyền thật sau khi ghi.
  return userView(await loadOrgContext(tx, viewer.orgId), userId);
}
