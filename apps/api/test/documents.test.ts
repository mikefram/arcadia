import { closeDb, withOrg, type SeedIds } from '@mihato/backend';
import type { FileView, RegisterView, RunDetail, StepResult, TemplateDetail, TemplateSummary } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, rawCallerFor, type Caller } from './helpers';

/**
 * Tệp đính kèm, sổ văn bản, xuất tệp tổng hợp và quyền khởi chạy qua HTTP thật (docs/DECISIONS.md, 06/10/2026):
 * kiểm phần nối giữa registrar (Zod, quyền, giới hạn thân yêu cầu, tiêu đề tải xuống) và service. Nghiệp vụ chi tiết ở packages/backend/test.
 */
let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;
let raw: ReturnType<typeof rawCallerFor>;

beforeAll(async () => {
  ids = await freshOrg('docs');
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
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const edge = (from: string, to: string) => ({ id: `${from}>${to}`, from, to });

async function publishAs(who: 'U_DESIGNER' | 'U_CHAIRMAN', name: string, def: Record<string, unknown>): Promise<string> {
  const created = await call<TemplateDetail>(who, 'POST', '/v1/templates', { name, definition: { schemaVersion: 1, name, ...def } });
  expect(created.status).toBe(201);
  const published = await call<{ version: number }>(who, 'POST', `/v1/templates/${created.body.id}/publish`);
  expect(published.status).toBe(200);
  return created.body.id;
}

const upload = (who: 'U_ADMIN' | 'U_LAN' | 'U_TUAN' | 'U_CHAIRMAN', name: string, data: Buffer = PDF) => call<FileView>(who, 'POST', '/v1/files', { name, data: data.toString('base64') });

describe('tải tệp lên và xuống', () => {
  it('cần đăng nhập; tải lên trả tệp chờ gắn; loại tệp lạ và nội dung giả bị 422', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/files', payload: { name: 'a.pdf', data: 'AAAA' } })).statusCode).toBe(401);
    const ok = await upload('U_ADMIN', 'cong-van.pdf');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'cong-van.pdf', mime: 'application/pdf', status: 'pending', compiled: false });
    const exe = await call<Problem>('U_ADMIN', 'POST', '/v1/files', { name: 'x.exe', data: Buffer.from('MZ').toString('base64') });
    expect(exe.status).toBe(422);
    expect(exe.body.errors?.[0]?.code).toBe('file_type_not_allowed');
    const fake = await call<Problem>('U_ADMIN', 'POST', '/v1/files', { name: 'gia.pdf', data: Buffer.from('không phải pdf').toString('base64') });
    expect(fake.body.errors?.[0]?.code).toBe('file_content_mismatch');
    const empty = await call<Problem>('U_ADMIN', 'POST', '/v1/files', { name: 'x.pdf', data: '' });
    expect(empty.status).toBe(422);
  });

  it('thân yêu cầu quá giới hạn (hơn 20 MB tệp) bị chặn trước khi vào service', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(21 * 1024 * 1024)]);
    const res = await upload('U_ADMIN', 'qua-lon.pdf', big);
    expect([413, 422]).toContain(res.status);
  });

  it('tải xuống: nội dung nguyên vẹn, tên có dấu trong tiêu đề, không cho trình duyệt đoán loại; người ngoài 404', async () => {
    const f = await upload('U_ADMIN', 'Công văn số 12.pdf');
    const mine = await raw('U_ADMIN', 'GET', `/v1/files/${f.body.id}/content`);
    expect(mine.status).toBe(200);
    expect(mine.rawBody.equals(PDF)).toBe(true);
    expect(mine.headers['content-type']).toBe('application/pdf');
    expect(mine.headers['x-content-type-options']).toBe('nosniff');
    expect(String(mine.headers['content-disposition'])).toContain(`filename*=UTF-8''${encodeURIComponent('Công văn số 12.pdf')}`);
    expect(String(mine.headers['cache-control'])).toContain('no-store');
    expect((await raw('U_LAN', 'GET', `/v1/files/${f.body.id}/content`)).status).toBe(404);
  });

  it('xoá tệp chờ gắn: chỉ người tải', async () => {
    const f = await upload('U_ADMIN', 'xoa.pdf');
    expect((await call('U_LAN', 'DELETE', `/v1/files/${f.body.id}`)).status).toBe(404);
    expect((await call('U_ADMIN', 'DELETE', `/v1/files/${f.body.id}`)).status).toBe(200);
    expect((await raw('U_ADMIN', 'GET', `/v1/files/${f.body.id}/content`)).status).toBe(404);
  });
});

