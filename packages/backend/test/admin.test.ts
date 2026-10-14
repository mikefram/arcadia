import { newId } from '@mihato/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { getAiUsage, listAdminNotifications, listAuditLog, listEffects, retryEffect } from '../src/services/admin';
import { createTestOrg, type TestOrg } from '../src/testing';
import { auditRows, expectApiError } from './helpers';

const NOW = '2026-10-16T03:00:00.000Z';
let org: TestOrg;

beforeAll(async () => {
  setFakeNow(NOW);
  org = await createTestOrg();
});
afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

/** Đi hết các trang bằng con trỏ; trả id theo đúng thứ tự nhận được. */
async function walk<T extends { id: string }>(fetch: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await fetch(cursor);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    ids.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('Phân trang không dừng');
}

describe('nhật ký hoạt động', () => {
  const ids = { login1: newId(), role: newId(), login2: newId(), failed: newId(), holiday: newId(), us1: newId(), us2: newId(), us3: newId() };

  beforeAll(async () => {
    const { itAdmin, officeAdmin, employee } = org.users;
    await org.run(async (tx) => {
      await tx.insert(schema.auditLog).values([
        { id: ids.login1, orgId: org.orgId, at: new Date('2026-10-01T01:00:00Z'), actorType: 'user', actorUserId: itAdmin, action: 'login', ip: '10.0.0.5' },
        { id: ids.role, orgId: org.orgId, at: new Date('2026-10-01T02:00:00Z'), actorType: 'user', actorUserId: itAdmin, action: 'role_changed', targetType: 'user', targetId: employee, detail: { after: [{ role: 'employee', unitId: null }] } },
        // hai dòng cùng thời điểm: thứ tự phân định bằng id
        { id: ids.login2, orgId: org.orgId, at: new Date('2026-10-02T01:00:00Z'), actorType: 'user', actorUserId: officeAdmin, action: 'login' },
        { id: ids.failed, orgId: org.orgId, at: new Date('2026-10-02T01:00:00Z'), actorType: 'system', action: 'login_failed', targetType: 'user', targetId: employee },
        { id: ids.holiday, orgId: org.orgId, at: new Date('2026-10-03T01:00:00Z'), actorType: 'user', actorUserId: officeAdmin, action: 'holiday_changed', detail: { op: 'put', day: '2027-01-01' } },
      ]);
      // Ba dòng lệch nhau vài micro giây trong cùng một mili giây: con trỏ không được làm sót hay lặp dòng nào.
      for (const [id, at] of [
        [ids.us1, '2026-10-04 01:00:00.123000+00'],
        [ids.us2, '2026-10-04 01:00:00.123456+00'],
        [ids.us3, '2026-10-04 01:00:00.123457+00'],
      ] as const) {
        await tx.execute(sql`INSERT INTO audit_log (id, org_id, at, actor_type, action, detail) VALUES (${id}, ${org.orgId}, ${at}::timestamptz, 'system', 'refresh_reuse', '{}'::jsonb)`);
      }
    });
  });

  it('mới nhất trước, phân trang con trỏ không sót không lặp', async () => {
    const all = await org.run((tx, ctx) => listAuditLog(tx, ctx, { limit: 50 }));
    expect(all.nextCursor).toBeNull();
    const samePair = [ids.login2, ids.failed].sort().reverse();
    expect(all.items.map((e) => e.id)).toEqual([ids.us3, ids.us2, ids.us1, ids.holiday, ...samePair, ids.role, ids.login1]);

    for (const limit of [1, 2, 3]) {
      const walked = await walk((cursor) => org.run((tx, ctx) => listAuditLog(tx, ctx, { limit, cursor })), limit);
      expect(walked).toEqual(all.items.map((e) => e.id));
    }

    const role = all.items.find((e) => e.id === ids.role)!;
    expect(role).toEqual({
      id: ids.role,
      at: '2026-10-01T02:00:00.000Z',
      actorType: 'user',
      actor: { id: org.users.itAdmin, fullName: 'Ngô Văn Tài', givenName: 'Tài', honorific: 'anh' },
      action: 'role_changed',
      targetType: 'user',
      targetId: org.users.employee,
      ip: null,
      detail: { after: [{ role: 'employee', unitId: null }] },
    });
    expect(all.items.find((e) => e.id === ids.failed)).toMatchObject({ actorType: 'system', actor: null });
    expect(all.items.find((e) => e.id === ids.login1)!.ip).toMatch(/^10\.0\.0\.5/);
  });

  it('lọc theo hành động, người thực hiện và khoảng thời gian', async () => {
    const list = (q: Parameters<typeof listAuditLog>[2]) => org.run(async (tx, ctx) => (await listAuditLog(tx, ctx, q)).items.map((e) => e.id));
    expect(await list({ limit: 50, action: 'login' })).toEqual([ids.login2, ids.login1]);
    expect(await list({ limit: 50, actorId: org.users.officeAdmin })).toEqual([ids.holiday, ids.login2]);
    expect(await list({ limit: 50, from: '2026-10-01T02:00:00Z', to: '2026-10-02T01:00:00Z' })).toEqual([...[ids.login2, ids.failed].sort().reverse(), ids.role]);
    expect(await list({ limit: 50, action: 'login', actorId: org.users.itAdmin, from: '2026-10-01T00:00:00+07:00' })).toEqual([ids.login1]);
    expect(await list({ limit: 50, action: 'khong_co' })).toEqual([]);
    await expectApiError(org.run((tx, ctx) => listAuditLog(tx, ctx, { limit: 50, cursor: 'rac' })), 'input_invalid');
  });
});

