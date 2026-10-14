import { PUSH_BATCH_SIZE, FakePush } from '@mihato/providers/push';
import { COMMENT_MAX, COMMENT_RATE_PER_MINUTE, newId, type RunDetail, type StepView } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { addStepComment, deleteStepComment, listStepComments } from '../src/services/comments';
import { deliverNotification, draftFromNotification } from '../src/services/notifications';
import { actOnStep, getRun, getStepDetail, listSteps, startRun } from '../src/services/runs';
import { removeRunShare, setRunShare } from '../src/services/shares';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';
import { auditRows, expectApiError } from './helpers';

/**
 * Bình luận theo việc (docs/DECISIONS.md, 07/10/2026 điểm a): quyền xem, quyền viết, xoá mềm, đếm, thông báo đẩy không lộ nội dung,
 * nhật ký không chứa nội dung, và bình luận không đụng tới engine.
 */
let org: TestOrg;
let templateId: string;
let N: { id: string; nhap: string; duyet: string };
let R: { id: string; nhap: string; duyet: string };

const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const START = { id: 'start', type: 'start', label: 'Bắt đầu' };
const END = { id: 'end', type: 'end', label: 'Hoàn tất' };
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ id: `${from}>${to}`, from, to, ...extra });
const asV = (who: TestUserKey) => org.viewer(who);
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;
const SECRET = 'NỘI DUNG BÌNH LUẬN RIÊNG TƯ 123456789 đồng';

const comment = (who: TestUserKey, stepId: string, body = 'Xin xem lại số liệu.') => org.run((tx, ctx) => addStepComment(tx, ctx, asV(who), stepId, { body }, { ip: '127.0.0.1' }));
const list = (who: TestUserKey, stepId: string, q: { limit: number; cursor?: string } = { limit: 50 }) => org.run((tx, ctx) => listStepComments(tx, ctx, asV(who), stepId, q));
const remove = (who: TestUserKey, stepId: string, commentId: string) => org.run((tx, ctx) => deleteStepComment(tx, ctx, asV(who), stepId, commentId));

async function build(title: string, mucMat: string) {
  const run = await org.run((tx, ctx) => startRun(tx, ctx, asV('designer'), { templateId, title, inputs: { mucMat } }, newId()));
  const nhap = stepOf(run, 'nhap').id;
  await org.run((tx, ctx) => actOnStep(tx, ctx, asV('employee'), nhap, newId(), { type: 'CompleteStep' }));
  const after = await org.run((tx, ctx) => getRun(tx, ctx, asV('designer'), run.id));
  return { id: run.id, nhap, duyet: stepOf(after, 'duyet').id };
}

