import { closeDb, type SeedIds } from '@mihato/backend';
import { newId, type RunDetail, type RunShares, type RunSummary, type StepComment, type StepCommentList, type StepResult, type TemplateDetail } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/** Chia sẻ và bình luận qua HTTP thật (docs/DECISIONS.md, 07/10/2026): nối registrar, Zod, Idempotency-Key và service. */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;
let secret: RunDetail;
let normal: RunDetail;

type Problem = { code: string; errors?: { path: string; code: string }[] };
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const OPTIONS = [{ value: 'thuong', label: 'Thường' }, { value: 'mat', label: 'Mật' }];

beforeAll(async () => {
  ids = await freshOrg('shares');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
  const def = {
    schemaVersion: 1,
    name: 'Văn bản thử HTTP',
    starters: [{ kind: 'everyone' }],
    inputs: [
      { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
      { key: 'mucMat', label: 'Mức mật', type: 'select', required: true, options: OPTIONS },
    ],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 'xem', type: 'task', label: 'Xem', title: 'Xem văn bản', assignee: { kind: 'user', userId: ids.users.U_TUAN }, due: DUE },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 's>x', from: 'start', to: 'xem' },
      { id: 'x>e', from: 'xem', to: 'end' },
    ],
  };
  const created = await call<TemplateDetail>('U_DESIGNER', 'POST', '/v1/templates', { name: def.name, definition: def });
  expect(created.status).toBe(201);
  expect((await call('U_DESIGNER', 'POST', `/v1/templates/${created.body.id}/publish`)).status).toBe(200);
  const mk = async (title: string, mucMat: string) => {
    const r = await call<RunDetail>('U_LAN', 'POST', '/v1/runs', { templateId: created.body.id, title, inputs: { trichYeu: `Trích yếu ${title}`, mucMat } });
    expect(r.status).toBe(201);
    return r.body;
  };
  secret = await mk('Văn bản mật HTTP', 'mat');
  normal = await mk('Văn bản thường HTTP', 'thuong');
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('văn bản mật qua HTTP', () => {
  it('khởi chạy trả mức mật; Chủ tịch (có run.view_all) không thấy lượt mật ở chi tiết, danh sách, chia sẻ', async () => {
    expect(secret.confidentiality).toBe('restricted');
    expect(normal.confidentiality).toBe('normal');
    expect((await call('U_CHAIRMAN', 'GET', `/v1/runs/${secret.id}`)).status).toBe(404);
    expect((await call('U_CHAIRMAN', 'GET', `/v1/runs/${normal.id}`)).status).toBe(200);
    const list = await call<{ items: RunSummary[] }>('U_CHAIRMAN', 'GET', '/v1/runs?limit=100');
    expect(list.body.items.some((r) => r.id === secret.id)).toBe(false);
    expect(list.body.items.some((r) => r.id === normal.id)).toBe(true);
    expect((await call('U_CHAIRMAN', 'GET', `/v1/runs/${secret.id}/shares`)).status).toBe(404);
    expect((await call('U_CHAIRMAN', 'GET', `/v1/steps/${secret.steps.find((s) => s.nodeId === 'xem')!.id}`)).status).toBe(404);
    expect((await call('U_TUAN', 'GET', `/v1/runs/${secret.id}`)).status).toBe(200);
    expect((await call('U_DIRECTOR', 'GET', `/v1/runs/${secret.id}`)).status).toBe(404);
  });

  it('chủ sở hữu chia sẻ cho Chủ tịch mức xem: Chủ tịch đọc được nhưng không bình luận, không chia sẻ tiếp; gỡ thì lại 404', async () => {
    const stepId = secret.steps.find((s) => s.nodeId === 'xem')!.id;
    const put = await call<RunShares>('U_LAN', 'PUT', `/v1/runs/${secret.id}/shares/${ids.users.U_CHAIRMAN}`, { role: 'viewer' });
    expect(put.status).toBe(200);
    expect(put.body.shares).toHaveLength(1);
    expect(put.body.canManage).toBe(true);
    expect((await call('U_CHAIRMAN', 'GET', `/v1/runs/${secret.id}`)).status).toBe(200);
    const cantComment = await call<Problem>('U_CHAIRMAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'Tôi đã xem.' });
    expect(cantComment.status).toBe(403);
    // Chủ tịch có quyền run.share mặc định nên chia sẻ tiếp được; Phó giám đốc (có run.view_all nhưng không có run.share) được chia sẻ mức xem thì không.
    expect((await call('U_CHAIRMAN', 'PUT', `/v1/runs/${secret.id}/shares/${ids.users.U_HUY}`, { role: 'viewer' })).status).toBe(200);
    expect((await call('U_HUY', 'GET', `/v1/runs/${secret.id}`)).status).toBe(200);
    expect((await call('U_HUY', 'PUT', `/v1/runs/${secret.id}/shares/${ids.users.U_DIRECTOR}`, { role: 'viewer' })).status).toBe(403);
    expect((await call('U_DIRECTOR', 'GET', `/v1/runs/${secret.id}`)).status).toBe(404);
    expect((await call('U_LAN', 'DELETE', `/v1/runs/${secret.id}/shares/${ids.users.U_HUY}`)).status).toBe(200);
    // Chuyển lên mức bình luận.
    expect((await call('U_LAN', 'PUT', `/v1/runs/${secret.id}/shares/${ids.users.U_CHAIRMAN}`, { role: 'commenter' })).status).toBe(200);
    expect((await call<StepComment>('U_CHAIRMAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'Ý kiến của Chủ tịch.' })).status).toBe(201);
    const del = await call<RunShares>('U_LAN', 'DELETE', `/v1/runs/${secret.id}/shares/${ids.users.U_CHAIRMAN}`);
    expect(del.status).toBe(200);
    expect(del.body.shares).toHaveLength(0);
    expect((await call('U_CHAIRMAN', 'GET', `/v1/runs/${secret.id}`)).status).toBe(404);
  });

  it('mức lạ là 422; không gỡ được người tham gia (422); gỡ người không có là 404', async () => {
    const bad = await call<Problem>('U_LAN', 'PUT', `/v1/runs/${secret.id}/shares/${ids.users.U_CHAIRMAN}`, { role: 'editor' });
    expect(bad.status).toBe(422);
    const keep = await call<Problem>('U_LAN', 'DELETE', `/v1/runs/${secret.id}/shares/${ids.users.U_TUAN}`);
    expect(keep.status).toBe(422);
    expect(keep.body.errors?.[0]?.code).toBe('cannot_remove_participant');
    expect((await call('U_LAN', 'DELETE', `/v1/runs/${secret.id}/shares/${ids.users.U_HUNG}`)).status).toBe(404);
    const shares = await call<RunShares>('U_TUAN', 'GET', `/v1/runs/${secret.id}/shares`);
    expect(shares.status).toBe(200);
    expect(shares.body.fixed.map((f) => f.role).sort()).toEqual(['owner', 'participant']);
    expect(shares.body.canManage).toBe(false);
  });
});

describe('bình luận qua HTTP', () => {
  it('viết (201), gửi lại cùng Idempotency-Key không tạo bản thứ hai, đọc, đếm, xoá chỉ tác giả', async () => {
    const stepId = normal.steps.find((s) => s.nodeId === 'xem')!.id;
    const key = newId();
    const first = await call<StepComment>('U_TUAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'Đã nhận văn bản.' }, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ body: 'Đã nhận văn bản.', mine: true, stepId });
    const again = await call<StepComment>('U_TUAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'Đã nhận văn bản.' }, { 'idempotency-key': key });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const list = await call<StepCommentList>('U_LAN', 'GET', `/v1/steps/${stepId}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((c) => c.body)).toEqual(['Đã nhận văn bản.']);
    expect(list.body.items[0]!.mine).toBe(false);
    expect(list.body.canComment).toBe(true);
    const detail = await call<StepResult['step'] & { commentCount: number }>('U_TUAN', 'GET', `/v1/steps/${stepId}`);
    expect(detail.body.commentCount).toBe(1);
    expect((await call('U_LAN', 'DELETE', `/v1/steps/${stepId}/comments/${first.body.id}`)).status).toBe(403);
    expect((await call('U_TUAN', 'DELETE', `/v1/steps/${stepId}/comments/${first.body.id}`)).status).toBe(200);
    expect((await call<StepCommentList>('U_LAN', 'GET', `/v1/steps/${stepId}/comments`)).body.items).toHaveLength(0);
  });

  it('nội dung rỗng hoặc quá 4000 ký tự là 422; con trỏ lạ là 422; người ngoài việc là 404; chưa đăng nhập là 401', async () => {
    const stepId = normal.steps.find((s) => s.nodeId === 'xem')!.id;
    expect((await call('U_TUAN', 'POST', `/v1/steps/${stepId}/comments`, { body: '' })).status).toBe(422);
    expect((await call('U_TUAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'x'.repeat(4001) })).status).toBe(422);
    expect((await call('U_TUAN', 'GET', `/v1/steps/${stepId}/comments?cursor=khong-hop-le`)).status).toBe(422);
    expect((await call('U_IT', 'GET', `/v1/steps/${stepId}/comments`)).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/steps/${stepId}/comments` })).statusCode).toBe(401);
  });
});

describe('dòng thời gian của lượt chạy qua HTTP (route không còn đòi run.view_all)', () => {
  it('người tham gia lượt (không có run.view_all) đọc được; người ngoài lượt thường và lượt mật đều 404; lượt mật chỉ mở cho người được chia sẻ', async () => {
    const events = await call<{ items: unknown[] }>('U_TUAN', 'GET', `/v1/runs/${normal.id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.items.length).toBeGreaterThan(0);
    // Nhân viên không tham gia lượt thường thì lượt đó không tồn tại với họ.
    expect((await call('U_PHUONG', 'GET', `/v1/runs/${normal.id}/events`)).status).toBe(404);
    // Lượt mật: Chủ tịch (có run.view_all) vẫn không đọc được dòng thời gian; người được chia sẻ thì đọc được.
    expect((await call('U_CHAIRMAN', 'GET', `/v1/runs/${secret.id}/events`)).status).toBe(404);
    expect((await call<RunShares>('U_LAN', 'PUT', `/v1/runs/${secret.id}/shares/${ids.users.U_PHUONG}`, { role: 'viewer' })).status).toBe(200);
    expect((await call('U_PHUONG', 'GET', `/v1/runs/${secret.id}/events`)).status).toBe(200);
    // Người chỉ được xem không tự gỡ mình được (không có quyền quản lý chia sẻ); chủ sở hữu gỡ.
    expect((await call('U_PHUONG', 'DELETE', `/v1/runs/${secret.id}/shares/${ids.users.U_PHUONG}`)).status).toBe(403);
    expect((await call('U_LAN', 'DELETE', `/v1/runs/${secret.id}/shares/${ids.users.U_PHUONG}`)).status).toBe(200);
    expect((await call('U_PHUONG', 'GET', `/v1/runs/${secret.id}/events`)).status).toBe(404);
  });
});