describe('trạng thái gửi và đọc của thông báo', () => {
  const n = { queued: newId(), sent: newId(), opened: newId() };

  beforeAll(async () => {
    const base = { orgId: org.orgId, body: 'Nội dung', payload: {} };
    await org.run((tx) =>
      tx.insert(schema.notifications).values([
        { ...base, id: n.queued, userId: org.users.employee, kind: 'assigned', title: 'Việc mới', state: 'queued', createdAt: new Date('2026-10-10T01:00:00Z') },
        { ...base, id: n.sent, userId: org.users.employee2, kind: 'reminder', title: 'Nhắc việc', state: 'sent', createdAt: new Date('2026-10-11T01:00:00Z'), sentAt: new Date('2026-10-11T01:00:05Z') },
        {
          ...base,
          id: n.opened,
          userId: org.users.employee,
          kind: 'nudge',
          title: 'Đi thúc',
          state: 'opened',
          createdAt: new Date('2026-10-12T01:00:00Z'),
          sentAt: new Date('2026-10-12T01:00:02Z'),
          deliveredAt: new Date('2026-10-12T01:16:00Z'),
          openedAt: new Date('2026-10-12T02:00:00Z'),
        },
      ]),
    );
  });

  it('liệt kê, lọc theo trạng thái và người nhận, phân trang', async () => {
    const all = await org.run((tx, ctx) => listAdminNotifications(tx, ctx, { limit: 50 }));
    expect(all.items.map((i) => i.id)).toEqual([n.opened, n.sent, n.queued]);
    expect(all.items[0]).toEqual({
      id: n.opened,
      user: { id: org.users.employee, fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi' },
      kind: 'nudge',
      title: 'Đi thúc',
      state: 'opened',
      createdAt: '2026-10-12T01:00:00.000Z',
      sentAt: '2026-10-12T01:00:02.000Z',
      deliveredAt: '2026-10-12T01:16:00.000Z',
      openedAt: '2026-10-12T02:00:00.000Z',
    });
    expect(all.items[2]).toMatchObject({ state: 'queued', sentAt: null, deliveredAt: null, openedAt: null });

    const ids = (q: Parameters<typeof listAdminNotifications>[2]) => org.run(async (tx, ctx) => (await listAdminNotifications(tx, ctx, q)).items.map((i) => i.id));
    expect(await ids({ limit: 50, state: 'sent' })).toEqual([n.sent]);
    expect(await ids({ limit: 50, userId: org.users.employee })).toEqual([n.opened, n.queued]);
    expect(await ids({ limit: 50, userId: org.users.employee, state: 'queued' })).toEqual([n.queued]);
    expect(await walk((cursor) => org.run((tx, ctx) => listAdminNotifications(tx, ctx, { limit: 1, cursor })), 1)).toEqual([n.opened, n.sent, n.queued]);
    await expectApiError(org.run((tx, ctx) => listAdminNotifications(tx, ctx, { limit: 50, state: 'la' })), 'input_invalid');
  });
});

describe('hàng effect', () => {
  const e = { dead1: newId(), dead2: newId(), pending: newId(), done: newId() };

  beforeAll(async () => {
    const row = (id: string, state: string, attempts: number, createdAt: string, lastError: string | null = null) => ({
      id,
      orgId: org.orgId,
      kind: 'notify.assigned',
      payload: { toUserId: org.users.employee },
      dedupeKey: `test:${id}`,
      state,
      attempts,
      lastError,
      createdAt: new Date(createdAt),
      nextAttemptAt: new Date('2026-10-10T02:00:00Z'),
    });
    await org.run((tx) =>
      tx.insert(schema.effects).values([
        row(e.dead1, 'dead', 8, '2026-10-10T01:00:00Z', 'Error:push_transient'),
        row(e.dead2, 'dead', 8, '2026-10-11T01:00:00Z', 'unknown_effect_kind'),
        row(e.pending, 'pending', 2, '2026-10-12T01:00:00Z'),
        row(e.done, 'done', 1, '2026-10-13T01:00:00Z'),
      ]),
    );
  });

  it('mặc định liệt kê effect dead; lọc theo trạng thái', async () => {
    const dead = await org.run((tx) => listEffects(tx, { limit: 50, state: 'dead' }));
    expect(dead.items.map((i) => i.id)).toEqual([e.dead2, e.dead1]);
    expect(dead.items[1]).toEqual({
      id: e.dead1,
      kind: 'notify.assigned',
      state: 'dead',
      attempts: 8,
      lastError: 'Error:push_transient',
      runId: null,
      createdAt: '2026-10-10T01:00:00.000Z',
      nextAttemptAt: '2026-10-10T02:00:00.000Z',
    });
    expect((await org.run((tx) => listEffects(tx, { limit: 50, state: 'pending' }))).items.map((i) => i.id)).toEqual([e.pending]);
    expect(await walk((cursor) => org.run((tx) => listEffects(tx, { limit: 1, state: 'dead', cursor })), 1)).toEqual([e.dead2, e.dead1]);
  });

  it('thử lại: về pending, số lần thử về 0, hẹn chạy ngay, ghi nhật ký; effect không dead thì 409', async () => {
    const itAdmin = org.viewer('it_admin');
    const view = await org.run((tx) => retryEffect(tx, itAdmin, e.dead1));
    expect(view).toMatchObject({ id: e.dead1, state: 'pending', attempts: 0, nextAttemptAt: NOW });

    const [row] = await org.run((tx) => tx.select().from(schema.effects).where(eq(schema.effects.id, e.dead1)));
    expect(row).toMatchObject({ state: 'pending', attempts: 0, lockedAt: null, dedupeKey: `test:${e.dead1}` });
    expect(row!.nextAttemptAt.toISOString()).toBe(NOW);

    const [entry] = await org.run((tx) => auditRows(tx, 'effect_retried'));
    expect(entry).toMatchObject({ targetType: 'effect', targetId: e.dead1, actorUserId: itAdmin.id });
    expect(entry!.detail).toEqual({ kind: 'notify.assigned', attempts: 8 });

    const again = await expectApiError(org.run((tx) => retryEffect(tx, itAdmin, e.dead1)), 'state_conflict');
    expect(again.extra.currentState).toBe('pending');
    await expectApiError(org.run((tx) => retryEffect(tx, itAdmin, e.done)), 'state_conflict');
    await expectApiError(org.run((tx) => retryEffect(tx, itAdmin, newId())), 'not_found');
    expect((await org.run((tx) => listEffects(tx, { limit: 50, state: 'dead' }))).items.map((i) => i.id)).toEqual([e.dead2]);
  });
});

describe('số liệu dùng AI', () => {
  beforeAll(async () => {
    const { chairman, director } = org.users;
    const row = (userId: string, day: string, llmCalls: number, llmInputTokens: number, llmOutputTokens: number, sttSeconds: number, ttsChars: number, errors: number) => ({ orgId: org.orgId, userId, day, llmCalls, llmInputTokens, llmOutputTokens, sttSeconds, ttsChars, errors });
    await org.run((tx) =>
      tx.insert(schema.aiUsage).values([
        row(chairman, '2026-10-01', 10, 100_000, 5_000, 60, 2_500, 1),
        row(chairman, '2026-10-02', 5, 50_000, 2_000, 30, 1_000, 0),
        row(director, '2026-10-02', 40, 400_000, 30_000, 0, 0, 2),
        row(chairman, '2026-09-01', 99, 9_000_000, 900_000, 999, 99_999, 9),
      ]),
    );
  });

  it('theo người và ngày, tổng và chi phí ước tính theo giá ở SPEC 6.3', async () => {
    const usage = await org.run((tx, ctx) => getAiUsage(tx, ctx, { from: '2026-10-01', to: '2026-10-02' }));
    expect(usage.rows.map((r) => [r.day, r.user.fullName, r.llmCalls])).toEqual(
      expect.arrayContaining([
        ['2026-10-02', 'Trần Đức Minh', 5],
        ['2026-10-02', 'Lê Thanh Sơn', 40],
        ['2026-10-01', 'Trần Đức Minh', 10],
      ]),
    );
    expect(usage.rows).toHaveLength(3);
    expect(usage.rows.map((r) => r.day)).toEqual(['2026-10-02', '2026-10-02', '2026-10-01']);
    expect(usage.rows.find((r) => r.day === '2026-10-01')).toEqual({
      user: { id: org.users.chairman, fullName: 'Trần Đức Minh', givenName: 'Minh', honorific: 'ong' },
      day: '2026-10-01',
      llmCalls: 10,
      llmInputTokens: 100_000,
      llmOutputTokens: 5_000,
      sttSeconds: 60,
      ttsChars: 2_500,
      errors: 1,
    });
    // 550.000 token vào × 2 USD + 37.000 token ra × 10 USD, mỗi triệu token: 1,10 + 0,37 = 1,47 USD
    expect(usage.totals).toEqual({ llmCalls: 55, llmInputTokens: 550_000, llmOutputTokens: 37_000, sttSeconds: 90, ttsChars: 3_500, errors: 3, estimatedUsd: 1.47 });

    const oneDay = await org.run((tx, ctx) => getAiUsage(tx, ctx, { from: '2026-10-01', to: '2026-10-01' }));
    expect(oneDay.totals).toMatchObject({ llmCalls: 10, estimatedUsd: 0.25 });
  });

  it('bỏ trống kỳ: 30 ngày gần nhất tính tới hôm nay theo giờ Việt Nam', async () => {
    // hôm nay là 16/10/2026: kỳ mặc định từ 17/09 tới 16/10, không gồm dòng 01/09
    const usage = await org.run((tx, ctx) => getAiUsage(tx, ctx));
    expect(usage.rows).toHaveLength(3);
    expect(usage.totals.llmCalls).toBe(55);
    expect((await org.run((tx, ctx) => getAiUsage(tx, ctx, { from: '2026-09-01' }))).totals.llmCalls).toBe(154);
    await expectApiError(org.run((tx, ctx) => getAiUsage(tx, ctx, { from: '2026-10-02', to: '2026-10-01' })), 'input_invalid');
  });
});
