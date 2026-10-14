import { newId } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeDevice } from '../src/auth/service';
import { closeDb, schema } from '../src/db/client';
import { getAiUsage, listAdminNotifications, listAuditLog, listEffects, retryEffect } from '../src/services/admin';
import {
  createDelegation,
  createUnit,
  createUser,
  createUserActivation,
  createUserPasswordLink,
  deleteDelegation,
  deleteHoliday,
  disableUser,
  enableUser,
  getOrgSettings,
  getUser,
  importUsers,
  listDelegations,
  listDevices,
  listHolidays,
  listUnits,
  listUsers,
  patchOrgSettings,
  putHoliday,
  searchPeople,
  setUserRoles,
  updateUnit,
  updateUser,
} from '../src/services/org';
import { getReport } from '../src/services/reports';
import { actOnStep, startRun } from '../src/services/runs';
import {
  archiveTemplate,
  createTemplate,
  diffTemplateVersions,
  getTemplate,
  getTemplateVersion,
  listTemplates,
  publishTemplate,
  saveTemplateDraft,
  simulateTemplate,
  validateTemplateDraft,
} from '../src/services/templates';
import { createTestOrg, type TestOrg } from '../src/testing';
import { expectApiError, twoTaskDefinition } from './helpers';

/**
 * Chéo tổ chức (SPEC 13.1, CLAUDE.md luật 1): người của tổ chức A gọi service bằng id của tổ chức B luôn nhận
 * `not_found` hoặc danh sách rỗng, và dữ liệu của B không đổi. Khoá ngoại của PostgreSQL không đi qua RLS,
 * nên các id nằm trong thân yêu cầu (đơn vị, người quản lý, người nhận ủy quyền) cũng phải bị chặn ở service.
 */
let a: TestOrg;
let b: TestOrg;
/** Những thứ của tổ chức B mà người của A sẽ thử chạm vào. */
const bIds = { template: '', device: '', delegation: '', effect: '', notification: '', childUnit: '' };

const HOUR = 3_600_000;
const day = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);

beforeAll(async () => {
  a = await createTestOrg();
  b = await createTestOrg({ settings: { officePhone: '0900000002' } });
  const designer = b.viewer('process_designer');
  const name = 'Quy trình của B';
  const tpl = await b.run((tx, ctx) => createTemplate(tx, ctx, designer, { name, description: null, definition: twoTaskDefinition(name, b.users.employee, b.users.employee2) }));
  bIds.template = tpl.id;
  await b.run((tx, ctx) => publishTemplate(tx, ctx, designer, tpl.id));
  // B có việc đã xong, việc đang mở, lời nhắc, thông báo, effect lỗi, số liệu AI, ngày nghỉ, ủy quyền, thiết bị.
  const run = await b.run((tx, ctx) => startRun(tx, ctx, b.viewer('office_admin'), { templateId: tpl.id, title: 'Lượt của B', inputs: {} }, newId()));
  await b.run((tx, ctx) => actOnStep(tx, ctx, b.viewer('employee'), run.steps[0]!.id, newId(), { type: 'CompleteStep' }));
  bIds.device = newId();
  bIds.effect = newId();
  bIds.notification = newId();
  await b.run(async (tx, ctx) => {
    await tx.insert(schema.devices).values({ id: bIds.device, orgId: b.orgId, userId: b.users.employee, platform: 'android', name: 'Máy của B' });
    await tx.insert(schema.effects).values({ id: bIds.effect, orgId: b.orgId, kind: 'notify.assigned', payload: {}, dedupeKey: `test:${bIds.effect}`, state: 'dead', attempts: 8 });
    await tx.insert(schema.notifications).values({ id: bIds.notification, orgId: b.orgId, userId: b.users.employee, kind: 'assigned', title: 'Việc của B', body: '' });
    await tx.insert(schema.aiUsage).values({ orgId: b.orgId, userId: b.users.chairman, day: day(new Date()), llmCalls: 7, llmInputTokens: 1000, llmOutputTokens: 100 });
    await putHoliday(tx, b.viewer('office_admin'), '2027-09-02', { name: 'Quốc khánh', kind: 'public' });
    const d = await createDelegation(tx, ctx, b.viewer('it_admin'), {
      fromUserId: b.users.head,
      toUserId: b.users.deputy,
      validFrom: new Date(Date.now() - HOUR).toISOString(),
      validTo: new Date(Date.now() + 24 * HOUR).toISOString(),
      scope: 'all',
      scopeRef: null,
    });
    bIds.delegation = d.id;
    const child = await createUnit(tx, b.viewer('it_admin'), { name: 'Tổ của B', parentId: b.units.sales, headUserId: null });
    bIds.childUnit = child.id;
  });
});
afterAll(closeDb);

