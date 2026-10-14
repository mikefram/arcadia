import { newId, type InternalToolResult } from '@mihato/domain';
import { FakePush } from '@mihato/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { expect } from 'vitest';
import { advanceFakeNow, setFakeNow } from '../src/clock';
import { loadOrgContext, type OrgContext } from '../src/context';
import { schema, withOrg, type Tx } from '../src/db/client';
import { generateSeedIds, seedDemoOrg, seedViewer, type SeedIds, type UserCode } from '../src/seed/org';
import { Scenario } from '../src/seed/scenario';
import { proposalApplyHandler } from '../src/services/proposals';
import { executeTool } from '../src/services/tools';
import { delegate } from './helpers';
import type { Viewer } from '../src/views';
import { registerEffectHandler } from '../src/worker';

/**
 * Thế giới thử cho phần AI: mỗi lần gọi tạo MỘT tổ chức riêng (SPEC 13.1) với dữ liệu mẫu ở SPEC 15.4 và đưa
 * kịch bản vàng tới sáng Thứ Năm 08/10/2026 09:05 (sau bước 7 của SPEC 13.2, rút gọn): s1 đã xong, s3 của Tuấn quá hạn
 * 1 ngày làm việc, s4 của Phương quá hạn 2 ngày, s2 của Ngọc Anh đến hạn hôm nay. Chủ tịch là người khởi chạy.
 * Mọi thay đổi đi qua service và advance(), đồng hồ giả, worker thật với FakePush và chỉ chạy việc của tổ chức này.
 */
export const vn = (s: string) => new Date(`${s}:00+07:00`);
export const tokenOf = (code: UserCode) => `ExponentPushToken[${code}]`;

// Worker thật đăng ký handler này ở apps/worker/src/extensions.ts; test đăng ký cùng handler.
registerEffectHandler('proposal.apply', proposalApplyHandler);

export type World = {
  ids: SeedIds;
  orgId: string;
  scenario: Scenario;
  push: FakePush;
  runId: string;
  /** nodeId (s1…s6) → id của việc */
  step: Record<string, string>;
  viewer(code: UserCode): Viewer;
  /** Chạy `fn` như một handler của API: một giao dịch có app.org_id, danh bạ vừa nạp, Viewer của người mẫu. */
  as<T>(code: UserCode, fn: (tx: Tx, ctx: OrgContext, viewer: Viewer) => Promise<T>): Promise<T>;
  db<T>(fn: (tx: Tx, ctx: OrgContext) => Promise<T>): Promise<T>;
  /** Ủy quyền toàn phần `from` → `to`: việc trong quy trình chỉ giao lại được cho người được bổ nhiệm hoặc người được ủy quyền. */
  delegate(from: UserCode, to: UserCode): Promise<void>;
  /** Gọi một tool của trợ lý thay cho người mẫu, như scribe gọi qua /internal/v1/tools/:name. */
  tool(code: UserCode, name: string, args: unknown): Promise<InternalToolResult>;
  /** Cho worker chạy mọi việc đã đến hạn của tổ chức này tại đồng hồ giả hiện tại. */
  tick(): Promise<void>;
  /** Tiến đồng hồ giả rồi cho worker chạy. */
  after(ms: number): Promise<void>;
  proposal(id: string): Promise<typeof schema.proposals.$inferSelect>;
  effects(proposalId: string): Promise<(typeof schema.effects.$inferSelect)[]>;
  events(proposalId: string): Promise<(typeof schema.runEvents.$inferSelect)[]>;
  auditActions(proposalId: string): Promise<string[]>;
  nudgesTo(code: UserCode): Promise<(typeof schema.nudges.$inferSelect)[]>;
  pushesTo(code: UserCode, type?: string): FakePush['sent'];
};

