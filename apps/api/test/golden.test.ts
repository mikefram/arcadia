import {
  Scenario,
  closeDb,
  createSession,
  generateSeedIds,
  loadOrgContext,
  loadRun,
  schema,
  seedDemoOrg,
  setFakeNow,
  signToken,
  sql,
  withOrg,
  type SeedIds,
  type UserCode,
} from '@mihato/backend';
import { newId, type Overview, type RunDetail, type RunEventRecord, type StepResult } from '@mihato/domain';
import { FakePush } from '@mihato/providers/push';
import { createRun, replay } from '@mihato/workflow-engine';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

/**
 * Kịch bản vàng biến thể A (SPEC 13.2, mốc M1): "Đón đoàn nhà đầu tư thăm KCN", sáu việc, mốc đích
 * Thứ Năm 15/10/2026, không AI. Chạy qua API thật (app.inject), PostgreSQL thật, worker thật với FakePush,
 * đồng hồ giả. Mọi hạn là 17:00 giờ Việt Nam (10:00 UTC).
 */
const vn = (s: string) => new Date(`${s}:00+07:00`);

let app: FastifyInstance;
let ids: SeedIds;
let scenario: Scenario;
const push = new FakePush();
const tokenOf = (code: UserCode) => `ExponentPushToken[${code}]`;

// Phiên web sống 8 giờ; kịch bản kéo dài một tuần theo đồng hồ giả nên mỗi lần gọi đăng nhập lại.
async function sessionOf(code: UserCode) {
  const s = await withOrg(ids.ORG, (tx) => createSession(tx, ids.ORG, ids.users[code], {}));
  return { cookie: `mihato_session=${s.token}`, csrf: s.csrfToken };
}