describe('văn bản đến: vào sổ, cấp số, đính tệp, Giám đốc nhận', () => {
  let templateId: string;
  beforeAll(async () => {
    const reg = await call<RegisterView>('U_IT', 'PUT', '/v1/registers/VBDEN', {
      name: 'Sổ văn bản đến',
      direction: 'incoming',
      pattern: '{seq:4}',
      columns: [{ key: 'noiGui', label: 'Nơi gửi' }, { key: 'mucKhan', label: 'Mức khẩn' }],
    });
    expect(reg.status).toBe(200);
    templateId = await publishAs('U_DESIGNER', 'Văn bản đến', {
      inputs: [
        { key: 'soDen', label: 'Số đến', type: 'autonumber', register: 'VBDEN' },
        { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
        { key: 'noiGui', label: 'Nơi gửi', type: 'text', required: true },
        { key: 'mucKhan', label: 'Mức khẩn', type: 'select', required: true, options: [{ value: 'thuong', label: 'Thường' }, { value: 'khan', label: 'Khẩn' }] },
        { key: 'tep', label: 'Bản scan văn bản', type: 'file', multiple: true, required: true },
      ],
      starters: [{ kind: 'role', role: 'office_admin' }],
      nodes: [{ id: 'start', type: 'start', label: 'Bắt đầu' }, { id: 'xem', type: 'task', label: 'Xem', title: 'Xem và cho ý kiến chỉ đạo', assignee: { kind: 'role', role: 'director' }, due: DUE }, { id: 'end', type: 'end', label: 'Hoàn tất' }],
      edges: [edge('start', 'xem'), edge('xem', 'end')],
    });
  });

  it('chỉ Văn phòng (văn thư) khởi chạy được; nhân viên bị 403; danh sách mẫu nói đúng ai khởi chạy được', async () => {
    const f = await upload('U_ADMIN', 'cv-so-45.pdf');
    const body = { templateId, title: 'Công văn số 45 của Sở', inputs: { trichYeu: 'V/v kiểm tra', noiGui: 'Sở Xây dựng', mucKhan: 'khan', tep: [f.body.id] } };
    expect((await call('U_LAN', 'POST', '/v1/runs', body)).status).toBe(403);
    const run = await call<RunDetail>('U_ADMIN', 'POST', '/v1/runs', body);
    expect(run.status).toBe(201);
    expect(run.body.inputs['soDen']).toBe('0001');
    expect(run.body.files?.map((x) => x.name)).toEqual(['cv-so-45.pdf']);
    expect(run.body.steps.find((s) => s.nodeId === 'xem')).toMatchObject({ state: 'ready', assignee: { id: ids.users.U_DIRECTOR } });

    const list = async (who: 'U_ADMIN' | 'U_LAN') => (await call<{ items: TemplateSummary[] }>(who, 'GET', '/v1/templates')).body.items.find((t) => t.id === templateId);
    expect((await list('U_ADMIN'))?.canStart).toBe(true);
    // Nhân viên không có quyền nào về mẫu: vào được danh sách nhưng chỉ thấy mẫu mình khởi chạy được, và "Văn bản đến" chỉ dành cho Văn phòng.
    const asStaff = await call<{ items: TemplateSummary[] }>('U_LAN', 'GET', '/v1/templates');
    expect(asStaff.status).toBe(200);
    expect(asStaff.body.items.map((t) => t.id)).not.toContain(templateId);
    expect((await call('U_LAN', 'GET', `/v1/templates/${templateId}`)).status).toBe(404);
    const asDirector = await call<{ items: TemplateSummary[] }>('U_DIRECTOR', 'GET', '/v1/templates');
    expect(asDirector.body.items.find((t) => t.id === templateId)).toMatchObject({ canStart: false, category: 'general' });
  });

  it('Giám đốc tải được bản scan; nhân viên không liên quan thì không', async () => {
    const f = await upload('U_ADMIN', 'cv-so-46.pdf');
    const run = await call<RunDetail>('U_ADMIN', 'POST', '/v1/runs', { templateId, title: 'Công văn 46', inputs: { trichYeu: 'x', noiGui: 'Sở', mucKhan: 'thuong', tep: [f.body.id] } });
    expect((await raw('U_DIRECTOR', 'GET', `/v1/files/${f.body.id}/content`)).status).toBe(200);
    expect((await raw('U_LAN', 'GET', `/v1/files/${f.body.id}/content`)).status).toBe(404);
    const files = await call<{ items: FileView[] }>('U_DIRECTOR', 'GET', `/v1/runs/${run.body.id}/files`);
    expect(files.body.items.map((x) => x.name)).toEqual(['cv-so-46.pdf']);
    expect((await call('U_LAN', 'GET', `/v1/runs/${run.body.id}/files`)).status).toBe(404);
  });

  it('sổ văn bản: Văn phòng và lãnh đạo xem được; nhân viên 403; chỉ quản trị cấu hình', async () => {
    const entries = await call<{ items: { number: string; subject: string; values: Record<string, unknown> }[] }>('U_DIRECTOR', 'GET', '/v1/registers/VBDEN/entries?limit=10');
    expect(entries.status).toBe(200);
    expect(entries.body.items.length).toBeGreaterThanOrEqual(2);
    expect(entries.body.items.at(-1)).toMatchObject({ number: '0001', subject: 'V/v kiểm tra', values: { noiGui: 'Sở Xây dựng', mucKhan: 'khan', __nhan: { mucKhan: 'Khẩn' } } });
    expect((await call('U_ADMIN', 'GET', '/v1/registers/VBDEN/entries')).status).toBe(200);
    expect((await call('U_LAN', 'GET', '/v1/registers/VBDEN/entries')).status).toBe(403);
    expect((await call('U_LAN', 'GET', '/v1/registers')).status).toBe(403);
    expect((await call('U_ADMIN', 'PUT', '/v1/registers/VBDEN', { name: 'x', direction: 'incoming', pattern: '{seq}' })).status).toBe(403);
    expect((await call<Problem>('U_IT', 'PUT', '/v1/registers/VBDEN', { name: 'x', direction: 'incoming', pattern: 'sai' })).status).toBe(422);
    expect((await call('U_ADMIN', 'GET', '/v1/registers/KHONGCO/entries')).status).toBe(404);
    const list = await call<{ items: RegisterView[] }>('U_IT', 'GET', '/v1/registers');
    expect(list.body.items.find((r) => r.code === 'VBDEN')).toMatchObject({ entryCount: 2, nextNumber: '0003' });
  });
});

describe('văn bản đi qua HTTP: xuất tệp Word từ phần của các đơn vị', () => {
  it('nhân viên soạn, hai người góp nội dung, người soạn xuất tệp rồi mới báo xong được', async () => {
    const templateId = await publishAs('U_DESIGNER', 'Văn bản đi', {
      inputs: [
        { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
        { key: 'phoiHop', label: 'Đơn vị phối hợp', type: 'users', required: true },
      ],
      starters: [{ kind: 'everyone' }],
      nodes: [
        { id: 'start', type: 'start', label: 'Bắt đầu' },
        {
          id: 'gop',
          type: 'approval',
          label: 'Góp nội dung',
          title: 'Góp nội dung',
          action: 'contribute',
          approvers: [{ kind: 'form_field', field: 'phoiHop' }],
          mode: 'all',
          due: DUE,
          form: [{ key: 'noiDung', label: 'Nội dung', type: 'longtext', required: true }],
        },
        {
          id: 'tonghop',
          type: 'task',
          label: 'Tổng hợp',
          title: 'Tổng hợp',
          assignee: { kind: 'initiator' },
          due: DUE,
          compile: { layout: 'official', title: '{trichYeu}', required: true, sections: [{ heading: 'Nội dung', ref: 'responses.gop.noiDung' }] },
        },
        { id: 'end', type: 'end', label: 'Hoàn tất' },
      ],
      edges: [{ id: 'e1', from: 'start', to: 'gop' }, { id: 'e2', from: 'gop', to: 'tonghop', outcome: 'approved' }, { id: 'e3', from: 'tonghop', to: 'end' }],
    });
    // Nhân viên không có quyền xem mẫu nhưng khởi chạy được mẫu này (mọi cán bộ): thấy mẫu trong danh sách, mở được biểu mẫu khởi chạy.
    const mine = await call<{ items: TemplateSummary[] }>('U_LAN', 'GET', '/v1/templates');
    expect(mine.body.items.find((t) => t.id === templateId)).toMatchObject({ canStart: true, hasDraft: false });
    const detail = await call<TemplateDetail>('U_LAN', 'GET', `/v1/templates/${templateId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.draft).toBeNull();
    expect((await call('U_LAN', 'GET', `/v1/templates/${templateId}/versions/1`)).status).toBe(200);
    const run = await call<RunDetail>('U_LAN', 'POST', '/v1/runs', { templateId, title: 'Báo cáo quý', inputs: { trichYeu: 'Báo cáo quý IV', phoiHop: [ids.users.U_TUAN, ids.users.U_PHUONG] } });
    expect(run.status).toBe(201);
    const gop = run.body.steps.find((s) => s.nodeId === 'gop')!;
    expect(gop.allowedActions).not.toContain('approve'); // Lan là người soạn, không phải người góp
    for (const who of ['U_TUAN', 'U_PHUONG'] as const) {
      const sent = await call<StepResult>(who, 'POST', `/v1/steps/${gop.id}/approve`, { result: { noiDung: `Phần của ${who}` } });
      expect(sent.status).toBe(200);
    }
    const tong = (await call<RunDetail>('U_LAN', 'GET', `/v1/runs/${run.body.id}`)).body.steps.find((s) => s.nodeId === 'tonghop')!;
    expect(tong).toMatchObject({ state: 'ready', compile: { layout: 'official', required: true, hasFile: false } });

    const early = await call<Problem>('U_LAN', 'POST', `/v1/steps/${tong.id}/complete`, {});
    expect(early.status).toBe(422);
    expect(early.body.errors?.[0]?.code).toBe('compile_required');
    expect((await call('U_TUAN', 'POST', `/v1/steps/${tong.id}/compile`, {})).status).toBe(404);

    const made = await call<FileView & { pdf: FileView | null }>('U_LAN', 'POST', `/v1/steps/${tong.id}/compile`, {});
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ compiled: true, renditionOf: null, name: 'Báo cáo quý IV.docx', status: 'attached' });
    // Cùng lúc có bản PDF của tệp Word, tải được với đúng loại tệp và đúng tiêu đề an toàn; người ngoài lượt chạy thì không thấy.
    expect(made.body.pdf).toMatchObject({ compiled: true, renditionOf: made.body.id, name: 'Báo cáo quý IV.pdf', mime: 'application/pdf', status: 'attached' });
    const pdf = await raw('U_LAN', 'GET', `/v1/files/${made.body.pdf!.id}/content`);
    expect(pdf.status).toBe(200);
    expect(pdf.rawBody.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(String(pdf.headers['content-type'])).toContain('application/pdf');
    expect(String(pdf.headers['content-disposition'])).toContain('attachment');
    expect(String(pdf.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(pdf.headers['cache-control'])).toContain('no-store');
    expect((await raw('U_IT', 'GET', `/v1/files/${made.body.pdf!.id}/content`)).status).toBe(404);
    const files = await call<{ items: FileView[] }>('U_LAN', 'GET', `/v1/runs/${run.body.id}/files`);
    expect(files.body.items.filter((f) => f.compiled).map((f) => f.name).sort()).toEqual(['Báo cáo quý IV.docx', 'Báo cáo quý IV.pdf']);
    const download = await raw('U_LAN', 'GET', `/v1/files/${made.body.id}/content`);
    expect(download.status).toBe(200);
    expect(download.rawBody.subarray(0, 2).toString()).toBe('PK'); // docx là ZIP
    expect(String(download.headers['content-type'])).toContain('wordprocessingml');

    expect((await call('U_LAN', 'POST', `/v1/steps/${tong.id}/complete`, {})).status).toBe(200);
    expect((await call<RunDetail>('U_LAN', 'GET', `/v1/runs/${run.body.id}`)).body.state).toBe('completed');
  });
});

describe('sổ văn bản có tách theo tổ chức', () => {
  it('tổ chức khác không thấy sổ, dòng sổ hay tệp của tổ chức này', async () => {
    const otherIds = await freshOrg('docs-other');
    const otherCall = callerFor(app, otherIds);
    const list = await otherCall<{ items: RegisterView[] }>('U_IT', 'GET', '/v1/registers');
    expect(list.body.items).toEqual([]);
    expect((await otherCall('U_ADMIN', 'GET', '/v1/registers/VBDEN/entries')).status).toBe(404);
    const rows = await withOrg(otherIds.ORG, (tx) => tx.execute<{ n: number }>(`SELECT count(*)::int AS n FROM document_entries` as never));
    expect(rows.rows[0]!.n).toBe(0);
  });
});
