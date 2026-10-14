import { newId } from '@mihato/domain';
import { FakePush } from '@mihato/providers/push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { loadOrgContext } from '../src/context';
import { closeDb, getScanDb, schema, sql, withOrg } from '../src/db/client';
import { generateSeedIds, seedDemoOrg, seedViewer, type SeedIds, type UserCode } from '../src/seed/org';
import { Scenario } from '../src/seed/scenario';
import { patchOrgSettings } from '../src/services/org';
import { actOnStep } from '../src/services/runs';
import { MAX_EFFECT_ATTEMPTS, releaseStaleLocks, runWorkerTick } from '../src/worker';
import { delegate } from './helpers';

/**
 * Thuộc tính 7 của engine (SPEC 4.10, 13.4) và độ bền của worker (SPEC 13.8, S2-06, 10.11 điều 7),
 * chạy với PostgreSQL thật. Mỗi nhóm test tạo tổ chức riêng.
 */
const vn = (s: string) => new Date(`${s}:00+07:00`);

async function freshOrg(label: string): Promise<SeedIds> {
  const ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  await seedDemoOrg(ids, { code: `${label}-${tag}`, name: `Tổ chức thử ${label}`, emailDomain: `${label}-${tag}.test` });
  return ids;
}

async function addDevice(ids: SeedIds, code: UserCode, token: string): Promise<void> {
  await withOrg(ids.ORG, (tx) => tx.insert(schema.devices).values({ id: newId(), orgId: ids.ORG, userId: ids.users[code], platform: 'android', name: 'Máy thử', pushToken: token }));
}

const complete = (ids: SeedIds, by: UserCode, stepId: string, result?: Record<string, unknown>) =>
  withOrg(ids.ORG, async (tx) => actOnStep(tx, await loadOrgContext(tx, ids.ORG), seedViewer(ids, by), stepId, newId(), { type: 'CompleteStep', result }));

afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

