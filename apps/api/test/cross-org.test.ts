import { Scenario, closeDb, getDb, setFakeNow, sql, type SeedIds } from '@mihato/backend';
import { newId, type RunDetail } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Test chéo tổ chức (SPEC 11.3, 13.8): người của tổ chức A gọi từng endpoint với id của tổ chức B,
 * kết quả luôn là 404 và không dòng nào của B bị đổi. RLS chặn ngay cả khi mã ứng dụng viết sai.
 */
let app: FastifyInstance;
let a: SeedIds;
let b: SeedIds;
let callA: Caller;
let runB: RunDetail;

beforeAll(async () => {
  a = await freshOrg('xa');
  b = await freshOrg('xb');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  callA = callerFor(app, a);
  const sb = new Scenario(b);
  await sb.at(new Date('2026-10-02T02:00:00Z'));
  runB = await sb.start('U_ADMIN', { title: 'Lượt chạy của tổ chức B', delegation: 'Đoàn B', visitDate: '2026-10-15' });
  setFakeNow(null);
});
afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await closeDb();
});

describe('cô lập dữ liệu giữa hai tổ chức', () => {
  it('đọc bằng id của tổ chức khác luôn là 404', async () => {
    const stepB = runB.steps[0]!.id;
    const gets = [
      `/v1/runs/${runB.id}`,
      `/v1/runs/${runB.id}/events`,
      `/v1/steps/${stepB}`,
      `/v1/templates/${b.TEMPLATE_DON_DOAN}`,
      `/v1/templates/${b.TEMPLATE_DON_DOAN}/versions/1`,
      `/v1/users/${b.users.U_LAN}`,
    ];
    for (const url of gets) {
      const who = url.startsWith('/v1/users') ? 'U_IT' : url.startsWith('/v1/templates') ? 'U_DESIGNER' : 'U_ADMIN';
      const res = await callA<{ code: string }>(who, 'GET', url);
      expect(res.status, url).toBe(404);
    }
  });

  it('ghi lên id của tổ chức khác luôn là 404 và không đổi dòng nào', async () => {
    const stepB = runB.steps.find((s) => s.state === 'ready')!.id;
    const before = await getDb().execute<{ n: string }>(sql`select 1 as n`);
    expect(before.rows).toHaveLength(1);
    const writes: [string, string, unknown][] = [
      ['U_ADMIN', `/v1/steps/${stepB}/reassign`, { toUserId: a.users.U_LAN, reason: 'thử chéo tổ chức' }],
      ['U_ADMIN', `/v1/steps/${stepB}/extend`, { newDueAt: '2026-12-01T10:00:00.000Z', reason: 'thử' }],
      ['U_ADMIN', `/v1/steps/${stepB}/skip`, { reason: 'thử' }],
      ['U_LAN', `/v1/steps/${stepB}/complete`, {}],
      ['U_ADMIN', `/v1/runs/${runB.id}/cancel`, { reason: 'thử', confirmTitle: runB.title }],
      ['U_ADMIN', `/v1/runs`, { templateId: b.TEMPLATE_DON_DOAN, title: 'x', inputs: { delegation: 'x', visitDate: '2026-10-15' } }],
    ];
    for (const [who, url, body] of writes) {
      const res = await callA<{ code: string }>(who as 'U_ADMIN', 'POST', url, body);
      expect(res.status, url).toBe(404);
    }
    const sb = new Scenario(b);
    const after = await sb.run(runB.id);
    expect(after.version).toBe(runB.version);
    expect(after.state).toBe('running');
  });

  it('id người của tổ chức khác đặt trong thân yêu cầu bị từ chối (khoá ngoại không đi qua RLS)', async () => {
    const sa = new Scenario(a);
    await sa.at(new Date('2026-10-02T02:00:00Z'));
    const runA = await sa.start('U_ADMIN', { title: 'Lượt chạy của tổ chức A', delegation: 'Đoàn A', visitDate: '2026-10-15' });
    setFakeNow(null);
    const stepA = runA.steps.find((s) => s.state === 'ready')!;
    const reassign = await callA<{ code: string }>('U_ADMIN', 'POST', `/v1/steps/${stepA.id}/reassign`, { toUserId: b.users.U_LAN, reason: 'thử giao cho người tổ chức khác' });
    expect([404, 422]).toContain(reassign.status);
    const override = await callA<{ code: string }>('U_ADMIN', 'POST', '/v1/runs', {
      templateId: a.TEMPLATE_DON_DOAN,
      title: 'Thử ghi đè người nhận',
      inputs: { delegation: 'x', visitDate: '2026-10-15' },
      assigneeOverrides: { s1: b.users.U_LAN },
    });
    if (override.status === 201) {
      const created = override.body as unknown as RunDetail;
      expect(created.steps.find((s) => s.nodeId === 's1')!.assignee?.id).not.toBe(b.users.U_LAN);
    } else {
      expect([404, 422]).toContain(override.status);
    }
    const after = await sa.step(runA.id, stepA.nodeId);
    expect(after.assignee?.id).toBe(stepA.assignee?.id);
    const delegation = await callA<{ code: string }>('U_IT', 'POST', '/v1/delegations', {
      fromUserId: a.users.U_HUY,
      toUserId: b.users.U_HUY,
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-11-01T00:00:00.000Z',
    });
    expect([404, 422]).toContain(delegation.status);
  });

  it('danh sách không bao giờ lẫn dữ liệu của tổ chức khác', async () => {
    const runs = await callA<{ items: { id: string }[] }>('U_ADMIN', 'GET', '/v1/runs');
    expect(runs.body.items.map((r) => r.id)).not.toContain(runB.id);
    const people = await callA<{ items: { id: string }[] }>('U_ADMIN', 'GET', '/v1/people?q=Lan');
    const idsOfB = new Set(Object.values(b.users));
    expect(people.body.items.some((p) => idsOfB.has(p.id))).toBe(false);
    const nudge = await callA<{ code: string }>('U_ADMIN', 'POST', '/v1/nudges/drafts', { stepIds: [runB.steps[0]!.id] });
    expect(nudge.status).toBe(404);
  });

  it('truy vấn quên đặt tổ chức không thấy dòng nào (an toàn theo mặc định)', async () => {
    const res = await getDb().execute<{ n: string }>(sql`select count(*) as n from process_runs`);
    expect(Number(res.rows[0]!.n)).toBe(0);
    const users = await getDb().execute<{ n: string }>(sql`select count(*) as n from users`);
    expect(Number(users.rows[0]!.n)).toBe(0);
  });

  it('phiên của tổ chức A không dùng được với mã tổ chức B trong token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `mihato_session=${b.ORG}.${newId()}` } });
    expect(res.statusCode).toBe(401);
  });
});
