import { ApiError, newId } from '@mihato/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, schema } from '../src/db/client';
import type { UserCode } from '../src/seed/org';
import { checkTask, createAdhocTask, stepAssignees } from '../src/services/adhoc';
import { disableUser } from '../src/services/org';
import { getOverview } from '../src/services/overview';
import { confirmProposal, createProposals, getProposal } from '../src/services/proposals';
import { actOnStep, batchSteps, listRuns, startRun } from '../src/services/runs';
import { getTemplate, listTemplates } from '../src/services/templates';
import { expectApiError } from './helpers';
import { createWorld, expectTrace, propose, snapshot, type World } from './helpers-ai';

/**
 * Việc ngoài quy trình và quy tắc "người được bổ nhiệm" (docs/DECISIONS.md, 05/10/2026):
 * - người giao giao một việc bất kỳ cho bất kỳ ai, không cần quy trình bao quanh;
 * - việc phát sinh từ quy trình chỉ về người quy trình chỉ định (hoặc người giữ cùng vai trò, hoặc người được ủy quyền).
 * Thế giới thử: kịch bản vàng tới 09:05 Thứ Năm 08/10/2026; s3 của Tuấn, s4 của Phương.
 */
afterAll(async () => {
  await closeDb();
});

const TOUCH = { via: 'touch' } as const;
const confirm = (w: World, code: UserCode, id: string) => w.as(code, (tx, ctx, v) => confirmProposal(tx, ctx, v, id, TOUCH));
const adhocTemplates = (w: World) => w.db(async (tx) => (await tx.select().from(schema.processTemplates).where(eq(schema.processTemplates.kind, 'adhoc'))).length);
const reassign = (w: World, by: UserCode, stepId: string, to: UserCode, reason = 'đổi người') =>
  w.as(by, (tx, ctx, v) => actOnStep(tx, ctx, v, stepId, newId(), { type: 'Reassign', toUserId: w.ids.users[to], reason }));

const SAKURA = { title: 'Gửi báo giá cho công ty Sakura', assigneeId: '', dueDate: '2026-10-12' };
const give = (w: World, by: UserCode, to: UserCode, over: Partial<typeof SAKURA & { description: string }> = {}, eventId = newId()) =>
  w.as(by, (tx, ctx, v) => createAdhocTask(tx, ctx, v, { ...SAKURA, assigneeId: w.ids.users[to], ...over }, eventId));

