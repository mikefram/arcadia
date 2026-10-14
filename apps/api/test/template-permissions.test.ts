import { closeDb, type SeedIds } from '@mihato/backend';
import type { PermissionMatrix, TemplateDetail, TemplateSummary, UserPermissionsView } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Quyền về mẫu quy trình tách làm ba (docs/DECISIONS.md, 05/10/2026): `template.edit` (tạo và sửa nháp), `template.publish` (xuất bản),
 * `template.archive` (lưu trữ). Mặc định Nhà thiết kế quy trình có đủ ba như trước khi tách; chỉnh quyền riêng thì từng việc tách được,
 * và người chỉ xuất bản thấy được nháp, người chỉ lưu trữ thấy được mẫu đã lưu trữ.
 */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;

beforeAll(async () => {
  ids = await freshOrg('tplperm');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

const putUser = (code: keyof SeedIds['users'], grants: string[], revokes: string[]) => call<UserPermissionsView>('U_IT', 'PUT', `/v1/users/${ids.users[code]}/permissions`, { grants, revokes });
/** Nhân bản mẫu dữ liệu mẫu: bản nháp đầu đã hợp lệ nên xuất bản được ngay. */
const clone = (who: Parameters<Caller>[0], name: string) => call<TemplateDetail>(who, 'POST', '/v1/templates', { name, cloneFromTemplateId: ids.TEMPLATE_DON_DOAN });
const list = (who: Parameters<Caller>[0]) => call<{ items: TemplateSummary[] }>(who, 'GET', '/v1/templates');

describe('mặc định không đổi sau khi tách', () => {
  it('bảng quyền: Nhà thiết kế quy trình có đủ ba quyền; Văn phòng và nhân viên không có quyền nào về mẫu ngoài xem', async () => {
    const matrix = await call<PermissionMatrix>('U_IT', 'GET', '/v1/permissions');
    const defaults = (role: string) => matrix.body.roles.find((r) => r.role === role)!.defaults;
    for (const action of ['template.edit', 'template.publish', 'template.archive']) {
      expect(defaults('process_designer'), action).toContain(action);
      expect(defaults('chairman'), action).toContain(action);
      expect(defaults('office_admin'), action).not.toContain(action);
      expect(defaults('employee'), action).not.toContain(action);
    }
    expect(matrix.body.groups.find((g) => g.id === 'templates')!.actions).toEqual(['template.read_published', 'template.simulate', 'template.edit', 'template.publish', 'template.archive']);
  });

  it('Nhà thiết kế tạo, kiểm tra, xuất bản, lưu trữ và bỏ lưu trữ như trước; Văn phòng bị 403 ở cả bốn việc', async () => {
    const made = await clone('U_DESIGNER', 'Mẫu mặc định');
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect((await call('U_DESIGNER', 'POST', `/v1/templates/${id}/validate`)).status).toBe(200);
    for (const [method, url] of [
      ['POST', '/v1/templates'],
      ['POST', `/v1/templates/${id}/validate`],
      ['POST', `/v1/templates/${id}/publish`],
      ['POST', `/v1/templates/${id}/archive`],
    ] as const) {
      expect((await call('U_ADMIN', method, url, method === 'POST' && url === '/v1/templates' ? { name: 'x' } : undefined)).status, `${method} ${url}`).toBe(403);
    }
    expect((await call<{ version: number }>('U_DESIGNER', 'POST', `/v1/templates/${id}/publish`)).body.version).toBe(1);
    expect((await call<TemplateSummary>('U_DESIGNER', 'POST', `/v1/templates/${id}/archive`)).body.archivedAt).not.toBeNull();
    expect((await call<TemplateSummary>('U_DESIGNER', 'POST', `/v1/templates/${id}/archive`, { archived: false })).body.archivedAt).toBeNull();
  });
});

describe('tạo và sửa nhưng không xuất bản', () => {
  it('Nhà thiết kế bị bớt template.publish: tạo, lưu nháp, kiểm tra được; xuất bản 403; nháp vẫn còn đó cho người có quyền xuất bản', async () => {
    expect((await putUser('U_DESIGNER', [], ['template.publish'])).status).toBe(200);
    const made = await clone('U_DESIGNER', 'Mẫu chờ xuất bản');
    expect(made.status).toBe(201);
    const id = made.body.id;
    const draft = made.body.draft!;
    expect((await call('U_DESIGNER', 'PUT', `/v1/templates/${id}/draft`, { definition: draft.definition }, { 'if-match': String(draft.rev) })).status).toBe(200);
    expect((await call('U_DESIGNER', 'POST', `/v1/templates/${id}/validate`)).status).toBe(200);
    expect((await call<{ code: string }>('U_DESIGNER', 'POST', `/v1/templates/${id}/publish`)).body.code).toBe('forbidden');
    // Người khác cùng vai trò không bị ảnh hưởng; Chủ tịch xuất bản được.
    expect((await call<{ version: number }>('U_CHAIRMAN', 'POST', `/v1/templates/${id}/publish`)).body.version).toBe(1);
    // Chỉnh riêng chỉ chặn xuất bản: lưu trữ vẫn được.
    expect((await call('U_DESIGNER', 'POST', `/v1/templates/${id}/archive`)).status).toBe(200);
    await call('U_DESIGNER', 'POST', `/v1/templates/${id}/archive`, { archived: false });
    expect((await putUser('U_DESIGNER', [], [])).status).toBe(200);
  });
});

describe('chỉ xuất bản, không sửa', () => {
  it('Văn phòng được thêm template.publish: thấy nháp, kiểm tra và xuất bản được; vẫn không tạo, không sửa nháp, không lưu trữ', async () => {
    const made = await clone('U_DESIGNER', 'Mẫu cho Văn phòng duyệt');
    const id = made.body.id;
    // Chưa được thêm quyền: không thấy mẫu chưa xuất bản.
    expect((await list('U_ADMIN')).body.items.map((t) => t.id)).not.toContain(id);
    expect((await call('U_ADMIN', 'GET', `/v1/templates/${id}`)).status).toBe(404);

    expect((await putUser('U_ADMIN', ['template.publish'], [])).status).toBe(200);
    const seen = (await list('U_ADMIN')).body.items.find((t) => t.id === id);
    expect(seen).toMatchObject({ hasDraft: true, latestPublishedVersion: null });
    const detail = await call<TemplateDetail>('U_ADMIN', 'GET', `/v1/templates/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.draft).not.toBeNull();
    expect((await call('U_ADMIN', 'GET', `/v1/templates/${id}/versions/1`)).status).toBe(200);
    expect((await call('U_ADMIN', 'POST', `/v1/templates/${id}/validate`)).status).toBe(200);

    // Không có quyền sửa và lưu trữ.
    expect((await call('U_ADMIN', 'POST', '/v1/templates', { name: 'x' })).status).toBe(403);
    expect((await call('U_ADMIN', 'PUT', `/v1/templates/${id}/draft`, { definition: detail.body.draft!.definition }, { 'if-match': String(detail.body.draft!.rev) })).status).toBe(403);
    expect((await call('U_ADMIN', 'POST', `/v1/templates/${id}/archive`)).status).toBe(403);

    const published = await call<{ version: number }>('U_ADMIN', 'POST', `/v1/templates/${id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.version).toBe(1);
    expect((await putUser('U_ADMIN', [], [])).status).toBe(200);
    // Bỏ quyền thì lại chỉ thấy bản đã xuất bản (mẫu này nay đã xuất bản nên vẫn thấy, nhưng không còn nháp).
    const after = await call<TemplateDetail>('U_ADMIN', 'GET', `/v1/templates/${id}`);
    expect(after.body.draft).toBeNull();
  });
});

describe('chỉ lưu trữ', () => {
  it('nhân viên được thêm template.archive: thấy mẫu đã lưu trữ và bỏ lưu trữ được; không thấy mẫu chưa xuất bản; không tạo, không xuất bản', async () => {
    const draftOnly = (await clone('U_DESIGNER', 'Mẫu chỉ có nháp')).body.id;
    const archived = (await clone('U_DESIGNER', 'Mẫu đã lưu trữ')).body.id;
    expect((await call('U_DESIGNER', 'POST', `/v1/templates/${archived}/publish`)).status).toBe(200);
    expect((await call('U_DESIGNER', 'POST', `/v1/templates/${archived}/archive`)).status).toBe(200);

    // Nhân viên chưa có quyền nào về mẫu: vào được danh sách nhưng chỉ thấy mẫu mình khởi chạy được (ở đây là không mẫu nào).
    expect((await list('U_LAN')).body.items).toEqual([]);
    expect((await putUser('U_LAN', ['template.archive'], [])).status).toBe(200);
    const ids_ = (await list('U_LAN')).body.items.map((t) => t.id);
    expect(ids_).toContain(archived);
    expect(ids_).toContain(ids.TEMPLATE_DON_DOAN);
    expect(ids_).not.toContain(draftOnly);
    expect((await call('U_LAN', 'GET', `/v1/templates/${draftOnly}`)).status).toBe(404);

    expect((await call<TemplateSummary>('U_LAN', 'POST', `/v1/templates/${archived}/archive`, { archived: false })).body.archivedAt).toBeNull();
    expect((await call('U_LAN', 'POST', `/v1/templates/${archived}/archive`)).status).toBe(200);
    expect((await call('U_LAN', 'POST', '/v1/templates', { name: 'x' })).status).toBe(403);
    expect((await call('U_LAN', 'POST', `/v1/templates/${draftOnly}/publish`)).status).toBe(403);
    expect((await call('U_LAN', 'POST', `/v1/templates/${archived}/validate`)).status).toBe(403);
    expect((await putUser('U_LAN', [], [])).status).toBe(200);
    expect((await list('U_LAN')).body.items).toEqual([]);
  });
});
