import { closeDb, type SeedIds } from '@mihato/backend';
import type { FileView, RunDetail, StepComment, StepCommentList, TemplateDetail } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, rawCallerFor, type Caller } from './helpers';

/** Tệp đính kèm bình luận qua HTTP thật (docs/DECISIONS.md, 12/10/2026): gửi, đọc lại, tải xuống đúng loại, người ngoài 404, xoá cùng bình luận. */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;
let raw: ReturnType<typeof rawCallerFor>;

beforeAll(async () => {
  ids = await freshOrg('comment-files');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
  raw = rawCallerFor(app, ids);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
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


describe('tệp đính kèm bình luận', () => {
  it('gửi bình luận kèm tệp, đọc lại có tệp, người thấy việc tải được nguyên vẹn, người ngoài 404, xoá bình luận thì tệp 404', async () => {
    const run = await newRun();
    const stepId = run.steps.find((s) => s.nodeId === 'xem')!.id;
    const f = await upload('U_LAN', 'bien-ban.pdf');

    const sent = await call<StepComment>('U_LAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'Gửi biên bản.', fileIds: [f.body.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.files).toHaveLength(1);
    expect(sent.body.files[0]).toMatchObject({ id: f.body.id, name: 'bien-ban.pdf', mime: 'application/pdf', fieldKey: '__comment', status: 'attached' });

    const listed = await call<StepCommentList>('U_ADMIN', 'GET', `/v1/steps/${stepId}/comments`);
    expect(listed.body.items[0]!.files.map((x) => x.id)).toEqual([f.body.id]);

    const content = await raw('U_ADMIN', 'GET', `/v1/files/${f.body.id}/content`);
    expect(content.status).toBe(200);
    expect(content.rawBody.equals(PDF)).toBe(true);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect((await raw('U_TUAN', 'GET', `/v1/files/${f.body.id}/content`)).status).toBe(404);

    // Bình luận chỉ có tệp (không chữ) hợp lệ; không chữ không tệp thì 422; quá 5 tệp thì 422.
    const g = await upload('U_LAN', 'chi-co-tep.pdf');
    expect((await call('U_LAN', 'POST', `/v1/steps/${stepId}/comments`, { fileIds: [g.body.id] })).status).toBe(201);
    expect((await call('U_LAN', 'POST', `/v1/steps/${stepId}/comments`, { body: '', fileIds: [] })).status).toBe(422);
    expect((await call('U_LAN', 'POST', `/v1/steps/${stepId}/comments`, { body: 'x', fileIds: Array.from({ length: 6 }, () => f.body.id) })).status).toBe(422);

    expect((await call('U_LAN', 'DELETE', `/v1/steps/${stepId}/comments/${sent.body.id}`)).status).toBe(200);
    expect((await raw('U_ADMIN', 'GET', `/v1/files/${f.body.id}/content`)).status).toBe(404);
  });
});
