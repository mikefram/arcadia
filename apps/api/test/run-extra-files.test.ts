import { closeDb, type SeedIds } from '@mihato/backend';
import type { FileView, RunDetail, TemplateDetail } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, rawCallerFor, type Caller } from './helpers';

/** Đính thêm tài liệu vào lượt chạy đang chạy qua HTTP thật (docs/DECISIONS.md, 12/10/2026): quyền, trạng thái lượt chạy, và xem lại tệp đã đính. */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;
let raw: ReturnType<typeof rawCallerFor>;

beforeAll(async () => {
  ids = await freshOrg('extra-files');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
  raw = rawCallerFor(app, ids);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
type Problem = { code: string; errors?: { path: string; code: string }[] };
type Who = 'U_ADMIN' | 'U_LAN' | 'U_TUAN' | 'U_CHAIRMAN';
const upload = (who: Who, name = 'bo-sung.pdf') => call<FileView>(who, 'POST', '/v1/files', { name, data: PDF.toString('base64') });

async function newRun(): Promise<RunDetail> {
  const def = {
    schemaVersion: 1,
    name: 'Xử lý công văn',
    inputs: [{ key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true }],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 'xem', type: 'task', label: 'Xem', title: 'Xem công văn', assignee: { kind: 'user', userId: ids.users.U_LAN }, due: { anchor: 'activation', offset: { value: 3, unit: 'working_day' } } },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 'start>xem', from: 'start', to: 'xem' },
      { id: 'xem>end', from: 'xem', to: 'end' },
    ],
  };
  const created = await call<TemplateDetail>('U_DESIGNER', 'POST', '/v1/templates', { name: `Mẫu ${Math.random()}`, definition: def });
  expect(created.status).toBe(201);
  expect((await call('U_DESIGNER', 'POST', `/v1/templates/${created.body.id}/publish`)).status).toBe(200);
  const run = await call<RunDetail>('U_ADMIN', 'POST', '/v1/runs', { templateId: created.body.id, title: 'Công văn thử', inputs: { trichYeu: 'Thử' } });
  expect(run.status).toBe(201);
  return run.body;
}

describe('đính thêm tài liệu vào lượt chạy', () => {
  it('cần đăng nhập; người khởi chạy đính được; tệp hiện ở hồ sơ, tải được, nhận đúng loại để xem', async () => {
    const run = await newRun();
    expect((await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/files`, payload: { fileIds: [] } })).statusCode).toBe(401);

    const f = await upload('U_ADMIN', 'ban-scan-bo-sung.pdf');
    const added = await call<{ items: FileView[] }>('U_ADMIN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: [f.body.id] });
    expect(added.status).toBe(200);
    expect(added.body.items[0]).toMatchObject({ id: f.body.id, status: 'attached', runId: run.id, stepId: null, fieldKey: '__extra', mime: 'application/pdf' });

    const listed = await call<{ items: FileView[] }>('U_CHAIRMAN', 'GET', `/v1/runs/${run.id}/files`);
    expect(listed.body.items.map((x) => x.id)).toContain(f.body.id);

    // Trình xem lấy nội dung qua đúng đường tải xuống: người xem được lượt chạy thì xem được, nguyên vẹn.
    const content = await raw('U_CHAIRMAN', 'GET', `/v1/files/${f.body.id}/content`);
    expect(content.status).toBe(200);
    expect(content.rawBody.equals(PDF)).toBe(true);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
  });

  it('người giữ việc đính được; người không thấy lượt chạy 404; thân yêu cầu sai 422', async () => {
    const run = await newRun();
    const mine = await upload('U_LAN');
    expect((await call('U_LAN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: [mine.body.id] })).status).toBe(200);

    const other = await upload('U_TUAN');
    expect((await call('U_TUAN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: [other.body.id] })).status).toBe(404);

    const empty = await call<Problem>('U_ADMIN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: [] });
    expect(empty.status).toBe(422);
    const notId = await call<Problem>('U_ADMIN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: ['khong-phai-id'] });
    expect(notId.status).toBe(422);
  });

  it('không đính được tệp của người khác; lượt chạy đã huỷ thì 409', async () => {
    const run = await newRun();
    const theirs = await upload('U_ADMIN');
    const err = await call<Problem>('U_LAN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: [theirs.body.id] });
    expect(err.status).toBe(422);
    expect(err.body.errors).toEqual([{ path: 'body.fileIds', code: 'file_unavailable' }]);

    const cancelled = await call('U_ADMIN', 'POST', `/v1/runs/${run.id}/cancel`, { reason: 'Thử', confirmTitle: run.title });
    expect(cancelled.status).toBe(200);
    const f = await upload('U_ADMIN');
    expect((await call('U_ADMIN', 'POST', `/v1/runs/${run.id}/files`, { fileIds: [f.body.id] })).status).toBe(409);
  });
});