describe('thuộc tính 7: hai người cùng lúc', () => {
  it('hai CompleteStep song song trên hai việc của một lượt chạy cho kết quả giống chạy tuần tự', async () => {
    const shape = async (ids: SeedIds, parallel: boolean) => {
      const s = new Scenario(ids);
      await s.at(vn('2026-10-02T09:00'));
      const run = await s.start('U_ADMIN', { title: 'Lượt thử song song', delegation: 'Đoàn thử', visitDate: '2026-10-15' });
      const s1 = run.steps.find((x) => x.nodeId === 's1')!;
      const s4 = run.steps.find((x) => x.nodeId === 's4')!;
      setFakeNow(vn('2026-10-05T11:00'));
      if (parallel) {
        // Khoá hàng process_runs (FOR UPDATE) buộc hai giao dịch xếp hàng (SPEC 4.4).
        const results = await Promise.all([complete(ids, 'U_LAN', s1.id), complete(ids, 'U_PHUONG', s4.id, { amount: 20_000_000 })]);
        expect(results.every((r) => r.step.state === 'done')).toBe(true);
      } else {
        await complete(ids, 'U_LAN', s1.id);
        await complete(ids, 'U_PHUONG', s4.id, { amount: 20_000_000 });
      }
      const after = await s.run(run.id);
      const seqs = await withOrg(ids.ORG, (tx) => tx.execute<{ seq: string }>(sql`select seq from run_events where run_id = ${run.id} order by seq`));
      const codeOf = (id: string | undefined) => Object.entries(ids.users).find(([, v]) => v === id)?.[0] ?? null;
      return {
        version: after.version - run.version,
        seqs: seqs.rows.map((r) => Number(r.seq)),
        steps: after.steps.map((x) => ({ nodeId: x.nodeId, state: x.state, assignee: codeOf(x.assignee?.id), dueAt: x.dueAt })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      };
    };
    const parallel = await shape(await freshOrg('p7a'), true);
    const sequential = await shape(await freshOrg('p7b'), false);
    expect(parallel.steps).toEqual(sequential.steps);
    expect(parallel.version).toBe(2);
    expect(parallel.seqs).toEqual([1, 2, 3]);
    expect(parallel.steps.filter((x) => x.state === 'ready').map((x) => x.nodeId)).toEqual(['s2', 's3', 's6']);
  });

  it('gửi lại cùng eventId song song chỉ tạo một sự kiện', async () => {
    const ids = await freshOrg('p7c');
    const s = new Scenario(ids);
    await s.at(vn('2026-10-02T09:00'));
    const run = await s.start('U_ADMIN', { title: 'Lượt thử lặp', delegation: 'Đoàn thử', visitDate: '2026-10-15' });
    const s1 = run.steps.find((x) => x.nodeId === 's1')!;
    const eventId = newId();
    const once = () => withOrg(ids.ORG, async (tx) => actOnStep(tx, await loadOrgContext(tx, ids.ORG), seedViewer(ids, 'U_LAN'), s1.id, eventId, { type: 'CompleteStep' }));
    const results = await Promise.all([once(), once(), once()]);
    expect(results.every((r) => r.step.state === 'done')).toBe(true);
    const n = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from run_events where run_id = ${run.id} and type = 'CompleteStep'`));
    expect(Number(n.rows[0]!.n)).toBe(1);
  });
});

describe('worker: effects và timers', () => {
  let ids: SeedIds;
  let s: Scenario;
  const push = new FakePush();
  const LAN = 'ExponentPushToken[worker-lan]';

  beforeAll(async () => {
    ids = await freshOrg('wk');
    await addDevice(ids, 'U_LAN', LAN);
    await addDevice(ids, 'U_PHUONG', 'ExponentPushToken[worker-phuong]');
    s = new Scenario(ids, push);
  });

  it('worker chết sau khi đã gửi nhưng trước khi đánh dấu xong: chạy lại, hiệu lực chỉ xảy ra một lần', async () => {
    await s.at(vn('2026-10-02T09:00'));
    await s.start('U_ADMIN', { title: 'Lượt thử worker', delegation: 'Đoàn thử', visitDate: '2026-10-15' });
    expect(push.sent.filter((m) => m.to === LAN)).toHaveLength(1);
    // Giả lập: effect đã gửi xong nhưng worker chết trước khi ghi `done`, khoá treo quá 10 phút.
    await getScanDb().execute(sql`UPDATE effects SET state = 'processing', locked_at = ${new Date(vn('2026-10-02T09:00').getTime() - 11 * 60_000)} WHERE org_id = ${ids.ORG} AND kind = 'notify.assigned'`);
    await releaseStaleLocks();
    await s.tick();
    expect(push.sent.filter((m) => m.to === LAN)).toHaveLength(1);
    const rows = await withOrg(ids.ORG, (tx) => tx.execute<{ state: string }>(sql`select state from effects where kind = 'notify.assigned'`));
    expect(rows.rows.every((r) => r.state === 'done')).toBe(true);
    const notifications = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from notifications where user_id = ${ids.users.U_LAN} and kind = 'assigned'`));
    expect(Number(notifications.rows[0]!.n)).toBe(1);
  });

  it('tin trong giờ yên tĩnh hoãn tới 07:00, không tính là một lần thử lỗi', async () => {
    // Giờ yên tĩnh mặc định là KHÔNG CÓ (docs/DECISIONS.md, 04/10/2026), nên bật rõ ràng để thử đường hoãn thông báo.
    await withOrg(ids.ORG, (tx) => patchOrgSettings(tx, seedViewer(ids, 'U_ADMIN'), { quietHours: { start: '21:00', end: '07:00' } }));
    const before = push.sent.length;
    // 22:00 Thứ Sáu: Văn phòng giao lại việc của Lan cho Hùng. Tin báo không được đẩy lúc này.
    setFakeNow(vn('2026-10-02T22:00'));
    await addDevice(ids, 'U_HUNG', 'ExponentPushToken[worker-hung]');
    // Việc s1 là của Lan theo quy trình; Hùng nhận được vì đang được Lan ủy quyền (docs/DECISIONS.md, 05/10/2026).
    await withOrg(ids.ORG, (tx) => delegate(tx, ids.ORG, ids.users.U_IT, ids.users.U_LAN, ids.users.U_HUNG));
    const run = (await withOrg(ids.ORG, (tx) => tx.execute<{ id: string }>(sql`select id from process_runs limit 1`))).rows[0]!;
    const step = await s.step(run.id, 's1');
    await withOrg(ids.ORG, async (tx) =>
      actOnStep(tx, await loadOrgContext(tx, ids.ORG), seedViewer(ids, 'U_ADMIN'), step.id, newId(), { type: 'Reassign', toUserId: ids.users.U_HUNG, reason: 'thử giờ yên tĩnh' }),
    );
    await runWorkerTick({ push }, { orgId: ids.ORG });
    expect(push.sent.length).toBe(before);
    const deferred = await withOrg(ids.ORG, (tx) => tx.execute<{ attempts: number; next_attempt_at: string; state: string }>(sql`select attempts, next_attempt_at, state from effects where state = 'pending'`));
    expect(deferred.rows.length).toBeGreaterThan(0);
    for (const r of deferred.rows) {
      expect(r.attempts).toBe(0);
      expect(new Date(r.next_attempt_at).toISOString()).toBe(vn('2026-10-03T07:00').toISOString());
    }
    // Người nhận vẫn thấy tin trong app ngay, chỉ là chưa đẩy.
    const queued = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from notifications where user_id = ${ids.users.U_HUNG} and state = 'queued'`));
    expect(Number(queued.rows[0]!.n)).toBe(1);

    setFakeNow(vn('2026-10-03T07:00'));
    await runWorkerTick({ push }, { orgId: ids.ORG });
    expect(push.sent.filter((m) => m.to === 'ExponentPushToken[worker-hung]')).toHaveLength(1);
    await withOrg(ids.ORG, (tx) => patchOrgSettings(tx, seedViewer(ids, 'U_ADMIN'), { quietHours: null }));
  });

  it('DeviceNotRegistered xoá token và ghi audit_log', async () => {
    push.unregistered.add('ExponentPushToken[worker-hung]');
    setFakeNow(vn('2026-10-05T10:00'));
    const run = (await withOrg(ids.ORG, (tx) => tx.execute<{ id: string }>(sql`select id from process_runs limit 1`))).rows[0]!;
    const step = await s.step(run.id, 's1');
    await withOrg(ids.ORG, async (tx) =>
      actOnStep(tx, await loadOrgContext(tx, ids.ORG), seedViewer(ids, 'U_ADMIN'), step.id, newId(), { type: 'ExtendDue', newDueAt: vn('2026-10-07T17:00').toISOString(), reason: 'thử token hết hạn' }),
    );
    await runWorkerTick({ push }, { orgId: ids.ORG });
    const tokens = await withOrg(ids.ORG, (tx) => tx.execute<{ push_token: string | null }>(sql`select push_token from devices where user_id = ${ids.users.U_HUNG}`));
    expect(tokens.rows[0]!.push_token).toBeNull();
    const audits = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from audit_log where action = 'push_token_removed'`));
    expect(Number(audits.rows[0]!.n)).toBe(1);
    push.unregistered.clear();
  });

  it('lỗi tạm được thử lại theo backoff; quá số lần thì effect thành dead và báo it_admin', async () => {
    await addDevice(ids, 'U_TUAN', 'ExponentPushToken[worker-tuan]');
    await withOrg(ids.ORG, (tx) => delegate(tx, ids.ORG, ids.users.U_IT, ids.users.U_LAN, ids.users.U_TUAN));
    setFakeNow(vn('2026-10-05T11:00'));
    const run = (await withOrg(ids.ORG, (tx) => tx.execute<{ id: string }>(sql`select id from process_runs limit 1`))).rows[0]!;
    const step = await s.step(run.id, 's1');
    push.failNext = 1000;
    await withOrg(ids.ORG, async (tx) =>
      actOnStep(tx, await loadOrgContext(tx, ids.ORG), seedViewer(ids, 'U_ADMIN'), step.id, newId(), { type: 'Reassign', toUserId: ids.users.U_TUAN, reason: 'thử backoff' }),
    );
    const pendingFor = async () =>
      (await withOrg(ids.ORG, (tx) => tx.execute<{ id: string; attempts: number; next_attempt_at: string; state: string }>(sql`select id, attempts, next_attempt_at, state from effects where payload->>'toUserId' = ${ids.users.U_TUAN} and kind = 'notify.assigned'`))).rows[0]!;

    await runWorkerTick({ push }, { orgId: ids.ORG });
    let e = await pendingFor();
    expect(e.state).toBe('pending');
    expect(e.attempts).toBe(1);
    // next_attempt_at = now + 30s × 2^attempts (SPEC 4.4)
    expect(new Date(e.next_attempt_at).getTime()).toBe(vn('2026-10-05T11:00').getTime() + 30_000);

    for (let i = 1; i < MAX_EFFECT_ATTEMPTS; i++) {
      const now = new Date(e.next_attempt_at);
      setFakeNow(now);
      await runWorkerTick({ push }, { orgId: ids.ORG });
      e = await pendingFor();
      if (e.state === 'pending') expect(new Date(e.next_attempt_at).getTime() - now.getTime()).toBe(30_000 * 2 ** i);
    }
    expect(e.state).toBe('dead');
    expect(e.attempts).toBe(MAX_EFFECT_ATTEMPTS);
    const told = await withOrg(ids.ORG, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from notifications where user_id = ${ids.users.U_IT} and payload->>'type' = 'effect_dead'`));
    expect(Number(told.rows[0]!.n)).toBe(1);
    push.failNext = 0;
  });
});
