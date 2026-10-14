import { ACTIONS, newId, can, type Action } from '@mihato/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrgContext } from '../src/context';
import { closeDb, schema } from '../src/db/client';
import { loadEffectivePermissions } from '../src/permissions';
import { createTestOrg, type TestOrg } from '../src/testing';
import { disableUser, setUserRoles } from '../src/services/org';
import { getPermissionMatrix, getUserPermissions, resetRolePermissions, setRolePermissions, setUserPermissions } from '../src/services/permissions';
import { actOnStep, startRun } from '../src/services/runs';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { auditRows, expectApiError, twoTaskDefinition } from './helpers';

/**
 * Chỉnh quyền theo vai trò và riêng từng người (docs/DECISIONS.md, 05/10/2026), với PostgreSQL thật.
 * Mỗi test tạo tổ chức riêng. Người mẫu: chairman, director, deputy, officeAdmin, designer, itAdmin, head, employee (Lan), employee2 (Tuấn).
 */
afterAll(async () => {
  await closeDb();
});

const cfg = (org: TestOrg) => org.viewer('itAdmin');
const permsOf = async (org: TestOrg, who: keyof TestOrg['users']) => org.run(async (_tx, ctx) => ctx.users.get(org.users[who])!.permissions);

describe('bảng quyền của tổ chức', () => {
  it('chưa chỉnh gì thì đúng bảng mặc định; mỗi vai trò có số người giữ', async () => {
    const org = await createTestOrg();
    const matrix = await org.run(async (_tx, ctx) => getPermissionMatrix(ctx));
    expect(matrix.roles.map((r) => r.role)).toEqual(['chairman', 'director', 'deputy', 'office_admin', 'process_designer', 'it_admin', 'employee']);
    expect(matrix.roles.every((r) => !r.customized && r.allowed.join() === r.defaults.join())).toBe(true);
    expect(matrix.roles.find((r) => r.role === 'employee')?.holders).toBe(3); // head, employee, employee2
    expect(matrix.locked).toEqual(['self.read']);
    expect(matrix.groups.flatMap((g) => g.actions).sort()).toEqual([...ACTIONS].sort());
  });

  it('đổi quyền của vai trò: mọi người giữ vai trò đó đổi theo, vai trò khác không đổi; có nhật ký chỉ ghi khoá quyền', async () => {
    const org = await createTestOrg();
    const before = await permsOf(org, 'employee');
    const next = [...before, 'report.view', 'run.view_all'] as Action[];
    const view = await org.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(org), 'employee', next));
    expect(view).toMatchObject({ role: 'employee', customized: true });
    expect(view.allowed).toEqual(expect.arrayContaining(['report.view', 'run.view_all']));
    expect(await permsOf(org, 'employee')).toEqual(expect.arrayContaining(['report.view', 'run.view_all']));
    expect(await permsOf(org, 'employee2')).toEqual(expect.arrayContaining(['report.view']));
    expect(await permsOf(org, 'director')).not.toEqual(expect.arrayContaining(['permission.manage']));

    const logs = await org.run((tx) => auditRows(tx, 'permission_role_changed'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toEqual({ role: 'employee', added: ['run.view_all', 'report.view'], removed: [] });
    expect(JSON.stringify(logs[0]!.detail)).not.toContain('Nguyễn');
  });

  it('gửi lại đúng bộ hiện có thì không ghi gì thêm; khôi phục mặc định xoá chỉnh', async () => {
    const org = await createTestOrg();
    const base = await permsOf(org, 'employee');
    await org.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(org), 'employee', base));
    expect(await org.run((tx) => auditRows(tx, 'permission_role_changed'))).toHaveLength(0);

    await org.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(org), 'employee', [...base, 'report.view'] as Action[]));
    const reset = await org.run((tx, ctx) => resetRolePermissions(tx, ctx, cfg(org), 'employee'));
    expect(reset.customized).toBe(false);
    expect(await permsOf(org, 'employee')).toEqual(base);
    expect(await org.run((tx) => tx.select().from(schema.permissionRules))).toEqual([]);
    expect(await org.run((tx) => auditRows(tx, 'permission_role_reset'))).toHaveLength(1);
  });

  it('quyền đọc hồ sơ của chính mình luôn còn, dù bộ mong muốn bỏ sót', async () => {
    const org = await createTestOrg();
    const view = await org.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(org), 'employee', []));
    expect(view.allowed).toContain('self.read');
  });
});

