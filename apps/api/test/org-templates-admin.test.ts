import { closeDb, type SeedIds } from '@mihato/backend';
import type { OrgSettings, Paged, Report, RunDetail, TemplateDetail, UserView } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Các route quản trị tổ chức, mẫu quy trình, báo cáo và nhật ký đi qua HTTP thật (app.inject): kiểm phần nối giữa
 * registrar (Zod, quyền, Idempotency-Key, If-Match) và service. Nghiệp vụ chi tiết kiểm ở packages/backend/test.
 */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;

beforeAll(async () => {
  ids = await freshOrg('adm');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

type Problem = { code: string; errors?: { path: string; code: string }[] };

describe('tổ chức', () => {
  it('tìm người không dấu cho mọi người dùng đã đăng nhập', async () => {
    const res = await call<{ items: { id: string; fullName: string; unitName: string | null; roleTitle: string | null }[] }>('U_LAN', 'GET', '/v1/people?q=lan&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.items.map((p) => p.id).sort()).toEqual([ids.users.U_LAN, ids.users.U_LAN2].sort());
    expect(res.body.items[0]).toMatchObject({ roleTitle: 'Nhân viên' });
    expect(res.body.items.map((p) => p.unitName).sort()).toEqual(['Kinh doanh', 'Kế toán'].sort());
  });

  it('PATCH cấu hình chỉ áp khoá đã gửi: mặc định của Zod không ghi đè cấu hình đang có', async () => {
    const first = await call<OrgSettings>('U_IT', 'PATCH', '/v1/org/settings', { ai: { enabled: false, tts: 'device' }, officePhone: '02812345678' });
    expect(first.status).toBe(200);
    expect(first.body.ai).toMatchObject({ enabled: false, tts: 'device', stt: 'deepgram', llm: 'anthropic' });

    // Lần hai chỉ gửi một khoá khác: ai và officePhone phải còn nguyên.
    const second = await call<OrgSettings>('U_IT', 'PATCH', '/v1/org/settings', { greeting: 'Chúc mừng năm mới' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ greeting: 'Chúc mừng năm mới', officePhone: '02812345678' });
    expect(second.body.ai).toMatchObject({ enabled: false, tts: 'device' });

    const read = await call<OrgSettings>('U_ADMIN', 'GET', '/v1/org/settings');
    expect(read.status).toBe(200);
    expect(read.body).toEqual(second.body);
    expect((await call<Problem>('U_ADMIN', 'PATCH', '/v1/org/settings', { greeting: 'x' })).status).toBe(403);
  });

  it('thêm, sửa, nhập thử và đặt vai trò người dùng', async () => {
    const created = await call<UserView>('U_IT', 'POST', '/v1/users', { fullName: 'Trịnh Văn Nam', givenName: 'Nam', unitId: ids.units.sales, managerId: ids.users.U_LAN, roles: [{ role: 'employee' }] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'invited', unitName: 'Kinh doanh', managerName: 'Nguyễn Thu Lan', uiProfile: 'standard' });

    // Chỉ gửi phone: đơn vị và người quản lý không bị mặc định null của Zod xoá mất.
    const patched = await call<UserView>('U_IT', 'PATCH', `/v1/users/${created.body.id}`, { phone: '0901234567' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ phone: '0901234567', unitId: ids.units.sales, managerId: ids.users.U_LAN });

    const roles = await call<UserView>('U_IT', 'PUT', `/v1/users/${created.body.id}/roles`, { roles: [{ role: 'office_admin' }, { role: 'employee' }] });
    expect(roles.body.roles.map((r) => r.role)).toEqual(['office_admin', 'employee']);

    const list = await call<Paged<UserView>>('U_IT', 'GET', '/v1/users?q=trinh%20van&limit=10');
    expect(list.body.items.map((u) => u.id)).toEqual([created.body.id]);

    const dry = await call<{ dryRun: boolean; total: number; created: number; rows: { line: number; ok: boolean; errors: string[] }[] }>('U_IT', 'POST', '/v1/users/import?dryRun=true', {
      csv: 'fullName,unit,roles\n"Lê, Thị Hoa",Kinh doanh,employee\nPhan Văn Ba,Phòng Không Có,employee',
    });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, total: 2, created: 0 });
    expect(dry.body.rows).toEqual([
      { line: 2, ok: true, errors: [] },
      { line: 3, ok: false, errors: ['unit_not_found'] },
    ]);

    const disabled = await call<UserView>('U_IT', 'POST', `/v1/users/${created.body.id}/disable`);
    expect(disabled.body.status).toBe('disabled');
    expect((await call<Problem>('U_IT', 'POST', `/v1/users/${created.body.id}/disable`)).status).toBe(409);
    expect((await call<UserView>('U_IT', 'POST', `/v1/users/${created.body.id}/enable`)).body.status).toBe('invited');
  });

  it('điều hành tự ủy quyền mà thiếu mã nâng quyền thì 403 step_up_required', async () => {
    const body = { fromUserId: ids.users.U_CHAIRMAN, toUserId: ids.users.U_HUY, validFrom: '2026-10-05T01:00:00Z', validTo: '2026-10-09T10:00:00Z' };
    const res = await call<Problem>('U_CHAIRMAN', 'POST', '/v1/delegations', body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('step_up_required');
    // Nhân viên tự ủy quyền thì không cần; ủy quyền thay người khác thì không được.
    const own = await call<{ id: string }>('U_LAN', 'POST', '/v1/delegations', { ...body, fromUserId: ids.users.U_LAN, toUserId: ids.users.U_HUNG });
    expect(own.status).toBe(201);
    expect((await call<Problem>('U_LAN', 'POST', '/v1/delegations', { ...body, fromUserId: ids.users.U_HUNG, toUserId: ids.users.U_LAN })).body.code).toBe('forbidden');
    expect((await call<{ items: unknown[] }>('U_LAN', 'GET', '/v1/delegations')).body.items).toHaveLength(1);
    expect((await call<{ ok: boolean }>('U_LAN', 'DELETE', `/v1/delegations/${own.body.id}`)).status).toBe(200);
  });

  it('ngày nghỉ và gợi ý ngày lễ', async () => {
    expect((await call('U_ADMIN', 'PUT', '/v1/holidays/2027-01-01', { name: 'Tết Dương lịch', kind: 'public' })).status).toBe(200);
    const list = await call<{ items: { day: string }[] }>('U_LAN', 'GET', '/v1/holidays?year=2027');
    expect(list.body.items.map((h) => h.day)).toEqual(['2027-01-01']);
    const suggestions = await call<{ items: { day: string; alreadyAdded: boolean }[] }>('U_ADMIN', 'GET', '/v1/holidays/suggestions?year=2027');
    expect(suggestions.body.items.find((s) => s.day === '2027-01-01')!.alreadyAdded).toBe(true);
    expect(suggestions.body.items.find((s) => s.day === '2027-09-02')!.alreadyAdded).toBe(false);
    expect((await call('U_ADMIN', 'DELETE', '/v1/holidays/2027-01-01')).status).toBe(200);
    expect((await call('U_ADMIN', 'DELETE', '/v1/holidays/2027-01-01')).status).toBe(404);
  });
});

describe('mẫu quy trình', () => {
  it('lưu nháp cần If-Match; xuất bản nháp còn lỗi thì 422', async () => {
    const created = await call<TemplateDetail>('U_DESIGNER', 'POST', '/v1/templates', { name: 'Mẫu thử qua HTTP' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const definition = created.body.draft!.definition;

    const noHeader = await call<Problem>('U_DESIGNER', 'PUT', `/v1/templates/${id}/draft`, { definition });
    expect(noHeader.status).toBe(412);
    expect(noHeader.body.code).toBe('precondition_failed');
    expect((await call<Problem>('U_DESIGNER', 'PUT', `/v1/templates/${id}/draft`, { definition }, { 'if-match': '5' })).status).toBe(412);
    const saved = await call<{ rev: number }>('U_DESIGNER', 'PUT', `/v1/templates/${id}/draft`, { definition }, { 'if-match': '0' });
    expect(saved.status).toBe(200);
    expect(saved.body.rev).toBe(1);

    const checked = await call<{ errors: unknown[] }>('U_DESIGNER', 'POST', `/v1/templates/${id}/validate`);
    expect(checked.body.errors.length).toBeGreaterThan(0);
    const published = await call<Problem>('U_DESIGNER', 'POST', `/v1/templates/${id}/publish`);
    expect(published.status).toBe(422);
    expect(published.body.code).toBe('template_invalid');
    expect(published.body.errors!.length).toBeGreaterThan(0);

    // Văn phòng chỉ thấy mẫu đã xuất bản: mẫu dữ liệu mẫu có, mẫu nháp vừa tạo thì không.
    const office = await call<{ items: { id: string }[] }>('U_ADMIN', 'GET', '/v1/templates');
    expect(office.body.items.map((t) => t.id)).toEqual([ids.TEMPLATE_DON_DOAN]);
    expect((await call('U_ADMIN', 'GET', `/v1/templates/${id}`)).status).toBe(404);
    expect((await call<{ items: unknown[] }>('U_DESIGNER', 'GET', '/v1/templates')).body.items).toHaveLength(2);
  });

  it('chạy thử bản đã xuất bản và so sánh phiên bản', async () => {
    const sim = await call<{ rows: { nodeId: string; assignee: { id: string } | null; dueAt: string | null }[]; targetAt: string | null }>('U_ADMIN', 'POST', `/v1/templates/${ids.TEMPLATE_DON_DOAN}/simulate`, {
      inputs: { delegation: 'Đoàn thử', visitDate: '2027-03-18' },
    });
    expect(sim.status).toBe(200);
    expect(sim.body.rows).toHaveLength(6);
    expect(sim.body.rows.find((r) => r.nodeId === 's1')!.assignee!.id).toBe(ids.users.U_LAN);
    expect(sim.body.targetAt).not.toBeNull();

    const diff = await call<{ nodes: unknown[]; edges: unknown[] }>('U_DESIGNER', 'GET', `/v1/templates/${ids.TEMPLATE_DON_DOAN}/diff?from=1&to=1`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ from: 1, to: 1, nodes: [], edges: [] });
  });
});

describe('báo cáo và nhật ký', () => {
  it('báo cáo cho người điều phối; nhật ký, effect và số liệu AI cho quản trị', async () => {
    const report = await call<Report>('U_ADMIN', 'GET', '/v1/reports/summary?from=2026-10-01&to=2026-10-31');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ from: '2026-10-01', to: '2026-10-31', completedCount: 0, onTimeRate: null });
    expect((await call('U_LAN', 'GET', '/v1/reports/summary?from=2026-10-01&to=2026-10-31')).status).toBe(403);
    expect((await call<Problem>('U_ADMIN', 'GET', '/v1/reports/summary?from=2026-10-31')).status).toBe(422);

    const audit = await call<Paged<{ action: string; detail: Record<string, unknown> }>>('U_IT', 'GET', '/v1/admin/audit-log?action=org_settings_changed&limit=1');
    expect(audit.status).toBe(200);
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.nextCursor).not.toBeNull();
    // chỉ tên khoá, không có giá trị
    expect(audit.body.items[0]!.detail).toEqual({ keys: ['greeting'] });
    const next = await call<Paged<{ detail: Record<string, unknown> }>>('U_IT', 'GET', `/v1/admin/audit-log?action=org_settings_changed&limit=1&cursor=${audit.body.nextCursor}`);
    expect(next.body.items[0]!.detail).toEqual({ keys: ['officePhone', 'ai.enabled', 'ai.tts'] });

    expect((await call<Paged<unknown>>('U_IT', 'GET', '/v1/admin/effects')).status).toBe(200);
    expect((await call<Paged<unknown>>('U_ADMIN', 'GET', '/v1/admin/notifications?state=sent')).status).toBe(200);
    const usage = await call<{ rows: unknown[]; totals: { estimatedUsd: number } }>('U_IT', 'GET', '/v1/admin/ai-usage');
    expect(usage.body).toMatchObject({ rows: [], totals: { llmCalls: 0, estimatedUsd: 0 } });
    expect((await call('U_ADMIN', 'GET', '/v1/admin/ai-usage')).status).toBe(403);
  });
});