export async function createWorld(label: string, opts: { settings?: Record<string, unknown>; at?: string; s3Title?: string } = {}): Promise<World> {
  const ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  setFakeNow(vn('2026-10-02T08:00'));
  await seedDemoOrg(ids, { code: `${label}-${tag}`, name: `Tổ chức thử ${label}`, emailDomain: `${label}-${tag}.test`, settings: opts.settings, s3Title: opts.s3Title });
  await withOrg(ids.ORG, async (tx) => {
    for (const code of Object.keys(ids.users) as UserCode[]) {
      await tx.insert(schema.devices).values({ id: newId(), orgId: ids.ORG, userId: ids.users[code], platform: 'android', name: `Máy thử ${code}`, pushToken: tokenOf(code) });
    }
  });
  const push = new FakePush();
  const scenario = new Scenario(ids, push);
  await scenario.at(vn('2026-10-02T09:00'));
  const run = await scenario.start('U_CHAIRMAN', { title: 'Đón đoàn nhà đầu tư Nhật Bản', delegation: 'Đoàn nhà đầu tư Nhật Bản', visitDate: '2026-10-15' });
  await scenario.at(vn('2026-10-05T11:00'));
  await scenario.complete('U_LAN', run.id, 's1');
  await scenario.at(vn(opts.at ?? '2026-10-08T09:05'));
  const detail = await scenario.run(run.id);
  const step = Object.fromEntries(detail.steps.map((s) => [s.nodeId, s.id]));

  const db: World['db'] = (fn) => withOrg(ids.ORG, async (tx) => fn(tx, await loadOrgContext(tx, ids.ORG)));
  const world: World = {
    ids,
    orgId: ids.ORG,
    scenario,
    push,
    runId: run.id,
    step,
    viewer: (code) => seedViewer(ids, code),
    as: (code, fn) => db((tx, ctx) => fn(tx, ctx, seedViewer(ids, code))),
    db,
    delegate: (from, to) => db((tx) => delegate(tx, ids.ORG, ids.users.U_IT, ids.users[from], ids.users[to])),
    tool: (code, name, args) => db((tx, ctx) => executeTool(tx, ctx, seedViewer(ids, code), name, args)),
    tick: () => scenario.tick(),
    after: async (ms) => {
      advanceFakeNow(ms);
      await scenario.tick();
    },
    proposal: (id) =>
      db(async (tx) => {
        const [row] = await tx.select().from(schema.proposals).where(eq(schema.proposals.id, id));
        if (!row) throw new Error('Không thấy đề xuất');
        return row;
      }),
    effects: (proposalId) => db((tx) => tx.select().from(schema.effects).where(eq(schema.effects.dedupeKey, `proposal:${proposalId}`))),
    events: (proposalId) => db((tx) => tx.select().from(schema.runEvents).where(eq(schema.runEvents.proposalId, proposalId))),
    auditActions: (proposalId) =>
      db(async (tx) => (await tx.select({ action: schema.auditLog.action }).from(schema.auditLog).where(eq(schema.auditLog.targetId, proposalId))).map((r) => r.action)),
    nudgesTo: (code) => db((tx) => tx.select().from(schema.nudges).where(eq(schema.nudges.toUserId, ids.users[code]))),
    pushesTo: (code, type) => push.sent.filter((m) => m.to === tokenOf(code) && (!type || m.data.type === type)),
  };
  return world;
}

/** Gọi tool đề xuất và trả id các đề xuất vừa tạo; tool lỗi thì test hỏng ngay với mã lỗi. */
export async function propose(w: World, code: UserCode, name: string, args: unknown): Promise<string[]> {
  const res = await w.tool(code, name, args);
  expect(res.error, `tool ${name} phải chạy được`).toBeUndefined();
  expect(res.ok).toBe(true);
  return (res.proposals ?? []).map((p) => p.proposalId);
}

/**
 * Điều 9 (SPEC 13.3): mọi hiệu lực ghi `run_events` kèm `proposal_id`, và ghi `audit_log`.
 * Gọi ở cuối mỗi test có hiệu lực chạy thật.
 */
export async function expectTrace(w: World, proposalId: string, confirmer: UserCode, eventType: string): Promise<void> {
  const events = await w.events(proposalId);
  expect(events, 'đúng một dòng run_events mang proposal_id').toHaveLength(1);
  expect(events[0]).toMatchObject({ type: eventType, actorType: 'ai', actorId: w.ids.users[confirmer], proposalId });
  const actions = await w.auditActions(proposalId);
  expect(actions).toEqual(expect.arrayContaining(['proposal_created', 'proposal_confirmed', 'proposal_applied']));
}

/** Ảnh chụp các bảng nghiệp vụ của tổ chức, để kiểm "không có dòng nào đổi". */
export async function snapshot(w: World): Promise<string> {
  return w.db(async (tx) => {
    const runs = await tx.select({ id: schema.processRuns.id, state: schema.processRuns.state, version: schema.processRuns.version }).from(schema.processRuns);
    const steps = await tx
      .select({ id: schema.stepRuns.id, state: schema.stepRuns.state, assigneeId: schema.stepRuns.assigneeId, dueAt: schema.stepRuns.dueAt, lastNudgedAt: schema.stepRuns.lastNudgedAt })
      .from(schema.stepRuns);
    const events = await tx.select({ id: schema.runEvents.id }).from(schema.runEvents);
    const nudges = await tx.select({ id: schema.nudges.id }).from(schema.nudges);
    const proposals = await tx.select({ id: schema.proposals.id, state: schema.proposals.state }).from(schema.proposals);
    const effects = await tx.select({ id: schema.effects.id }).from(schema.effects).where(and(eq(schema.effects.kind, 'proposal.apply'), inArray(schema.effects.state, ['pending', 'processing'])));
    const sort = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({ runs: sort(runs), steps: sort(steps), events: sort(events), nudges: sort(nudges), proposals: sort(proposals), effects: sort(effects) });
  });
}