describe('giao một việc ngoài quy trình', () => {
  it('việc tạo ra là một việc thật: đúng người, đúng hạn, hiện ở việc của người đó và được báo ngay', async () => {
    const w = await createWorld('adhoc-tao');
    const res = await give(w, 'U_CHAIRMAN', 'U_TUAN', { description: 'Kèm bảng giá quý bốn' });
    expect(res.step).toMatchObject({
      adhoc: true,
      title: SAKURA.title,
      description: 'Kèm bảng giá quý bốn',
      kind: 'task',
      state: 'ready',
      // Hạn = hết giờ làm việc (17:00 giờ Việt Nam) của Thứ Hai 12/10/2026
      dueAt: '2026-10-12T10:00:00.000Z',
      assignee: { id: w.ids.users.U_TUAN },
      assignedBy: { id: w.ids.users.U_CHAIRMAN },
    });
    expect(res.run).toMatchObject({ adhoc: true, title: SAKURA.title, state: 'running', initiator: { id: w.ids.users.U_CHAIRMAN } });

    await w.tick();
    expect(w.pushesTo('U_TUAN').length).toBeGreaterThan(0);

    // Tuấn thấy việc này cạnh việc s3 thuộc quy trình, và nó được đánh dấu là việc ngoài quy trình.
    const mine = await w.as('U_TUAN', (tx, ctx, v) => import('../src/services/runs').then((m) => m.listSteps(tx, ctx, v, { assignee: 'me', limit: 50 } as never)));
    expect(mine.items.find((s) => s.id === res.step.id)).toMatchObject({ adhoc: true });
    expect(mine.items.filter((s) => !s.adhoc).length).toBeGreaterThan(0);
  });

  it('hạn rơi vào ngày nghỉ thì lùi về ngày làm việc liền trước (SPEC 4.10)', async () => {
    const w = await createWorld('adhoc-nghi');
    const res = await give(w, 'U_CHAIRMAN', 'U_LAN', { dueDate: '2026-10-17' }); // Thứ Bảy
    expect(res.step.dueAt).toBe('2026-10-16T10:00:00.000Z');
  });

  it('gửi lại cùng Idempotency-Key chỉ ra một việc', async () => {
    const w = await createWorld('adhoc-lap');
    const key = newId();
    const a = await give(w, 'U_CHAIRMAN', 'U_HUNG', {}, key);
    const b = await give(w, 'U_CHAIRMAN', 'U_HUNG', {}, key);
    expect(b.step.id).toBe(a.step.id);
    expect(await adhocTemplates(w)).toBe(1);
    const runs = await w.db(async (tx) => (await tx.select().from(schema.processRuns).where(eq(schema.processRuns.title, SAKURA.title))).length);
    expect(runs).toBe(1);
  });

  it('kiểm đầu vào: mỗi ô sai báo đúng mã, không ghi gì', async () => {
    const w = await createWorld('adhoc-kiem');
    const before = await snapshot(w);
    const bad: [string, Partial<typeof SAKURA>, UserCode, string, string][] = [
      ['tên trống', { title: '   ' }, 'U_CHAIRMAN', 'body.title', 'required'],
      ['người không có', { assigneeId: newId() }, 'U_CHAIRMAN', 'body.assigneeId', 'unknown_user'],
      ['tự giao cho mình', {}, 'U_HUNG', 'body.assigneeId', 'assignee_is_self'],
      ['ngày không có thật', { dueDate: '2026-02-30' }, 'U_CHAIRMAN', 'body.dueDate', 'invalid_date'],
      ['ngày đã qua', { dueDate: '2026-10-07' }, 'U_CHAIRMAN', 'body.dueDate', 'date_in_past'],
    ];
    for (const [name, over, by, path, code] of bad) {
      // 'tự giao cho mình' giao cho đúng người đang giao
      const to = name === 'tự giao cho mình' ? 'U_HUNG' : 'U_LAN';
      const err = await expectApiError(give(w, by, to, over), 'input_invalid');
      expect(err.extra.errors, name).toEqual([{ path, code }]);
    }
    expect(await snapshot(w)).toBe(before);
    expect(await adhocTemplates(w)).toBe(0);
  });

  it('người đã bị vô hiệu hoá không nhận được việc', async () => {
    const w = await createWorld('adhoc-nghi-viec');
    await w.as('U_IT', (tx, _ctx, v) => disableUser(tx, v, w.ids.users.U_LAN, newId()));
    const err = await expectApiError(give(w, 'U_CHAIRMAN', 'U_LAN'), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'body.assigneeId', code: 'user_inactive' }]);
  });

  it('ngày hôm nay vẫn giao được; hết giờ làm việc thì việc đã quá hạn ngay (cờ pastDue cho trợ lý)', async () => {
    const w = await createWorld('adhoc-homnay', { at: '2026-10-08T18:00' });
    const res = await give(w, 'U_CHAIRMAN', 'U_HUNG', { dueDate: '2026-10-08' });
    expect(res.step).toMatchObject({ dueAt: '2026-10-08T10:00:00.000Z', isOverdue: true });
  });
});

