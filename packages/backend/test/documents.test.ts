import { newId, type FileView, type RunDetail, type StepCompileResponse, type StepView } from '@mihato/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { COMPILED_FIELD } from '../src/file-view';
import { compileStep } from '../src/services/compile';
import { downloadFile, listRunFiles, purgePendingFiles, removePendingFile, uploadFile } from '../src/services/files';
import { listEntries, listRegisters, upsertRegister } from '../src/services/registers';
import { actOnStep, getRun, getStepDetail, listActivity, listRunEvents, listSteps, startRun } from '../src/services/runs';
import { createTemplate, listTemplates, publishTemplate } from '../src/services/templates';
import { MemoryFileStorage, setFileStorage } from '../src/storage';
import { createTestOrg, type TestOrg } from '../src/testing';
import { expectApiError } from './helpers';
import { readPdf } from './support/pdf';
import { docxText } from './support/zip';

/**
 * Văn thư và chỉ thị (docs/DECISIONS.md, 06/10/2026): tệp đính kèm, sổ văn bản và cấp số, ai được khởi chạy, bước đóng góp,
 * và xuất tệp Word tổng hợp. Mỗi bài dùng sổ riêng để không giẫm lên nhau (các bài chạy cùng một tổ chức).
 */
let org: TestOrg;
const storage = new MemoryFileStorage();

beforeAll(async () => {
  setFileStorage(storage);
  org = await createTestOrg({ name: 'Công ty thử nghiệm VRG' });
});
afterAll(async () => {
  setFileStorage(null);
  setFakeNow(null);
  await closeDb();
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const b64 = (b: Buffer) => b.toString('base64');
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const START = { id: 'start', type: 'start', label: 'Bắt đầu' };
const END = { id: 'end', type: 'end', label: 'Hoàn tất' };
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ id: `${from}>${to}${extra['outcome'] ? `:${String(extra['outcome'])}` : ''}`, from, to, ...extra });

const designer = () => org.viewer('designer');
const upload = (who: Parameters<TestOrg['viewer']>[0], name = 'cong-van.pdf', data: Buffer = PDF) => org.run((tx, ctx) => uploadFile(tx, ctx, org.viewer(who), { name, data: b64(data) }));
const start = (who: Parameters<TestOrg['viewer']>[0], templateId: string, title: string, inputs: Record<string, unknown>, eventId = newId()) =>
  org.run((tx, ctx) => startRun(tx, ctx, org.viewer(who), { templateId, title, inputs }, eventId));
const act = (who: Parameters<TestOrg['viewer']>[0], stepId: string, input: Parameters<typeof actOnStep>[5]) => org.run((tx, ctx) => actOnStep(tx, ctx, org.viewer(who), stepId, newId(), input));
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;
const runOf = (who: Parameters<TestOrg['viewer']>[0], id: string) => org.run((tx, ctx) => getRun(tx, ctx, org.viewer(who), id));

async function publish(name: string, def: Record<string, unknown>, category?: 'directive' | 'incoming' | 'outgoing'): Promise<string> {
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, designer(), { name, description: null, category, definition: { schemaVersion: 1, name, ...def } as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, designer(), created.id));
  return created.id;
}

const register = (code: string, over: Partial<Parameters<typeof upsertRegister>[4]> = {}) =>
  org.run((tx, ctx) => upsertRegister(tx, ctx, org.viewer('itAdmin'), code, { name: `Sổ ${code}`, direction: 'incoming', pattern: '{seq:4}', resetPolicy: 'yearly', columns: [], ...over }));

// ───────────────────────── Tệp đính kèm ─────────────────────────

describe('tệp đính kèm', () => {
  let templateId: string;
  beforeAll(async () => {
    templateId = await publish('Nhận công văn', {
      inputs: [
        { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
        { key: 'tep', label: 'Bản scan', type: 'file', multiple: true, required: true },
      ],
      nodes: [START, { id: 'xem', type: 'task', label: 'Xem', title: 'Xem công văn', assignee: { kind: 'user', userId: org.users.director }, due: DUE }, END],
      edges: [edge('start', 'xem'), edge('xem', 'end')],
    });
  });

  it('tải lên: tệp chờ gắn chỉ người tải thấy và tải xuống được; người khác 404', async () => {
    const f = await upload('officeAdmin');
    expect(f).toMatchObject({ name: 'cong-van.pdf', mime: 'application/pdf', sizeBytes: PDF.length, status: 'pending', runId: null, compiled: false });
    const mine = await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('officeAdmin'), f.id));
    expect(mine.data.equals(PDF)).toBe(true);
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('director'), f.id)), 'not_found');
  });

  it('chỉ nhận loại tệp được phép, nội dung khớp phần mở rộng, không rỗng, không quá lớn, base64 hợp lệ', async () => {
    const bad = async (name: string, data: Buffer | string) => {
      const err = await org
        .run((tx, ctx) => uploadFile(tx, ctx, org.viewer('officeAdmin'), { name, data: typeof data === 'string' ? data : b64(data) }))
        .then(() => null, (e: { extra?: { errors?: { code: string }[] } }) => e.extra?.errors?.[0]?.code ?? 'other');
      return err;
    };
    expect(await bad('chay.exe', Buffer.from('MZ....'))).toBe('file_type_not_allowed');
    expect(await bad('khong-co-duoi', PDF)).toBe('file_type_not_allowed');
    expect(await bad('gia.pdf', Buffer.from('MZ này là chương trình, không phải PDF'))).toBe('file_content_mismatch');
    expect(await bad('rong.txt', Buffer.alloc(0))).toBe('file_empty');
    expect(await bad('x.pdf', '###')).toBe('invalid_base64');
    expect(await bad('lon.pdf', Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)]))).toBe('file_too_large');
    // Tên có đường dẫn bị cắt về tên tệp, ký tự lạ bị bỏ.
    const ok = await upload('officeAdmin', '..\\..\\etc/passwd.txt', Buffer.from('xin chào'));
    expect(ok.name).toBe('passwd.txt');
  });

  it('mỗi người chỉ giữ được một số tệp chờ gắn nhất định', async () => {
    const { MAX_PENDING_FILES_PER_USER } = await import('../src/services/files');
    const who = 'itAdmin' as const;
    const have = (await org.run((tx) => tx.select().from(schema.files).where(and(eq(schema.files.ownerUserId, org.users[who]), eq(schema.files.status, 'pending'))))).length;
    for (let i = have; i < MAX_PENDING_FILES_PER_USER; i++) await upload(who, `t${i}.txt`, Buffer.from('x'));
    const err = await upload(who, 'them.txt', Buffer.from('x')).then(() => null, (e: { extra?: { errors?: { code: string }[] } }) => e.extra?.errors?.[0]?.code);
    expect(err).toBe('too_many_pending_files');
    // Dọn thì lại tải lên được.
    await org.run((tx) => purgePendingFiles(tx, new Date(Date.now() + 25 * 3_600_000)));
    expect((await upload(who, 'sau-khi-don.txt', Buffer.from('x'))).status).toBe('pending');
  });

  it('gắn vào lượt chạy lúc khởi chạy: mọi người thấy lượt chạy đều tải được; người ngoài lượt chạy 404', async () => {
    const a = await upload('officeAdmin', 'a.pdf');
    const b = await upload('officeAdmin', 'b.pdf');
    const detail = await start('officeAdmin', templateId, 'Công văn số 1', { trichYeu: 'V/v thử', tep: [a.id, b.id] });
    expect(detail.files?.map((f) => f.name).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(detail.files?.every((f) => f.status === 'attached' && f.fieldKey === 'tep' && f.runId === detail.id)).toBe(true);
    expect(detail.inputForm?.map((f) => f.key)).toEqual(['trichYeu', 'tep']);
    // Giám đốc là người nhận việc nên thấy lượt chạy và tải được; nhân viên không dính tới thì không.
    const got = await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('director'), a.id));
    expect(got.row.status).toBe('attached');
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('employee2'), a.id)), 'not_found');
    expect((await org.run((tx, ctx) => listRunFiles(tx, ctx, org.viewer('director'), detail.id))).map((f) => f.name).sort()).toEqual(['a.pdf', 'b.pdf']);
    await expectApiError(org.run((tx, ctx) => listRunFiles(tx, ctx, org.viewer('employee2'), detail.id)), 'not_found');
  });

  it('không gắn được tệp của người khác, tệp đã gắn vào lượt chạy khác, hay id không có; lỗi thì không tạo lượt chạy', async () => {
    const theirs = await upload('employee');
    const before = await org.run((tx) => tx.select().from(schema.processRuns));
    const err = (id: string) => start('officeAdmin', templateId, 'Công văn lỗi', { trichYeu: 'x', tep: [id] });
    await expectApiError(err(theirs.id), 'input_invalid');
    await expectApiError(err(newId()), 'input_invalid');
    const mine = await upload('officeAdmin');
    await start('officeAdmin', templateId, 'Công văn dùng tệp', { trichYeu: 'x', tep: [mine.id] });
    await expectApiError(err(mine.id), 'input_invalid');
    expect((await org.run((tx) => tx.select().from(schema.processRuns))).length).toBe(before.length + 1);
  });

  it('xoá tệp chờ gắn: chỉ người tải; tệp đã gắn không xoá được; việc dọn xoá tệp chờ quá hạn và cả nội dung trên kho', async () => {
    const f = await upload('officeAdmin');
    await expectApiError(org.run((tx) => removePendingFile(tx, org.viewer('director'), f.id)), 'not_found');
    await org.run((tx) => removePendingFile(tx, org.viewer('officeAdmin'), f.id));
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('officeAdmin'), f.id)), 'not_found');

    const kept = await upload('officeAdmin');
    await start('officeAdmin', templateId, 'Công văn giữ tệp', { trichYeu: 'x', tep: [kept.id] });
    await expectApiError(org.run((tx) => removePendingFile(tx, org.viewer('officeAdmin'), kept.id)), 'state_conflict');

    const stale = await upload('officeAdmin');
    const before = storage.blobs.size;
    const purged = await org.run((tx) => purgePendingFiles(tx, new Date(Date.now() + 25 * 3_600_000)));
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(storage.blobs.size).toBeLessThan(before);
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('officeAdmin'), stale.id)), 'not_found');
    // Tệp đã gắn không bị dọn.
    expect((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('director'), kept.id))).row.status).toBe('attached');
  });
});

