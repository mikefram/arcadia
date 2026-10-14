import { closeDb, setFakeNow, type SeedIds } from '@mihato/backend';
import type { Me, PermissionMatrix, UserPermissionsView } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Chỉnh quyền qua API thật (docs/DECISIONS.md, 05/10/2026): quyền thật của từng người thay đổi ngay ở yêu cầu kế tiếp,
 * cả khi tổ chức chỉnh theo vai trò lẫn khi chỉnh riêng; chỉ người có `permission.manage` chỉnh được; không tự khoá mình ra.
 */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;

beforeAll(async () => {
  ids = await freshOrg('perm');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
  setFakeNow(new Date('2026-10-05T02:00:00Z'));
});
afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await closeDb();
});

const startBody = () => ({ templateId: ids.TEMPLATE_DON_DOAN, title: 'Đón đoàn thử quyền', inputs: { delegation: 'Đoàn thử', visitDate: '2026-10-23' } });
const putUser = (id: string, grants: string[], revokes: string[]) => call<UserPermissionsView>('U_IT', 'PUT', `/v1/users/${id}/permissions`, { grants, revokes });

describe('ai được vào màn Phân quyền', () => {
  it('chỉ Quản trị hệ thống và Chủ tịch (mặc định); Văn phòng, Giám đốc, nhân viên bị 403 ở cả năm route', async () => {
    const routes: ['GET' | 'PUT' | 'POST', string, unknown][] = [
      ['GET', '/v1/permissions', undefined],
      ['PUT', '/v1/permissions/roles/employee', { allowed: ['self.read'] }],
      ['POST', '/v1/permissions/roles/employee/reset', undefined],
      ['GET', `/v1/users/${ids.users.U_LAN}/permissions`, undefined],
      ['PUT', `/v1/users/${ids.users.U_LAN}/permissions`, { grants: [], revokes: [] }],
    ];
    for (const who of ['U_ADMIN', 'U_DIRECTOR', 'U_LAN', 'U_DESIGNER'] as const) {
      for (const [method, url, body] of routes) expect((await call(who, method, url, body)).status, `${who} ${method} ${url}`).toBe(403);
    }
    for (const who of ['U_IT', 'U_CHAIRMAN'] as const) expect((await call(who, 'GET', '/v1/permissions')).status, who).toBe(200);
  });

  it('GET /v1/permissions trả bảng đủ bảy vai trò kèm quyền mặc định', async () => {
    const res = await call<PermissionMatrix>('U_IT', 'GET', '/v1/permissions');
    expect(res.body.roles.map((r) => r.role)).toHaveLength(7);
    expect(res.body.roles.find((r) => r.role === 'employee')).toMatchObject({ customized: false, defaults: ['self.read', 'step.act_own', 'delegation.self'] });
    expect(res.body.required).toEqual(['permission.manage', 'user.manage']);
  });
});

describe('chỉnh riêng một người có hiệu lực ngay', () => {
  it('nhân viên chưa có run.start nên khởi chạy bị 403; được thêm quyền thì khởi chạy được; bỏ chỉnh thì lại bị 403', async () => {
    expect((await call('U_LAN', 'POST', '/v1/runs', startBody())).status).toBe(403);
    const added = await putUser(ids.users.U_LAN, ['run.start'], []);
    expect(added.status).toBe(200);
    expect(added.body.effective).toContain('run.start');
    expect((await call('U_LAN', 'POST', '/v1/runs', startBody())).status).toBe(201);
    // Người cùng vai trò không được thêm thì vẫn bị từ chối.
    expect((await call('U_HUNG', 'POST', '/v1/runs', startBody())).status).toBe(403);
    expect((await putUser(ids.users.U_LAN, [], [])).status).toBe(200);
    expect((await call('U_LAN', 'POST', '/v1/runs', startBody())).status).toBe(403);
  });

  it('/v1/me phản ánh quyền thật để giao diện ẩn hiện nút đúng', async () => {
    const before = await call<Me>('U_TUAN', 'GET', '/v1/me');
    expect(before.body.permissions).toEqual(['self.read', 'step.act_own', 'delegation.self']);
    await putUser(ids.users.U_TUAN, ['report.view'], ['delegation.self']);
    const after = await call<Me>('U_TUAN', 'GET', '/v1/me');
    expect(after.body.permissions).toEqual(['self.read', 'step.act_own', 'report.view']);
    expect(after.body.roles).toEqual(before.body.roles);
    await putUser(ids.users.U_TUAN, [], []);
  });

  it('bớt quyền riêng của một người có hiệu lực ở route có khai quyền: Văn phòng bị bớt run.start thì khởi chạy 403, đồng nghiệp cùng vai thì không', async () => {
    expect((await call('U_ADMIN', 'POST', '/v1/runs', startBody())).status).toBe(201);
    await putUser(ids.users.U_ADMIN, [], ['run.start']);
    expect((await call('U_ADMIN', 'POST', '/v1/runs', startBody())).status).toBe(403);
    await putUser(ids.users.U_ADMIN, [], []);
    expect((await call('U_ADMIN', 'POST', '/v1/runs', startBody())).status).toBe(201);
  });

  it('cùng một quyền vừa thêm vừa bớt, hay bớt quyền bị khoá, là 422', async () => {
    const both = await putUser(ids.users.U_LAN, ['report.view'], ['report.view']);
    expect(both.status).toBe(422);
    expect(await putUser(ids.users.U_LAN, [], ['self.read'])).toMatchObject({ status: 422 });
  });
});

