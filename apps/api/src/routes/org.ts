import {
  createDelegation,
  createUnit,
  createUser,
  createUserActivation,
  createUserPasswordLink,
  resendInviteEmail,
  clearEmailSettings,
  getEmailSettings,
  putEmailSettings,
  sendTestEmail,
  deleteDelegation,
  deleteHoliday,
  disableUser,
  enableUser,
  getOrgSettings,
  getPermissionMatrix,
  getUser,
  getUserPermissions,
  holidaySuggestions,
  importUsers,
  listDelegations,
  listDevices,
  listHolidays,
  listUnits,
  listUsers,
  patchOrgSettings,
  putHoliday,
  resetRolePermissions,
  revokeDevice,
  searchPeople,
  setRolePermissions,
  setUserPermissions,
  setUserRoles,
  updateUnit,
  updateUser,
} from '@mihato/backend';
import type { Registrar } from '../registrar';

/**
 * SPEC 10.3 và phần thiết bị của 10.2: người dùng, vai trò, đơn vị, thiết bị, ủy quyền, ngày nghỉ, cấu hình tổ chức.
 * Quyền theo vai trò đã được registrar kiểm từ bảng hợp đồng; quyền theo từng tài nguyên (ủy quyền của ai) kiểm ở service.
 */
export function registerOrgRoutes(r: Registrar): void {
  r.user('people.search', async ({ ctx, input }) => ({ items: searchPeople(ctx, input.query.q, input.query.limit) }));

  r.user('users.list', ({ tx, input }) => listUsers(tx, input.query));
  r.user('users.create', ({ tx, viewer, input, meta }) => createUser(tx, viewer, input.body, meta));
  r.user('users.get', ({ tx, input }) => getUser(tx, input.params.id));
  r.user('users.update', ({ tx, viewer, input, rawBody, meta }) => updateUser(tx, viewer, input.params.id, input.body, rawBody, meta));
  r.user('users.import', ({ tx, viewer, input, meta }) => importUsers(tx, viewer, input.body.csv, input.query.dryRun === 'true', meta));
  r.user('users.disable', ({ tx, viewer, input, idempotencyKey, meta }) => disableUser(tx, viewer, input.params.id, idempotencyKey, meta));
  r.user('users.enable', ({ tx, viewer, input, meta }) => enableUser(tx, viewer, input.params.id, meta));
  r.user('users.setRoles', ({ tx, viewer, input, meta }) => setUserRoles(tx, viewer, input.params.id, input.body.roles, meta));
  // Chỉnh quyền (docs/DECISIONS.md, 05/10/2026): quyền `permission.manage` đã được registrar kiểm từ bảng hợp đồng.
  r.user('permissions.get', async ({ ctx }) => getPermissionMatrix(ctx));
  r.user('permissions.setRole', ({ tx, ctx, viewer, input, meta }) => setRolePermissions(tx, ctx, viewer, input.params.role, input.body.allowed, meta));
  r.user('permissions.resetRole', ({ tx, ctx, viewer, input, meta }) => resetRolePermissions(tx, ctx, viewer, input.params.role, meta));
  r.user('users.permissions', async ({ ctx, input }) => getUserPermissions(ctx, input.params.id));
  r.user('users.setPermissions', ({ tx, ctx, viewer, input, meta }) => setUserPermissions(tx, ctx, viewer, input.params.id, input.body, meta));
  r.user('users.activation', ({ tx, viewer, input }) => createUserActivation(tx, viewer, input.params.id, input.query.app));
  r.user('users.passwordLink', ({ tx, viewer, input, meta }) => createUserPasswordLink(tx, viewer, input.params.id, meta));
  r.user('org.emailGet', ({ tx, viewer }) => getEmailSettings(tx, viewer.orgId));
  r.user('org.emailPut', ({ tx, viewer, input, meta }) => putEmailSettings(tx, viewer, input.body, meta));
  r.user('org.emailDelete', ({ tx, viewer, meta }) => clearEmailSettings(tx, viewer, meta));
  r.user('org.emailTest', ({ tx, viewer, input, meta }) => sendTestEmail(tx, viewer, input.body.to, meta));
  r.user('users.inviteEmail', ({ tx, viewer, input, meta }) => resendInviteEmail(tx, viewer, input.params.id, meta));

  r.user('devices.list', async ({ tx, input }) => ({ items: await listDevices(tx, { userId: input.query.userId }) }));
  r.user('devices.revoke', async ({ tx, viewer, input, meta }) => {
    await revokeDevice(tx, viewer, input.params.id, meta);
    return { ok: true };
  });

  r.user('units.list', async ({ tx }) => ({ items: await listUnits(tx) }));
  r.user('units.create', ({ tx, viewer, input, meta }) => createUnit(tx, viewer, input.body, meta));
  r.user('units.update', ({ tx, viewer, input, rawBody, meta }) => updateUnit(tx, viewer, input.params.id, input.body, rawBody, meta));

  r.user('delegations.list', async ({ tx, ctx, viewer }) => ({ items: await listDelegations(tx, ctx, viewer) }));
  r.user('delegations.create', ({ tx, ctx, viewer, input, stepUpToken, meta }) => createDelegation(tx, ctx, viewer, input.body, { stepUpToken, meta }));
  r.user('delegations.delete', async ({ tx, viewer, input, meta }) => {
    await deleteDelegation(tx, viewer, input.params.id, meta);
    return { ok: true };
  });

  r.user('holidays.list', async ({ tx, input }) => ({ items: await listHolidays(tx, input.query.year) }));
  r.user('holidays.suggestions', async ({ tx, input }) => ({ items: await holidaySuggestions(tx, input.query.year) }));
  r.user('holidays.put', ({ tx, viewer, input, meta }) => putHoliday(tx, viewer, input.params.day, input.body, meta));
  r.user('holidays.delete', async ({ tx, viewer, input, meta }) => {
    await deleteHoliday(tx, viewer, input.params.day, meta);
    return { ok: true };
  });

  r.user('org.settingsGet', async ({ ctx }) => getOrgSettings(ctx));
  // Thân yêu cầu THÔ: chỉ khoá người gọi thật sự gửi mới được áp (Zod 4 điền mặc định cho khoá vắng mặt).
  r.user('org.settingsPatch', ({ tx, viewer, rawBody, meta }) => patchOrgSettings(tx, viewer, rawBody, meta));
}