// ───────────────────────── Sổ văn bản và cấp số ─────────────────────────

describe('sổ văn bản và cấp số', () => {
  const numbered = (code: string, extra: Record<string, unknown> = {}) =>
    publish(`Văn bản ${code}`, {
      inputs: [
        { key: 'soVanBan', label: 'Số', type: 'autonumber', register: code },
        { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
        { key: 'noiGui', label: 'Nơi gửi', type: 'text' },
      ],
      nodes: [START, { id: 'xem', type: 'task', label: 'Xem', title: 'Xem', assignee: { kind: 'user', userId: org.users.director }, due: DUE }, END],
      edges: [edge('start', 'xem'), edge('xem', 'end')],
      ...extra,
    });

  it('cấp số liên tiếp theo mẫu, ghi vào ô và vào sổ kèm các cột đã chọn; người gửi không tự đặt được số', async () => {
    await register('SO1', { pattern: '{seq:4}/VRG-VP', columns: [{ key: 'noiGui', label: 'Nơi gửi' }] });
    const t = await numbered('SO1');
    const a = await start('officeAdmin', t, 'Công văn A', { trichYeu: 'Thử A', noiGui: 'Sở Xây dựng', soVanBan: '9999/GIẢ' });
    const b = await start('officeAdmin', t, 'Công văn B', { trichYeu: 'Thử B' });
    expect(a.inputs['soVanBan']).toBe('0001/VRG-VP');
    expect(b.inputs['soVanBan']).toBe('0002/VRG-VP');
    const entries = await org.run((tx, ctx) => listEntries(tx, ctx, org.viewer('officeAdmin'), 'SO1', { limit: 10 }));
    expect(entries.items.map((e) => e.number)).toEqual(['0002/VRG-VP', '0001/VRG-VP']);
    // Trích yếu của dòng sổ là ô trích yếu của biểu mẫu, không phải tiêu đề lượt chạy (văn thư khỏi gõ hai lần).
    expect(entries.items[1]).toMatchObject({ subject: 'Thử A', seq: 1, values: { noiGui: 'Sở Xây dựng' }, run: { id: a.id, state: 'running' } });
    expect(entries.items[0]!.values).toEqual({});
    const found = await org.run((tx, ctx) => listEntries(tx, ctx, org.viewer('officeAdmin'), 'SO1', { limit: 10, q: '0001' }));
    expect(found.items.map((e) => e.subject)).toEqual(['Thử A']);
    const views = await org.run((tx, ctx) => listRegisters(tx, ctx, org.viewer('officeAdmin')));
    expect(views.find((r) => r.code === 'SO1')).toMatchObject({ entryCount: 2, nextNumber: '0003/VRG-VP', direction: 'incoming' });
  });

  it('cột ô chọn lưu cả giá trị gốc lẫn nhãn hiển thị; cột ô chọn người và cột của việc xong sau được gộp vào dòng sổ; không có ô trích yếu thì dùng tiêu đề lượt chạy', async () => {
    await register('SO7', { pattern: '{seq}', columns: [{ key: 'mucKhan', label: 'Mức khẩn' }, { key: 'chuTri', label: 'Người chủ trì' }, { key: 'noiLuu', label: 'Nơi lưu' }] });
    const t = await publish('Văn bản có nhãn', {
      inputs: [
        { key: 'soVanBan', label: 'Số', type: 'autonumber', register: 'SO7' },
        { key: 'mucKhan', label: 'Mức khẩn', type: 'select', required: true, options: [{ value: 'thuong', label: 'Thường' }, { value: 'hoa_toc', label: 'Hỏa tốc' }] },
      ],
      nodes: [
        START,
        { id: 'xem', type: 'task', label: 'Xem', title: 'Xem', assignee: { kind: 'user', userId: org.users.director }, due: DUE, form: [{ key: 'chuTri', label: 'Người chủ trì', type: 'user' }, { key: 'noiLuu', label: 'Nơi lưu', type: 'text' }] },
        END,
      ],
      edges: [edge('start', 'xem'), edge('xem', 'end')],
    });
    const run = await start('officeAdmin', t, 'Tiêu đề lượt chạy', { mucKhan: 'hoa_toc' });
    const list = () => org.run((tx, ctx) => listEntries(tx, ctx, org.viewer('officeAdmin'), 'SO7', { limit: 10 }));
    const first = (await list()).items[0]!;
    expect(first.subject).toBe('Tiêu đề lượt chạy');
    expect(first.values).toEqual({ mucKhan: 'hoa_toc', __nhan: { mucKhan: 'Hỏa tốc' } });
    await act('director', stepOf(run, 'xem').id, { type: 'CompleteStep', result: { chuTri: org.users.head, noiLuu: 'Tủ số 3' } });
    const after = (await list()).items[0]!;
    const headName = await org.run(async (_tx, ctx) => ctx.person(org.users.head)!.fullName);
    expect(after.values).toEqual({ mucKhan: 'hoa_toc', chuTri: org.users.head, noiLuu: 'Tủ số 3', __nhan: { mucKhan: 'Hỏa tốc', chuTri: headName } });
  });

  it('gửi lại cùng khoá chống lặp không cấp thêm số', async () => {
    await register('SO2', { pattern: '{seq}' });
    const t = await numbered('SO2');
    const key = newId();
    const first = await start('officeAdmin', t, 'Lặp', { trichYeu: 'x' }, key);
    const again = await start('officeAdmin', t, 'Lặp', { trichYeu: 'x' }, key);
    expect(again.id).toBe(first.id);
    expect(again.inputs['soVanBan']).toBe('1');
    const next = await start('officeAdmin', t, 'Tiếp', { trichYeu: 'y' });
    expect(next.inputs['soVanBan']).toBe('2');
    expect((await org.run((tx, ctx) => listEntries(tx, ctx, org.viewer('officeAdmin'), 'SO2', { limit: 10 }))).items).toHaveLength(2);
  });

  it('khởi chạy lỗi thì số trả về: quay lui giao dịch nên sổ không hụt số', async () => {
    await register('SO3', { pattern: '{seq}' });
    const t = await numbered('SO3');
    await expectApiError(start('officeAdmin', t, 'Lỗi', { trichYeu: 'x', tep: 'không hợp lệ', noiGui: 5 as never }), 'input_invalid');
    const ok = await start('officeAdmin', t, 'Đúng', { trichYeu: 'x' });
    expect(ok.inputs['soVanBan']).toBe('1');
  });

  it('nhiều yêu cầu song song không trùng số', async () => {
    await register('SO4', { pattern: '{seq}' });
    const t = await numbered('SO4');
    const runs = await Promise.all(Array.from({ length: 8 }, (_v, i) => start('officeAdmin', t, `Song song ${i}`, { trichYeu: 'x' })));
    const numbers = runs.map((r) => Number(r.inputs['soVanBan'])).sort((x, y) => x - y);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('đánh lại từ đầu mỗi năm với sổ "yearly"; sổ "never" đếm tiếp; {yyyy} theo năm lịch', async () => {
    await register('SO5', { pattern: '{seq}/{yyyy}', resetPolicy: 'yearly' });
    await register('SO6', { pattern: '{seq}', resetPolicy: 'never' });
    const t5 = await numbered('SO5');
    const t6 = await numbered('SO6');
    try {
      setFakeNow(new Date('2026-12-31T05:00:00Z'));
      expect((await start('officeAdmin', t5, 'Cuối năm', { trichYeu: 'x' })).inputs['soVanBan']).toBe('1/2026');
      expect((await start('officeAdmin', t6, 'Cuối năm', { trichYeu: 'x' })).inputs['soVanBan']).toBe('1');
      setFakeNow(new Date('2027-01-04T05:00:00Z'));
      expect((await start('officeAdmin', t5, 'Đầu năm', { trichYeu: 'x' })).inputs['soVanBan']).toBe('1/2027');
      expect((await start('officeAdmin', t6, 'Đầu năm', { trichYeu: 'x' })).inputs['soVanBan']).toBe('2');
      const y2026 = await org.run((tx, ctx) => listEntries(tx, ctx, org.viewer('officeAdmin'), 'SO5', { limit: 10, year: 2026 }));
      expect(y2026.items.map((e) => e.number)).toEqual(['1/2026']);
    } finally {
      setFakeNow(null);
    }
  });

  it('ô cấp số trỏ vào sổ không có thì chặn xuất bản (template_invalid, register_unknown); sổ mặc định thì tự tạo', async () => {
    const err = await numbered('CHUATAO').then(() => null, (e: { code?: string; extra?: { errors?: { path: string; code: string }[] } }) => ({ code: e.code, errors: e.extra?.errors }));
    expect(err).toEqual({ code: 'template_invalid', errors: [{ path: 'inputs', code: 'register_unknown' }] });
    // VBDEN là sổ mặc định: chưa có thì được tạo khi xuất bản.
    await numbered('VBDEN');
    const views = await org.run((tx, ctx) => listRegisters(tx, ctx, org.viewer('officeAdmin')));
    expect(views.find((r) => r.code === 'VBDEN')).toMatchObject({ direction: 'incoming', pattern: '{seq:4}' });
  });

  it('chỉ người có quyền xem sổ liệt kê được; mẫu số sai bị từ chối ở hợp đồng', async () => {
    const { RegisterUpsertSchema } = await import('@mihato/domain');
    expect(RegisterUpsertSchema.safeParse({ name: 'x', direction: 'incoming', pattern: 'khong-co-so' }).success).toBe(false);
    expect(RegisterUpsertSchema.safeParse({ name: 'x', direction: 'incoming', pattern: '{seq}/{lạ}' }).success).toBe(false);
    expect(RegisterUpsertSchema.safeParse({ name: 'x', direction: 'incoming', pattern: '{seq:4}/{yy}-VP' }).success).toBe(true);
  });
});

// ───────────────────────── Ai được khởi chạy ─────────────────────────

describe('ai được khởi chạy quy trình', () => {
  const simple = (starters?: unknown[]) => ({
    inputs: [{ key: 'noiDung', label: 'Nội dung', type: 'longtext', required: true }],
    ...(starters ? { starters } : {}),
    nodes: [START, { id: 'nhan', type: 'task', label: 'Nhận', title: 'Nhận', assignee: { kind: 'role', role: 'director' }, due: DUE }, END],
    edges: [edge('start', 'nhan'), edge('nhan', 'end')],
  });

  it('chỉ vai Chủ tịch: Văn phòng và Giám đốc bị 403, Chủ tịch khởi chạy được, danh sách mẫu nói đúng ai khởi chạy được', async () => {
    const id = await publish('Chỉ thị của Chủ tịch', simple([{ kind: 'role', role: 'chairman' }]), 'directive');
    await expectApiError(start('officeAdmin', id, 'x', { noiDung: 'a' }), 'forbidden');
    await expectApiError(start('director', id, 'x', { noiDung: 'a' }), 'forbidden');
    const run = await start('chairman', id, 'Chỉ thị 1', { noiDung: 'Triển khai kế hoạch' });
    expect(stepOf(run, 'nhan')).toMatchObject({ state: 'ready', assignee: { id: org.users.director } });
    const canStart = async (who: Parameters<TestOrg['viewer']>[0]) => (await org.run((tx, ctx) => listTemplates(tx, ctx, org.viewer(who)))).find((t) => t.id === id)!.canStart;
    expect(await canStart('chairman')).toBe(true);
    expect(await canStart('officeAdmin')).toBe(false);
    expect(await canStart('director')).toBe(false);
  });

  it('mọi cán bộ: nhân viên cũng khởi chạy được; không khai báo thì người có quyền run.start như cũ', async () => {
    const open = await publish('Văn bản đi (mọi cán bộ)', simple([{ kind: 'everyone' }]), 'outgoing');
    const legacy = await publish('Quy trình không khai báo', simple());
    expect((await start('employee', open, 'Của Lan', { noiDung: 'a' })).initiator.id).toBe(org.users.employee);
    await expectApiError(start('employee', legacy, 'x', { noiDung: 'a' }), 'forbidden');
    expect((await start('officeAdmin', legacy, 'Của văn phòng', { noiDung: 'a' })).state).toBe('running');
  });

  it('theo đơn vị hoặc người cụ thể', async () => {
    const bySales = await publish('Chỉ phòng Kinh doanh', simple([{ kind: 'unit', unitId: org.units.sales }]));
    const byUser = await publish('Chỉ một người', simple([{ kind: 'user', userId: org.users.deputy }]));
    expect((await start('employee2', bySales, 'a', { noiDung: 'a' })).state).toBe('running');
    await expectApiError(start('officeAdmin', bySales, 'a', { noiDung: 'a' }), 'forbidden');
    expect((await start('deputy', byUser, 'a', { noiDung: 'a' })).state).toBe('running');
    await expectApiError(start('chairman', byUser, 'a', { noiDung: 'a' }), 'forbidden');
  });

  it('nhóm quy trình: lưu, lọc, và nhân bản thì giữ nhóm', async () => {
    const id = await publish('Văn bản đến thử nhóm', simple(), 'incoming');
    const all = await org.run((tx, ctx) => listTemplates(tx, ctx, org.viewer('chairman'), { category: 'incoming' }));
    expect(all.map((t) => t.id)).toContain(id);
    expect(all.every((t) => t.category === 'incoming')).toBe(true);
    const cloned = await org.run((tx, ctx) => createTemplate(tx, ctx, designer(), { name: 'Bản sao nhóm', description: null, cloneFromTemplateId: id }));
    expect(cloned.category).toBe('incoming');
    const other = await org.run((tx, ctx) => listTemplates(tx, ctx, org.viewer('chairman'), { category: 'directive' }));
    expect(other.map((t) => t.id)).not.toContain(id);
  });
});

// ───────────────────────── Chỉ thị: bước đóng góp kèm tệp ─────────────────────────

describe('chỉ thị: Giám đốc phân công, nhiều người gửi phần của mình kèm tệp', () => {
  let templateId: string;
  beforeAll(async () => {
    templateId = await publish(
      'Chỉ thị của Chủ tịch (thử)',
      {
        inputs: [
          { key: 'noiDung', label: 'Nội dung chỉ thị', type: 'longtext', required: true },
          { key: 'tep', label: 'Tài liệu kèm theo', type: 'file', multiple: true },
        ],
        starters: [{ kind: 'role', role: 'chairman' }],
        nodes: [
          START,
          {
            id: 'nhan',
            type: 'task',
            label: 'Tiếp nhận và phân công',
            title: 'Tiếp nhận chỉ thị và phân công',
            assignee: { kind: 'role', role: 'director' },
            due: DUE,
            form: [
              { key: 'chuTri', label: 'Người chủ trì', type: 'user', required: true },
              { key: 'phoiHop', label: 'Người phối hợp', type: 'users' },
            ],
          },
          {
            id: 'thuchien',
            type: 'approval',
            label: 'Thực hiện',
            title: 'Gửi kết quả thực hiện',
            action: 'contribute',
            approvers: [
              { kind: 'step_field', node: 'nhan', field: 'chuTri' },
              { kind: 'step_field', node: 'nhan', field: 'phoiHop' },
            ],
            mode: 'all',
            due: DUE,
            form: [
              { key: 'ketQua', label: 'Kết quả', type: 'longtext', required: true },
              { key: 'tep', label: 'Tệp', type: 'file', multiple: true },
            ],
          },
          { id: 'tonghop', type: 'task', label: 'Tổng hợp', title: 'Tổng hợp báo cáo', assignee: { kind: 'step_field', node: 'nhan', field: 'chuTri' }, due: DUE },
          END,
        ],
        edges: [edge('start', 'nhan'), edge('nhan', 'thuchien'), edge('thuchien', 'tonghop', { outcome: 'approved' }), edge('tonghop', 'end')],
      },
      'directive',
    );
  });

  it('Chủ tịch ra chỉ thị kèm tệp, Giám đốc chọn người, ba người gửi phần của mình; mỗi người thấy việc của mình và chỉ nút "gửi"', async () => {
    const att = await upload('chairman', 'chi-thi.pdf');
    const run = await start('chairman', templateId, 'Chỉ thị quý IV', { noiDung: 'Triển khai kế hoạch quý IV', tep: [att.id] });
    expect(run.files?.map((f) => f.name)).toEqual(['chi-thi.pdf']);
    const nhan = stepOf(run, 'nhan');

    const done = await act('director', nhan.id, { type: 'CompleteStep', result: { chuTri: org.users.deputy, phoiHop: [org.users.employee, org.users.employee2] } });
    expect(done.step.state).toBe('done');
    const after = await runOf('chairman', run.id);
    const gui = stepOf(after, 'thuchien');
    expect(gui).toMatchObject({ state: 'ready', action: 'contribute', kind: 'approval' });
    expect(gui.participants?.map((p) => p.person.id)).toEqual([org.users.deputy, org.users.employee, org.users.employee2].sort());
    expect(gui.form.map((f) => f.key)).toEqual(['ketQua', 'tep']);

    // Người phối hợp thấy bước này ở "việc của tôi" (đủ quyền xem lượt chạy) và chỉ có "approve".
    const mine = await org.run((tx, ctx) => getStepDetail(tx, ctx, org.viewer('employee'), gui.id));
    expect(mine.allowedActions).toContain('approve');
    expect(mine.allowedActions).not.toContain('reject');

    const f1 = await upload('employee', 'phan-lan.pdf');
    const f2 = await upload('deputy', 'tong-hop-huy.pdf');
    await act('employee', gui.id, { type: 'ApproveStep', result: { ketQua: 'Đã khảo sát xong', tep: [f1.id] } });
    await act('employee2', gui.id, { type: 'ApproveStep', result: { ketQua: 'Đã kiểm tra hạ tầng điện' } });
    expect((await runOf('chairman', run.id)).steps.find((s) => s.nodeId === 'tonghop')?.state).toBe('pending');
    // Người đã gửi xong không còn thấy bước này là việc của mình khi nó còn mở; người chưa gửi thì còn.
    const open = async (who: Parameters<TestOrg['viewer']>[0]) =>
      (await org.run((tx, ctx) => listSteps(tx, ctx, org.viewer(who), { limit: 50, assignee: 'me', open: true, sort: 'dueAt' }))).items.filter((x) => x.runId === run.id).map((x) => x.nodeId);
    expect(await open('employee')).toEqual([]);
    expect(await open('employee2')).toEqual([]);
    expect(await open('deputy')).toEqual(['thuchien']);
    await act('deputy', gui.id, { type: 'ApproveStep', comment: 'Hoàn thành đúng hạn', result: { ketQua: 'Phần của phòng', tep: [f2.id] } });

    const final = await runOf('chairman', run.id);
    const stepDone = stepOf(final, 'thuchien');
    expect(stepDone.state).toBe('done');
    const responses = (stepDone.result as { responses: { userId: string; result: Record<string, unknown>; fileIds: string[] }[] }).responses;
    expect(responses).toHaveLength(3);
    expect(responses.find((r) => r.userId === org.users.employee)).toMatchObject({ result: { ketQua: 'Đã khảo sát xong' }, fileIds: [f1.id] });
    const huy = stepDone.participants!.find((p) => p.person.id === org.users.deputy)!;
    expect(huy).toMatchObject({ decision: 'approved', comment: 'Hoàn thành đúng hạn', result: { ketQua: 'Phần của phòng' }, fileIds: [f2.id] });
    // Tệp của từng người gắn đúng vào bước, kèm ô và người tải.
    expect(stepDone.files?.map((f) => [f.name, f.fieldKey, f.uploadedBy?.id]).sort()).toEqual(
      [['phan-lan.pdf', 'tep', org.users.employee], ['tong-hop-huy.pdf', 'tep', org.users.deputy]].sort(),
    );
    expect(final.files).toHaveLength(3);
    // Xong cả bước thì người đã gửi thấy nó ở "Đã xong".
    const doneList = await org.run((tx, ctx) => listSteps(tx, ctx, org.viewer('employee'), { limit: 50, assignee: 'me', bucket: 'done', sort: '-completedAt' }));
    expect(doneList.items.some((x) => x.runId === run.id && x.nodeId === 'thuchien')).toBe(true);
    // Việc tổng hợp giao đúng người chủ trì.
    expect(stepOf(final, 'tonghop')).toMatchObject({ state: 'ready', assignee: { id: org.users.deputy } });
  });

  it('thiếu ô bắt buộc của phần mình bị từ chối; người ngoài danh sách không gửi được', async () => {
    const run = await start('chairman', templateId, 'Chỉ thị khác', { noiDung: 'x' });
    await act('director', stepOf(run, 'nhan').id, { type: 'CompleteStep', result: { chuTri: org.users.deputy } });
    const gui = stepOf(await runOf('chairman', run.id), 'thuchien');
    await expectApiError(act('deputy', gui.id, { type: 'ApproveStep', result: {} }), 'input_invalid');
    await expectApiError(act('employee', gui.id, { type: 'ApproveStep', result: { ketQua: 'x' } }), 'not_found');
  });
});

// ───────────────────────── Văn bản đi: tổng hợp, xuất tệp Word, duyệt ─────────────────────────

describe('văn bản đi: góp nội dung, tổng hợp, xuất tệp Word, lãnh đạo duyệt, văn thư cấp số', () => {
  let templateId: string;
  beforeAll(async () => {
    await register('VBDI_T', { name: 'Sổ văn bản đi', direction: 'outgoing', pattern: '{seq}/VRG-VP', columns: [{ key: 'trichYeu', label: 'Trích yếu' }, { key: 'noiNhan', label: 'Nơi nhận' }] });
    templateId = await publish(
      'Văn bản đi (thử)',
      {
        inputs: [
          { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
          { key: 'noiNhan', label: 'Nơi nhận', type: 'text', required: true },
          { key: 'phoiHop', label: 'Đơn vị phối hợp', type: 'users', required: true },
        ],
        starters: [{ kind: 'everyone' }],
        nodes: [
          START,
          {
            id: 'gop',
            type: 'approval',
            label: 'Góp nội dung',
            title: 'Góp nội dung vào dự thảo',
            action: 'contribute',
            approvers: [{ kind: 'form_field', field: 'phoiHop' }],
            mode: 'all',
            due: DUE,
            form: [{ key: 'noiDung', label: 'Nội dung phần của đơn vị', type: 'longtext', required: true }],
          },
          {
            id: 'tonghop',
            type: 'task',
            label: 'Tổng hợp',
            title: 'Tổng hợp dự thảo và xuất tệp',
            assignee: { kind: 'initiator' },
            due: DUE,
            form: [{ key: 'kienNghi', label: 'Kiến nghị', type: 'longtext' }],
            compile: {
              layout: 'official',
              title: '{trichYeu}',
              required: true,
              includeAttachments: true,
              sections: [
                { heading: 'I. Căn cứ', text: 'Căn cứ chức năng, nhiệm vụ của Công ty.' },
                { heading: 'II. Nội dung các đơn vị', ref: 'responses.gop.noiDung' },
                { heading: 'III. Kiến nghị', ref: 'steps.tonghop.kienNghi' },
              ],
            },
          },
          { id: 'duyet', type: 'approval', label: 'Duyệt', title: 'Lãnh đạo duyệt và ký', approvers: [{ kind: 'role', role: 'director' }], mode: 'any', due: DUE },
          {
            id: 'banhanh',
            type: 'task',
            label: 'Ban hành',
            title: 'Văn thư cấp số và ban hành',
            assignee: { kind: 'role', role: 'office_admin' },
            due: DUE,
            form: [
              { key: 'soVanBan', label: 'Số văn bản', type: 'autonumber', register: 'VBDI_T' },
              { key: 'banChinh', label: 'Bản chính đã ký', type: 'file', required: true },
            ],
          },
          END,
        ],
        edges: [
          edge('start', 'gop'),
          edge('gop', 'tonghop', { outcome: 'approved' }),
          edge('tonghop', 'duyet'),
          edge('duyet', 'banhanh', { outcome: 'approved' }),
          edge('duyet', 'tonghop', { outcome: 'rejected' }),
          edge('banhanh', 'end'),
        ],
      },
      'outgoing',
    );
  });

  async function toTonghop(title = 'Báo cáo tình hình quý IV'): Promise<RunDetail> {
    const run = await start('head', templateId, title, { trichYeu: title, noiNhan: 'Hội đồng quản trị', phoiHop: [org.users.employee, org.users.employee2] });
    await act('employee', stepOf(run, 'gop').id, { type: 'ApproveStep', result: { noiDung: 'Phòng Kinh doanh: ký thêm 3 hợp đồng thuê.' } });
    await act('employee2', stepOf(run, 'gop').id, { type: 'ApproveStep', result: { noiDung: 'Phòng Kỹ thuật: hoàn thành nghiệm thu hạ tầng.' } });
    return runOf('head', run.id);
  }

  it('người soạn (nhân viên) khởi chạy; việc tổng hợp chỉ xong khi đã xuất tệp; tệp chứa nội dung của từng đơn vị', async () => {
    const run = await toTonghop();
    const tong = stepOf(run, 'tonghop');
    expect(tong).toMatchObject({ state: 'ready', assignee: { id: org.users.head }, compile: { layout: 'official', required: true, hasFile: false } });

    await expectApiError(act('head', tong.id, { type: 'CompleteStep', result: { kienNghi: 'Đề nghị phê duyệt' } }), 'input_invalid');
    // Chỉ người đang giữ việc xuất tệp: Giám đốc thấy được lượt chạy nhưng không giữ việc nên 403; người ngoài lượt chạy thì 404.
    await expectApiError(org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('employee'), tong.id, {})), 'not_found');
    await expectApiError(org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('director'), tong.id, {})), 'forbidden');

    // Xuất khi chưa điền kiến nghị rồi điền lại và xuất lần nữa: ra hai tệp, tệp sau mới nhất.
    const first = await org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), tong.id, {}));
    expect(first).toMatchObject({ compiled: true, fieldKey: COMPILED_FIELD, status: 'attached', stepId: tong.id });
    expect(first.name).toBe('Báo cáo tình hình quý IV.docx');
    const doc = await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), first.id));
    const text = docxText(doc.data);
    expect(doc.row.mime).toContain('wordprocessingml');
    expect(text).toContain('V/v Báo cáo tình hình quý IV');
    expect(text).toContain('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM');
    expect(text).toContain('CÔNG TY THỬ NGHIỆM VRG');
    expect(text).toContain('Kính gửi: Hội đồng quản trị');
    expect(text).toContain('Phòng Kinh doanh: ký thêm 3 hợp đồng thuê.');
    expect(text).toContain('Phòng Kỹ thuật: hoàn thành nghiệm thu hạ tầng.');
    expect(text).toContain('Nguyễn Thu Lan (Phòng Kinh doanh)');
    expect(text).toContain('Bùi Quốc Tuấn (Phòng Kinh doanh)');
    expect(text).toContain('(chưa có nội dung)'); // kiến nghị chưa điền

    // Cùng lúc có bản PDF của đúng nội dung đó, đính vào cùng việc và trỏ về tệp Word.
    expect(first.renditionOf).toBeNull();
    expect(first.pdf).toMatchObject({ name: 'Báo cáo tình hình quý IV.pdf', mime: 'application/pdf', compiled: true, renditionOf: first.id, fieldKey: COMPILED_FIELD, status: 'attached', stepId: tong.id });
    const pdfFile = await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), first.pdf!.id));
    expect(pdfFile.row.mime).toBe('application/pdf');
    expect(pdfFile.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdf = await readPdf(pdfFile.data);
    expect(pdf.title).toBe('Báo cáo tình hình quý IV');
    for (const expected of [
      'V/v Báo cáo tình hình quý IV',
      'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
      'Độc lập - Tự do - Hạnh phúc',
      'CÔNG TY THỬ NGHIỆM VRG',
      'Kính gửi: Hội đồng quản trị',
      'Phòng Kinh doanh: ký thêm 3 hợp đồng thuê.',
      'Phòng Kỹ thuật: hoàn thành nghiệm thu hạ tầng.',
      'Nguyễn Thu Lan (Phòng Kinh doanh)',
      '(chưa có nội dung)',
      'Nơi nhận:',
    ]) expect(pdf.text, expected).toContain(expected);
    // Hồ sơ của lượt chạy liệt kê cả hai tệp.
    const listed = await org.run((tx, ctx) => listRunFiles(tx, ctx, org.viewer('director'), run.id));
    expect(listed.filter((f) => f.compiled).map((f) => f.name).sort()).toEqual(['Báo cáo tình hình quý IV.docx', 'Báo cáo tình hình quý IV.pdf']);

    // Điền kiến nghị rồi xuất lại: tệp mới có cả phần người làm vừa gõ (chưa gửi).
    const withText = await org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), tong.id, { kienNghi: 'Đề nghị Hội đồng quản trị phê duyệt kế hoạch.' }));
    expect(withText.id).not.toBe(first.id);
    expect(docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), withText.id))).data)).toContain('Đề nghị Hội đồng quản trị phê duyệt kế hoạch.');
    expect((await readPdf((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), withText.pdf!.id))).data)).text).toContain('Đề nghị Hội đồng quản trị phê duyệt kế hoạch.');

    const detail = await org.run((tx, ctx) => getStepDetail(tx, ctx, org.viewer('head'), tong.id));
    expect(detail.compile?.hasFile).toBe(true);
    const done = await act('head', tong.id, { type: 'CompleteStep', result: { kienNghi: 'Đề nghị Hội đồng quản trị phê duyệt kế hoạch.' } });
    expect(done.step.state).toBe('done');
    const second = await org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), tong.id)).catch((e: { code?: string }) => e.code);
    // Việc đã xong thì không xuất tiếp được.
    expect(second).toBe('forbidden');
  });

  it('tệp được xuất sau khi điền kiến nghị chứa kiến nghị; Giám đốc duyệt thấy tệp ở bước duyệt rồi văn thư cấp số kèm bản chính', async () => {
    const run = await toTonghop('Tờ trình kế hoạch năm 2027');
    const tong = stepOf(run, 'tonghop');
    // Điền kiến nghị rồi xuất: kiến nghị nằm trong kết quả của chính việc đang làm, nên phải báo xong rồi mới có; ở đây kiểm đường rẽ
    // "xuất, báo xong, bị từ chối, làm lại": sau khi bị trả về, việc làm lại phải xuất tệp mới.
    await org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), tong.id));
    await act('head', tong.id, { type: 'CompleteStep', result: { kienNghi: 'Đề nghị phê duyệt.' } });

    const atDuyet = await runOf('director', run.id);
    const duyet = stepOf(atDuyet, 'duyet');
    expect(duyet).toMatchObject({ state: 'ready', action: 'approve' });
    expect(atDuyet.files?.some((f) => f.compiled)).toBe(true);
    // Lãnh đạo từ chối: việc tổng hợp quay lại, làm lại phải xuất tệp mới.
    await act('director', duyet.id, { type: 'RejectStep', reason: 'Bổ sung số liệu doanh thu' });
    const back = stepOf(await runOf('head', run.id), 'tonghop');
    expect(back).toMatchObject({ state: 'ready', compile: { hasFile: false } });
    expect(back.id).not.toBe(tong.id);
    await expectApiError(act('head', back.id, { type: 'CompleteStep', result: { kienNghi: 'Đã bổ sung.' } }), 'input_invalid');
    const second = await org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), back.id));
    expect(docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), second.id))).data)).toContain('Phòng Kinh doanh');
    await act('head', back.id, { type: 'CompleteStep', result: { kienNghi: 'Đã bổ sung.' } });
    const again = stepOf(await runOf('director', run.id), 'duyet');
    await act('director', again.id, { type: 'ApproveStep', comment: 'Đồng ý ban hành' });

    // Văn thư cấp số và đính bản chính đã ký.
    const ban = stepOf(await runOf('officeAdmin', run.id), 'banhanh');
    expect(ban).toMatchObject({ state: 'ready', assignee: { id: org.users.officeAdmin } });
    await expectApiError(act('officeAdmin', ban.id, { type: 'CompleteStep', result: {} }), 'input_invalid');
    const signed = await upload('officeAdmin', 'ban-chinh-da-ky.pdf');
    await act('officeAdmin', ban.id, { type: 'CompleteStep', result: { banChinh: [signed.id] } });

    const final = await runOf('chairman', run.id);
    expect(final.state).toBe('completed');
    const number = stepOf(final, 'banhanh').result?.['soVanBan'];
    expect(number).toMatch(/^\d+\/VRG-VP$/);
    const entry = (await org.run((tx, ctx) => listEntries(tx, ctx, org.viewer('officeAdmin'), 'VBDI_T', { limit: 20 }))).items.find((e) => e.number === number)!;
    expect(entry).toMatchObject({ subject: 'Tờ trình kế hoạch năm 2027', values: { trichYeu: 'Tờ trình kế hoạch năm 2027', noiNhan: 'Hội đồng quản trị' }, run: { id: run.id, state: 'completed' } });
    expect(final.files?.map((f) => f.name)).toContain('ban-chinh-da-ky.pdf');
    // Toàn bộ hồ sơ có 2 lần xuất tệp tổng hợp (lần bị trả về và lần làm lại), mỗi lần một Word và một PDF, và bản chính.
    expect(final.files?.filter((f) => f.compiled && f.renditionOf === null)).toHaveLength(2);
    expect(final.files?.filter((f) => f.compiled && f.renditionOf !== null)).toHaveLength(2);
  });

  it('việc không có cấu hình xuất tệp thì không xuất được', async () => {
    const run = await start('chairman', await publish('Một việc', {
      inputs: [],
      starters: [{ kind: 'everyone' }],
      nodes: [START, { id: 'a', type: 'task', label: 'A', title: 'A', assignee: { kind: 'user', userId: org.users.head }, due: DUE }, END],
      edges: [edge('start', 'a'), edge('a', 'end')],
    }), 'x', {});
    await expectApiError(org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), stepOf(run, 'a').id)), 'input_invalid');
  });

  it('dòng của sổ chỉ do máy chủ ghi: bảng entries tách theo tổ chức (RLS)', async () => {
    const other = await createTestOrg();
    const none = await other.run((tx) => tx.select().from(schema.documentEntries).where(and(eq(schema.documentEntries.orgId, org.orgId))));
    expect(none).toEqual([]);
  });
});

