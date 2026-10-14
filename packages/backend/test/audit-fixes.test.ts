import { FakePush } from '@mihato/providers/push';
import { can, newId, type RunDetail, type StepView } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, getDb, schema } from '../src/db/client';
import { attachFiles, removePendingFile, uploadFile } from '../src/services/files';
import { listNotifications } from '../src/services/notifications';
import { getOverview } from '../src/services/overview';
import { allocateNumber, upsertRegister } from '../src/services/registers';
import { actOnStep, getRun, startRun } from '../src/services/runs';
import { archiveTemplate, createTemplate, publishTemplate, saveTemplateDraft } from '../src/services/templates';
import { MemoryFileStorage, setFileStorage } from '../src/storage';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';
import { assertScanRole, registerMaintenanceJob, runOrgMaintenance } from '../src/worker';
import { expectApiError } from './helpers';

/** Các sửa nhỏ của đợt rà soát 07/10/2026 (docs/RA-SOAT-2026-10-07.md): mỗi phát hiện một bài, đặt lại lỗi thì bài đỏ. */
let org: TestOrg;
const storage = new MemoryFileStorage();
const asV = (who: TestUserKey) => org.viewer(who);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n').toString('base64');
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;
let templateId: string;

beforeAll(async () => {
  setFileStorage(storage);
  setFakeNow('2026-10-07T03:00:00.000Z');
  org = await createTestOrg({ name: 'Công ty thử sửa lỗi rà soát' });
  const def = {
    schemaVersion: 1,
    name: 'Một việc',
    starters: [{ kind: 'everyone' }],
    inputs: [],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 'a', type: 'task', label: 'A', title: 'Việc A', assignee: { kind: 'user', userId: org.users.employee }, due: DUE },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 's>a', from: 'start', to: 'a' },
      { id: 'a>e', from: 'a', to: 'end' },
    ],
  };
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, asV('designer'), { name: def.name, description: null, definition: def as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, asV('designer'), created.id));
  templateId = created.id;
});
afterAll(async () => {
  setFileStorage(null);
  setFakeNow(null);
  await closeDb();
});

const begin = (who: TestUserKey, title: string) => org.run((tx, ctx) => startRun(tx, ctx, asV(who), { templateId, title, inputs: {} }, newId()));

describe('files-4: đổi chính sách đánh lại số của sổ đã cấp số', () => {
  const register = (code: string, resetPolicy: 'yearly' | 'never', name = `Sổ ${code}`) =>
    org.run((tx, ctx) => upsertRegister(tx, ctx, asV('itAdmin'), code, { name, direction: 'incoming', pattern: '{seq}', resetPolicy, columns: [] }));

  it('sổ đã có số thì không đổi được chính sách (409), vẫn đổi được tên; sổ chưa có số đổi tự do; cấp số vẫn liên tục', async () => {
    await register('F4A', 'never');
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) numbers.push((await org.run((tx, ctx) => allocateNumber(tx, ctx, 'F4A'))).number);
    expect(numbers).toEqual(['1', '2', '3']);
    const err = await expectApiError(register('F4A', 'yearly'), 'state_conflict');
    expect(err.extra.errors?.[0]).toMatchObject({ path: 'body.resetPolicy', code: 'register_has_numbers' });
    // Chính sách giữ nguyên: số tiếp theo là 4, không quay về 1.
    expect((await register('F4A', 'never', 'Sổ đã đổi tên')).nextNumber).toBe('4');
    expect((await org.run((tx, ctx) => allocateNumber(tx, ctx, 'F4A'))).number).toBe('4');
    // Sổ chưa cấp số nào thì đổi được.
    await register('F4B', 'never');
    expect((await register('F4B', 'yearly')).resetPolicy).toBe('yearly');
  });
});