beforeAll(async () => {
  setFakeNow('2026-10-07T03:00:00.000Z');
  org = await createTestOrg({ name: 'Công ty thử bình luận' });
  const def = {
    schemaVersion: 1,
    name: 'Thử bình luận',
    starters: [{ kind: 'everyone' }],
    inputs: [{ key: 'mucMat', label: 'Mức mật', type: 'select', required: true, options: [{ value: 'thuong', label: 'Thường' }, { value: 'mat', label: 'Mật' }] }],
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
  N = await build('Lượt thường', 'thuong');
  R = await build('Lượt mật', 'mat');
});
afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

describe('quyền xem và quyền viết', () => {
  it('lượt thường: ai thấy việc thì đọc được; người giữ, người khởi chạy, người xem mọi lượt viết được; cấp trên chỉ xem thì 403; người ngoài 404', async () => {
    const t = N.duyet;
    for (const who of ['designer', 'employee2', 'chairman', 'director', 'deputy', 'officeAdmin', 'head'] as TestUserKey[]) {
      const res = await list(who, t).catch((e: { code?: string }) => e);
      // head (cấp trên của Tuấn) thấy việc qua tầm nhìn nhóm; Lan chỉ thấy việc của mình nên không đọc việc của Tuấn.
      expect('items' in (res as object), `đọc ← ${who}`).toBe(true);
    }
    await expectApiError(list('employee', t), 'not_found');
    await expectApiError(list('itAdmin', t), 'not_found');
    for (const who of ['designer', 'employee2', 'chairman', 'director', 'deputy', 'officeAdmin'] as TestUserKey[]) {
      expect((await list(who, t)).canComment, `canComment ← ${who}`).toBe(true);
      expect((await comment(who, t, `Ý kiến của ${who}`)).mine).toBe(true);
    }
    expect((await list('head', t)).canComment).toBe(false);
    await expectApiError(comment('head', t), 'forbidden');
    await expectApiError(comment('employee', t), 'not_found');
    await expectApiError(comment('itAdmin', t), 'not_found');
  });

  it('lượt mật: chỉ chủ sở hữu và người tham gia đọc và viết; Chủ tịch, Giám đốc 404; người được chia sẻ mức xem đọc được nhưng 403 khi viết, mức bình luận thì viết được', async () => {
    for (const who of ['designer', 'employee', 'employee2'] as TestUserKey[]) {
      const t = who === 'employee2' ? R.duyet : R.nhap;
      expect((await comment(who, t)).author.id).toBe(org.users[who]);
    }
    for (const who of ['chairman', 'director', 'deputy', 'officeAdmin', 'head', 'itAdmin'] as TestUserKey[]) {
      await expectApiError(list(who, R.nhap), 'not_found');
      await expectApiError(comment(who, R.nhap), 'not_found');
    }
    await org.run((tx, ctx) => setRunShare(tx, ctx, asV('designer'), R.id, org.users.itAdmin, 'viewer'));
    await org.run((tx, ctx) => setRunShare(tx, ctx, asV('designer'), R.id, org.users.deputy, 'commenter'));
    expect((await list('itAdmin', R.nhap)).items.length).toBeGreaterThan(0);
    await expectApiError(comment('itAdmin', R.nhap), 'forbidden');
    expect((await comment('deputy', R.nhap, 'Ý kiến của Phó giám đốc')).author.id).toBe(org.users.deputy);
    // Gỡ chia sẻ: hết đọc, hết viết.
    await org.run((tx, ctx) => removeRunShare(tx, ctx, asV('designer'), R.id, org.users.deputy));
    await org.run((tx, ctx) => removeRunShare(tx, ctx, asV('designer'), R.id, org.users.itAdmin));
    await expectApiError(list('deputy', R.nhap), 'not_found');
    await expectApiError(comment('itAdmin', R.nhap), 'not_found');
  });

  it('nội dung rỗng hoặc quá dài bị từ chối', async () => {
    await expectApiError(comment('designer', N.nhap, '   '), 'input_invalid');
    await expectApiError(comment('designer', N.nhap, 'x'.repeat(COMMENT_MAX + 1)), 'input_invalid');
    expect((await comment('designer', N.nhap, 'x'.repeat(COMMENT_MAX))).body).toHaveLength(COMMENT_MAX);
  });
});

describe('danh sách, xoá mềm, đếm', () => {
  it('cũ nhất trước, phân trang theo con trỏ; xoá mềm chỉ tác giả; bình luận đã xoá không còn trong danh sách và không đếm', async () => {
    const t = N.duyet;
    const base = (await list('designer', t)).items.length;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      setFakeNow(new Date(Date.UTC(2026, 9, 7, 4, i, 0)));
      made.push((await comment('designer', t, `Bình luận số ${i}`)).id);
    }
    const all = await list('designer', t, { limit: 100 });
    expect(all.items.slice(-5).map((c) => c.body)).toEqual([0, 1, 2, 3, 4].map((i) => `Bình luận số ${i}`));
    // Phân trang từng 2 bình luận phải đi hết đúng một lần, không sót, không lặp.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await list('designer', t, { limit: 2, cursor });
      seen.push(...page.items.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all.items.map((c) => c.id));
    expect(seen).toHaveLength(base + 5);
    await expectApiError(list('designer', t, { limit: 2, cursor: 'khong-hop-le' }), 'input_invalid');

    const countOf = async (who: TestUserKey) => (await org.run((tx, ctx) => getStepDetail(tx, ctx, asV(who), t))).commentCount;
    expect(await countOf('designer')).toBe(base + 5);
    await expectApiError(remove('chairman', t, made[0]!), 'forbidden');
    await remove('designer', t, made[0]!);
    await remove('designer', t, made[0]!); // xoá lại không lỗi
    await expectApiError(remove('designer', t, newId()), 'not_found');
    expect((await list('designer', t, { limit: 100 })).items.map((c) => c.id)).not.toContain(made[0]);
    expect(await countOf('designer')).toBe(base + 4);
    // Dòng vẫn còn trong CSDL (xoá mềm).
    const row = await org.run(async (tx) => (await tx.select().from(schema.stepComments).where(eq(schema.stepComments.id, made[0]!)))[0]);
    expect(row?.deletedAt).not.toBeNull();
    // commentCount có ở danh sách việc và ở chi tiết lượt chạy.
    const viaList = (await org.run((tx, ctx) => listSteps(tx, ctx, asV('designer'), { limit: 100, runId: N.id, sort: 'dueAt' }))).items.find((s) => s.id === t);
    expect(viaList?.commentCount).toBe(base + 4);
    expect(stepOf(await org.run((tx, ctx) => getRun(tx, ctx, asV('designer'), N.id)), 'duyet').commentCount).toBe(base + 4);
    setFakeNow('2026-10-07T03:00:00.000Z');
  });

  it('bình luận không đổi trạng thái việc, không tăng phiên bản lượt chạy và không ghi run_events', async () => {
    const before = await org.run(async (tx) => ({
      run: (await tx.select().from(schema.processRuns).where(eq(schema.processRuns.id, R.id)))[0]!,
      steps: await tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.runId, R.id)),
      events: (await tx.select().from(schema.runEvents).where(eq(schema.runEvents.runId, R.id))).length,
    }));
    await comment('designer', R.duyet, 'Nhờ Tuấn duyệt sớm.');
    const after = await org.run(async (tx) => ({
      run: (await tx.select().from(schema.processRuns).where(eq(schema.processRuns.id, R.id)))[0]!,
      steps: await tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.runId, R.id)),
      events: (await tx.select().from(schema.runEvents).where(eq(schema.runEvents.runId, R.id))).length,
    }));
    expect(after.run.version).toBe(before.run.version);
    expect(after.run.state).toBe(before.run.state);
    expect(after.events).toBe(before.events);
    expect(JSON.stringify(after.steps)).toBe(JSON.stringify(before.steps));
  });

  it('giới hạn 30 bình luận mỗi phút mỗi người, qua một phút lại viết được', async () => {
    setFakeNow('2026-10-07T05:00:00.000Z');
    for (let i = 0; i < COMMENT_RATE_PER_MINUTE; i++) await comment('employee2', N.duyet, `Nhanh ${i}`);
    await expectApiError(comment('employee2', N.duyet, 'Vượt'), 'rate_limited');
    // Người khác không bị ảnh hưởng.
    await comment('designer', N.duyet, 'Vẫn viết được');
    setFakeNow('2026-10-07T05:01:05.000Z');
    expect((await comment('employee2', N.duyet, 'Sau một phút')).body).toBe('Sau một phút');
    setFakeNow('2026-10-07T03:00:00.000Z');
  });
});

