import { COMMENT_FILES_MAX, newId, type RunDetail, type StepView } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { addStepComment, deleteStepComment, listStepComments } from '../src/services/comments';
import { downloadFile, listRunFiles, uploadFile } from '../src/services/files';
import { actOnStep, getRun, startRun } from '../src/services/runs';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';
import { auditRows, expectApiError } from './helpers';

/** Tệp đính kèm bình luận (docs/DECISIONS.md, 12/10/2026): gắn, xem, tải, quyền, giới hạn, xoá cùng bình luận, không lẫn vào hồ sơ lượt chạy. */
let org: TestOrg;
let templateId: string;
let N: { id: string; nhap: string; duyet: string };

const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const START = { id: 'start', type: 'start', label: 'Bắt đầu' };
const END = { id: 'end', type: 'end', label: 'Hoàn tất' };
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ id: `${from}>${to}`, from, to, ...extra });
const asV = (who: TestUserKey) => org.viewer(who);
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;
const FILE_NAME = 'BIEN-BAN-MAT-123.txt';

const upload = (who: TestUserKey, name = FILE_NAME, text = 'nội dung tệp') => org.run((tx, ctx) => uploadFile(tx, ctx, asV(who), { name, data: Buffer.from(text, 'utf8').toString('base64') }));
const comment = (who: TestUserKey, stepId: string, input: { body?: string; fileIds?: string[] }) =>
  org.run((tx, ctx) => addStepComment(tx, ctx, asV(who), stepId, { body: input.body ?? '', ...(input.fileIds ? { fileIds: input.fileIds } : {}) }, { ip: '127.0.0.1' }));
const list = (who: TestUserKey, stepId: string) => org.run((tx, ctx) => listStepComments(tx, ctx, asV(who), stepId, { limit: 50 }));
const download = (who: TestUserKey, fileId: string) => org.run((tx, ctx) => downloadFile(tx, ctx, asV(who), fileId));

async function build(title: string) {
  const run = await org.run((tx, ctx) => startRun(tx, ctx, asV('designer'), { templateId, title, inputs: {} }, newId()));
  const nhap = stepOf(run, 'nhap').id;
  await org.run((tx, ctx) => actOnStep(tx, ctx, asV('employee'), nhap, newId(), { type: 'CompleteStep' }));
  const after = await org.run((tx, ctx) => getRun(tx, ctx, asV('designer'), run.id));
  return { id: run.id, nhap, duyet: stepOf(after, 'duyet').id };
}

beforeAll(async () => {
  setFakeNow('2026-10-12T03:00:00.000Z');
  org = await createTestOrg({ name: 'Công ty thử tệp bình luận' });
  const def = {
    schemaVersion: 1,
    name: 'Thử tệp bình luận',
    starters: [{ kind: 'everyone' }],
    inputs: [],
    nodes: [
      START,
      { id: 'nhap', type: 'task', label: 'Nhập', title: 'Nhập nội dung', assignee: { kind: 'user', userId: org.users.employee }, due: DUE },
      { id: 'duyet', type: 'approval', label: 'Duyệt', title: 'Duyệt nội dung', approvers: [{ kind: 'user', userId: org.users.employee2 }], mode: 'any', due: DUE },
      END,
    ],
    edges: [edge('start', 'nhap'), edge('nhap', 'duyet'), edge('duyet', 'end', { outcome: 'approved' })],
  };
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, asV('designer'), { name: def.name, description: null, definition: def as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, asV('designer'), created.id));
  templateId = created.id;
  N = await build('Lượt thử tệp bình luận');
});
afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