describe('files-5 và files-6: tệp chờ gắn', () => {
  const up = (who: TestUserKey = 'employee') => org.run((tx, ctx) => uploadFile(tx, ctx, asV(who), { name: 'a.pdf', data: PDF }));

  it('gắn và xoá chạy song song: tệp còn trong CSDL thì blob còn, không bao giờ "đã gắn" mà mất tệp', async () => {
    for (let i = 0; i < 8; i++) {
      const run = await begin('designer', `Lượt tệp ${i}`);
      const f = await up();
      const key = (await org.run((tx) => tx.select().from(schema.files).where(eq(schema.files.id, f.id))))[0]!.storageKey;
      const attach = org.run((tx, ctx) => attachFiles(tx, ctx, asV('employee'), { runId: run.id, stepRunId: null, fieldKey: 'tep', fileIds: [f.id] })).then(() => 'attached', () => 'attach_failed');
      const remove = org.run((tx) => removePendingFile(tx, asV('employee'), f.id)).then(() => 'removed', () => 'remove_failed');
      await Promise.all([attach, remove]);
      const row = (await org.run((tx) => tx.select().from(schema.files).where(eq(schema.files.id, f.id))))[0];
      if (row) {
        expect(row.status).toBe('attached');
        expect(storage.blobs.has(key), `lần ${i}: tệp đã gắn mà mất blob`).toBe(true);
      } else {
        expect(storage.blobs.has(key), `lần ${i}: tệp đã xoá mà còn blob`).toBe(false);
      }
    }
  });

  it('gắn tệp của người khác hoặc đã bị xoá là file_unavailable; xoá tệp đã gắn là state_conflict', async () => {
    const run = await begin('designer', 'Lượt tệp khác');
    const f = await up('employee');
    await expectApiError(org.run((tx, ctx) => attachFiles(tx, ctx, asV('employee2'), { runId: run.id, stepRunId: null, fieldKey: 'tep', fileIds: [f.id] })), 'input_invalid');
    await org.run((tx, ctx) => attachFiles(tx, ctx, asV('employee'), { runId: run.id, stepRunId: null, fieldKey: 'tep', fileIds: [f.id] }));
    await expectApiError(org.run((tx) => removePendingFile(tx, asV('employee'), f.id)), 'state_conflict');
  });

  it('files-6: ghi dòng CSDL lỗi thì blob vừa ghi bị xoá, không để tệp mồ côi', async () => {
    const before = storage.blobs.size;
    const ghost = { ...asV('employee'), id: newId() }; // người không tồn tại: khoá ngoại làm câu INSERT lỗi
    await expect(org.run((tx, ctx) => uploadFile(tx, ctx, ghost, { name: 'ma.pdf', data: PDF }))).rejects.toBeTruthy();
    expect(storage.blobs.size).toBe(before);
  });
});

describe('runs-2: tổng quan chỉ tính phần người gọi được thấy', () => {
  it('người có overview.view mà không có run.view_all chỉ đếm lượt và việc của mình', async () => {
    const mineRun = await begin('designer', 'Lượt của Lan');
    expect(stepOf(mineRun, 'a').assignee?.id).toBe(org.users.employee);
    // Tuấn được cấp overview.view nhưng không có run.view_all, và không dính tới lượt nào của Lan.
    const tuan = { ...asV('employee2'), permissions: [...asV('employee2').permissions, 'overview.view' as const] };
    expect(can(tuan, 'run.view_all')).toBe(false);
    const view = await org.run((tx, ctx) => getOverview(tx, ctx, tuan));
    expect(view.running).toBe(0);
    expect(view.dueToday + view.dueTomorrow + view.overdue).toBe(0);
    const chair = await org.run((tx, ctx) => getOverview(tx, ctx, asV('chairman')));
    expect(chair.running).toBeGreaterThan(0);
  });
});

