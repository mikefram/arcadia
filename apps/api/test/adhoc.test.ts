import { closeDb, setFakeNow, type SeedIds } from '@mihato/backend';
import type { StepResult } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Việc ngoài quy trình qua API thật (docs/DECISIONS.md, 05/10/2026): quyền `task.assign`, khoá chống lặp, mẫu ẩn khỏi API mẫu,
 * danh sách người nhận khi giao lại, và đường vòng "giao lại để chọn người tuỳ ý" đã bị chặn với việc trong quy trình.
 */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;

beforeAll(async () => {
  ids = await freshOrg('adhoc');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
  setFakeNow(new Date('2026-10-05T02:00:00Z')); // Thứ Hai 09:00 giờ Việt Nam
});
afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await closeDb();
});

const body = (to: string, over: Record<string, unknown> = {}) => ({ title: 'Gửi báo giá cho công ty Sakura', assigneeId: to, dueDate: '2026-10-09', ...over });

describe('POST /v1/tasks', () => {
  it('chỉ nhóm điều phối giao được; nhân viên, người vẽ quy trình, quản trị hệ thống bị 403', async () => {
    for (const who of ['U_LAN', 'U_DESIGNER', 'U_IT'] as const) {
      const res = await call(who, 'POST', '/v1/tasks', body(ids.users.U_HUNG));
      expect(res.status, who).toBe(403);
    }
    for (const who of ['U_ADMIN', 'U_CHAIRMAN', 'U_DIRECTOR', 'U_HUY'] as const) {
      const res = await call<StepResult>(who, 'POST', '/v1/tasks', body(ids.users.U_HUNG, { title: `Việc của ${who}` }));
      expect(res.status, who).toBe(201);
      expect(res.body.step).toMatchObject({ adhoc: true, state: 'ready', assignee: { id: ids.users.U_HUNG } });
    }
  });

  it('gửi lại cùng Idempotency-Key trả đúng việc đã tạo, không tạo thêm', async () => {
    const key = crypto.randomUUID();
    const first = await call<StepResult>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_LAN, { title: 'Việc gửi hai lần' }), { 'idempotency-key': key });
    const again = await call<StepResult>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_LAN, { title: 'Việc gửi hai lần' }), { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(again.body.step.id).toBe(first.body.step.id);
    const runs = await call<{ items: { title: string }[] }>('U_ADMIN', 'GET', '/v1/runs?adhoc=true&q=Việc gửi hai lần');
    expect(runs.body.items.filter((r) => r.title === 'Việc gửi hai lần')).toHaveLength(1);
  });

  it('ô sai trả 422 kèm mã từng ô', async () => {
    const self = await call<{ code: string; errors: { path: string; code: string }[] }>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_ADMIN));
    expect(self.status).toBe(422);
    expect(self.body.errors).toEqual([{ path: 'body.assigneeId', code: 'assignee_is_self' }]);
    const past = await call<{ errors: { path: string; code: string }[] }>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_LAN, { dueDate: '2026-10-01' }));
    expect(past.status).toBe(422);
    expect(past.body.errors).toEqual([{ path: 'body.dueDate', code: 'date_in_past' }]);
    const bad = await call('U_ADMIN', 'POST', '/v1/tasks', { title: '', assigneeId: 'khong-phai-id', dueDate: 'mai' });
    expect(bad.status).toBe(422);
  });

  it('người nhận của tổ chức khác không giao được (RLS: coi như không có người này)', async () => {
    const other = await freshOrg('adhoc-khac');
    const res = await call<{ errors: { path: string; code: string }[] }>('U_ADMIN', 'POST', '/v1/tasks', body(other.users.U_LAN));
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ path: 'body.assigneeId', code: 'unknown_user' }]);
  });
});

describe('mẫu một việc là mẫu ẩn', () => {
  it('không có trong GET /v1/templates và không đọc/chạy lại được qua id của nó', async () => {
    const made = await call<StepResult>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_HUNG, { title: 'Việc để thử mẫu ẩn' }));
    const run = await call<{ templateId: string; adhoc: boolean }>('U_ADMIN', 'GET', `/v1/runs/${made.body.run.id}`);
    expect(run.body.adhoc).toBe(true);
    const list = await call<{ items: { id: string; name: string }[] }>('U_DESIGNER', 'GET', '/v1/templates');
    expect(list.body.items.map((t) => t.id)).not.toContain(run.body.templateId);
    expect((await call('U_DESIGNER', 'GET', `/v1/templates/${run.body.templateId}`)).status).toBe(404);
    expect((await call('U_ADMIN', 'POST', '/v1/runs', { templateId: run.body.templateId, title: 'Chạy lại', inputs: { due: '2026-10-09' } })).status).toBe(404);
  });
});

describe('giao lại và danh sách người nhận', () => {
  it('việc trong quy trình: danh sách chỉ có người được bổ nhiệm; giao cho người khác bị 422 not_appointed', async () => {
    const started = await call<{ id: string; steps: { id: string; nodeId: string; assignee: { id: string } | null; state: string }[] }>('U_ADMIN', 'POST', '/v1/runs', {
      templateId: ids.TEMPLATE_DON_DOAN,
      title: 'Đón đoàn thử việc được bổ nhiệm',
      inputs: { delegation: 'Đoàn thử', visitDate: '2026-10-23' },
    });
    expect(started.status).toBe(201);
    const first = started.body.steps.find((s) => s.state === 'ready')!;
    const who = await call<{ anyone: boolean; people: { id: string }[] }>('U_ADMIN', 'POST', '/v1/steps/assignees', { stepIds: [first.id] });
    expect(who.status).toBe(200);
    expect(who.body.anyone).toBe(false);
    expect(who.body.people.map((p) => p.id)).toEqual([first.assignee!.id]);

    const other = first.assignee!.id === ids.users.U_HUNG ? ids.users.U_TUAN : ids.users.U_HUNG;
    const res = await call<{ errors: { path: string; code: string }[] }>('U_ADMIN', 'POST', `/v1/steps/${first.id}/reassign`, { toUserId: other, reason: 'thử đường vòng' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ path: 'body.toUserId', code: 'not_appointed' }]);
  });

  it('việc ngoài quy trình: ai còn hoạt động cũng nhận được', async () => {
    const made = await call<StepResult>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_HUNG, { title: 'Việc giao lại tự do' }));
    const who = await call<{ anyone: boolean }>('U_ADMIN', 'POST', '/v1/steps/assignees', { stepIds: [made.body.step.id] });
    expect(who.body.anyone).toBe(true);
    const moved = await call<StepResult>('U_ADMIN', 'POST', `/v1/steps/${made.body.step.id}/reassign`, { toUserId: ids.users.U_NGOCANH, reason: 'đổi người' });
    expect(moved.status).toBe(200);
    expect(moved.body.step.assignee!.id).toBe(ids.users.U_NGOCANH);
  });

  it('người ngoài tầm nhìn của việc hỏi danh sách thì 404', async () => {
    const made = await call<StepResult>('U_ADMIN', 'POST', '/v1/tasks', body(ids.users.U_HUNG, { title: 'Việc riêng của Hùng' }));
    const res = await call('U_PHUONG', 'POST', '/v1/steps/assignees', { stepIds: [made.body.step.id] });
    expect(res.status).toBe(404);
  });
});