async function call<T>(code: UserCode, method: 'GET' | 'POST', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const s = await sessionOf(code);
  const res = await app.inject({
    method,
    url,
    headers: {
      cookie: s.cookie,
      'x-csrf-token': s.csrf,
      ...(method === 'POST' ? { 'idempotency-key': extra['idempotency-key'] ?? newId(), 'content-type': 'application/json' } : {}),
      ...extra,
    },
    payload: body === undefined ? (method === 'POST' ? {} : undefined) : (body as object),
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

const pushesTo = (code: UserCode, type?: string) => push.sent.filter((m) => m.to === tokenOf(code) && (!type || m.data.type === type));

let runId: string;
const stepId = async (nodeId: string) => (await scenario.step(runId, nodeId)).id;
const run = () => scenario.run(runId);

beforeAll(async () => {
  ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  await seedDemoOrg(ids, { code: `golden-${tag}`, name: 'Tổ chức kịch bản vàng', emailDomain: `golden-${tag}.test` });
  await withOrg(ids.ORG, async (tx) => {
    for (const code of Object.keys(ids.users) as UserCode[]) {
      await tx.insert(schema.devices).values({ id: newId(), orgId: ids.ORG, userId: ids.users[code], platform: 'android', name: `Máy thử ${code}`, pushToken: tokenOf(code) });
    }
  });
  scenario = new Scenario(ids, push);
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
});

afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await closeDb();
});

describe('kịch bản vàng, biến thể A (không AI)', () => {
  it('bước 1: Văn phòng khởi chạy; s1 và s4 sẵn sàng, hạn Thứ Ba 06/10', async () => {
    await scenario.at(vn('2026-10-02T09:00'));
    const res = await call<RunDetail>('U_ADMIN', 'POST', '/v1/runs', {
      templateId: ids.TEMPLATE_DON_DOAN,
      title: 'Đón đoàn nhà đầu tư Nhật Bản',
      inputs: { delegation: 'Đoàn nhà đầu tư Nhật Bản', visitDate: '2026-10-15' },
    });
    expect(res.status).toBe(201);
    runId = res.body.id;
    await scenario.tick();

    const r = await run();
    expect(r.state).toBe('running');
    expect(r.steps).toHaveLength(6);
    const byNode = Object.fromEntries(r.steps.map((s) => [s.nodeId, s]));
    expect(byNode.s1!.state).toBe('ready');
    expect(byNode.s4!.state).toBe('ready');
    expect(byNode.s1!.dueAt).toBe('2026-10-06T10:00:00.000Z');
    expect(byNode.s4!.dueAt).toBe('2026-10-06T10:00:00.000Z');
    for (const n of ['s2', 's3', 's5', 's6']) expect(byNode[n]!.state).toBe('pending');
    expect(byNode.s1!.assignee?.id).toBe(ids.users.U_LAN);
    expect(byNode.s4!.assignee?.id).toBe(ids.users.U_PHUONG);

    expect(pushesTo('U_LAN', 'assigned')).toHaveLength(1);
    expect(pushesTo('U_PHUONG', 'assigned')).toHaveLength(1);
    expect(push.sent).toHaveLength(2);
  });

  it('bước 2: Thứ Hai 05/10 08:30, Lan và Phương mỗi người đúng một tin "Ngày mai đến hạn"', async () => {
    await scenario.at(vn('2026-10-05T08:31'));
    expect(pushesTo('U_LAN', 'reminder_due_tomorrow')).toHaveLength(1);
    expect(pushesTo('U_PHUONG', 'reminder_due_tomorrow')).toHaveLength(1);
    expect(pushesTo('U_LAN', 'reminder_due_tomorrow')[0]!.title).toContain('Ngày mai đến hạn');
  });

  it('bước 3: Lan báo xong s1; s2 và s3 sẵn sàng; timer của s1 bị huỷ', async () => {
    await scenario.at(vn('2026-10-05T11:00'));
    const res = await call<StepResult>('U_LAN', 'POST', `/v1/steps/${await stepId('s1')}/complete`, {});
    expect(res.status).toBe(200);
    expect(res.body.step.state).toBe('done');
    await scenario.tick();

    const r = await run();
    const byNode = Object.fromEntries(r.steps.map((s) => [s.nodeId, s]));
    expect(byNode.s2!.state).toBe('ready');
    expect(byNode.s2!.assignee?.id).toBe(ids.users.U_NGOCANH);
    expect(byNode.s2!.dueAt).toBe('2026-10-08T10:00:00.000Z');
    expect(byNode.s3!.state).toBe('ready');
    expect(byNode.s3!.assignee?.id).toBe(ids.users.U_TUAN);
    expect(byNode.s3!.dueAt).toBe('2026-10-07T10:00:00.000Z');
    expect(pushesTo('U_NGOCANH', 'assigned')).toHaveLength(1);
    expect(pushesTo('U_TUAN', 'assigned')).toHaveLength(1);

    const s1 = byNode.s1!.id;
    const pending = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from timers where step_run_id = ${s1} and state = 'pending'`));
    expect(Number(pending.rows[0]!.n)).toBe(0);
  });

  it('bước 4: Phương nhập 20.000.000 đồng rồi báo xong s4; Huy nhận "Cần duyệt"', async () => {
    await scenario.at(vn('2026-10-05T14:00'));
    const noAmount = await call<{ code: string }>('U_PHUONG', 'POST', `/v1/steps/${await stepId('s4')}/complete`, {});
    expect(noAmount.status).toBe(422);
    const res = await call<StepResult>('U_PHUONG', 'POST', `/v1/steps/${await stepId('s4')}/complete`, { result: { amount: 20_000_000 } });
    expect(res.status).toBe(200);
    await scenario.tick();

    const s6 = await scenario.step(runId, 's6');
    expect(s6.state).toBe('ready');
    expect(s6.assignee?.id).toBe(ids.users.U_HUY);
    expect(s6.dueAt).toBe('2026-10-07T10:00:00.000Z');
    expect(pushesTo('U_HUY', 'approval_needed')).toHaveLength(1);
    // Tiêu đề thông báo không chứa số tiền (SPEC 8.3, 11.1).
    expect(pushesTo('U_HUY')[0]!.title + pushesTo('U_HUY')[0]!.body).not.toMatch(/20\.?000\.?000/);
  });

  it('bước 5: Huy duyệt s6; việc có số tiền nên thiếu mã nâng quyền bị 403 step_up_required', async () => {
    await scenario.at(vn('2026-10-07T09:00'));
    const id = await stepId('s6');
    const asHuy = await call<{ items: { id: string; amountVnd: number | null; requiresStepUp: boolean; allowedActions: string[] }[] }>('U_HUY', 'GET', '/v1/steps?assignee=me&open=true');
    const mine = asHuy.body.items.find((s) => s.id === id)!;
    expect(mine.amountVnd).toBe(20_000_000);
    expect(mine.requiresStepUp).toBe(true);
    expect(mine.allowedActions).toEqual(expect.arrayContaining(['approve', 'reject']));

    const denied = await call<{ code: string }>('U_HUY', 'POST', `/v1/steps/${id}/approve`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('step_up_required');

    const stepUp = await signToken('stepup', { sub: ids.users.U_HUY, org: ids.ORG }, 60);
    const ok = await call<StepResult>('U_HUY', 'POST', `/v1/steps/${id}/approve`, {}, { 'x-step-up-token': stepUp.token });
    expect(ok.status).toBe(200);
    expect(ok.body.step.state).toBe('done');
    await scenario.tick();

    const events = await call<{ items: { type: string; actor: { id: string } | null; at: string }[] }>('U_ADMIN', 'GET', `/v1/runs/${runId}/events`);
    const approve = events.body.items.find((e) => e.type === 'ApproveStep')!;
    expect(approve.actor?.id).toBe(ids.users.U_HUY);
    expect(approve.at).toBe(vn('2026-10-07T09:00').toISOString());
  });

  it('bước 6: Ngọc Anh mất mạng, app gửi lại hai lần cùng eventId; máy chủ ghi đúng một lần', async () => {
    await scenario.at(vn('2026-10-07T10:00'));
    const id = await stepId('s2');
    const key = newId();
    const first = await call<StepResult>('U_NGOCANH', 'POST', `/v1/steps/${id}/complete`, { note: 'đã xong' }, { 'idempotency-key': key });
    await scenario.at(vn('2026-10-07T10:05'));
    const second = await call<StepResult>('U_NGOCANH', 'POST', `/v1/steps/${id}/complete`, { note: 'đã xong' }, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    await scenario.tick();

    const count = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from run_events where run_id = ${runId} and type = 'CompleteStep' and payload->'event'->>'stepId' = ${id}`));
    expect(Number(count.rows[0]!.n)).toBe(1);
    const s5 = await scenario.step(runId, 's5');
    expect(s5.state).toBe('ready');
    expect(s5.assignee?.id).toBe(ids.users.U_HUNG);
    expect(s5.dueAt).toBe('2026-10-09T10:00:00.000Z');
    expect(pushesTo('U_HUNG', 'assigned')).toHaveLength(1);
  });

  it('bước 7: Thứ Năm 08/10 08:30, s3 quá hạn: Tuấn và người giao (Văn phòng) nhận tin; Chủ tịch không nhận gì', async () => {
    await scenario.at(vn('2026-10-08T08:31'));
    expect(pushesTo('U_TUAN', 'overdue')).toHaveLength(1);
    expect(pushesTo('U_TUAN', 'overdue')[0]!.title).toContain('quá hạn 1 ngày');
    expect(pushesTo('U_ADMIN', 'overdue')).toHaveLength(1);
    expect(pushesTo('U_CHAIRMAN')).toHaveLength(0);
  });

  it('bước 8: Văn phòng mở Điều phối; số liệu khớp truy vấn SQL', async () => {
    await scenario.at(vn('2026-10-08T09:00'));
    const overview = await call<Overview>('U_ADMIN', 'GET', '/v1/overview');
    expect(overview.status).toBe(200);
    const sqlCounts = await withOrg(ids.ORG, (tx) =>
      tx.execute<{ overdue: string; open: string }>(sql`select count(*) filter (where is_overdue) as overdue, count(*) filter (where state in ('ready','in_progress')) as open from v_step_status`),
    );
    expect(overview.body.overdue).toBe(Number(sqlCounts.rows[0]!.overdue));
    expect(overview.body.overdue).toBe(1);
    expect(overview.body.running).toBe(1);

    const r = await run();
    const state = Object.fromEntries(r.steps.map((s) => [s.nodeId, s]));
    for (const n of ['s1', 's4', 's6', 's2']) expect(state[n]!.state).toBe('done');
    expect(state.s5!.isOverdue).toBe(false);
    expect(state.s3!.isOverdue).toBe(true);
    expect(state.s3!.lateWorkingDays).toBe(1);
    expect(r.progress).toEqual({ done: 4, total: 6 });
    expect(r.schedule).toEqual({ status: 'late', lateWorkingDays: 1 });
  });

  it('bước 9: Văn phòng bấm Đi thúc; Tuấn nhận lời nhắc từ "Văn phòng Chủ tịch", không có dòng "do Trợ lý AI soạn"', async () => {
    await scenario.at(vn('2026-10-08T09:05'));
    const id = await stepId('s3');
    const drafts = await call<{ items: { stepId: string; message: string; throttled: boolean; lateWorkingDays: number }[]; senderName: string }>('U_ADMIN', 'POST', '/v1/nudges/drafts', { stepIds: [id] });
    expect(drafts.status).toBe(200);
    expect(drafts.body.senderName).toBe('Văn phòng Chủ tịch');
    expect(drafts.body.items[0]!.throttled).toBe(false);
    expect(drafts.body.items[0]!.message).toContain('anh Tuấn');
    expect(drafts.body.items[0]!.message).toContain('Kiểm tra tuyến tham quan');

    const sent = await call<{ results: { ok: boolean }[] }>('U_ADMIN', 'POST', '/v1/nudges', { items: [{ stepId: id, message: drafts.body.items[0]!.message }] });
    expect(sent.body.results[0]!.ok).toBe(true);
    await scenario.tick();

    const nudges = pushesTo('U_TUAN', 'nudge');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.title).toContain('Văn phòng Chủ tịch');
    expect(nudges[0]!.body).not.toContain('Trợ lý AI');
    expect(nudges[0]!.channelId).toBe('nudge');

    // Chống làm phiền: không đi thúc cùng một việc quá một lần trong một ngày làm việc (SPEC 4.7).
    const again = await call<{ results: { ok: boolean; error?: { code: string } }[] }>('U_ADMIN', 'POST', '/v1/nudges', { items: [{ stepId: id, message: 'nhắc lần hai' }] });
    expect(again.body.results[0]!.ok).toBe(false);
    expect(again.body.results[0]!.error?.code).toBe('nudge_throttled');
  });

  it('bước 10: Tuấn báo xong s3; mọi timer leo thang của s3 bị huỷ', async () => {
    await scenario.at(vn('2026-10-08T10:00'));
    const id = await stepId('s3');
    const res = await call<StepResult>('U_TUAN', 'POST', `/v1/steps/${id}/complete`, {});
    expect(res.status).toBe(200);
    await scenario.tick();
    const pending = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from timers where step_run_id = ${id} and state = 'pending'`));
    expect(Number(pending.rows[0]!.n)).toBe(0);
  });

  it('bước 11: Thứ Sáu 09/10 08:30, Hùng nhận "Hôm nay đến hạn"; không có tin leo thang nào về s3', async () => {
    await scenario.at(vn('2026-10-09T08:31'));
    expect(pushesTo('U_HUNG', 'reminder_due_today')).toHaveLength(1);
    expect(push.sent.filter((m) => m.data.type === 'escalation')).toHaveLength(0);
    expect(pushesTo('U_HUY', 'escalation')).toHaveLength(0);
  });

  it('bước 12: Hùng báo xong s5; lượt chạy hoàn thành; không còn timer chờ chạy', async () => {
    await scenario.at(vn('2026-10-09T15:00'));
    const res = await call<StepResult>('U_HUNG', 'POST', `/v1/steps/${await stepId('s5')}/complete`, {});
    expect(res.status).toBe(200);
    expect(res.body.run.state).toBe('completed');
    expect(res.body.run.outcome).toBe('success');
    await scenario.tick();

    const pending = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from timers where run_id = ${runId} and state in ('pending','firing')`));
    expect(Number(pending.rows[0]!.n)).toBe(0);
    const overview = await call<Overview>('U_CHAIRMAN', 'GET', '/v1/overview');
    expect(overview.body.recentlyCompletedRuns.map((r) => r.id)).toContain(runId);
  });

  it('kiểm cuối: hạn, phát lại, effects, thông báo đúng một lần, không đẩy trong giờ yên tĩnh', async () => {
    const r = await run();
    const due = Object.fromEntries(r.steps.map((s) => [s.nodeId, s.dueOriginalAt]));
    expect(due).toEqual({
      s1: '2026-10-06T10:00:00.000Z',
      s4: '2026-10-06T10:00:00.000Z',
      s3: '2026-10-07T10:00:00.000Z',
      s6: '2026-10-07T10:00:00.000Z',
      s2: '2026-10-08T10:00:00.000Z',
      s5: '2026-10-09T10:00:00.000Z',
    });

    // Phát lại toàn bộ run_events cho đúng trạng thái cuối (thuộc tính 3, SPEC 4.10).
    await withOrg(ids.ORG, async (tx) => {
      const ctx = await loadOrgContext(tx, ids.ORG);
      const loaded = (await loadRun(tx, runId))!;
      const rows = await tx.select().from(schema.runEvents).where(eq(schema.runEvents.runId, runId)).orderBy(schema.runEvents.seq);
      const events: RunEventRecord[] = rows.map((e) => ({
        id: e.id,
        runId: e.runId,
        seq: e.seq,
        type: e.type as RunEventRecord['type'],
        actorType: e.actorType as RunEventRecord['actorType'],
        actorId: e.actorId,
        proposalId: e.proposalId,
        payload: e.payload as RunEventRecord['payload'],
        at: e.at.toISOString(),
      }));
      const initial = createRun(loaded.def, {
        id: loaded.run.id,
        orgId: loaded.run.orgId,
        templateId: loaded.run.templateId,
        templateVersionId: loaded.run.templateVersionId,
        title: loaded.run.title,
        initiatorId: loaded.run.initiatorId,
        inputs: loaded.run.inputs,
      });
      const replayed = replay({ def: loaded.def, initial, events, ctx: ctx.resolve });
      expect(replayed).toEqual(loaded.run);
    });

    const effects = await withOrg(ids.ORG, (tx) => tx.execute<{ state: string; n: string }>(sql`select state, count(*) as n from effects group by state`));
    expect(effects.rows.map((e) => e.state)).toEqual(['done']);

    // FakePush nhận mỗi thông báo đúng một lần.
    const keys = push.sent.map((m) => `${m.to}:${String(m.data.notificationId)}`);
    expect(new Set(keys).size).toBe(keys.length);

    // Không có thông báo đẩy nào trong giờ yên tĩnh 21:00 đến 07:00 (giờ Việt Nam).
    const sentAt = await withOrg(ids.ORG, (tx) => tx.execute<{ hour: string }>(sql`select extract(hour from sent_at at time zone 'Asia/Ho_Chi_Minh') as hour from notifications where push_tickets is not null`));
    expect(sentAt.rows.length).toBeGreaterThan(0);
    for (const row of sentAt.rows) {
      expect(Number(row.hour)).toBeGreaterThanOrEqual(7);
      expect(Number(row.hour)).toBeLessThan(21);
    }
  });
});
