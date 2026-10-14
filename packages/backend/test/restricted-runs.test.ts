import { newId, type RunDetail, type StepView } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { currentBriefing } from '../src/services/briefing';
import { downloadFile, listRunFiles, uploadFile } from '../src/services/files';
import { getOverview } from '../src/services/overview';
import { listEntries, listRegisters, upsertRegister } from '../src/services/registers';
import { getReport } from '../src/services/reports';
import { actOnStep, getRun, getStepDetail, listActivity, listExtensionRequests, listRunEvents, listRuns, listSteps, startRun } from '../src/services/runs';
import { getRunShares, removeRunShare, setRunShare } from '../src/services/shares';
import { listStepComments } from '../src/services/comments';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { MemoryFileStorage, setFileStorage } from '../src/storage';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';
import { viewerSeesRun } from '../src/views';
import { auditRows, expectApiError } from './helpers';

/**
 * Văn bản mật và chia sẻ kiểu Google Drive (docs/DECISIONS.md, 07/10/2026 điểm b).
 *
 * Một lượt THƯỜNG (N) và một lượt MẬT (R) cùng một quy trình, do Khôi (designer, không có `run.view_all`) khởi chạy:
 *   nhap  (Lan làm)  →  duyet (Tuấn duyệt)
 * Người xem: chủ sở hữu Khôi; người tham gia Lan và Tuấn; người có `run.view_all` (Chủ tịch, Giám đốc, Phó giám đốc, Hạnh ở Văn phòng);
 * trưởng Phòng Kinh doanh Bảo (cấp trên trực tiếp của Lan và Tuấn); Tài (it_admin) là người ngoài.
 */
let org: TestOrg;
const storage = new MemoryFileStorage();

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const START = { id: 'start', type: 'start', label: 'Bắt đầu' };
const END = { id: 'end', type: 'end', label: 'Hoàn tất' };
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ id: `${from}>${to}`, from, to, ...extra });

const ALL: TestUserKey[] = ['chairman', 'director', 'deputy', 'officeAdmin', 'designer', 'itAdmin', 'head', 'employee', 'employee2'];
type Run = { id: string; stepNhap: string; stepDuyet: string; fileId: string };
let N: Run;
let R: Run;
let templateId: string;

const asV = (who: TestUserKey) => org.viewer(who);
const publishDef = async (name: string, def: Record<string, unknown>): Promise<string> => {
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, asV('designer'), { name, description: null, definition: { schemaVersion: 1, name, ...def } as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, asV('designer'), created.id));
  return created.id;
};
const OPTIONS = [
  { value: 'thuong', label: 'Thường' },
  { value: 'mat', label: 'Mật' },
  { value: 'toi_mat', label: 'Tối mật' },
  { value: 'tuyet_mat', label: 'Tuyệt mật' },
];
const startAs = async (who: TestUserKey, title: string, mucMat: string, extra: Record<string, unknown> = {}, tpl = templateId): Promise<RunDetail> => {
  const file = await org.run((tx, ctx) => uploadFile(tx, ctx, asV(who), { name: 'ban-scan.pdf', data: PDF.toString('base64') }));
  return org.run((tx, ctx) => startRun(tx, ctx, asV(who), { templateId: tpl, title, inputs: { trichYeu: `Trích yếu ${title}`, mucMat, tep: [file.id], ...extra } }, newId()));
};
const act = (who: TestUserKey, stepId: string, input: Parameters<typeof actOnStep>[5]) => org.run((tx, ctx) => actOnStep(tx, ctx, asV(who), stepId, newId(), input));
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;

/** Dựng một lượt: Lan xong bước nhập nên Tuấn có việc duyệt. */
async function build(title: string, mucMat: string): Promise<Run> {
  const run = await startAs('designer', title, mucMat);
  await act('employee', stepOf(run, 'nhap').id, { type: 'CompleteStep' });
  const after = await org.run((tx, ctx) => getRun(tx, ctx, asV('designer'), run.id));
  return { id: run.id, stepNhap: stepOf(after, 'nhap').id, stepDuyet: stepOf(after, 'duyet').id, fileId: run.files![0]!.id };
}

