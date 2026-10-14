import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { aiBudgetJob, estimateAiUsd } from '../src/services/admin';
import { createTestOrg } from '../src/testing';

/**
 * Cảnh báo ngân sách AI (SPEC 12.4, 12.6): chạm 80% và 100% ngân sách tháng thì báo it_admin MỘT lần mỗi mốc mỗi tháng.
 * Chỉ cảnh báo, không tự cắt trợ lý.
 */
afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

const AI = { enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee', dailyCallLimit: 200, monthlyBudgetUsd: 10 };

async function addUsage(org: Awaited<ReturnType<typeof createTestOrg>>, day: string, input: number, output = 0) {
  await org.run((tx) =>
    tx
      .insert(schema.aiUsage)
      .values({ orgId: org.orgId, userId: org.users.chairman, day, llmCalls: 10, llmInputTokens: input, llmOutputTokens: output })
      .onConflictDoNothing(),
  );
}

const budgetNotes = (org: Awaited<ReturnType<typeof createTestOrg>>) =>
  org.run((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'system'))));

describe('ngân sách AI hằng tháng', () => {
  it('công thức chi phí: 2 USD mỗi triệu token vào, 10 USD mỗi triệu token ra', () => {
    expect(estimateAiUsd(4_000_000, 50_000)).toBeCloseTo(8.5, 6);
    expect(estimateAiUsd(0, 0)).toBe(0);
  });

  it('báo it_admin ở 80% rồi ở 100%, mỗi mốc đúng một lần; sang tháng mới thì tính lại từ đầu', async () => {
    const org = await createTestOrg({ settings: { ai: AI } });
    setFakeNow('2026-10-15T03:00:00Z');
    const job = () => org.run((tx, ctx) => aiBudgetJob(tx, ctx));

    // Chưa dùng gì: không báo.
    expect(await job()).toMatchObject({ notified: 0, level: 0 });

    // 8,5 USD trên 10 USD = 85%: mốc 80%.
    await addUsage(org, '2026-10-10', 4_000_000, 50_000);
    const first = await job();
    expect(first).toMatchObject({ notified: 1, level: 80 });
    expect(first.usd).toBeCloseTo(8.5, 6);
    expect(await job()).toMatchObject({ notified: 0, level: 80 });

    const notes = await budgetNotes(org);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.userId).toBe(org.users.itAdmin);
    expect(notes[0]!.body).toContain('đã đạt 80%');
    expect(notes[0]!.body).toContain('8.50 USD');
    expect(notes[0]!.body).toContain('10.00 USD');
    expect(notes[0]!.body).toContain('không tự cắt trợ lý');
    expect(notes[0]!.state).toBe('queued'); // hẹn đẩy qua chuỗi thông báo (giờ yên tĩnh, backoff)

    // Thêm 2 USD: 10,5 USD = 105%: mốc 100%.
    await addUsage(org, '2026-10-12', 1_000_000);
    expect(await job()).toMatchObject({ notified: 1, level: 100 });
    expect(await job()).toMatchObject({ notified: 0, level: 100 });
    const after = await budgetNotes(org);
    expect(after).toHaveLength(2);
    expect(after.some((n) => n.body.includes('đã vượt ngân sách'))).toBe(true);
    expect(after.every((n) => n.userId === org.users.itAdmin)).toBe(true);

    // Tháng sau: số liệu tháng 10 không tính nữa.
    setFakeNow('2026-11-02T03:00:00Z');
    expect(await job()).toMatchObject({ notified: 0, level: 0, usd: 0 });
    await addUsage(org, '2026-11-01', 4_500_000);
    expect(await job()).toMatchObject({ notified: 1, level: 80 });
    expect(await budgetNotes(org)).toHaveLength(3);
  });

  it('không có ngân sách hoặc tắt AI thì không báo', async () => {
    const noBudget = await createTestOrg({ settings: { ai: { ...AI, monthlyBudgetUsd: null } } });
    const off = await createTestOrg({ settings: { ai: { ...AI, enabled: false } } });
    setFakeNow('2026-10-15T03:00:00Z');
    for (const org of [noBudget, off]) {
      await addUsage(org, '2026-10-10', 9_000_000);
      expect(await org.run((tx, ctx) => aiBudgetJob(tx, ctx))).toMatchObject({ notified: 0, level: 0 });
      expect(await budgetNotes(org)).toHaveLength(0);
    }
  });
});