const newUser = (over: Partial<Parameters<typeof createUser>[2]> = {}): Parameters<typeof createUser>[2] => ({
  fullName: 'Người Mới',
  givenName: 'Mới',
  honorific: null,
  email: null,
  phone: null,
  unitId: null,
  managerId: null,
  uiProfile: 'standard',
  displayOrder: 0,
  roles: [{ role: 'employee', unitId: null }],
  ...over,
});

describe('chéo tổ chức: người của A dùng id của B', () => {
  it('người dùng, vai trò, thiết bị', async () => {
    const admin = a.viewer('it_admin');
    const target = b.users.employee;
    const raw = { phone: '0999' };

    await expectApiError(a.run((tx) => getUser(tx, target)), 'not_found');
    await expectApiError(a.run((tx) => updateUser(tx, admin, target, raw, raw)), 'not_found');
    await expectApiError(a.run((tx) => setUserRoles(tx, admin, target, [{ role: 'it_admin', unitId: null }])), 'not_found');
    await expectApiError(a.run((tx) => disableUser(tx, admin, target, newId())), 'not_found');
    await expectApiError(a.run((tx) => enableUser(tx, admin, target)), 'not_found');
    await expectApiError(a.run((tx) => createUserActivation(tx, admin, target)), 'not_found');
    await expectApiError(a.run((tx) => createUserPasswordLink(tx, admin, target)), 'not_found');
    await expectApiError(a.run((tx) => revokeDevice(tx, admin, bIds.device, {})), 'not_found');

    expect((await a.run((tx) => listUsers(tx, { limit: 200, unitId: b.units.sales }))).items).toEqual([]);
    expect(await a.run((tx) => listDevices(tx, { userId: target }))).toEqual([]);
    expect(await a.run((tx) => listDevices(tx))).toEqual([]);
    const everyone = (await a.run((tx) => listUsers(tx, { limit: 200 }))).items.map((u) => u.id);
    expect(everyone.sort()).toEqual(Object.values(a.users).sort());

    // id của B nằm trong thân yêu cầu: khoá ngoại không chặn được, service phải chặn.
    await expectApiError(a.run((tx) => createUser(tx, admin, newUser({ unitId: b.units.sales }))), 'not_found');
    await expectApiError(a.run((tx) => createUser(tx, admin, newUser({ managerId: b.users.head }))), 'not_found');
    await expectApiError(a.run((tx) => createUser(tx, admin, newUser({ roles: [{ role: 'office_admin', unitId: b.units.office }] }))), 'not_found');
    await expectApiError(a.run((tx) => updateUser(tx, admin, a.users.employee, { unitId: b.units.sales }, { unitId: b.units.sales })), 'not_found');
    await expectApiError(a.run((tx) => updateUser(tx, admin, a.users.employee, { managerId: b.users.head }, { managerId: b.users.head })), 'not_found');
    await expectApiError(a.run((tx) => setUserRoles(tx, admin, a.users.employee, [{ role: 'employee', unitId: b.units.sales }])), 'not_found');
    expect((await a.run((tx) => listUsers(tx, { limit: 200 }))).items).toHaveLength(9);

    // Nhập CSV: email của người bên B không phải người quản lý hợp lệ, và cũng không bị coi là email trùng.
    const csv = `fullName,email,manager\nNgười Một,moi1@${a.code}.test,head@${b.code}.test\nNgười Hai,employee@${b.code}.test,`;
    const dry = await a.run((tx) => importUsers(tx, admin, csv, true));
    expect(dry.rows).toEqual([
      { line: 2, ok: false, errors: ['manager_not_found'] },
      { line: 3, ok: true, errors: [] },
    ]);

    // Ô chọn người của A không bao giờ có người của B (hai tổ chức mẫu trùng tên nhau).
    const found = await a.run(async (_tx, ctx) => searchPeople(ctx, 'Lan', 100).map((p) => p.id));
    expect(found).toEqual([a.users.employee]);
  });

  it('đơn vị, ủy quyền, ngày nghỉ, cấu hình', async () => {
    const admin = a.viewer('it_admin');
    await expectApiError(a.run((tx) => updateUnit(tx, admin, b.units.sales, { name: 'Chiếm' }, { name: 'Chiếm' })), 'not_found');
    await expectApiError(a.run((tx) => updateUnit(tx, admin, a.units.sales, { parentId: bIds.childUnit }, { parentId: bIds.childUnit })), 'not_found');
    await expectApiError(a.run((tx) => updateUnit(tx, admin, a.units.sales, { headUserId: b.users.head }, { headUserId: b.users.head })), 'not_found');
    await expectApiError(a.run((tx) => createUnit(tx, admin, { name: 'Tổ lạ', parentId: b.units.sales, headUserId: null })), 'not_found');
    await expectApiError(a.run((tx) => createUnit(tx, admin, { name: 'Tổ lạ', parentId: null, headUserId: b.users.head })), 'not_found');
    expect((await a.run((tx) => listUnits(tx))).map((u) => u.id).sort()).toEqual(Object.values(a.units).sort());

    const range = { validFrom: new Date(Date.now() - HOUR).toISOString(), validTo: new Date(Date.now() + HOUR).toISOString() };
    await expectApiError(a.run((tx, ctx) => createDelegation(tx, ctx, admin, { fromUserId: b.users.head, toUserId: a.users.deputy, ...range, scope: 'all', scopeRef: null })), 'not_found');
    await expectApiError(a.run((tx, ctx) => createDelegation(tx, ctx, admin, { fromUserId: a.users.head, toUserId: b.users.deputy, ...range, scope: 'all', scopeRef: null })), 'not_found');
    await expectApiError(a.run((tx, ctx) => createDelegation(tx, ctx, admin, { fromUserId: a.users.head, toUserId: a.users.deputy, ...range, scope: 'process', scopeRef: bIds.template })), 'not_found');
    await expectApiError(a.run((tx) => deleteDelegation(tx, admin, bIds.delegation)), 'not_found');
    expect(await a.run((tx, ctx) => listDelegations(tx, ctx, admin))).toEqual([]);

    expect(await a.run((tx) => listHolidays(tx, 2027))).toEqual([]);
    await expectApiError(a.run((tx) => deleteHoliday(tx, a.viewer('office_admin'), '2027-09-02')), 'not_found');
    // Cùng một ngày ở hai tổ chức là hai dòng riêng.
    await a.run((tx) => putHoliday(tx, a.viewer('office_admin'), '2027-09-02', { name: 'Nghỉ của A', kind: 'company' }));
    expect(await b.run((tx) => listHolidays(tx, 2027))).toEqual([{ day: '2027-09-02', name: 'Quốc khánh', kind: 'public' }]);

    await a.run((tx) => patchOrgSettings(tx, admin, { officePhone: '0911111111', ai: { enabled: false } }));
    const bSettings = await b.run(async (_tx, ctx) => getOrgSettings(ctx));
    expect(bSettings.officePhone).toBe('0900000002');
    expect(bSettings.ai.enabled).toBe(true);
  });

  it('mẫu quy trình', async () => {
    const designer = a.viewer('process_designer');
    const id = bIds.template;
    const definition = twoTaskDefinition('Chiếm', a.users.employee, a.users.employee2);

    expect(await a.run((tx, ctx) => listTemplates(tx, ctx, designer))).toEqual([]);
    expect(await a.run((tx, ctx) => listTemplates(tx, ctx, a.viewer('office_admin')))).toEqual([]);
    await expectApiError(a.run((tx, ctx) => getTemplate(tx, ctx, designer, id)), 'not_found');
    await expectApiError(a.run((tx, ctx) => getTemplateVersion(tx, ctx, designer, id, 1)), 'not_found');
    await expectApiError(a.run((tx) => saveTemplateDraft(tx, designer, id, { definition }, '0')), 'not_found');
    await expectApiError(a.run((tx, ctx) => validateTemplateDraft(tx, ctx, id)), 'not_found');
    await expectApiError(a.run((tx, ctx) => simulateTemplate(tx, ctx, designer, id, { inputs: {} })), 'not_found');
    await expectApiError(a.run((tx, ctx) => publishTemplate(tx, ctx, designer, id)), 'not_found');
    await expectApiError(a.run((tx, ctx) => archiveTemplate(tx, ctx, designer, id, true)), 'not_found');
    await expectApiError(a.run((tx) => diffTemplateVersions(tx, id, 1, 1)), 'not_found');
    await expectApiError(a.run((tx, ctx) => createTemplate(tx, ctx, designer, { name: 'Chép trộm', description: null, cloneFromTemplateId: id })), 'not_found');
    await expectApiError(a.run((tx, ctx) => startRun(tx, ctx, a.viewer('office_admin'), { templateId: id, title: 'Chạy trộm', inputs: {} }, newId())), 'not_found');
    expect(await a.run((tx, ctx) => listTemplates(tx, ctx, designer))).toEqual([]);

  });

  it('nhật ký, thông báo, effect, số liệu AI, báo cáo', async () => {
    const admin = a.viewer('it_admin');
    const office = a.viewer('office_admin');

    // B có nhật ký (xuất bản mẫu, tạo ủy quyền, ngày nghỉ); A lọc theo người của B thì rỗng.
    expect((await b.run((tx, ctx) => listAuditLog(tx, ctx, { limit: 50 }))).items.length).toBeGreaterThan(0);
    expect((await a.run((tx, ctx) => listAuditLog(tx, ctx, { limit: 50, actorId: b.users.designer }))).items).toEqual([]);
    const aAudit = (await a.run((tx, ctx) => listAuditLog(tx, ctx, { limit: 200 }))).items;
    const bUserIds = new Set(Object.values(b.users));
    expect(aAudit.some((e) => (e.actor && bUserIds.has(e.actor.id)) || e.targetId === bIds.template)).toBe(false);

    expect((await a.run((tx, ctx) => listAdminNotifications(tx, ctx, { limit: 50, userId: b.users.employee }))).items).toEqual([]);
    expect((await a.run((tx, ctx) => listAdminNotifications(tx, ctx, { limit: 50 }))).items.map((n) => n.id)).not.toContain(bIds.notification);

    expect((await a.run((tx) => listEffects(tx, { limit: 50, state: 'dead' }))).items).toEqual([]);
    await expectApiError(a.run((tx) => retryEffect(tx, admin, bIds.effect)), 'not_found');

    expect((await a.run((tx, ctx) => getAiUsage(tx, ctx))).rows).toEqual([]);
    expect((await b.run((tx, ctx) => getAiUsage(tx, ctx))).totals.llmCalls).toBe(7);

    const period = { from: day(new Date(Date.now() - 24 * HOUR)), to: day(new Date(Date.now() + 24 * HOUR)) };
    const empty = { completedCount: 0, overdueNow: 0, onTimeRate: null, byUser: [], byUnit: [], byTemplateStep: [], nudges: [] };
    expect((await b.run((tx, ctx) => getReport(tx, ctx, b.viewer('office_admin'), period))).completedCount).toBe(1);
    expect(await a.run((tx, ctx) => getReport(tx, ctx, office, period))).toMatchObject(empty);
    expect(await a.run((tx, ctx) => getReport(tx, ctx, office, { ...period, unitId: b.units.sales }))).toMatchObject(empty);
    expect(await a.run((tx, ctx) => getReport(tx, ctx, office, { ...period, userId: b.users.employee }))).toMatchObject(empty);
    expect(await a.run((tx, ctx) => getReport(tx, ctx, office, { ...period, templateId: bIds.template }))).toMatchObject(empty);
  });

  it('sau tất cả, dữ liệu của B không đổi', async () => {
    const employee = await b.run((tx) => getUser(tx, b.users.employee));
    expect(employee).toMatchObject({ status: 'active', phone: null, roles: [{ role: 'employee', unitId: null }], deviceCount: 1, unitId: b.units.sales, managerId: b.users.head });
    expect((await b.run((tx) => listUsers(tx, { limit: 200 }))).items).toHaveLength(9);
    expect((await b.run((tx) => listDevices(tx)))[0]).toMatchObject({ id: bIds.device, revokedAt: null });

    const units = await b.run((tx) => listUnits(tx));
    expect(units.find((u) => u.id === b.units.sales)).toMatchObject({ name: 'Phòng Kinh doanh', parentId: null, headUserId: b.users.head });
    expect(units).toHaveLength(4);
    expect((await b.run((tx, ctx) => listDelegations(tx, ctx, b.viewer('it_admin')))).map((d) => d.id)).toEqual([bIds.delegation]);

    const tpl = await b.run((tx, ctx) => getTemplate(tx, ctx, b.viewer('process_designer'), bIds.template));
    expect(tpl).toMatchObject({ name: 'Quy trình của B', archivedAt: null, latestPublishedVersion: 1, hasDraft: false, runCount: 1 });
    const [effect] = await b.run((tx) => tx.select().from(schema.effects).where(eq(schema.effects.id, bIds.effect)));
    expect(effect).toMatchObject({ state: 'dead', attempts: 8 });
  });
});