describe('tệp đính kèm bình luận', () => {
  it('bình luận chỉ có tệp (không chữ) gửi được; ai thấy việc thì thấy và tải được tệp, người ngoài 404', async () => {
    const f = await upload('employee2');
    const c = await comment('employee2', N.duyet, { fileIds: [f.id] });
    expect(c.body).toBe('');
    expect(c.files).toHaveLength(1);
    expect(c.files[0]).toMatchObject({ id: f.id, name: FILE_NAME, status: 'attached', fieldKey: '__comment' });

    const seen = await list('designer', N.duyet);
    expect(seen.items.find((i) => i.id === c.id)!.files.map((x) => x.id)).toEqual([f.id]);
    for (const who of ['designer', 'employee2', 'chairman'] as TestUserKey[]) {
      const { data, row } = await download(who, f.id);
      expect(data.toString('utf8')).toBe('nội dung tệp');
      expect(row.name).toBe(FILE_NAME);
    }
    for (const who of ['employee', 'itAdmin'] as TestUserKey[]) await expectApiError(download(who, f.id), 'not_found');
  });

  it('có cả chữ lẫn tệp; không chữ không tệp thì 400; quá số tệp thì 400', async () => {
    const f = await upload('designer', 'a.txt');
    const c = await comment('designer', N.duyet, { body: 'Xin xem tệp kèm.', fileIds: [f.id] });
    expect(c.body).toBe('Xin xem tệp kèm.');
    expect(c.files).toHaveLength(1);

    const empty = await expectApiError(comment('designer', N.duyet, {}), 'input_invalid');
    expect(empty.extra.errors).toEqual([{ path: 'body.body', code: 'required' }]);

    const many = await Promise.all(Array.from({ length: COMMENT_FILES_MAX + 1 }, (_, i) => upload('designer', `m${i}.txt`)));
    const tooMany = await expectApiError(comment('designer', N.duyet, { fileIds: many.map((m) => m.id) }), 'input_invalid');
    expect(tooMany.extra.errors).toEqual([{ path: 'body.fileIds', code: 'too_many' }]);
    // bình luận lỗi không để lại tệp đã gắn
    const rows = await org.run((tx) => tx.select({ status: schema.files.status }).from(schema.files).where(eq(schema.files.id, many[0]!.id)));
    expect(rows[0]!.status).toBe('pending');
  });

  it('chỉ đính được tệp của chính mình còn chờ gắn: tệp người khác, tệp đã gắn, id không có đều bị từ chối', async () => {
    const mine = await upload('designer', 'cua-minh.txt');
    const theirs = await upload('employee2', 'cua-nguoi-khac.txt');
    await expectApiError(comment('designer', N.duyet, { fileIds: [theirs.id] }), 'input_invalid');
    await expectApiError(comment('designer', N.duyet, { fileIds: [newId()] }), 'input_invalid');
    const ok = await comment('designer', N.duyet, { fileIds: [mine.id] });
    expect(ok.files).toHaveLength(1);
    // tệp đã gắn vào bình luận thì không đính lại vào bình luận khác
    const again = await expectApiError(comment('designer', N.duyet, { fileIds: [mine.id] }), 'input_invalid');
    expect(again.extra.errors).toEqual([{ path: 'body.fileIds', code: 'file_unavailable' }]);
  });

  it('tệp bình luận không lẫn vào hồ sơ lượt chạy', async () => {
    const f = await upload('designer', 'chi-trong-thao-luan.txt');
    await comment('designer', N.duyet, { fileIds: [f.id] });
    const run = await org.run((tx, ctx) => getRun(tx, ctx, asV('designer'), N.id));
    expect((run.files ?? []).some((x) => x.id === f.id)).toBe(false);
    const listed = await org.run((tx, ctx) => listRunFiles(tx, ctx, asV('designer'), N.id));
    expect(listed.some((x) => x.id === f.id)).toBe(false);
  });

  it('xoá bình luận thì xoá cả tệp; nhật ký chỉ ghi số tệp, không ghi tên tệp', async () => {
    const f = await upload('employee2', 'se-bi-xoa.txt');
    const c = await comment('employee2', N.duyet, { body: 'Tệp này sắp xoá.', fileIds: [f.id] });
    await org.run((tx, ctx) => deleteStepComment(tx, ctx, asV('employee2'), N.duyet, c.id));
    await expectApiError(download('employee2', f.id), 'not_found');
    await expectApiError(download('designer', f.id), 'not_found');
    expect((await list('designer', N.duyet)).items.some((i) => i.id === c.id)).toBe(false);

    const added = await org.run((tx) => auditRows(tx, 'step_comment_added'));
    const deleted = await org.run((tx) => auditRows(tx, 'step_comment_deleted'));
    expect(added.some((r) => (r.detail as { fileCount?: number }).fileCount === 1)).toBe(true);
    expect(deleted.some((r) => (r.detail as { fileCount?: number }).fileCount === 1)).toBe(true);
    expect(JSON.stringify([...added, ...deleted])).not.toMatch(/xoá\.txt|BIEN-BAN|se-bi/);
  });
});