describe('mẫu một việc là mẫu ẩn', () => {
  it('không lọt vào danh sách mẫu, tool search_templates, hay API mẫu; không khởi chạy lại được', async () => {
    const w = await createWorld('adhoc-an');
    const res = await give(w, 'U_CHAIRMAN', 'U_HUNG');
    const templateId = await w.db(async (tx) => (await tx.select({ id: schema.processRuns.templateId }).from(schema.processRuns).where(eq(schema.processRuns.id, res.run.id)))[0]!.id);

    const list = await w.as('U_DESIGNER', (tx, ctx, v) => listTemplates(tx, ctx, v));
    expect(list.map((t) => t.id)).not.toContain(templateId);
    expect(list.map((t) => t.name)).not.toContain(SAKURA.title);

    await expectApiError(w.as('U_DESIGNER', (tx, ctx, v) => getTemplate(tx, ctx, v, templateId)), 'not_found');
    await expectApiError(w.as('U_CHAIRMAN', (tx, ctx, v) => startRun(tx, ctx, v, { templateId, title: 'Chạy lại', inputs: { due: '2026-10-20' } }, newId())), 'not_found');

    const found = await w.tool('U_CHAIRMAN', 'search_templates', { query: 'Sakura', includeDrafts: true });
    expect(found.ok).toBe(true);
    expect(JSON.stringify(found.result)).not.toContain('Sakura');
  });

  it('danh sách lượt chạy lọc được theo việc ngoài quy trình; tổng quan không đếm nó là một quy trình đang chạy', async () => {
    const w = await createWorld('adhoc-loc');
    const overview = () => w.as('U_CHAIRMAN', (tx, ctx, v) => getOverview(tx, ctx, v, {}));
    const before = await overview();
    const res = await give(w, 'U_CHAIRMAN', 'U_HUNG');
    const after = await overview();
    expect(after.running).toBe(before.running);

    const runsOf = (adhoc: boolean | undefined) =>
      w.as('U_CHAIRMAN', async (tx, ctx, v) => (await listRuns(tx, ctx, v, { limit: 50, sort: '-startedAt', adhoc })).items.map((r) => r.id));
    expect(await runsOf(true)).toEqual([res.run.id]);
    expect(await runsOf(false)).not.toContain(res.run.id);
    expect(await runsOf(false)).toContain(w.runId);
    expect(await runsOf(undefined)).toEqual(expect.arrayContaining([res.run.id, w.runId]));
  });

  it('việc ngoài quy trình tính vào khối lượng của người nhận nhưng không thành một "quy trình" trong báo cáo nút thắt', async () => {
    const w = await createWorld('adhoc-baocao');
    const res = await give(w, 'U_CHAIRMAN', 'U_HUNG');
    await w.as('U_HUNG', (tx, ctx, v) => actOnStep(tx, ctx, v, res.step.id, newId(), { type: 'CompleteStep' }));
    const { getReport } = await import('../src/services/reports');
    const report = await w.as('U_CHAIRMAN', (tx, ctx, v) => getReport(tx, ctx, v, { from: '2026-10-01', to: '2026-10-31' }));
    expect(report.byUser.find((u) => u.user.id === w.ids.users.U_HUNG)?.completed).toBeGreaterThanOrEqual(1);
    expect(report.byTemplateStep.map((t) => t.title)).not.toContain(SAKURA.title);
  });
});