describe('chỉnh riêng từng người (ví dụ Josh)', () => {
  it('thêm một quyền và bớt một quyền cho một người mà vai trò và người cùng vai không đổi', async () => {
    const org = await createTestOrg();
    const view = await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: ['report.view'], revokes: ['delegation.self'] }));
    expect(view.fromRoles).toEqual(['self.read', 'step.act_own', 'delegation.self']);
    expect(view.grants).toEqual(['report.view']);
    expect(view.revokes).toEqual(['delegation.self']);
    expect(view.effective).toEqual(['self.read', 'step.act_own', 'report.view']);
    expect(await permsOf(org, 'employee')).toEqual(view.effective);
    // Đọc lại từ CSDL ra đúng bản vừa lưu.
    expect(await org.run(async (_tx, ctx) => getUserPermissions(ctx, org.users.employee))).toEqual(view);
    expect(await permsOf(org, 'employee2')).toEqual(['self.read', 'step.act_own', 'delegation.self']);
    const logs = await org.run((tx) => auditRows(tx, 'permission_user_changed'));
    expect(logs[0]!.detail).toMatchObject({ grants: ['report.view'], revokes: ['delegation.self'], added: ['report.view'], removed: ['delegation.self'] });
  });

  it('đổi vai trò của người đó không làm mất chỉnh riêng; đổi quyền của vai trò thì chỉnh riêng vẫn thắng', async () => {
    const org = await createTestOrg();
    await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: ['report.view'], revokes: ['step.act_own'] }));
    await org.run((tx) => setUserRoles(tx, cfg(org), org.users.employee, [{ role: 'office_admin', unitId: null }]));
    const asOffice = await permsOf(org, 'employee');
    expect(asOffice).toContain('step.reassign');
    expect(asOffice).toContain('report.view');
    expect(asOffice).not.toContain('step.act_own');
    // Vai trò Nhân viên được tổ chức thêm "step.act_own" lần nữa không cứu được quyền đã bị bớt riêng.
    await org.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(org), 'office_admin', [...ctx.users.get(org.users.employee)!.permissions, 'step.act_own'] as Action[]));
    expect(await permsOf(org, 'employee')).not.toContain('step.act_own');
  });

  it('thêm quyền vai trò đã có, hay bớt quyền vai trò không có, là thừa nên không lưu; gửi hai mảng rỗng là bỏ hết chỉnh riêng', async () => {
    const org = await createTestOrg();
    const view = await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: ['step.act_own'], revokes: ['run.start'] }));
    expect(view).toMatchObject({ grants: [], revokes: [] });
    await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: ['report.view'], revokes: [] }));
    const cleared = await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: [], revokes: [] }));
    expect(cleared).toMatchObject({ grants: [], revokes: [] });
    expect(await org.run((tx) => tx.select().from(schema.permissionRules))).toEqual([]);
  });

  it('lỗi: cùng một quyền vừa thêm vừa bớt, bớt quyền bị khoá, người không có', async () => {
    const org = await createTestOrg();
    const both = await expectApiError(org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: ['report.view'], revokes: ['report.view'] })), 'input_invalid');
    expect(both.extra.errors).toEqual([{ path: 'body.grants.report.view', code: 'grant_and_revoke' }]);
    const locked = await expectApiError(org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee, { grants: [], revokes: ['self.read'] })), 'input_invalid');
    expect(locked.extra.errors).toEqual([{ path: 'body.revokes.self.read', code: 'locked' }]);
    await expectApiError(org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), newId(), { grants: [], revokes: [] })), 'not_found');
  });
});

describe('quyền thật được dùng ở mọi nơi kiểm quyền', () => {
  it('viewer lúc xác thực mang quyền hiệu lực: chỉnh của vai trò và chỉnh riêng đều có mặt', async () => {
    const org = await createTestOrg();
    await org.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(org), 'employee', [...ctx.users.get(org.users.employee)!.permissions, 'report.view'] as Action[]));
    await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.employee2, { grants: ['run.start'], revokes: ['delegation.self'] }));
    const lan = await org.run((tx) => loadEffectivePermissions(tx, org.users.employee, [{ role: 'employee', unitId: null }]));
    const tuan = await org.run((tx) => loadEffectivePermissions(tx, org.users.employee2, [{ role: 'employee', unitId: null }]));
    expect(can({ permissions: lan }, 'report.view')).toBe(true);
    expect(can({ permissions: lan }, 'run.start')).toBe(false);
    expect(can({ permissions: tuan }, 'run.start')).toBe(true);
    expect(can({ permissions: tuan }, 'delegation.self')).toBe(false);
  });

  it('engine theo quyền: Giám đốc bị bớt "gia hạn" thì không gia hạn được việc của lượt do người khác khởi chạy', async () => {
    const org = await createTestOrg();
    const office = org.viewer('office_admin');
    const designer = org.viewer('process_designer');
    const tpl = await org.run((tx, ctx) => createTemplate(tx, ctx, designer, { name: 'Mẫu gia hạn', description: null, definition: twoTaskDefinition('Mẫu gia hạn', org.users.employee, org.users.employee2) }));
    await org.run((tx, ctx) => publishTemplate(tx, ctx, designer, tpl.id));
    const run = await org.run((tx, ctx) => startRun(tx, ctx, office, { templateId: tpl.id, title: 'Lượt của Văn phòng', inputs: {} }, newId()));
    const stepId = run.steps.find((s) => s.state === 'ready')!.id;
    const newDueAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const director = () => org.run(async (_tx, ctx) => ({ ...org.viewer('director'), permissions: ctx.users.get(org.users.director)!.permissions }));
    await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.director, { grants: [], revokes: ['step.extend'] }));
    const d = await director();
    await expectApiError(org.run((tx, ctx) => actOnStep(tx, ctx, d, stepId, newId(), { type: 'ExtendDue', newDueAt, reason: 'thử' })), 'forbidden');
    // Khôi phục: bỏ chỉnh riêng thì gia hạn lại được.
    await org.run((tx, ctx) => setUserPermissions(tx, ctx, cfg(org), org.users.director, { grants: [], revokes: [] }));
    const d2 = await director();
    await org.run((tx, ctx) => actOnStep(tx, ctx, d2, stepId, newId(), { type: 'ExtendDue', newDueAt, reason: 'thử' }));
  });
});

