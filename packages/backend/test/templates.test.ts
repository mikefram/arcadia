import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '../src/db/client';
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
import { auditRows, expectApiError, twoTaskDefinition } from './helpers';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg();
});
afterAll(closeDb);

describe('nháp, If-Match và xuất bản', () => {
  let templateId: string;
  let rev = 0;

  it('tạo mẫu: nháp đầu chỉ có Bắt đầu và Hoàn tất', async () => {
    const designer = org.viewer('process_designer');
    const detail = await org.run((tx, ctx) => createTemplate(tx, ctx, designer, { name: 'Trình ký hồ sơ', description: null }));
    templateId = detail.id;
    expect(detail).toMatchObject({ name: 'Trình ký hồ sơ', latestPublishedVersion: null, hasDraft: true, stepCount: 0, runCount: 0, archivedAt: null });
    expect(detail.createdBy.fullName).toBe('Vũ Minh Khôi');
    expect(detail.versions).toEqual([{ version: 1, status: 'draft', publishedAt: null, publishedBy: null }]);
    expect(detail.draft).toMatchObject({ version: 1, rev: 0 });
    expect(detail.draft!.definition.name).toBe('Trình ký hồ sơ');
    expect(detail.draft!.definition.nodes).toEqual([
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ]);
    expect(Object.keys(detail.draft!.definition.layout ?? {}).sort()).toEqual(['end', 'start']);
  });

  it('người không có template.edit không thấy mẫu chưa xuất bản', async () => {
    const office = org.viewer('office_admin');
    expect(await org.run((tx, ctx) => listTemplates(tx, ctx, office))).toEqual([]);
    await expectApiError(org.run((tx, ctx) => getTemplate(tx, ctx, office, templateId)), 'not_found');
    await expectApiError(org.run((tx, ctx) => getTemplateVersion(tx, ctx, office, templateId, 1)), 'not_found');
    // người vẽ thì thấy
    expect((await org.run((tx, ctx) => listTemplates(tx, ctx, org.viewer('process_designer')))).map((t) => t.id)).toEqual([templateId]);
    expect((await org.run((tx, ctx) => getTemplateVersion(tx, ctx, org.viewer('process_designer'), templateId, 1))).status).toBe('draft');
  });

  it('xuất bản nháp còn lỗi thì 422 template_invalid kèm errors[]', async () => {
    const designer = org.viewer('process_designer');
    const checked = await org.run((tx, ctx) => validateTemplateDraft(tx, ctx, templateId));
    expect(checked.errors.length).toBeGreaterThan(0);

    const err = await expectApiError(org.run((tx, ctx) => publishTemplate(tx, ctx, designer, templateId)), 'template_invalid');
    expect(err.status).toBe(422);
    expect(err.extra.errors!.length).toBe(checked.errors.length);
    expect(err.extra.errors!.map((e) => e.code).sort()).toEqual(checked.errors.map((e) => e.code).sort());
    for (const e of err.extra.errors!) expect(e.path).toMatch(/^(start|end|definition)$/);

    // Vẫn là nháp, chưa có gì được xuất bản.
    const detail = await org.run((tx, ctx) => getTemplate(tx, ctx, designer, templateId));
    expect(detail.latestPublishedVersion).toBeNull();
    expect(await org.run((tx) => auditRows(tx, 'template_published'))).toEqual([]);
  });

  it('lưu nháp sai If-Match thì 412; đúng thì tăng rev; nháp còn lỗi vẫn lưu được', async () => {
    const designer = org.viewer('process_designer');
    // nháp còn dở: việc chưa có người nhận, chưa có hạn
    const broken = {
      schemaVersion: 1 as const,
      name: 'Trình ký hồ sơ',
      inputs: [],
      nodes: [
        { id: 'start', type: 'start' as const, label: 'Bắt đầu' },
        { id: 't1', type: 'task' as const, label: 'Soạn', title: 'Soạn hồ sơ' },
        { id: 'end', type: 'end' as const, label: 'Hoàn tất' },
      ],
      edges: [{ id: 'e1', from: 'start', to: 't1' }],
    };
    for (const bad of [undefined, '7', 'abc', '"7"', '-1']) {
      const err = await expectApiError(org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition: broken }, bad)), 'precondition_failed');
      expect(err.status).toBe(412);
    }
    const untouched = await org.run((tx, ctx) => getTemplate(tx, ctx, designer, templateId));
    expect(untouched.draft).toMatchObject({ rev: 0 });
    expect(untouched.draft!.definition.nodes).toHaveLength(2);

    const saved = await org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition: broken }, '0'));
    expect(saved.rev).toBe(1);
    expect(saved.updatedAt).toMatch(/Z$/);
    // rev cũ không còn dùng được
    await expectApiError(org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition: broken }, '0')), 'precondition_failed');

    const again = await org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition: broken, description: 'Mẫu trình ký' }, 'W/"1"'));
    expect(again.rev).toBe(2);
    rev = again.rev;
    const detail = await org.run((tx, ctx) => getTemplate(tx, ctx, designer, templateId));
    expect(detail).toMatchObject({ description: 'Mẫu trình ký', stepCount: 1, hasDraft: true });
    expect(detail.draft).toMatchObject({ rev: 2, version: 1 });
    expect(detail.draft!.definition.nodes.map((n) => n.id)).toEqual(['start', 't1', 'end']);
  });

  it('xuất bản nháp hợp lệ: tạo phiên bản bất biến, đổi tên mẫu theo definition, ghi nhật ký', async () => {
    const designer = org.viewer('process_designer');
    const definition = twoTaskDefinition('Trình ký hồ sơ đất', org.users.employee, org.users.employee2);
    rev = (await org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition }, String(rev)))).rev;
    expect(rev).toBe(3);
    expect(await org.run((tx, ctx) => validateTemplateDraft(tx, ctx, templateId))).toMatchObject({ errors: [] });

    const published = await org.run((tx, ctx) => publishTemplate(tx, ctx, designer, templateId));
    expect(published.version).toBe(1);

    const detail = await org.run((tx, ctx) => getTemplate(tx, ctx, designer, templateId));
    expect(detail).toMatchObject({ name: 'Trình ký hồ sơ đất', latestPublishedVersion: 1, hasDraft: false, draft: null, stepCount: 2 });
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]).toMatchObject({ version: 1, status: 'published', publishedAt: published.publishedAt });
    expect(detail.versions[0]!.publishedBy!.id).toBe(designer.id);

    const [entry] = await org.run((tx) => auditRows(tx, 'template_published'));
    expect(entry).toMatchObject({ targetType: 'template', targetId: templateId, actorUserId: designer.id });
    expect(entry!.detail).toEqual({ version: 1, versionId: published.versionId });

    // Không còn nháp để xuất bản lần nữa.
    await expectApiError(org.run((tx, ctx) => publishTemplate(tx, ctx, designer, templateId)), 'state_conflict');
  });

  it('CSDL chặn sửa và xoá dòng đã published', async () => {
    const v = schema.processTemplateVersions;
    const [row] = await org.run((tx) => tx.select().from(v).where(eq(v.templateId, templateId)));
    expect(row!.status).toBe('published');

    await expect(org.run((tx) => tx.update(v).set({ definition: { hacked: true } }).where(eq(v.id, row!.id)))).rejects.toThrow();
    await expect(org.run((tx) => tx.update(v).set({ status: 'draft' }).where(eq(v.id, row!.id)))).rejects.toThrow();
    await expect(org.run((tx) => tx.delete(v).where(eq(v.id, row!.id)))).rejects.toThrow();

    const [after] = await org.run((tx) => tx.select().from(v).where(eq(v.id, row!.id)));
    expect(after).toEqual(row);
  });

  it('sau khi xuất bản, lần lưu kế tiếp tạo nháp version 2 và rev nối tiếp', async () => {
    const designer = org.viewer('process_designer');
    const next = twoTaskDefinition('Trình ký hồ sơ đất', org.users.employee, org.users.employee2);
    next.nodes[1] = { ...next.nodes[1]!, title: 'Soạn hồ sơ pháp lý' };
    next.nodes.splice(3, 0, { id: 't3', type: 'task', label: 'Nộp', title: 'Nộp hồ sơ', assignee: { kind: 'initiator' }, due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } } });
    next.edges = [
      { id: 'e1', from: 'start', to: 't1' },
      { id: 'e2', from: 'start', to: 't2' },
      { id: 'e3', from: 't1', to: 't3' },
      { id: 'e4', from: 't2', to: 'end' },
      { id: 'e5', from: 't3', to: 'end' },
    ];
    // một tab cũ giữ rev của vòng nháp trước không ghi đè được
    await expectApiError(org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition: next }, '2')), 'precondition_failed');

    const saved = await org.run((tx) => saveTemplateDraft(tx, designer, templateId, { definition: next }, String(rev)));
    expect(saved.rev).toBe(rev + 1);
    const detail = await org.run((tx, ctx) => getTemplate(tx, ctx, designer, templateId));
    expect(detail.versions.map((x) => [x.version, x.status])).toEqual([
      [1, 'published'],
      [2, 'draft'],
    ]);
    expect(detail).toMatchObject({ latestPublishedVersion: 1, hasDraft: true, stepCount: 3 });
    expect(detail.draft).toMatchObject({ version: 2, rev: rev + 1 });

    // Bản 1 đã xuất bản không đổi.
    const v1 = await org.run((tx, ctx) => getTemplateVersion(tx, ctx, designer, templateId, 1));
    expect(v1.definition.nodes.map((n) => n.id)).toEqual(['start', 't1', 't2', 'end']);
  });

  it('người điều phối chỉ thấy bản đã xuất bản', async () => {
    const office = org.viewer('office_admin');
    const list = await org.run((tx, ctx) => listTemplates(tx, ctx, office));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: templateId, latestPublishedVersion: 1, hasDraft: false, stepCount: 2 });

    const detail = await org.run((tx, ctx) => getTemplate(tx, ctx, office, templateId));
    expect(detail.draft).toBeNull();
    expect(detail.versions.map((x) => x.version)).toEqual([1]);

    expect((await org.run((tx, ctx) => getTemplateVersion(tx, ctx, office, templateId, 1))).status).toBe('published');
    await expectApiError(org.run((tx, ctx) => getTemplateVersion(tx, ctx, office, templateId, 2)), 'not_found');
    await expectApiError(org.run((tx, ctx) => getTemplateVersion(tx, ctx, office, templateId, 9)), 'not_found');
  });

  it('so sánh hai phiên bản: nút và cạnh thêm, bớt, đổi', async () => {
    const diff = await org.run((tx) => diffTemplateVersions(tx, templateId, 1, 2));
    expect(diff.from).toBe(1);
    expect(diff.to).toBe(2);
    expect(diff.nodes).toEqual([
      { nodeId: 't1', change: 'changed', label: 'Soạn', fields: ['title'] },
      { nodeId: 't3', change: 'added', label: 'Nộp', fields: [] },
    ]);
    expect(diff.edges).toEqual([
      { edgeId: 'e3', change: 'changed', from: 't1', to: 't3' },
      { edgeId: 'e5', change: 'added', from: 't3', to: 'end' },
    ]);
    const reverse = await org.run((tx) => diffTemplateVersions(tx, templateId, 2, 1));
    expect(reverse.nodes).toContainEqual({ nodeId: 't3', change: 'removed', label: 'Nộp', fields: [] });
    expect(reverse.edges).toContainEqual({ edgeId: 'e5', change: 'removed', from: 't3', to: 'end' });
    await expectApiError(org.run((tx) => diffTemplateVersions(tx, templateId, 1, 7)), 'not_found');
  });

  it('chạy thử: bản xuất bản cho người điều phối, nháp cho người vẽ', async () => {
    const office = org.viewer('office_admin');
    const sim = await org.run((tx, ctx) => simulateTemplate(tx, ctx, office, templateId, { inputs: {} }));
    expect(sim.rows.map((r) => [r.nodeId, r.assignee?.fullName])).toEqual([
      ['t1', 'Nguyễn Thu Lan'],
      ['t2', 'Bùi Quốc Tuấn'],
    ]);
    for (const row of sim.rows) {
      expect(row.kind).toBe('task');
      expect(row.onBehalfOf).toBeNull();
      expect(row.pastDue).toBe(false);
      expect(row.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    // office_admin gửi draft: true vẫn chỉ được bản xuất bản (2 việc, không phải 3).
    expect((await org.run((tx, ctx) => simulateTemplate(tx, ctx, office, templateId, { draft: true, inputs: {} }))).rows).toHaveLength(2);

    const designer = org.viewer('process_designer');
    const draftSim = await org.run((tx, ctx) => simulateTemplate(tx, ctx, designer, templateId, { draft: true, inputs: {} }));
    expect(draftSim.rows.map((r) => r.nodeId).sort()).toEqual(['t1', 't2', 't3']);
    // t3 giao cho người khởi chạy: ở đây là chính người chạy thử
    expect(draftSim.rows.find((r) => r.nodeId === 't3')!.assignee!.id).toBe(designer.id);

    await expectApiError(org.run((tx, ctx) => simulateTemplate(tx, ctx, office, templateId, { version: 2, inputs: {} })), 'not_found');
  });

  it('chạy thử nháp còn lỗi thì 422', async () => {
    const designer = org.viewer('process_designer');
    const fresh = await org.run((tx, ctx) => createTemplate(tx, ctx, designer, { name: 'Mẫu dở', description: null }));
    const err = await expectApiError(org.run((tx, ctx) => simulateTemplate(tx, ctx, designer, fresh.id, { draft: true, inputs: {} })), 'template_invalid');
    expect(err.extra.errors!.length).toBeGreaterThan(0);
    // chưa xuất bản lần nào thì người điều phối không chạy thử được
    await expectApiError(org.run((tx, ctx) => simulateTemplate(tx, ctx, org.viewer('office_admin'), fresh.id, { inputs: {} })), 'template_invalid');
  });

  it('lưu trữ và bỏ lưu trữ', async () => {
    const designer = org.viewer('process_designer');
    const office = org.viewer('office_admin');
    const archived = await org.run((tx, ctx) => archiveTemplate(tx, ctx, designer, templateId, true));
    expect(archived.archivedAt).not.toBeNull();
    expect(await org.run((tx, ctx) => listTemplates(tx, ctx, office))).toEqual([]);
    expect((await org.run((tx, ctx) => listTemplates(tx, ctx, designer, { archived: 'true' }))).map((t) => t.id)).toEqual([templateId]);
    expect((await org.run((tx, ctx) => listTemplates(tx, ctx, designer, { archived: 'false' }))).map((t) => t.id)).not.toContain(templateId);
    // lượt chạy cũ vẫn cần vẽ lại sơ đồ: mở theo id vẫn được
    expect((await org.run((tx, ctx) => getTemplate(tx, ctx, office, templateId))).archivedAt).toBe(archived.archivedAt);

    // lưu trữ lần nữa không đổi gì và không ghi thêm nhật ký
    const same = await org.run((tx, ctx) => archiveTemplate(tx, ctx, designer, templateId, true));
    expect(same.archivedAt).toBe(archived.archivedAt);

    const restored = await org.run((tx, ctx) => archiveTemplate(tx, ctx, designer, templateId, false));
    expect(restored.archivedAt).toBeNull();
    expect((await org.run((tx, ctx) => listTemplates(tx, ctx, office))).map((t) => t.id)).toEqual([templateId]);

    const entries = await org.run((tx) => auditRows(tx, 'template_archived'));
    expect(entries.map((e) => e.detail)).toEqual([{ archived: false }, { archived: true }]);
  });

  it('tìm theo tên không dấu, nhân bản từ mẫu khác, If-Match 0 khi mẫu vừa xuất bản chưa có nháp', async () => {
    const designer = org.viewer('process_designer');
    expect((await org.run((tx, ctx) => listTemplates(tx, ctx, designer, { q: 'ho so dat' }))).map((t) => t.id)).toEqual([templateId]);

    const clone = await org.run((tx, ctx) => createTemplate(tx, ctx, designer, { name: 'Bản sao trình ký', description: null, cloneFromTemplateId: templateId }));
    // chép definition mới nhất của mẫu gốc (nháp version 2, có t3), tên theo mẫu mới
    expect(clone.draft!.definition.name).toBe('Bản sao trình ký');
    expect(clone.draft!.definition.nodes.map((n) => n.id)).toEqual(['start', 't1', 't2', 't3', 'end']);
    expect(clone.stepCount).toBe(3);

    const published = await org.run((tx, ctx) => publishTemplate(tx, ctx, designer, clone.id));
    expect(published.version).toBe(1);
    expect((await org.run((tx, ctx) => getTemplate(tx, ctx, designer, clone.id))).draft).toBeNull();
    const saved = await org.run((tx) => saveTemplateDraft(tx, designer, clone.id, { definition: clone.draft!.definition, name: 'Bản sao đã đổi tên' }, '0'));
    expect(saved.rev).toBe(1);
    const after = await org.run((tx, ctx) => getTemplate(tx, ctx, designer, clone.id));
    expect(after).toMatchObject({ name: 'Bản sao đã đổi tên', latestPublishedVersion: 1, hasDraft: true });
    expect(after.draft).toMatchObject({ version: 2, rev: 1 });
  });
});