describe('giao lại: việc ngoài quy trình tự do, việc trong quy trình chỉ về người được bổ nhiệm', () => {
  it('việc ngoài quy trình giao lại cho ai còn hoạt động cũng được', async () => {
    const w = await createWorld('adhoc-giaolai');
    const res = await give(w, 'U_CHAIRMAN', 'U_HUNG');
    const moved = await reassign(w, 'U_CHAIRMAN', res.step.id, 'U_NGOCANH');
    expect(moved.step.assignee!.id).toBe(w.ids.users.U_NGOCANH);
    // Văn phòng cũng giao lại được.
    const again = await reassign(w, 'U_ADMIN', res.step.id, 'U_PHUONG');
    expect(again.step.assignee!.id).toBe(w.ids.users.U_PHUONG);
  });

  it('việc trong quy trình: giao cho người không được bổ nhiệm bị từ chối với mã not_appointed', async () => {
    const w = await createWorld('adhoc-boNhiem');
    const err = await expectApiError(reassign(w, 'U_CHAIRMAN', w.step.s3, 'U_HUNG'), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'body.toUserId', code: 'not_appointed' }]);
    const row = await w.db(async (tx) => (await tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.id, w.step.s3)))[0]!);
    expect(row.assigneeId).toBe(w.ids.users.U_TUAN);
  });

  it('người được ủy quyền thì nhận được; ủy quyền hết hiệu lực thì lại bị chặn', async () => {
    const w = await createWorld('adhoc-uyquyen');
    await w.delegate('U_TUAN', 'U_HUNG');
    const moved = await reassign(w, 'U_CHAIRMAN', w.step.s3, 'U_HUNG');
    expect(moved.step.assignee!.id).toBe(w.ids.users.U_HUNG);
    // Người khác ngoài ủy quyền vẫn không được.
    await expectApiError(reassign(w, 'U_CHAIRMAN', w.step.s3, 'U_NGOCANH'), 'input_invalid');
  });

  it('người được chỉ định đã nghỉ thì việc vào "Cần giao người" và Văn phòng chọn ai cũng được', async () => {
    const w = await createWorld('adhoc-nghiviec');
    await w.as('U_IT', (tx, _ctx, v) => disableUser(tx, v, w.ids.users.U_TUAN, newId()));
    const stuck = await w.db(async (tx) => (await tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.id, w.step.s3)))[0]!);
    expect(stuck).toMatchObject({ state: 'unassigned', assigneeId: null });
    const res = await reassign(w, 'U_ADMIN', w.step.s3, 'U_NGOCANH');
    expect(res.step).toMatchObject({ state: 'ready', assignee: { id: w.ids.users.U_NGOCANH } });
  });

  it('giao lại hàng loạt: việc không đủ tư cách báo lỗi riêng, việc khác vẫn chạy', async () => {
    const w = await createWorld('adhoc-loat');
    const res = await give(w, 'U_CHAIRMAN', 'U_LAN');
    const out = await w.as('U_ADMIN', (tx, ctx, v) =>
      batchSteps(tx, ctx, v, { action: 'reassign', stepIds: [w.step.s3, res.step.id], params: { toUserId: w.ids.users.U_HUNG, reason: 'đổi người' } }, newId()),
    );
    expect(out.results).toEqual([
      { stepId: w.step.s3, ok: false, error: { code: 'not_appointed' } },
      { stepId: res.step.id, ok: true },
    ]);
  });

  it('danh sách người nhận được: việc trong quy trình bị giới hạn, việc ngoài quy trình thì bất kỳ ai', async () => {
    const w = await createWorld('adhoc-ds');
    const adhoc = await give(w, 'U_CHAIRMAN', 'U_LAN');
    const who = (ids: string[]) => w.as('U_ADMIN', (tx, ctx, v) => stepAssignees(tx, ctx, v, ids));
    expect(await who([w.step.s3])).toMatchObject({ anyone: false, people: [expect.objectContaining({ id: w.ids.users.U_TUAN })] });
    expect(await who([adhoc.step.id])).toEqual({ anyone: true, people: [] });
    // Trộn: chỉ việc trong quy trình giới hạn.
    expect((await who([w.step.s3, adhoc.step.id])).people.map((p) => p.id)).toEqual([w.ids.users.U_TUAN]);
    // Hai việc của hai người khác nhau: không có ai chung.
    expect(await who([w.step.s3, w.step.s4])).toEqual({ anyone: false, people: [] });
    // Có ủy quyền thì thêm người được ủy quyền.
    await w.delegate('U_TUAN', 'U_HUNG');
    expect((await who([w.step.s3])).people.map((p) => p.id).sort()).toEqual([w.ids.users.U_TUAN, w.ids.users.U_HUNG].sort());
  });
});