describe('không tự khoá mình ra khỏi hệ thống', () => {
  it('không bớt quyền phân quyền khỏi vai trò cuối cùng còn giữ nó; chấp nhận khi còn người khác giữ', async () => {
    const org = await createTestOrg();
    // Mặc định: Chủ tịch và Quản trị hệ thống đều giữ permission.manage. Bớt khỏi Quản trị hệ thống thì Chủ tịch vẫn còn.
    const itRole = await org.run(async (_tx, ctx) => ctx.users.get(org.users.itAdmin)!.permissions);
    await org.run((tx, ctx) => setRolePermissions(tx, ctx, org.viewer('chairman'), 'it_admin', itRole.filter((a) => a !== 'permission.manage')));
    expect(await permsOf(org, 'itAdmin')).not.toContain('permission.manage');
    // Giờ Chủ tịch là người cuối: bớt khỏi Chủ tịch bị từ chối, và bớt riêng của Chủ tịch cũng vậy.
    const chair = await permsOf(org, 'chairman');
    const e1 = await expectApiError(org.run((tx, ctx) => setRolePermissions(tx, ctx, org.viewer('chairman'), 'chairman', chair.filter((a) => a !== 'permission.manage'))), 'input_invalid');
    expect(e1.extra.errors).toEqual([{ path: 'body', code: 'last_permission_manager' }]);
    await expectApiError(org.run((tx, ctx) => setUserPermissions(tx, ctx, org.viewer('chairman'), org.users.chairman, { grants: [], revokes: ['permission.manage'] })), 'input_invalid');
  });

  it('không vô hiệu hoá hay đổi vai trò người cuối cùng còn giữ quyền quản lý người dùng', async () => {
    const org = await createTestOrg();
    // Cho Quản trị hệ thống mất user.manage; Chủ tịch (toàn quyền) giữ.
    await org.run((tx, ctx) => setUserPermissions(tx, ctx, org.viewer('chairman'), org.users.itAdmin, { grants: [], revokes: ['user.manage'] }));
    const e = await expectApiError(org.run((tx) => disableUser(tx, org.viewer('chairman'), org.users.chairman, newId())), 'input_invalid');
    expect(e.extra.errors).toEqual([{ path: 'body', code: 'last_user_manager' }]);
    await expectApiError(org.run((tx) => setUserRoles(tx, org.viewer('chairman'), org.users.chairman, [{ role: 'employee', unitId: null }])), 'input_invalid');
  });

  it('dữ liệu cũ đã thiếu người giữ quyền thì không chặn các thay đổi không liên quan', async () => {
    const org = await createTestOrg();
    const view = await org.run((tx, ctx) => setRolePermissions(tx, ctx, org.viewer('chairman'), 'employee', [...ctx.users.get(org.users.employee)!.permissions, 'report.view'] as Action[]));
    expect(view.customized).toBe(true);
  });
});

describe('cô lập tổ chức', () => {
  it('chỉnh quyền của tổ chức này không đổi quyền ở tổ chức khác', async () => {
    const a = await createTestOrg();
    const b = await createTestOrg();
    await a.run((tx, ctx) => setRolePermissions(tx, ctx, cfg(a), 'employee', [...ctx.users.get(a.users.employee)!.permissions, 'report.view'] as Action[]));
    expect(await permsOf(a, 'employee')).toContain('report.view');
    expect(await permsOf(b, 'employee')).not.toContain('report.view');
    const ctxB = await b.run(async (tx) => loadOrgContext(tx, b.orgId));
    expect(ctxB.roleAdjusts).toEqual({});
  });
});