// ───────────────────────── Dữ liệu ─────────────────────────

describe('dữ liệu người dùng được xử lý như chữ, không như định dạng', () => {
  it('nội dung có ký tự XML đặc biệt vẫn ra tệp hợp lệ', async () => {
    const t = await publish('Tờ trình ký tự lạ', {
      inputs: [{ key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true }],
      starters: [{ kind: 'everyone' }],
      nodes: [
        START,
        {
          id: 'a',
          type: 'task',
          label: 'A',
          title: 'A',
          assignee: { kind: 'user', userId: org.users.head },
          due: DUE,
          compile: { layout: 'report', title: '{trichYeu}', sections: [{ heading: 'Mở đầu', ref: 'inputs.trichYeu' }] },
        },
        END,
      ],
      edges: [edge('start', 'a'), edge('a', 'end')],
    });
    const title = 'Tổng hợp <script>alert(1)</script> & "ký tự" lạ';
    const run = await start('head', t, 'Ký tự lạ', { trichYeu: title });
    const file: StepCompileResponse = await org.run((tx, ctx) => compileStep(tx, ctx, org.viewer('head'), stepOf(run, 'a').id));
    const text = docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), file.id))).data);
    expect(text).toContain(title.toLocaleUpperCase('vi-VN'));
    expect(text).toContain('<script>alert(1)</script>');
    // Bản PDF coi chữ người dùng nhập chỉ là chữ: giữ nguyên, không diễn giải.
    const pdf = await readPdf((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('head'), file.pdf!.id))).data);
    expect(pdf.text).toContain(title.toLocaleUpperCase('vi-VN'));
    expect(pdf.text).toContain('<script>alert(1)</script>');
  });
});