beforeAll(async () => {
  setFileStorage(storage);
  org = await createTestOrg({ name: 'Công ty thử mức mật' });
  await org.run((tx, ctx) =>
    upsertRegister(tx, ctx, asV('itAdmin'), 'SOMAT', { name: 'Sổ thử mật', direction: 'incoming', pattern: '{seq:3}', resetPolicy: 'yearly', columns: [{ key: 'mucMat', label: 'Mức mật' }] }),
  );
  templateId = await publishDef('Văn bản thử mức mật', {
    starters: [{ kind: 'everyone' }],
    inputs: [
      { key: 'so', label: 'Số', type: 'autonumber', register: 'SOMAT' },
      { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
      { key: 'mucMat', label: 'Mức mật', type: 'select', required: true, options: OPTIONS },
      { key: 'tep', label: 'Tệp', type: 'file', multiple: true },
    ],
    nodes: [
      START,
      { id: 'nhap', type: 'task', label: 'Nhập', title: 'Nhập nội dung', assignee: { kind: 'user', userId: org.users.employee }, due: DUE },
      { id: 'duyet', type: 'approval', label: 'Duyệt', title: 'Duyệt nội dung', approvers: [{ kind: 'user', userId: org.users.employee2 }], mode: 'any', due: DUE },
      END,
    ],
    edges: [edge('start', 'nhap'), edge('nhap', 'duyet'), edge('duyet', 'end', { outcome: 'approved' })],
  });
  N = await build('Công văn thường', 'thuong');
  R = await build('Công văn mật', 'mat');
});
afterAll(async () => {
  setFileStorage(null);
  setFakeNow(null);
  await closeDb();
});

/** Ai thấy lượt: người có đường vào riêng. */
const ENTRY: TestUserKey[] = ['designer', 'employee', 'employee2'];
const NORMAL_VISIBLE: TestUserKey[] = [...ALL.filter((u) => u !== 'itAdmin')];

const seesRun = (who: TestUserKey, runId: string) => org.run((tx, ctx) => viewerSeesRun(tx, ctx, asV(who), runId));
const listIds = async (who: TestUserKey) => (await org.run((tx, ctx) => listRuns(tx, ctx, asV(who), { limit: 100, sort: '-startedAt' }))).items.map((r) => r.id);
const stepIdsOf = async (who: TestUserKey, runId: string) => (await org.run((tx, ctx) => listSteps(tx, ctx, asV(who), { limit: 100, runId, sort: 'dueAt' }))).items.map((s) => s.id);

describe('mức mật được tính một lần lúc khởi chạy', () => {
  it('ô mucMat là mat, toi_mat hoặc tuyet_mat thì lượt hạn chế; thường, trống hoặc không có ô thì lượt thường', async () => {
    const level = async (mucMat: string) => (await startAs('designer', `Lượt ${mucMat}`, mucMat)).confidentiality;
    expect(await level('thuong')).toBe('normal');
    expect(await level('mat')).toBe('restricted');
    expect(await level('toi_mat')).toBe('restricted');
    expect(await level('tuyet_mat')).toBe('restricted');
    const plain = await publishDef('Không có ô mức mật', {
      starters: [{ kind: 'everyone' }],
      inputs: [{ key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true }],
      nodes: [START, { id: 'xem', type: 'task', label: 'Xem', title: 'Xem', assignee: { kind: 'user', userId: org.users.employee }, due: DUE }, END],
      edges: [edge('start', 'xem'), edge('xem', 'end')],
    });
    const detail = await org.run((tx, ctx) => startRun(tx, ctx, asV('designer'), { templateId: plain, title: 'Thường', inputs: { trichYeu: 'x' } }, newId()));
    expect(detail.confidentiality).toBe('normal');
    // Một ô tên khác (mucKhan) chứa giá trị mat không làm lượt hạn chế: chỉ ô mucMat được xét.
    const other = await publishDef('Ô khác tên', {
      starters: [{ kind: 'everyone' }],
      inputs: [{ key: 'mucKhan', label: 'Mức khẩn', type: 'select', options: [{ value: 'mat', label: 'Mật' }] }],
      nodes: [START, { id: 'xem', type: 'task', label: 'Xem', title: 'Xem', assignee: { kind: 'user', userId: org.users.employee }, due: DUE }, END],
      edges: [edge('start', 'xem'), edge('xem', 'end')],
    });
    expect((await org.run((tx, ctx) => startRun(tx, ctx, asV('designer'), { templateId: other, title: 'Ô khác', inputs: { mucKhan: 'mat' } }, newId()))).confidentiality).toBe('normal');
  });
});

describe('ma trận người xem × lượt thường và lượt mật', () => {
  it('lượt thường giữ nguyên: người xem mọi lượt, người tham gia, chủ sở hữu và cấp trên của người nhận thấy; người ngoài không', async () => {
    for (const who of ALL) expect(await seesRun(who, N.id), `thường ← ${who}`).toBe(NORMAL_VISIBLE.includes(who));
  });

  it('lượt mật: chỉ chủ sở hữu và người tham gia; Chủ tịch, Giám đốc, Phó giám đốc, Văn phòng và cấp trên của người nhận KHÔNG thấy', async () => {
    for (const who of ALL) expect(await seesRun(who, R.id), `mật ← ${who}`).toBe(ENTRY.includes(who));
    const hidden: TestUserKey[] = ['chairman', 'director', 'deputy', 'officeAdmin', 'head', 'itAdmin'];
    for (const who of hidden) await expectApiError(org.run((tx, ctx) => getRun(tx, ctx, asV(who), R.id)), 'not_found');
    for (const who of ENTRY) expect((await org.run((tx, ctx) => getRun(tx, ctx, asV(who), R.id))).confidentiality).toBe('restricted');
  });

  it('danh sách lượt chạy và danh sách việc đi cùng một quy tắc', async () => {
    for (const who of ALL) {
      const ids = await listIds(who);
      expect(ids.includes(N.id), `ds thường ← ${who}`).toBe(NORMAL_VISIBLE.includes(who));
      expect(ids.includes(R.id), `ds mật ← ${who}`).toBe(ENTRY.includes(who));
      const steps = await stepIdsOf(who, R.id);
      expect(steps.includes(R.stepNhap), `việc mật ← ${who}`).toBe(who === 'designer' || who === 'employee');
      expect(steps.includes(R.stepDuyet), `việc duyệt mật ← ${who}`).toBe(who === 'designer' || who === 'employee2');
    }
    // Lọc theo từ khoá trích yếu cũng không lộ.
    const found = await org.run((tx, ctx) => listRuns(tx, ctx, asV('chairman'), { limit: 50, q: 'mật', sort: '-startedAt' }));
    expect(found.items.some((r) => r.id === R.id)).toBe(false);
  });

  it('chi tiết việc, việc của lượt mật: người ngoài 404; người tham gia đọc được; hoạt động và dòng thời gian cũng vậy', async () => {
    for (const who of ['chairman', 'director', 'deputy', 'officeAdmin', 'head', 'itAdmin'] as TestUserKey[]) {
      await expectApiError(org.run((tx, ctx) => getStepDetail(tx, ctx, asV(who), R.stepNhap)), 'not_found');
      await expectApiError(org.run((tx, ctx) => listRunEvents(tx, ctx, asV(who), R.id, { limit: 50 })), 'not_found');
      const activity = await org.run((tx, ctx) => listActivity(tx, ctx, asV(who), 200));
      expect(activity.some((a) => a.runId === R.id), `hoạt động ← ${who}`).toBe(false);
    }
    expect((await org.run((tx, ctx) => getStepDetail(tx, ctx, asV('employee'), R.stepNhap))).state).toBe('done');
    expect((await org.run((tx, ctx) => listRunEvents(tx, ctx, asV('designer'), R.id, { limit: 50 }))).items.length).toBeGreaterThan(0);
    expect((await org.run((tx, ctx) => listActivity(tx, ctx, asV('designer'), 200))).some((a) => a.runId === R.id)).toBe(true);
    // Lượt thường: Giám đốc đọc được dòng thời gian và hoạt động như trước.
    expect((await org.run((tx, ctx) => listRunEvents(tx, ctx, asV('director'), N.id, { limit: 50 }))).items.length).toBeGreaterThan(0);
    expect((await org.run((tx, ctx) => listActivity(tx, ctx, asV('director'), 200))).some((a) => a.runId === N.id)).toBe(true);
  });

  it('tệp: danh sách và tải xuống của lượt mật là 404 với người ngoài, kể cả Chủ tịch; lượt thường vẫn tải được', async () => {
    for (const who of ['chairman', 'director', 'deputy', 'officeAdmin', 'head', 'itAdmin'] as TestUserKey[]) {
      await expectApiError(org.run((tx, ctx) => listRunFiles(tx, ctx, asV(who), R.id)), 'not_found');
      await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, asV(who), R.fileId)), 'not_found');
    }
    for (const who of ENTRY) {
      expect((await org.run((tx, ctx) => listRunFiles(tx, ctx, asV(who), R.id))).length).toBe(1);
      expect((await org.run((tx, ctx) => downloadFile(tx, ctx, asV(who), R.fileId))).data.equals(PDF)).toBe(true);
    }
    expect((await org.run((tx, ctx) => downloadFile(tx, ctx, asV('chairman'), N.fileId))).data.equals(PDF)).toBe(true);
  });

  it('Sổ văn bản: dòng của lượt mật chỉ hiện cho người xem được lượt, và số đếm không tính dòng đó', async () => {
    const entries = async (who: TestUserKey) => (await org.run((tx, ctx) => listEntries(tx, ctx, asV(who), 'SOMAT', { limit: 100 }))).items;
    const count = async (who: TestUserKey) => (await org.run((tx, ctx) => listRegisters(tx, ctx, asV(who)))).find((r) => r.code === 'SOMAT')!.entryCount;
    const rows = await org.run((tx) => tx.select({ runId: schema.documentEntries.runId, confidentiality: schema.processRuns.confidentiality }).from(schema.documentEntries).innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.documentEntries.runId)));
    const restricted = rows.filter((r) => r.confidentiality === 'restricted').map((r) => r.runId);
    expect(restricted.length).toBeGreaterThanOrEqual(4);
    const normalRuns = rows.filter((r) => r.confidentiality !== 'restricted').map((r) => r.runId);
    for (const who of ['chairman', 'director', 'deputy', 'officeAdmin', 'head', 'itAdmin'] as TestUserKey[]) {
      const seen = await entries(who);
      // Dòng của lượt thường theo đúng tầm nhìn của lượt đó; dòng của lượt mật không bao giờ lọt vào.
      expect(seen.some((e) => restricted.includes(e.run.id)), `sổ lộ dòng mật ← ${who}`).toBe(false);
      // Lượt thường: mở cho mọi người có quyền xem sổ như trước, không phụ thuộc tầm nhìn lượt chạy.
      expect(seen.length, `dòng ← ${who}`).toBe(normalRuns.length);
      expect(await count(who), `đếm ← ${who}`).toBe(normalRuns.length);
    }
    for (const who of ['designer', 'employee'] as TestUserKey[]) {
      expect((await entries(who)).length, `dòng ← ${who}`).toBe(rows.length);
      expect(await count(who)).toBe(rows.length);
    }
    // Tìm theo từ khoá cũng không lộ dòng mật.
    const found = await org.run((tx, ctx) => listEntries(tx, ctx, asV('chairman'), 'SOMAT', { limit: 100, q: 'mật' }));
    expect(found.items.some((e) => restricted.includes(e.run.id))).toBe(false);
  });

  it('tổng quan, báo cáo và báo cáo đầu ngày không tính và không nêu lượt mật với người ngoài đường vào', async () => {
    const overview = (who: TestUserKey) => org.run((tx, ctx) => getOverview(tx, ctx, asV(who)));
    const visibleRuns = async (who: TestUserKey) => (await listIds(who)).length;
    for (const who of ['chairman', 'director', 'officeAdmin'] as TestUserKey[]) {
      expect((await overview(who)).running, `running ← ${who}`).toBe(await visibleRuns(who));
    }
    // Chủ tịch: lượt mật không tính; Khôi (chủ sở hữu) tính đủ.
    expect((await overview('designer')).running).toBeGreaterThan((await overview('chairman')).running);
    expect((await overview('designer')).pendingApproval).toBe((await overview('chairman')).pendingApproval + 1);
    const wide = { from: '2020-01-01', to: '2099-12-31' };
    const report = (who: TestUserKey) => org.run((tx, ctx) => getReport(tx, ctx, asV(who), wide));
    expect((await report('chairman')).completedCount).toBe(1); // chỉ bước nhập của N
    expect((await report('designer')).completedCount).toBe(2); // N và R
    expect((await report('itAdmin')).completedCount).toBe(0);
    // Báo cáo đầu ngày đọc to cho Chủ tịch: số việc chưa xong chỉ gồm việc nhìn thấy.
    const open = async (who: TestUserKey) => (await org.run((tx, ctx) => listSteps(tx, ctx, asV(who), { limit: 200, open: true, sort: 'dueAt' }))).items.length;
    const briefing = await org.run((tx, ctx) => currentBriefing(tx, ctx, asV('chairman')));
    expect(briefing?.text).toContain(`Hiện còn ${await open('chairman')} việc chưa xong`);
    expect(await open('chairman')).toBeLessThan(await open('designer'));
  });

  it('yêu cầu gia hạn của việc trong lượt mật không hiện cho người có quyền quyết gia hạn nhưng không có đường vào', async () => {
    const run = await startAs('designer', 'Công văn mật cần gia hạn', 'tuyet_mat');
    const nhap = stepOf(run, 'nhap');
    await act('employee', nhap.id, { type: 'RequestExtension', proposedDueAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), reason: 'Cần thêm thời gian' });
    const pending = (who: TestUserKey) => org.run((tx, ctx) => listExtensionRequests(tx, ctx, asV(who), 'pending'));
    expect((await pending('chairman')).some((x) => x.step.runId === run.id)).toBe(false);
    expect((await pending('officeAdmin')).some((x) => x.step.runId === run.id)).toBe(false);
    expect((await pending('designer')).some((x) => x.step.runId === run.id)).toBe(true);
  });

  it('tổ chức khác không thấy gì: lượt mật và lượt thường đều 404 qua RLS', async () => {
    const other = await createTestOrg({ name: 'Tổ chức khác' });
    for (const id of [N.id, R.id]) {
      await expectApiError(other.run((tx, ctx) => getRun(tx, ctx, other.viewer('chairman'), id)), 'not_found');
      expect(await other.run((tx, ctx) => viewerSeesRun(tx, ctx, other.viewer('chairman'), id))).toBe(false);
      await expectApiError(other.run((tx, ctx) => setRunShare(tx, ctx, other.viewer('chairman'), id, other.users.employee, 'viewer')), 'not_found');
    }
    expect((await other.run((tx, ctx) => listRuns(tx, ctx, other.viewer('chairman'), { limit: 50, sort: '-startedAt' }))).items).toHaveLength(0);
  });
});