describe('thông báo và nhật ký', () => {
  it('người giữ việc và người khởi chạy (trừ tác giả) nhận tin "Có bình luận mới ở việc …"; tiêu đề và dữ liệu đẩy không chứa nội dung bình luận', async () => {
    const run = await build('Lượt thông báo', 'thuong');
    await comment('designer', run.duyet, SECRET);
    const rows = await org.run((tx) => tx.select().from(schema.notifications).where(eq(schema.notifications.stepRunId, run.duyet)));
    const mine = rows.filter((r) => r.kind === 'comment_new');
    // Tuấn (người duyệt chưa quyết) nhận; Khôi là tác giả và người khởi chạy nên không tự nhận.
    expect(mine.map((r) => r.userId)).toEqual([org.users.employee2]);
    const n = mine[0]!;
    expect(n.title).toBe('Có bình luận mới ở việc Duyệt nội dung');
    expect(n.runId).toBe(run.id);
    expect(JSON.stringify(n)).not.toContain(SECRET);
    expect(Object.keys(n.payload as object).sort()).toEqual(['link', 'runId', 'stepId', 'type']);

    // Tuấn viết lại: Khôi (người khởi chạy) nhận.
    await comment('employee2', run.duyet, SECRET);
    const designerRows = (await org.run((tx) => tx.select().from(schema.notifications).where(eq(schema.notifications.userId, org.users.designer)))).filter((r) => r.kind === 'comment_new');
    expect(designerRows.length).toBeGreaterThanOrEqual(1);

    // Đẩy thật: tin đẩy tới máy của Tuấn chỉ mang tên việc và id.
    await org.run((tx) => tx.insert(schema.devices).values({ id: newId(), orgId: org.orgId, userId: org.users.employee2, platform: 'android', name: 'Máy Tuấn', pushToken: 'ExponentPushToken[tuan]' }));
    const push = new FakePush();
    await org.run(async (tx, ctx) => {
      const draft = (await draftFromNotification(tx, n.id))!;
      expect(await deliverNotification(tx, ctx, draft, push)).toEqual({ state: 'done' });
    });
    expect(push.sent).toHaveLength(1);
    const sent = push.sent[0]!;
    expect(sent.title).toBe('Có bình luận mới ở việc Duyệt nội dung');
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(sent.body).toBe('');
    expect(Object.keys(sent.data).sort()).toEqual(['link', 'notificationId', 'runId', 'stepId', 'type']);
    expect(PUSH_BATCH_SIZE).toBeGreaterThan(0);
    // Mỗi bình luận hẹn đúng một lần đẩy.
    const effects = await org.run((tx) => tx.select().from(schema.effects).where(eq(schema.effects.kind, 'notify.deliver')));
    expect(effects.some((e) => JSON.stringify(e.payload).includes(n.id))).toBe(true);
    expect(JSON.stringify(effects.map((e) => e.payload))).not.toContain(SECRET);
  });

  it('audit_log ghi id của bình luận, không ghi nội dung', async () => {
    const created = await comment('designer', N.nhap, SECRET);
    await remove('designer', N.nhap, created.id);
    const added = await org.run((tx) => auditRows(tx, 'step_comment_added'));
    const deleted = await org.run((tx) => auditRows(tx, 'step_comment_deleted'));
    const mineAdded = added.find((r) => r.targetId === created.id)!;
    expect(mineAdded).toMatchObject({ actorUserId: org.users.designer, targetType: 'step_comment', detail: { stepId: N.nhap, runId: N.id } });
    expect(deleted.some((r) => r.targetId === created.id)).toBe(true);
    for (const row of [...added, ...deleted]) expect(JSON.stringify(row)).not.toContain('RIÊNG TƯ');
  });
});
