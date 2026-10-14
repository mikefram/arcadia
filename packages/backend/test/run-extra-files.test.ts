import { newId, type RunDetail, type StepView } from '@mihato/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/client';
import { attachRunFiles, listRunFiles, uploadFile } from '../src/services/files';
import { actOnStep, getRun, startRun } from '../src/services/runs';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { MemoryFileStorage, setFileStorage } from '../src/storage';
import { createTestOrg, type TestOrg } from '../src/testing';
import { auditRows, expectApiError } from './helpers';

/**
 * Đính THÊM tài liệu vào lượt chạy đang chạy (docs/DECISIONS.md, 12/10/2026): ai được, lúc nào, tệp của ai, và nhật ký không ghi tên tệp.
 */
let org: TestOrg;
let templateId: string;
const storage = new MemoryFileStorage();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };

beforeAll(async () => {
  setFileStorage(storage);
  org = await createTestOrg();
  const def = {
    schemaVersion: 1,
    name: 'Xử lý công văn',
    inputs: [{ key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true }],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 'xem', type: 'task', label: 'Xem', title: 'Xem công văn', assignee: { kind: 'user', userId: org.users.employee }, due: DUE },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 'start>xem', from: 'start', to: 'xem' },
      { id: 'xem>end', from: 'xem', to: 'end' },
    ],
  };
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, org.viewer('designer'), { name: 'Xử lý công văn', description: null, definition: def as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, org.viewer('designer'), created.id));
  templateId = created.id;
});
afterAll(async () => {
  setFileStorage(null);
  await closeDb();
});

type Who = Parameters<TestOrg['viewer']>[0];
const upload = (who: Who, name = 'bo-sung.pdf') => org.run((tx, ctx) => uploadFile(tx, ctx, org.viewer(who), { name, data: PDF.toString('base64') }));
const startOne = () => org.run((tx, ctx) => startRun(tx, ctx, org.viewer('officeAdmin'), { templateId, title: 'Công văn thử', inputs: { trichYeu: 'Thử' } }, newId()));
const attach = (who: Who, runId: string, ids: string[]) => org.run((tx, ctx) => attachRunFiles(tx, ctx, org.viewer(who), runId, ids));
const stepOf = (run: RunDetail): StepView => run.steps.find((s) => s.nodeId === 'xem')!;

describe('đính thêm tài liệu vào lượt chạy', () => {
  it('người khởi chạy đính được: tệp vào hồ sơ không gắn với việc nào, mang dấu bổ sung, nhật ký chỉ ghi số tệp', async () => {
    const run = await startOne();
    const f = await upload('officeAdmin', 'ban-scan-bo-sung.pdf');
    const added = await attach('officeAdmin', run.id, [f.id]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: f.id, status: 'attached', runId: run.id, stepId: null, fieldKey: '__extra', compiled: false });

    const listed = await org.run((tx, ctx) => listRunFiles(tx, ctx, org.viewer('director'), run.id));
    expect(listed.map((x) => x.id)).toContain(f.id);

    const rows = await org.run((tx) => auditRows(tx, 'run_files_attached'));
    const entry = rows.find((r) => r.targetId === run.id)!;
    expect(entry.detail).toEqual({ count: 1, bytes: PDF.length });
    expect(JSON.stringify(entry.detail)).not.toMatch(/scan|pdf/i);
  });

  it('người đang giữ việc của lượt cũng đính được; gửi lại cùng tệp không lỗi và không ghi nhật ký lần hai', async () => {
    const run = await startOne();
    const f = await upload('employee');
    await attach('employee', run.id, [f.id]);
    const before = (await org.run((tx) => auditRows(tx, 'run_files_attached'))).filter((r) => r.targetId === run.id).length;
    await attach('employee', run.id, [f.id]);
    const after = (await org.run((tx) => auditRows(tx, 'run_files_attached'))).filter((r) => r.targetId === run.id).length;
    expect(after).toBe(before);
  });

  it('người thấy lượt chạy nhưng không phải chủ, không giữ việc, không có run.note thì bị từ chối', async () => {
    const run = await startOne();
    // Bảo là trưởng đơn vị của Lan (người giữ việc) nên thấy lượt chạy, nhưng không có quyền đính thêm.
    const f = await upload('head');
    await expectApiError(attach('head', run.id, [f.id]), 'forbidden');
  });

  it('người không thấy lượt chạy thì 404', async () => {
    const run = await startOne();
    const f = await upload('employee2');
    await expectApiError(attach('employee2', run.id, [f.id]), 'not_found');
  });

  it('chỉ đính được tệp do chính mình tải lên và còn chờ gắn', async () => {
    const run = await startOne();
    const theirs = await upload('officeAdmin');
    const err = await expectApiError(attach('employee', run.id, [theirs.id]), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'body.fileIds', code: 'file_unavailable' }]);
    await expectApiError(attach('officeAdmin', run.id, [newId()]), 'input_invalid');
  });

  it('lượt chạy đã xong thì không đính thêm (hồ sơ đã khép)', async () => {
    const run = await startOne();
    await org.run((tx, ctx) => actOnStep(tx, ctx, org.viewer('employee'), stepOf(run).id, newId(), { type: 'CompleteStep', result: {} }));
    const done = await org.run((tx, ctx) => getRun(tx, ctx, org.viewer('officeAdmin'), run.id));
    expect(done.state).toBe('completed');
    const f = await upload('officeAdmin');
    await expectApiError(attach('officeAdmin', run.id, [f.id]), 'state_conflict');
  });
});