// ───────────────────────── Phần của người đóng góp ─────────────────────────

describe('phần của người đóng góp: người chỉ góp nội dung chỉ thấy phần của mình', () => {
  let templateId: string;
  const TEXT = { employee: 'PHAN-LAN: ký thêm 3 hợp đồng.', employee2: 'PHAN-TUAN: nghiệm thu hạ tầng.', deputy: 'PHAN-PHO: rà soát pháp lý.' } as const;
  let run: RunDetail;
  let gopId: string;
  const file = {} as Record<'employee' | 'employee2', FileView>;

  beforeAll(async () => {
    templateId = await publish('Góp ý kiến nhiều đơn vị', {
      inputs: [{ key: 'phoiHop', label: 'Các đơn vị góp ý', type: 'users', required: true }],
      starters: [{ kind: 'everyone' }],
      nodes: [
        START,
        {
          id: 'gop',
          type: 'approval',
          label: 'Góp ý',
          title: 'Các đơn vị góp ý',
          action: 'contribute',
          approvers: [{ kind: 'form_field', field: 'phoiHop' }],
          mode: 'all',
          due: DUE,
          form: [
            { key: 'noiDung', label: 'Ý kiến', type: 'longtext', required: true },
            { key: 'tep', label: 'Tệp kèm theo', type: 'file', multiple: true },
          ],
        },
        { id: 'tonghop', type: 'task', label: 'Tổng hợp', title: 'Tổng hợp ý kiến', assignee: { kind: 'user', userId: org.users.deputy }, due: DUE },
        END,
      ],
      edges: [edge('start', 'gop'), edge('gop', 'tonghop', { outcome: 'approved' }), edge('tonghop', 'end')],
    });
    run = await start('head', templateId, 'Góp ý dự thảo', { phoiHop: [org.users.employee, org.users.employee2, org.users.deputy] });
    gopId = stepOf(run, 'gop').id;
    file.employee = await upload('employee', 'y-kien-lan.pdf');
    file.employee2 = await upload('employee2', 'y-kien-tuan.pdf');
    await act('employee', gopId, { type: 'ApproveStep', comment: 'GHICHU-LAN', result: { noiDung: TEXT.employee, tep: [file.employee.id] }, fileIds: [file.employee.id] });
    await act('employee2', gopId, { type: 'ApproveStep', comment: 'GHICHU-TUAN', result: { noiDung: TEXT.employee2, tep: [file.employee2.id] }, fileIds: [file.employee2.id] });
  });

  const gopAs = async (who: Parameters<TestOrg['viewer']>[0]) => stepOf(await runOf(who, run.id), 'gop');
  const everything = (v: unknown) => JSON.stringify(v);

  it('đang chờ người cuối: Lan chỉ thấy phần của mình; Tuấn và Phó giám đốc hiện tên và "đã gửi / chưa gửi" nhưng không có nội dung', async () => {
    const gop = await gopAs('employee');
    const who = (id: string) => gop.participants!.find((p) => p.person.id === id)!;
    expect(who(org.users.employee)).toMatchObject({ decision: 'approved', result: { noiDung: TEXT.employee } });
    expect(who(org.users.employee)).not.toHaveProperty('contentHidden');
    expect(who(org.users.employee2)).toMatchObject({ decision: 'approved', result: null, comment: null, fileIds: [], contentHidden: true });
    expect(who(org.users.deputy)).toMatchObject({ decision: null, result: null });
    // Không chỗ nào trong dữ liệu lượt chạy lộ chữ của người khác.
    const seen = everything(await runOf('employee', run.id));
    expect(seen).toContain('PHAN-LAN');
    for (const secret of ['PHAN-TUAN', 'GHICHU-TUAN', file.employee2.id, 'y-kien-tuan.pdf']) expect(seen, secret).not.toContain(secret);
  });

  it('cả hai chiều: Tuấn thấy phần của mình và không thấy phần của Lan', async () => {
    const seen = everything(await runOf('employee2', run.id));
    expect(seen).toContain('PHAN-TUAN');
    for (const secret of ['PHAN-LAN', 'GHICHU-LAN', file.employee.id, 'y-kien-lan.pdf']) expect(seen, secret).not.toContain(secret);
  });

  it('chi tiết việc, lịch sử, dòng thời gian, hoạt động và danh sách tệp cũng không lộ phần của người khác', async () => {
    const detail = await org.run((tx, ctx) => getStepDetail(tx, ctx, org.viewer('employee'), gopId));
    const events = await org.run((tx, ctx) => listRunEvents(tx, ctx, org.viewer('employee'), run.id, { limit: 100 }));
    const activity = await org.run((tx, ctx) => listActivity(tx, ctx, org.viewer('employee'), 50));
    const files = await org.run((tx, ctx) => listRunFiles(tx, ctx, org.viewer('employee'), run.id));
    for (const [name, value] of Object.entries({ detail, events, activity })) {
      for (const secret of ['PHAN-TUAN', 'GHICHU-TUAN', file.employee2.id]) expect(everything(value), `${name}: ${secret}`).not.toContain(secret);
    }
    // Sự kiện gửi phần của Tuấn vẫn có (ai, lúc nào) nhưng không có nội dung; sự kiện của chính Lan còn nguyên.
    const approvals = events.items.filter((e) => e.type === 'ApproveStep');
    expect(approvals).toHaveLength(2);
    const mine = approvals.find((e) => e.actor?.id === org.users.employee)!;
    const theirs = approvals.find((e) => e.actor?.id === org.users.employee2)!;
    expect(mine.payload).toMatchObject({ comment: 'GHICHU-LAN', result: { noiDung: TEXT.employee } });
    expect(theirs.payload).not.toHaveProperty('result');
    expect(theirs.payload).not.toHaveProperty('comment');
    expect(theirs.payload).not.toHaveProperty('fileIds');
    expect(detail.history.find((h) => h.code === 'ApproveStep' && h.actor?.id === org.users.employee2)?.text).toBeNull();
    expect(detail.history.find((h) => h.code === 'ApproveStep' && h.actor?.id === org.users.employee)?.text).toBe('GHICHU-LAN');
    expect(files.map((f) => f.name)).toEqual(['y-kien-lan.pdf']);
  });

  it('tải tệp của người khác: 404 như tệp không có; tệp của chính mình tải được', async () => {
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('employee'), file.employee2.id)), 'not_found');
    await expectApiError(org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('employee2'), file.employee.id)), 'not_found');
    expect((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer('employee'), file.employee.id))).row.name).toBe('y-kien-lan.pdf');
  });

  it('người khởi chạy, người xem mọi lượt chạy và người chủ trì tổng hợp thấy hết', async () => {
    for (const who of ['head', 'chairman', 'director', 'officeAdmin'] as const) {
      const seen = everything(await runOf(who, run.id));
      for (const text of [TEXT.employee, TEXT.employee2, 'GHICHU-LAN', 'GHICHU-TUAN']) expect(seen, `${who}: ${text}`).toContain(text);
      expect(await org.run((tx, ctx) => listRunFiles(tx, ctx, org.viewer(who), run.id))).toHaveLength(2);
      expect((await org.run((tx, ctx) => downloadFile(tx, ctx, org.viewer(who), file.employee2.id))).row.name).toBe('y-kien-tuan.pdf');
    }
  });

  it('xong bước góp nội dung: người chủ trì (vừa góp vừa tổng hợp) thấy hết, hai người chỉ góp vẫn chỉ thấy phần mình', async () => {
    await act('deputy', gopId, { type: 'ApproveStep', result: { noiDung: TEXT.deputy } });
    const done = await runOf('deputy', run.id);
    expect(stepOf(done, 'gop').state).toBe('done');
    expect(stepOf(done, 'tonghop')).toMatchObject({ state: 'ready', assignee: { id: org.users.deputy } });
    const deputySees = everything(done);
    for (const text of [TEXT.employee, TEXT.employee2, TEXT.deputy]) expect(deputySees, text).toContain(text);
    expect((stepOf(done, 'gop').result as { responses: unknown[] }).responses).toHaveLength(3);

    for (const [who, others] of [
      ['employee', [TEXT.employee2, TEXT.deputy]],
      ['employee2', [TEXT.employee, TEXT.deputy]],
    ] as const) {
      const finished = await runOf(who, run.id);
      const gop = stepOf(finished, 'gop');
      const responses = (gop.result as { responses: { userId: string }[] }).responses;
      expect(responses.map((r) => r.userId), who).toEqual([org.users[who]]);
      const seen = everything(finished);
      for (const text of others) expect(seen, `${who}: ${text}`).not.toContain(text);
    }
  });

  it('che theo từng lượt chạy: phần của Lan ở một lượt không bị che ở lượt khác, và phần của Tuấn ở lượt này vẫn không lộ', async () => {
    const other = await start('head', templateId, 'Lượt khác', { phoiHop: [org.users.employee] });
    await act('employee', stepOf(other, 'gop').id, { type: 'ApproveStep', result: { noiDung: 'LUOT-KHAC: ý kiến riêng.' } });
    expect(everything(await runOf('employee', other.id))).toContain('LUOT-KHAC');
    expect(everything(await runOf('employee', run.id))).not.toContain(TEXT.employee2);
  });
});