/**
 * Chủ tịch toàn quyền (docs/DECISIONS.md, 04/10/2026), khác bảng 9.1 của SPEC. Đặt cuối tệp vì các test này ghi cấu hình,
 * mẫu và nhật ký, mà các test ở trên đếm chính những thứ đó.
 */
describe('Chủ tịch toàn quyền', () => {
  it('nhân bản rồi xuất bản mẫu quy trình như người vẽ quy trình; Giám đốc vẫn không tạo được mẫu', async () => {
    const cloned = await call<TemplateDetail>('U_CHAIRMAN', 'POST', '/v1/templates', { name: 'Mẫu do Chủ tịch nhân bản', cloneFromTemplateId: ids.TEMPLATE_DON_DOAN });
    expect(cloned.status).toBe(201);
    const published = await call<{ version: number }>('U_CHAIRMAN', 'POST', `/v1/templates/${cloned.body.id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.version).toBe(1);
    expect((await call<Problem>('U_DIRECTOR', 'POST', '/v1/templates', { name: 'x' })).body.code).toBe('forbidden');
  });

  it('thêm và đổi vai trò người dùng, vô hiệu hoá, đổi cài đặt tổ chức, xem nhật ký, hàng effect và số liệu AI', async () => {
    const created = await call<UserView>('U_CHAIRMAN', 'POST', '/v1/users', { fullName: 'Lương Văn Quang', givenName: 'Quang', unitId: ids.units.sales, managerId: ids.users.U_LAN, roles: [{ role: 'employee' }] });
    expect(created.status).toBe(201);
    expect((await call('U_CHAIRMAN', 'PUT', `/v1/users/${created.body.id}/roles`, { roles: [{ role: 'employee' }, { role: 'office_admin' }] })).status).toBe(200);
    expect((await call<UserView>('U_CHAIRMAN', 'POST', `/v1/users/${created.body.id}/disable`)).body.status).toBe('disabled');
    expect((await call<OrgSettings>('U_CHAIRMAN', 'PATCH', '/v1/org/settings', { greeting: 'Chủ tịch gửi lời chào' })).body.greeting).toBe('Chủ tịch gửi lời chào');
    for (const url of ['/v1/admin/audit-log', '/v1/admin/effects', '/v1/admin/notifications', '/v1/admin/ai-usage', '/v1/users', '/v1/units']) {
      expect((await call('U_CHAIRMAN', 'GET', url)).status, url).toBe(200);
    }
    // Giám đốc không có các quyền này.
    expect((await call<Problem>('U_DIRECTOR', 'PATCH', '/v1/org/settings', { greeting: 'x' })).body.code).toBe('forbidden');
    expect((await call<Problem>('U_DIRECTOR', 'GET', '/v1/users')).body.code).toBe('forbidden');
  });

  it('bỏ qua một bước của lượt chạy (trước đây chỉ Văn phòng làm được); Giám đốc thì không', async () => {
    const run = await call<RunDetail>('U_CHAIRMAN', 'POST', '/v1/runs', { templateId: ids.TEMPLATE_DON_DOAN, title: 'Đón đoàn do Chủ tịch khởi chạy', inputs: { delegation: 'Đoàn thử', visitDate: '2027-03-18' } });
    expect(run.status).toBe(201);
    const step = run.body.steps.find((s) => s.nodeId === 's3')!;
    expect((await call<Problem>('U_DIRECTOR', 'POST', `/v1/steps/${step.id}/skip`, { reason: 'không cần' })).body.code).toBe('forbidden');
    expect((await call('U_CHAIRMAN', 'POST', `/v1/steps/${step.id}/skip`, { reason: 'Chủ tịch cho qua' })).status).toBe(200);
    const after = await call<RunDetail>('U_CHAIRMAN', 'GET', `/v1/runs/${run.body.id}`);
    expect(after.body.steps.find((s) => s.nodeId === 's3')).toMatchObject({ state: 'skipped' });
  });

  it('"Trình" vẫn chỉ của Văn phòng: đó là kênh đưa việc cho người điều hành xác nhận, không phải một quyền', async () => {
    const res = await call<Problem>('U_CHAIRMAN', 'POST', '/v1/proposals', {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });
});