describe('Trợ lý đề xuất giao việc (propose_assign_task)', () => {
  const args = (w: World, over: Record<string, unknown> = {}) => ({ title: SAKURA.title, assigneeId: w.ids.users.U_HUNG, dueDate: '2026-10-12', ...over });

  it('câu xác nhận do máy chủ dựng; chưa xác nhận thì không có gì thay đổi; xác nhận xong 30 giây sau việc mới có', async () => {
    const w = await createWorld('adhoc-ai');
    const before = await snapshot(w);
    const [id] = await propose(w, 'U_CHAIRMAN', 'propose_assign_task', args(w, { description: 'Kèm bảng giá quý bốn' }));
    expect(await adhocTemplates(w)).toBe(0);
    const view = await w.as('U_CHAIRMAN', (tx, ctx, v) => getProposal(tx, ctx, v, id!));
    expect(view).toMatchObject({ tool: 'propose_assign_task', risk: 1, state: 'pending', source: 'ai' });
    expect(view.summary).toBe('Giao việc ‘Gửi báo giá cho công ty Sakura’ cho anh Võ Hoàng Hùng, hạn Thứ Hai, ngày 12 tháng 10 năm 2026.');
    expect(view.items[0]!.text).toBe(`${view.summary} Nội dung ghi kèm: “Kèm bảng giá quý bốn”.`);
    expect(view.items[0]!.toUser).toMatchObject({ id: w.ids.users.U_HUNG });
    // Sau khi tạo đề xuất mà chưa xác nhận: lượt chạy, việc, sự kiện đều nguyên (chỉ thêm dòng proposals).
    const afterCreate = JSON.parse(await snapshot(w)) as { runs: unknown[]; steps: unknown[]; events: unknown[] };
    const baseline = JSON.parse(before) as typeof afterCreate;
    expect(afterCreate.runs).toEqual(baseline.runs);
    expect(afterCreate.steps).toEqual(baseline.steps);
    expect(afterCreate.events).toEqual(baseline.events);

    await confirm(w, 'U_CHAIRMAN', id!);
    expect(await adhocTemplates(w)).toBe(0); // chờ 30 giây hoàn tác
    await w.after(30_000);
    expect(await adhocTemplates(w)).toBe(1);
    await expectTrace(w, id!, 'U_CHAIRMAN', 'StartRun');
    const applied = (await w.proposal(id!)).result as { applied: boolean; runId: string; stepId: string };
    expect(applied.applied).toBe(true);
    const row = await w.db(async (tx) => (await tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.id, applied.stepId)))[0]!);
    expect(row).toMatchObject({ assigneeId: w.ids.users.U_HUNG, title: SAKURA.title, state: 'ready' });
  });

  it('hoàn tác trong 30 giây thì không có việc nào được giao', async () => {
    const w = await createWorld('adhoc-hoantac');
    const [id] = await propose(w, 'U_CHAIRMAN', 'propose_assign_task', args(w));
    await confirm(w, 'U_CHAIRMAN', id!);
    const { undoProposal } = await import('../src/services/proposals');
    await w.as('U_CHAIRMAN', (tx, ctx, v) => undoProposal(tx, ctx, v, id!));
    await w.after(60_000);
    expect(await adhocTemplates(w)).toBe(0);
  });

  it('hạn đã qua được nói rõ trong câu xác nhận', async () => {
    const w = await createWorld('adhoc-qua', { at: '2026-10-08T18:00' });
    const [id] = await propose(w, 'U_CHAIRMAN', 'propose_assign_task', args(w, { dueDate: '2026-10-08' }));
    const view = await w.as('U_CHAIRMAN', (tx, ctx, v) => getProposal(tx, ctx, v, id!));
    expect(view.summary).toBe('Giao việc ‘Gửi báo giá cho công ty Sakura’ cho anh Võ Hoàng Hùng, hạn Thứ Năm, ngày 8 tháng 10 năm 2026 (đã qua).');
  });

  it('đầu vào sai: trả mã từng ô để trợ lý hỏi lại, không tạo đề xuất', async () => {
    const w = await createWorld('adhoc-ai-sai');
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['người không có', { assigneeId: newId() }, 'args.assigneeId', 'unknown_user'],
      ['tự giao cho mình', { assigneeId: w.ids.users.U_CHAIRMAN }, 'args.assigneeId', 'assignee_is_self'],
      ['ngày đã qua', { dueDate: '2026-10-01' }, 'args.dueDate', 'date_in_past'],
      ['ngày không có thật', { dueDate: '2026-13-40' }, 'args.dueDate', 'invalid_date'],
    ];
    for (const [name, over, path, code] of cases) {
      const res = await w.tool('U_CHAIRMAN', 'propose_assign_task', args(w, over));
      expect(res, name).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      expect(res.error!.message, name).toContain(`${path} (${code})`);
    }
    expect(await w.db(async (tx) => (await tx.select({ id: schema.proposals.id }).from(schema.proposals)).length)).toBe(0);
  });

  it('chỉ người có quyền giao việc; Văn phòng "Trình" không có loại này', async () => {
    const w = await createWorld('adhoc-quyen');
    await expectApiError(w.as('U_HUNG', (tx, ctx, v) => createProposals(tx, ctx, v, 'propose_assign_task', args(w, { assigneeId: w.ids.users.U_LAN }), { source: 'ai' })), 'forbidden');
    await expectApiError(w.as('U_ADMIN', (tx, ctx, v) => createProposals(tx, ctx, v, 'propose_assign_task', args(w), { source: 'office', createdBy: v.id })), 'input_invalid');
  });

  it('người nhận nghỉ việc trong lúc chờ: đề xuất thất bại với lý do, không giao cho ai', async () => {
    const w = await createWorld('adhoc-stale');
    const [id] = await propose(w, 'U_CHAIRMAN', 'propose_assign_task', args(w));
    await confirm(w, 'U_CHAIRMAN', id!);
    await w.as('U_IT', (tx, _ctx, v) => disableUser(tx, v, w.ids.users.U_HUNG, newId()));
    await w.after(30_000);
    const row = await w.proposal(id!);
    expect(row.state).toBe('failed');
    expect(row.result).toMatchObject({ reason: 'assignee_unavailable' });
    expect(await adhocTemplates(w)).toBe(0);
  });

  it('propose_reassign: việc trong quy trình giao cho người không được bổ nhiệm bị từ chối ngay; việc ngoài quy trình thì được', async () => {
    const w = await createWorld('adhoc-ai-giaolai');
    const res = await w.tool('U_CHAIRMAN', 'propose_reassign', { stepRunId: w.step.s3, toUserId: w.ids.users.U_HUNG, reason: 'Anh Tuấn đi công tác' });
    expect(res).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(res.error!.message).toContain('args.toUserId (not_appointed)');

    const [giveId] = await propose(w, 'U_CHAIRMAN', 'propose_assign_task', args(w));
    await confirm(w, 'U_CHAIRMAN', giveId!);
    await w.after(30_000);
    const stepId = ((await w.proposal(giveId!)).result as { stepId: string }).stepId;
    const [moveId] = await propose(w, 'U_CHAIRMAN', 'propose_reassign', { stepRunId: stepId, toUserId: w.ids.users.U_LAN, reason: 'Hùng bận' });
    await confirm(w, 'U_CHAIRMAN', moveId!);
    await w.after(30_000);
    const moved = await w.db(async (tx) => (await tx.select().from(schema.stepRuns).where(and(eq(schema.stepRuns.id, stepId))))[0]!);
    expect(moved.assigneeId).toBe(w.ids.users.U_LAN);
  });

  it('propose_reassign: ủy quyền bị thu hồi trong lúc chờ thì đề xuất thất bại với mã not_appointed', async () => {
    const w = await createWorld('adhoc-ai-thuhoi');
    await w.delegate('U_TUAN', 'U_HUNG');
    const [id] = await propose(w, 'U_CHAIRMAN', 'propose_reassign', { stepRunId: w.step.s3, toUserId: w.ids.users.U_HUNG, reason: 'Anh Tuấn đi công tác' });
    await confirm(w, 'U_CHAIRMAN', id!);
    await w.db((tx) => tx.delete(schema.delegations));
    await w.after(30_000);
    const row = await w.proposal(id!);
    expect(row.state).toBe('failed');
    expect(row.result).toMatchObject({ reason: 'not_appointed' });
  });
});

describe('checkTask', () => {
  it('ném ApiError input_invalid, là hàm không ghi gì', async () => {
    const w = await createWorld('adhoc-check');
    await w.as('U_CHAIRMAN', async (_tx, ctx, v) => {
      expect(() => checkTask(ctx, v, { title: '', assigneeId: newId(), dueDate: 'mai' })).toThrow(ApiError);
      expect(checkTask(ctx, v, { title: '  Việc  ', assigneeId: w.ids.users.U_LAN, dueDate: '2026-10-09' })).toEqual({ title: 'Việc', description: undefined, assigneeId: w.ids.users.U_LAN, dueDate: '2026-10-09' });
    });
  });
});