describe('runs-3: nút "Cho qua" khớp engine', () => {
  it('việc đã nhận (in_progress) không còn "skip"; việc chưa nhận (ready) vẫn có', async () => {
    const run = await begin('designer', 'Lượt cho qua');
    const step = stepOf(run, 'a');
    const admin = asV('officeAdmin');
    const ready = stepOf(await org.run((tx, ctx) => getRun(tx, ctx, admin, run.id)), 'a');
    expect(ready.state).toBe('ready');
    expect(ready.allowedActions).toContain('skip');
    await org.run((tx, ctx) => actOnStep(tx, ctx, asV('employee'), step.id, newId(), { type: 'AcceptStep' }));
    const working = stepOf(await org.run((tx, ctx) => getRun(tx, ctx, admin, run.id)), 'a');
    expect(working.state).toBe('in_progress');
    expect(working.allowedActions).not.toContain('skip');
    await expectApiError(org.run((tx, ctx) => actOnStep(tx, ctx, admin, step.id, newId(), { type: 'SkipStep', reason: 'thử' })), 'state_conflict');
  });
});

describe('worker-9: con trỏ trang thông báo không hợp lệ là 422, không phải 500', () => {
  it('chuỗi bất kỳ bị từ chối; thời điểm ISO dùng được', async () => {
    await expectApiError(org.run((tx) => listNotifications(tx, asV('employee'), { limit: 10, cursor: 'abc' })), 'input_invalid');
    const page = await org.run((tx) => listNotifications(tx, asV('employee'), { limit: 10, cursor: new Date().toISOString() }));
    expect(Array.isArray(page.items)).toBe(true);
  });
});

describe('files-7: mẫu đã lưu trữ không xuất bản và không lưu nháp', () => {
  it('state_conflict archived, giống bước xem trước xuất bản', async () => {
    const def = { schemaVersion: 1, name: 'Mẫu lưu trữ', starters: [{ kind: 'everyone' }], inputs: [], nodes: [{ id: 'start', type: 'start', label: 'Bắt đầu' }, { id: 'end', type: 'end', label: 'Hoàn tất' }], edges: [{ id: 's>e', from: 'start', to: 'end' }] };
    const t = await org.run((tx, ctx) => createTemplate(tx, ctx, asV('designer'), { name: 'Mẫu lưu trữ', description: null, definition: def as never }));
    await org.run((tx, ctx) => archiveTemplate(tx, ctx, asV('designer'), t.id, true));
    const err = await expectApiError(org.run((tx, ctx) => publishTemplate(tx, ctx, asV('designer'), t.id)), 'state_conflict');
    expect(err.extra.currentState).toBe('archived');
    await expectApiError(org.run((tx) => saveTemplateDraft(tx, asV('designer'), t.id, { definition: def as never }, '1')), 'state_conflict');
  });
});

describe('worker-3: việc định kỳ không kéo đổ nhau', () => {
  it('Expo lỗi khi hỏi biên nhận thì các việc đã đăng ký vẫn chạy; việc ném lỗi cũng không làm mất kết quả của việc khác', async () => {
    // Một thông báo đã gửi, có vé, quá 15 phút: checkPushReceipts sẽ gọi getReceipts.
    await org.run((tx) =>
      tx.insert(schema.notifications).values({
        id: newId(), orgId: org.orgId, userId: org.users.employee, kind: 'assigned', title: 't', body: 'b', state: 'sent',
        sentAt: new Date('2026-10-07T02:00:00.000Z'), pushTickets: [{ ticketId: 'x1', token: 'ExponentPushToken[x]' }], createdAt: new Date('2026-10-07T02:00:00.000Z'),
      }),
    );
    const push = new FakePush();
    push.getReceipts = async () => {
      throw new Error('Expo push HTTP 429');
    };
    let ran = 0;
    registerMaintenanceJob(async function goodJob() {
      ran++;
    });
    registerMaintenanceJob(async function badJob() {
      throw new Error('I/O');
    });
    registerMaintenanceJob(async function afterBadJob() {
      ran++;
    });
    const res = await runOrgMaintenance(org.orgId, { push });
    expect(ran).toBe(2);
    expect(res.failed).toEqual(['badJob']);
  });
});

describe('db-2: vai trò quét timers và effects phải có BYPASSRLS', () => {
  it('app_scan đạt; một vai trò chịu RLS (app_user) bị từ chối bằng thông báo rõ', async () => {
    await expect(assertScanRole()).resolves.toBeUndefined();
    await expect(assertScanRole(getDb())).rejects.toThrow(/BYPASSRLS/);
  });
});