describe('chia sẻ kiểu Google Drive', () => {
  const shares = (who: TestUserKey, runId: string) => org.run((tx, ctx) => getRunShares(tx, ctx, asV(who), runId));
  const share = (who: TestUserKey, runId: string, target: TestUserKey, role: 'viewer' | 'commenter') => org.run((tx, ctx) => setRunShare(tx, ctx, asV(who), runId, org.users[target], role, { ip: '127.0.0.1' }));
  const unshare = (who: TestUserKey, runId: string, target: TestUserKey) => org.run((tx, ctx) => removeRunShare(tx, ctx, asV(who), runId, org.users[target]));

  it('người không thấy lượt mật thì không quản lý được chia sẻ (404), kể cả có quyền run.share; người tham gia không có quyền thì 403', async () => {
    await expectApiError(share('officeAdmin', R.id, 'itAdmin', 'viewer'), 'not_found');
    await expectApiError(share('chairman', R.id, 'itAdmin', 'viewer'), 'not_found');
    await expectApiError(share('employee', R.id, 'itAdmin', 'viewer'), 'forbidden');
    await expectApiError(shares('director', R.id), 'not_found');
  });

  it('chủ sở hữu thêm người xem: người đó thấy lượt, việc, tệp, dòng sổ nhưng không bình luận được và không quản lý được', async () => {
    const view = await share('designer', R.id, 'itAdmin', 'viewer');
    expect(view.shares.map((x) => [x.person.id, x.role])).toEqual([[org.users.itAdmin, 'viewer']]);
    expect(view.fixed.map((x) => x.role).sort()).toEqual(['owner', 'participant', 'participant']);
    expect(view.canManage).toBe(true);
    expect(await seesRun('itAdmin', R.id)).toBe(true);
    expect((await org.run((tx, ctx) => getRun(tx, ctx, asV('itAdmin'), R.id))).id).toBe(R.id);
    expect((await org.run((tx, ctx) => getStepDetail(tx, ctx, asV('itAdmin'), R.stepNhap))).id).toBe(R.stepNhap);
    expect(await stepIdsOf('itAdmin', R.id)).toEqual(expect.arrayContaining([R.stepNhap, R.stepDuyet]));
    expect((await org.run((tx, ctx) => downloadFile(tx, ctx, asV('itAdmin'), R.fileId))).data.equals(PDF)).toBe(true);
    expect((await org.run((tx, ctx) => listRunFiles(tx, ctx, asV('itAdmin'), R.id))).length).toBe(1);
    expect((await org.run((tx, ctx) => listEntries(tx, ctx, asV('itAdmin'), 'SOMAT', { limit: 100 }))).items.some((e) => e.run.id === R.id)).toBe(true);
    expect((await listIds('itAdmin')).includes(R.id)).toBe(true);
    const mine = await shares('itAdmin', R.id);
    expect(mine).toMatchObject({ canManage: false, canComment: false });
    expect((await org.run((tx, ctx) => listStepComments(tx, ctx, asV('itAdmin'), R.stepNhap, { limit: 10 }))).canComment).toBe(false);
    await expectApiError(share('itAdmin', R.id, 'head', 'viewer'), 'forbidden');
    // Người chưa được chia sẻ vẫn không thấy.
    expect(await seesRun('head', R.id)).toBe(false);
  });

  it('đổi mức, người có run.view_all được chia sẻ vẫn thấy; Giám đốc không được chia sẻ thì vẫn 404', async () => {
    const changed = await share('designer', R.id, 'itAdmin', 'commenter');
    expect(changed.shares[0]!.role).toBe('commenter');
    expect((await shares('itAdmin', R.id)).canComment).toBe(true);
    await share('designer', R.id, 'deputy', 'viewer');
    expect(await seesRun('deputy', R.id)).toBe(true);
    expect(await seesRun('director', R.id)).toBe(false);
    expect(await seesRun('chairman', R.id)).toBe(false);
    // Phó giám đốc được chia sẻ mức xem: đọc được, không bình luận (dù có view_all, vì lượt mật).
    expect((await shares('deputy', R.id)).canComment).toBe(false);
  });

  it('không thêm được chủ sở hữu hay người tham gia; không gỡ được họ; gỡ người không có trong danh sách là 404', async () => {
    for (const who of ['designer', 'employee', 'employee2'] as TestUserKey[]) {
      const err = await share('designer', R.id, who, 'viewer').then(() => null, (e: { extra?: { errors?: { code: string }[] } }) => e.extra?.errors?.[0]?.code);
      expect(err, `thêm ${who}`).toBe('already_has_access');
      const err2 = await unshare('designer', R.id, who).then(() => null, (e: { extra?: { errors?: { code: string }[] } }) => e.extra?.errors?.[0]?.code);
      expect(err2, `gỡ ${who}`).toBe('cannot_remove_participant');
    }
    await expectApiError(unshare('designer', R.id, 'head'), 'not_found');
  });

  it('gỡ chia sẻ thì mất quyền xem ngay; mỗi lần thêm, đổi, gỡ đều ghi audit_log chỉ có id và mức', async () => {
    await unshare('designer', R.id, 'itAdmin');
    expect(await seesRun('itAdmin', R.id)).toBe(false);
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, asV('itAdmin'), R.fileId)), 'not_found');
    await unshare('designer', R.id, 'deputy');
    expect(await seesRun('deputy', R.id)).toBe(false);
    const audit = await org.run(async (tx) => ({ added: await auditRows(tx, 'run_share_added'), changed: await auditRows(tx, 'run_share_changed'), removed: await auditRows(tx, 'run_share_removed') }));
    expect(audit.added.length).toBeGreaterThanOrEqual(2);
    expect(audit.changed.length).toBe(1);
    expect(audit.removed.length).toBe(2);
    for (const row of [...audit.added, ...audit.changed, ...audit.removed]) {
      expect(row.targetType).toBe('run');
      expect(row.actorUserId).toBe(org.users.designer);
      expect(Object.keys(row.detail as object).every((k) => ['userId', 'role', 'previousRole', 'confidentiality'].includes(k))).toBe(true);
      expect(JSON.stringify(row.detail)).not.toMatch(/Lê|Phạm|Ngô|mật/);
    }
  });

  it('lượt thường: chủ sở hữu và người có run.share chia sẻ thêm cho người chưa thấy; Giám đốc chỉ có run.view_all thì 403', async () => {
    expect(await seesRun('itAdmin', N.id)).toBe(false);
    await expectApiError(share('director', N.id, 'itAdmin', 'viewer'), 'forbidden');
    await share('designer', N.id, 'itAdmin', 'viewer');
    expect(await seesRun('itAdmin', N.id)).toBe(true);
    await unshare('officeAdmin', N.id, 'itAdmin');
    expect(await seesRun('itAdmin', N.id)).toBe(false);
    await share('chairman', N.id, 'itAdmin', 'commenter');
    expect(await seesRun('itAdmin', N.id)).toBe(true);
    await unshare('designer', N.id, 'itAdmin');
  });

  it('lượt mật: quyền run.share một mình không đủ, nhưng người có run.share mà là người tham gia thì quản lý được', async () => {
    // Hạnh (office_admin) có run.share nhưng không dính tới R: 404. Cho Hạnh làm người xem rồi cô ấy quản lý được vì có run.share.
    await expectApiError(share('officeAdmin', R.id, 'itAdmin', 'viewer'), 'not_found');
    await share('designer', R.id, 'officeAdmin', 'viewer');
    const view = await share('officeAdmin', R.id, 'itAdmin', 'viewer');
    expect(view.shares.map((x) => x.person.id).sort()).toEqual([org.users.itAdmin, org.users.officeAdmin].sort());
    await unshare('officeAdmin', R.id, 'itAdmin');
    await unshare('designer', R.id, 'officeAdmin');
    expect(await seesRun('officeAdmin', R.id)).toBe(false);
  });
});