describe('chỉnh theo vai trò có hiệu lực ngay', () => {
  it('thêm run.start cho vai Nhân viên thì mọi nhân viên khởi chạy được; khôi phục mặc định thì lại bị 403', async () => {
    const put = await call<{ customized: boolean; allowed: string[] }>('U_IT', 'PUT', '/v1/permissions/roles/employee', { allowed: ['self.read', 'step.act_own', 'delegation.self', 'run.start'] });
    expect(put.status).toBe(200);
    expect(put.body.customized).toBe(true);
    expect((await call('U_HUNG', 'POST', '/v1/runs', startBody())).status).toBe(201);
    const reset = await call<{ customized: boolean }>('U_IT', 'POST', '/v1/permissions/roles/employee/reset');
    expect(reset.body.customized).toBe(false);
    expect((await call('U_HUNG', 'POST', '/v1/runs', startBody())).status).toBe(403);
  });

  it('bớt xem báo cáo khỏi vai Giám đốc thì route báo cáo của Giám đốc bị 403, Phó giám đốc vẫn xem được', async () => {
    const q = '/v1/reports/summary?from=2026-10-01&to=2026-10-31';
    expect((await call('U_DIRECTOR', 'GET', q)).status).toBe(200);
    const director = (await call<PermissionMatrix>('U_IT', 'GET', '/v1/permissions')).body.roles.find((r) => r.role === 'director')!;
    await call('U_IT', 'PUT', '/v1/permissions/roles/director', { allowed: director.allowed.filter((a) => a !== 'report.view') });
    expect((await call('U_DIRECTOR', 'GET', q)).status).toBe(403);
    expect((await call('U_HUY', 'GET', q)).status).toBe(200);
    await call('U_IT', 'POST', '/v1/permissions/roles/director/reset');
    expect((await call('U_DIRECTOR', 'GET', q)).status).toBe(200);
  });
});

describe('không tự khoá mình ra', () => {
  it('bớt permission.manage khỏi vai trò Chủ tịch khi Quản trị hệ thống đã mất nó là 422 last_permission_manager', async () => {
    const roles = (await call<PermissionMatrix>('U_IT', 'GET', '/v1/permissions')).body.roles;
    const it = roles.find((r) => r.role === 'it_admin')!;
    const chairman = roles.find((r) => r.role === 'chairman')!;
    expect((await call('U_CHAIRMAN', 'PUT', '/v1/permissions/roles/it_admin', { allowed: it.allowed.filter((a) => a !== 'permission.manage') })).status).toBe(200);
    // Quản trị hệ thống không còn vào được màn Phân quyền.
    expect((await call('U_IT', 'GET', '/v1/permissions')).status).toBe(403);
    const res = await call<{ errors: { path: string; code: string }[] }>('U_CHAIRMAN', 'PUT', '/v1/permissions/roles/chairman', { allowed: chairman.allowed.filter((a) => a !== 'permission.manage') });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ path: 'body', code: 'last_permission_manager' }]);
    // Khôi phục để các bài sau không bị ảnh hưởng.
    expect((await call('U_CHAIRMAN', 'POST', '/v1/permissions/roles/it_admin/reset')).status).toBe(200);
  });
});
