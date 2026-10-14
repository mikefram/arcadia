import { newId, type DraftDefinition, type RunDetail, type StepView } from '@mihato/domain';
import { addCalendarDays, addWorkingDays, toLocalDate } from '@mihato/domain/calendar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clock } from '../src/clock';
import { closeDb } from '../src/db/client';
import { compileStep } from '../src/services/compile';
import { downloadFile, uploadFile } from '../src/services/files';
import { loadPresets } from '../src/services/presets';
import { listEntries, upsertRegister } from '../src/services/registers';
import { actOnStep, getRun, startRun } from '../src/services/runs';
import { validate } from '@mihato/workflow-engine';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { MemoryFileStorage, setFileStorage } from '../src/storage';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';
import { expectApiError } from './helpers';
import { readPdf } from './support/pdf';
import { docxText } from './support/zip';

/**
 * Ba quy trình mẫu của thư viện (docs/DECISIONS.md, 06/10/2026) chạy trọn vẹn từ đầu đến cuối bằng dịch vụ thật:
 * Chủ tịch ra chỉ thị, Giám đốc nhận và phân công, Phó giám đốc và các chức vụ khác thực hiện; văn bản đến có tệp scan;
 * văn bản đi có tổng hợp, xuất tệp Word, duyệt và cấp số.
 */
let org: TestOrg;
const storage = new MemoryFileStorage();
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

beforeAll(async () => {
  setFileStorage(storage);
  org = await createTestOrg({ name: 'Công ty CP Phát triển Đô thị và Khu công nghiệp Cao su Việt Nam' });
});
afterAll(async () => {
  setFileStorage(null);
  await closeDb();
});

const who = (k: TestUserKey) => org.viewer(k);
const act = (k: TestUserKey, stepId: string, input: Parameters<typeof actOnStep>[5]) => org.run((tx, ctx) => actOnStep(tx, ctx, who(k), stepId, newId(), input));
const runOf = (k: TestUserKey, id: string) => org.run((tx, ctx) => getRun(tx, ctx, who(k), id));
const stepOf = (run: RunDetail, nodeId: string): StepView => run.steps.find((s) => s.nodeId === nodeId)!;
const upload = (k: TestUserKey, name: string) => org.run((tx, ctx) => uploadFile(tx, ctx, who(k), { name, data: PDF.toString('base64') }));
const inDays = (n: number) => addCalendarDays(toLocalDate(clock.now(), { utcOffsetMinutes: 420, workdays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', holidays: [] }), n);

async function adopt(presetId: string): Promise<string> {
  const preset = loadPresets().find((p) => p.id === presetId)!;
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, who('designer'), { name: preset.name, description: preset.description, category: preset.category, definition: preset.definition }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, who('designer'), created.id));
  return created.id;
}
const start = (k: TestUserKey, templateId: string, title: string, inputs: Record<string, unknown>) => org.run((tx, ctx) => startRun(tx, ctx, who(k), { templateId, title, inputs }, newId()));

describe('thư viện quy trình mẫu', () => {
  it('có ba mẫu, mỗi mẫu hợp lệ và chỉ dùng vai trò (áp được cho mọi tổ chức)', () => {
    const presets = loadPresets();
    expect(presets.map((p) => p.id)).toEqual(['chi-thi', 'van-ban-den', 'van-ban-di']);
    expect(presets.map((p) => p.category)).toEqual(['directive', 'incoming', 'outgoing']);
    for (const p of presets) {
      expect(p.steps).toBeGreaterThanOrEqual(4);
      expect(p.summary.length).toBeGreaterThanOrEqual(5);
      // Không có id người hay đơn vị nào trong mẫu.
      expect(JSON.stringify(p.definition)).not.toMatch(/userId|unitId/);
    }
  });

  it('áp mẫu vào tổ chức: sổ mặc định (VBDEN, VBDI, CHITHI) được tạo tự động và mỗi mẫu xuất bản được', async () => {
    await adopt('chi-thi');
    await adopt('van-ban-den');
    await adopt('van-ban-di');
    const { listRegisters } = await import('../src/services/registers');
    const registers = await org.run((tx, ctx) => listRegisters(tx, ctx, who('officeAdmin')));
    expect(registers.map((r) => r.code).sort()).toEqual(['CHITHI', 'VBDEN', 'VBDI']);
  });
});

describe('Chỉ thị: Chủ tịch ra chỉ thị, Giám đốc nhận, Phó giám đốc và các chức vụ khác thực hiện', () => {
  it('trọn vòng: ra chỉ thị, tiếp nhận và phân công, ba người gửi kết quả, tổng hợp báo cáo, bị trả lại một lần, xác nhận hoàn thành', async () => {
    const templateId = (await org.run((tx) => tx.query.processTemplates.findFirst({ where: (t, { eq }) => eq(t.name, 'Chỉ thị của Chủ tịch') })))!.id;
    // Chỉ Chủ tịch ra chỉ thị.
    for (const k of ['director', 'deputy', 'officeAdmin', 'employee'] as const) {
      await expectApiError(start(k, templateId, 'x', { tieuDe: 'x', noiDung: 'x', mucKhan: 'khan', hanHoanThanh: inDays(10) }), 'forbidden');
    }
    const attachment = await upload('chairman', 'chi-thi-quy-iv.pdf');
    const run = await start('chairman', templateId, 'Chỉ thị triển khai kế hoạch quý IV', {
      tieuDe: 'Triển khai kế hoạch quý IV',
      noiDung: 'Các đơn vị rà soát tiến độ, báo cáo kết quả trước hạn.',
      mucKhan: 'khan',
      hanHoanThanh: inDays(14),
      tep: [attachment.id],
    });
    expect(run.inputs['soChiThi']).toMatch(/^1\/CT-\d{4}$/);
    // Mức khẩn in thành nhãn lên tiêu đề lượt chạy.
    expect(run.title).toBe('[KHẨN] Chỉ thị triển khai kế hoạch quý IV');
    expect(run.initiator.id).toBe(org.users.chairman);

    // Giám đốc nhận: việc đầu tiên giao đúng Giám đốc, không ai khác.
    const nhan = stepOf(run, 'nhan');
    expect(nhan).toMatchObject({ state: 'ready', assignee: { id: org.users.director } });
    await expectApiError(act('deputy', nhan.id, { type: 'CompleteStep', result: { yKien: 'x', chuTri: org.users.deputy } }), 'forbidden');
    await expectApiError(act('director', nhan.id, { type: 'CompleteStep', result: { yKien: 'Đồng ý triển khai' } }), 'input_invalid'); // thiếu người chủ trì
    await act('director', nhan.id, { type: 'CompleteStep', result: { yKien: 'Phó giám đốc chủ trì, phòng Kinh doanh phối hợp.', chuTri: org.users.deputy, phoiHop: [org.users.head, org.users.employee] } });

    // Phó giám đốc, trưởng phòng và nhân viên cùng thực hiện.
    const thuchien = stepOf(await runOf('chairman', run.id), 'thuchien');
    expect(thuchien.participants?.map((p) => p.person.id).sort()).toEqual([org.users.deputy, org.users.head, org.users.employee].sort());
    const proof = await upload('head', 'minh-chung.pdf');
    await act('head', thuchien.id, { type: 'ApproveStep', result: { ketQua: 'Phòng Kinh doanh đã rà soát 12 hợp đồng.', tep: [proof.id] } });
    await act('employee', thuchien.id, { type: 'ApproveStep', result: { ketQua: 'Đã lập bảng theo dõi.' } });
    await act('deputy', thuchien.id, { type: 'ApproveStep', result: { ketQua: 'Hoàn thành phần việc của Ban Giám đốc.' } });

    // Người chủ trì tổng hợp, xuất tệp báo cáo (không bắt buộc), báo xong.
    const tong = stepOf(await runOf('deputy', run.id), 'tonghop');
    expect(tong).toMatchObject({ state: 'ready', assignee: { id: org.users.deputy }, compile: { layout: 'report', required: false } });
    const report = await org.run((tx, ctx) => compileStep(tx, ctx, who('deputy'), tong.id, { baoCao: 'Chỉ thị đã được thực hiện đầy đủ, đúng hạn.' }));
    const text = docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, who('deputy'), report.id))).data);
    expect(text).toContain('BÁO CÁO KẾT QUẢ THỰC HIỆN CHỈ THỊ: TRIỂN KHAI KẾ HOẠCH QUÝ IV');
    expect(text).toContain('Các đơn vị rà soát tiến độ');
    expect(text).toContain('Phó giám đốc chủ trì, phòng Kinh doanh phối hợp.');
    expect(text).toContain('Phòng Kinh doanh đã rà soát 12 hợp đồng.');
    expect(text).toContain('Đã lập bảng theo dõi.');
    expect(text).toContain('Chỉ thị đã được thực hiện đầy đủ, đúng hạn.');
    expect(text).toContain('chi-thi-quy-iv.pdf');
    // Bản PDF cùng nội dung với bản Word.
    const pdf = await readPdf((await org.run((tx, ctx) => downloadFile(tx, ctx, who('deputy'), report.pdf!.id))).data);
    for (const expected of ['BÁO CÁO KẾT QUẢ THỰC HIỆN CHỈ THỊ: TRIỂN KHAI KẾ HOẠCH QUÝ IV', 'Phó giám đốc chủ trì, phòng Kinh doanh phối hợp.', 'Phòng Kinh doanh đã rà soát 12 hợp đồng.', 'Đã lập bảng theo dõi.', 'Chỉ thị đã được thực hiện đầy đủ, đúng hạn.', 'chi-thi-quy-iv.pdf']) expect(pdf.text, expected).toContain(expected);
    await act('deputy', tong.id, { type: 'CompleteStep', result: { baoCao: 'Chỉ thị đã được thực hiện đầy đủ, đúng hạn.' } });

    // Chủ tịch chưa đồng ý: trả về người chủ trì tổng hợp lại.
    const xacnhan = stepOf(await runOf('chairman', run.id), 'xacnhan');
    expect(xacnhan).toMatchObject({ state: 'ready', assignee: { id: org.users.chairman } });
    await act('chairman', xacnhan.id, { type: 'RejectStep', reason: 'Bổ sung số liệu hợp đồng ký mới.' });
    const again = stepOf(await runOf('deputy', run.id), 'tonghop');
    expect(again).toMatchObject({ state: 'ready', assignee: { id: org.users.deputy } });
    expect(again.id).not.toBe(tong.id);
    await act('deputy', again.id, { type: 'CompleteStep', result: { baoCao: 'Đã bổ sung: ký mới 3 hợp đồng.' } });
    await act('chairman', stepOf(await runOf('chairman', run.id), 'xacnhan').id, { type: 'ApproveStep', comment: 'Đã nắm. Cảm ơn các đơn vị.' });

    const final = await runOf('chairman', run.id);
    expect(final.state).toBe('completed');
    expect(final.files?.map((f) => f.name).sort()).toEqual(['Báo cáo kết quả thực hiện chỉ thị - Triển khai kế hoạch quý IV.docx', 'Báo cáo kết quả thực hiện chỉ thị - Triển khai kế hoạch quý IV.pdf', 'chi-thi-quy-iv.pdf', 'minh-chung.pdf'].sort());
  });

  it('chỉ thị vào sổ chỉ thị', async () => {
    const entries = await org.run((tx, ctx) => listEntries(tx, ctx, who('chairman'), 'CHITHI', { limit: 10 }));
    // Trích yếu của dòng sổ là ô tiêu đề của biểu mẫu, không phải tiêu đề lượt chạy; mức khẩn hiện nhãn, không hiện mã thô.
    expect(entries.items.map((e) => [e.number.split('/')[0], e.subject, e.values['tieuDe']])).toEqual([['1', 'Triển khai kế hoạch quý IV', 'Triển khai kế hoạch quý IV']]);
    expect(entries.items[0]!.values).toMatchObject({ mucKhan: 'khan', __nhan: { mucKhan: 'Khẩn' } });
  });

  it('hạn hoàn thành phải đủ xa: hạn ngày mai hay cuối tuần này bị từ chối, đủ 3 ngày làm việc thì nhận; gửi lại cùng khoá không kiểm lại', async () => {
    const templateId = (await org.run((tx) => tx.query.processTemplates.findFirst({ where: (t, { eq }) => eq(t.name, 'Chỉ thị của Chủ tịch') })))!.id;
    const cal = { utcOffsetMinutes: 420, workdays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', holidays: [] };
    const inputs = (hanHoanThanh: string, mucKhan = 'thuong') => ({ tieuDe: 'Chỉ thị gấp', noiDung: 'Làm ngay.', mucKhan, hanHoanThanh });
    const tomorrow = inDays(1);
    const err = await expectApiError(start('chairman', templateId, 'Chỉ thị gấp', inputs(tomorrow)), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'inputs.hanHoanThanh', code: 'target_too_soon' }]);
    const earliest = addWorkingDays(toLocalDate(clock.now(), cal), 3, cal);
    await expectApiError(start('chairman', templateId, 'Chỉ thị gấp', inputs(addCalendarDays(earliest, -1))), 'input_invalid');
    const ok = await start('chairman', templateId, 'Chỉ thị gấp', inputs(earliest, 'hoa_toc'));
    expect(ok.title).toBe('[HỎA TỐC] Chỉ thị gấp');
    // Hạn đủ xa thì việc thực hiện (trừ 2 ngày làm việc) không quá hạn ngay khi tới lượt.
    expect(stepOf(ok, 'nhan').state).toBe('ready');
    // Mức thường: tiêu đề giữ nguyên.
    expect((await start('chairman', templateId, 'Chỉ thị thường', inputs(inDays(15)))).title).toBe('Chỉ thị thường');
  });
});

describe('Văn bản đến: văn thư vào sổ kèm bản scan, Giám đốc cho ý kiến, phân công, đơn vị xử lý', () => {
  const body = (over: Record<string, unknown> = {}, files: string[] = []) => ({
    trichYeu: 'V/v đề nghị cung cấp hồ sơ pháp lý lô đất C5',
    noiGui: 'Sở Tài nguyên và Môi trường',
    soKyHieu: '1234/STNMT-QLĐĐ',
    ngayVanBan: inDays(-1),
    loaiVanBan: 'cong_van',
    mucKhan: 'khan',
    mucMat: 'thuong',
    hanXuLy: inDays(7),
    tep: files,
    ...over,
  });

  async function templateId(): Promise<string> {
    return (await org.run((tx) => tx.query.processTemplates.findFirst({ where: (t, { eq }) => eq(t.name, 'Văn bản đến') })))!.id;
  }
  const nameOf = (k: TestUserKey) => org.run(async (_tx, ctx) => ctx.person(org.users[k])!.fullName);

  /** Giám đốc cho ý kiến và chọn hướng; trả lượt chạy sau đó. */
  async function direct(run: RunDetail, huongXuLy: 'giao_xu_ly' | 'de_biet' | 'tra_lai', yKien = 'Đã xem.'): Promise<RunDetail> {
    await act('director', stepOf(run, 'giamdoc').id, { type: 'CompleteStep', result: { yKien, huongXuLy } });
    return runOf('director', run.id);
  }

  it('văn bản thường: đi thẳng tới Giám đốc; Giám đốc giao xử lý và chọn người chủ trì; xử lý; phiếu xử lý; văn thư lưu hồ sơ', async () => {
    const id = await templateId();
    await expectApiError(start('employee', id, 'x', body({}, [])), 'forbidden');
    const scan = await upload('officeAdmin', 'cv-1234.pdf');
    const run = await start('officeAdmin', id, 'Công văn 1234 của Sở TN&MT', body({}, [scan.id]));
    expect(run.inputs['soDen']).toBe('0001');
    expect(run.files?.map((f) => f.name)).toEqual(['cv-1234.pdf']);
    // Văn thường: Chủ tịch không phải xem.
    expect(stepOf(run, 'chutich').state).not.toBe('ready');
    expect(stepOf(run, 'giamdoc')).toMatchObject({ state: 'ready', assignee: { id: org.users.director } });
    // Thiếu hướng xử lý thì không báo xong được.
    await expectApiError(act('director', stepOf(run, 'giamdoc').id, { type: 'CompleteStep', result: { yKien: 'Giao phòng Pháp lý chủ trì.' } }), 'input_invalid');

    const after = await direct(run, 'giao_xu_ly', 'Giao phòng Pháp lý chủ trì, phòng Kinh doanh phối hợp.');
    const phancong = stepOf(after, 'phancong');
    expect(phancong).toMatchObject({ state: 'ready', assignee: { id: org.users.director } });
    // Giao xử lý thì bắt buộc chọn người chủ trì.
    await expectApiError(act('director', phancong.id, { type: 'CompleteStep', result: {} }), 'input_invalid');
    await act('director', phancong.id, { type: 'CompleteStep', result: { chuTri: org.users.head, phoiHop: [org.users.employee2] } });
    const xuly = stepOf(await runOf('director', run.id), 'xuly');
    await act('employee2', xuly.id, { type: 'ApproveStep', result: { ketQua: 'Đã thu thập bản sao giấy chứng nhận.' } });
    await act('head', xuly.id, { type: 'ApproveStep', result: { ketQua: 'Hồ sơ pháp lý lô C5 đầy đủ.' } });
    const tong = stepOf(await runOf('head', run.id), 'tonghop');
    expect(tong.compile).toMatchObject({ layout: 'report', required: true, hasFile: false });
    // Phải xuất phiếu xử lý trước khi báo xong.
    await expectApiError(act('head', tong.id, { type: 'CompleteStep', result: { deXuat: 'Đề nghị trả lời Sở bằng văn bản.' } }), 'input_invalid');
    const phieu = await org.run((tx, ctx) => compileStep(tx, ctx, who('head'), tong.id, { deXuat: 'Đề nghị trả lời Sở bằng văn bản.' }));
    const text = docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, who('head'), phieu.id))).data);
    expect(text).toContain('PHIẾU XỬ LÝ VĂN BẢN ĐẾN: V/V ĐỀ NGHỊ CUNG CẤP HỒ SƠ PHÁP LÝ LÔ ĐẤT C5');
    expect(text).toContain('Sở Tài nguyên và Môi trường');
    expect(text).toContain('Giao phòng Pháp lý chủ trì');
    expect(text).toContain('Hồ sơ pháp lý lô C5 đầy đủ.');
    expect(text).toContain('cv-1234.pdf');
    // Văn bản thường không đi qua Chủ tịch nên phiếu không có mục ý kiến của Chủ tịch (bỏ mục, không in tiêu đề trống).
    expect(text).not.toContain('Ý kiến của Chủ tịch');
    await act('head', tong.id, { type: 'CompleteStep', result: { deXuat: 'Đề nghị trả lời Sở bằng văn bản.' } });
    await act('officeAdmin', stepOf(await runOf('officeAdmin', run.id), 'luu').id, { type: 'CompleteStep', result: { noiLuu: 'Tủ hồ sơ số 3' } });
    expect((await runOf('officeAdmin', run.id)).state).toBe('completed');
  });

  it('văn bản mật: Chủ tịch xem và cho ý kiến trước rồi mới tới Giám đốc; ý kiến Chủ tịch vào phiếu xử lý', async () => {
    const id = await templateId();
    const scan = await upload('officeAdmin', 'mat-01.pdf');
    const run = await start('officeAdmin', id, 'Văn bản mật số 01', body({ mucMat: 'mat', trichYeu: 'V/v đề nghị bảo mật dữ liệu' }, [scan.id]));
    expect(run.inputs['soDen']).toBe('0002');
    expect(stepOf(run, 'chutich')).toMatchObject({ state: 'ready', assignee: { id: org.users.chairman } });
    expect(stepOf(run, 'giamdoc').state).toBe('pending');
    await act('chairman', stepOf(run, 'chutich').id, { type: 'ApproveStep', result: { yKienChuTich: 'Giữ kín, chỉ Giám đốc xử lý.' } });
    const afterChairman = await runOf('director', run.id);
    expect(stepOf(afterChairman, 'giamdoc')).toMatchObject({ state: 'ready', assignee: { id: org.users.director } });
    await direct(afterChairman, 'giao_xu_ly');
    await act('director', stepOf(await runOf('director', run.id), 'phancong').id, { type: 'CompleteStep', result: { chuTri: org.users.head } });
    await act('head', stepOf(await runOf('head', run.id), 'xuly').id, { type: 'ApproveStep', result: { ketQua: 'Đã giữ kín.' } });
    const tong = stepOf(await runOf('head', run.id), 'tonghop');
    const phieu = await org.run((tx, ctx) => compileStep(tx, ctx, who('head'), tong.id, { deXuat: 'Lưu mật.' }));
    const text = docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, who('head'), phieu.id))).data);
    expect(text).toContain('Ý kiến của Chủ tịch');
    expect(text).toContain('Giữ kín, chỉ Giám đốc xử lý.');
  });

  it('chỉ để biết, lưu: Giám đốc không phải chọn người chủ trì, đi thẳng tới văn thư lưu hồ sơ', async () => {
    const id = await templateId();
    const scan = await upload('officeAdmin', 'thu-moi.pdf');
    const run = await start('officeAdmin', id, 'Thư mời hội thảo', body({ trichYeu: 'Thư mời hội thảo ngành', mucKhan: 'thuong' }, [scan.id]));
    const after = await direct(run, 'de_biet', 'Để biết, lưu hồ sơ.');
    expect(stepOf(after, 'phancong').state).toBe('skipped');
    expect(stepOf(after, 'xuly').state).not.toBe('ready');
    expect(stepOf(after, 'luu')).toMatchObject({ state: 'ready', assignee: { id: org.users.officeAdmin } });
    await act('officeAdmin', stepOf(after, 'luu').id, { type: 'CompleteStep', result: { noiLuu: 'Hồ sơ để biết' } });
    expect((await runOf('officeAdmin', run.id)).state).toBe('completed');
  });

  it('trả lại văn thư: vào sổ nhầm thì việc về văn thư ghi cách đã xử lý rồi kết thúc, không có bước xử lý nào chạy', async () => {
    const id = await templateId();
    const scan = await upload('officeAdmin', 'nham.pdf');
    const run = await start('officeAdmin', id, 'Văn bản vào sổ nhầm', body({ trichYeu: 'Văn bản gửi nhầm cơ quan' }, [scan.id]));
    const after = await direct(run, 'tra_lai', 'Không thuộc thẩm quyền, trả lại.');
    expect(stepOf(after, 'phancong').state).toBe('skipped');
    const trala = stepOf(after, 'trala');
    expect(trala).toMatchObject({ state: 'ready', assignee: { id: org.users.officeAdmin } });
    await expectApiError(act('officeAdmin', trala.id, { type: 'CompleteStep', result: {} }), 'input_invalid');
    await act('officeAdmin', trala.id, { type: 'CompleteStep', result: { cachXuLy: 'Đã trả lại cơ quan gửi bằng công văn.' } });
    const final = await runOf('officeAdmin', run.id);
    expect(final.state).toBe('completed');
    expect(stepOf(final, 'luu').state).toBe('skipped');
  });

  it('sổ văn bản đến hiện nhãn thay mã thô, đủ ngày văn bản, loại, hạn xử lý và người chủ trì; trích yếu lấy từ ô trích yếu', async () => {
    const entries = await org.run((tx, ctx) => listEntries(tx, ctx, who('officeAdmin'), 'VBDEN', { limit: 20 }));
    expect(entries.items).toHaveLength(4);
    const first = entries.items.find((e) => e.number === '0001')!;
    // Trích yếu của sổ là ô trích yếu của biểu mẫu (không phải tiêu đề lượt chạy "Công văn 1234 của Sở TN&MT").
    expect(first.subject).toBe('V/v đề nghị cung cấp hồ sơ pháp lý lô đất C5');
    // Giá trị gốc giữ nguyên để lọc; nhãn để hiển thị.
    expect(first.values).toMatchObject({
      noiGui: 'Sở Tài nguyên và Môi trường',
      soKyHieu: '1234/STNMT-QLĐĐ',
      ngayVanBan: inDays(-1),
      loaiVanBan: 'cong_van',
      mucKhan: 'khan',
      mucMat: 'thuong',
      hanXuLy: inDays(7),
      chuTri: org.users.head,
    });
    expect((first.values as { __nhan: Record<string, string> }).__nhan).toEqual({ loaiVanBan: 'Công văn', mucKhan: 'Khẩn', mucMat: 'Thường', chuTri: await nameOf('head') });
    // Người chủ trì chỉ có sau khi Giám đốc phân công: văn bản chỉ để biết không có cột này.
    const biet = entries.items.find((e) => e.subject === 'Thư mời hội thảo ngành')!;
    expect(biet.values).not.toHaveProperty('chuTri');
    expect((biet.values as { __nhan: Record<string, string> }).__nhan).toMatchObject({ mucKhan: 'Thường' });
  });
});

describe('Văn bản đi: các đơn vị góp nội dung, tổng hợp, xuất tệp, soát xét, duyệt, văn thư cấp số rồi đóng dấu', () => {
  async function templateId(): Promise<string> {
    return (await org.run((tx) => tx.query.processTemplates.findFirst({ where: (t, { eq }) => eq(t.name, 'Văn bản đi') })))!.id;
  }
  const inputs = (over: Record<string, unknown> = {}) => ({
    trichYeu: 'V/v báo cáo tình hình hoạt động quý IV',
    loaiVanBan: 'bao_cao',
    noiNhan: 'Tập đoàn Công nghiệp Cao su Việt Nam',
    mucKhan: 'thuong',
    mucMat: 'thuong',
    phoiHop: [org.users.employee, org.users.employee2],
    hanHoanThanh: inDays(10),
    ...over,
  });

  async function upToTonghop(over: Record<string, unknown> = {}, title = 'Báo cáo quý IV gửi Tập đoàn'): Promise<RunDetail> {
    const run = await start('head', await templateId(), title, inputs(over));
    const gop = stepOf(run, 'gop');
    await act('employee', gop.id, { type: 'ApproveStep', result: { noiDung: 'Phòng Kinh doanh: doanh thu thuê đất tăng 12%.' } });
    await act('employee2', gop.id, { type: 'ApproveStep', result: { noiDung: 'Phòng Vận hành: 100% nhà xưởng được bảo trì.' } });
    return runOf('head', run.id);
  }

  async function finishDraft(run: RunDetail): Promise<void> {
    const tong = stepOf(await runOf('head', run.id), 'tonghop');
    const draft = { duThao: 'Kính báo cáo Tập đoàn tình hình hoạt động quý IV năm 2026.', kienNghi: 'Đề nghị Tập đoàn ghi nhận kết quả.' };
    await org.run((tx, ctx) => compileStep(tx, ctx, who('head'), tong.id, draft));
    await act('head', tong.id, { type: 'CompleteStep', result: draft });
  }

  /** Soát xét rồi Giám đốc duyệt. */
  async function approveUpToDirector(run: RunDetail): Promise<void> {
    await act('deputy', stepOf(await runOf('deputy', run.id), 'soatxet').id, { type: 'ApproveStep' });
    await act('director', stepOf(await runOf('director', run.id), 'duyet').id, { type: 'ApproveStep', comment: 'Đồng ý.' });
  }

  const issueBody = (over: Record<string, unknown> = {}) => ({ ngayBanHanh: '2026-10-20', nguoiKy: 'giam_doc', soLuongBan: 5, ...over });

  it('văn bản thường: soạn → soát xét → Giám đốc duyệt (không qua Chủ tịch) → văn thư cấp số có TRƯỚC khi đóng dấu → đóng dấu, đính bản chính', async () => {
    const run = await upToTonghop();
    const tong = stepOf(run, 'tonghop');
    expect(tong).toMatchObject({ state: 'ready', assignee: { id: org.users.head }, compile: { required: true, hasFile: false } });
    await expectApiError(act('head', tong.id, { type: 'CompleteStep', result: { duThao: 'x' } }), 'input_invalid');

    const draft = { duThao: 'Kính báo cáo Tập đoàn tình hình hoạt động quý IV năm 2026.', kienNghi: 'Đề nghị Tập đoàn ghi nhận kết quả.' };
    const file = await org.run((tx, ctx) => compileStep(tx, ctx, who('head'), tong.id, draft));
    const text = docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, who('head'), file.id))).data);
    expect(text).toContain('CÔNG TY CP PHÁT TRIỂN ĐÔ THỊ VÀ KHU CÔNG NGHIỆP CAO SU VIỆT NAM');
    expect(text).toContain('V/v V/v báo cáo tình hình hoạt động quý IV');
    expect(text).toContain('Kính gửi: Tập đoàn Công nghiệp Cao su Việt Nam');
    expect(text).toContain('Kính báo cáo Tập đoàn tình hình hoạt động quý IV năm 2026.');
    expect(text).toContain('Phòng Kinh doanh: doanh thu thuê đất tăng 12%.');
    expect(text).toContain('Phòng Vận hành: 100% nhà xưởng được bảo trì.');
    expect(text).toContain('Đề nghị Tập đoàn ghi nhận kết quả.');
    // Chưa cấp số thì tệp trình duyệt để trống số.
    expect(text).toContain('Số: ……');
    await act('head', tong.id, { type: 'CompleteStep', result: draft });

    // Soát xét bởi cấp trên trực tiếp của người soạn (Phó giám đốc), rồi Giám đốc duyệt.
    const soat = stepOf(await runOf('deputy', run.id), 'soatxet');
    expect(soat).toMatchObject({ state: 'ready', action: 'approve' });
    expect(soat.participants?.map((p) => p.person.id)).toEqual([org.users.deputy]);
    await act('deputy', soat.id, { type: 'ApproveStep' });
    const duyet = stepOf(await runOf('director', run.id), 'duyet');
    expect(duyet).toMatchObject({ state: 'ready' });
    await act('director', duyet.id, { type: 'ApproveStep', comment: 'Đồng ý ban hành.' });
    // Văn bản thường không cần Chủ tịch.
    const afterDuyet = await runOf('officeAdmin', run.id);
    expect(stepOf(afterDuyet, 'chutich').state).not.toBe('ready');

    // Việc 1: cấp số và ghi ngày ban hành. Đóng dấu chưa tới lượt: số có trước khi đóng dấu.
    const capso = stepOf(afterDuyet, 'capso');
    expect(capso).toMatchObject({ state: 'ready', assignee: { id: org.users.officeAdmin } });
    expect(stepOf(afterDuyet, 'dongdau').state).toBe('pending');
    await expectApiError(act('officeAdmin', capso.id, { type: 'CompleteStep', result: { ngayBanHanh: '2026-10-20' } }), 'input_invalid'); // thiếu người ký, số lượng bản
    await act('officeAdmin', capso.id, { type: 'CompleteStep', result: issueBody() });
    const afterCapSo = await runOf('officeAdmin', run.id);
    const number = stepOf(afterCapSo, 'capso').result?.['soVanBan'];
    expect(number).toMatch(/^1\/VB-\d{4}$/);
    // Sổ có dòng ngay sau khi cấp số (trước khi đóng dấu), đủ người ký, số bản, ngày ban hành; nhãn thay mã thô.
    const entry = (await org.run((tx, ctx) => listEntries(tx, ctx, who('head'), 'VBDI', { limit: 10 }))).items.find((e) => e.number === number)!;
    expect(entry.subject).toBe('V/v báo cáo tình hình hoạt động quý IV');
    expect(entry.values).toMatchObject({ noiNhan: 'Tập đoàn Công nghiệp Cao su Việt Nam', loaiVanBan: 'bao_cao', mucKhan: 'thuong', mucMat: 'thuong', nguoiKy: 'giam_doc', soLuongBan: 5, ngayBanHanh: '2026-10-20' });
    expect((entry.values as { __nhan: Record<string, string> }).__nhan).toEqual({ loaiVanBan: 'Báo cáo', mucKhan: 'Thường', mucMat: 'Thường', nguoiKy: 'Giám đốc' });

    // Việc 2: đóng dấu. Tệp cuối in số và ngày ban hành; bằng chứng gửi đi không bắt buộc.
    const dongdau = stepOf(afterCapSo, 'dongdau');
    expect(dongdau).toMatchObject({ state: 'ready', assignee: { id: org.users.officeAdmin }, compile: { required: false } });
    await expectApiError(act('officeAdmin', dongdau.id, { type: 'CompleteStep', result: {} }), 'input_invalid'); // thiếu bản chính
    const finalFile = await org.run((tx, ctx) => compileStep(tx, ctx, who('officeAdmin'), dongdau.id, { noiLuu: 'Tủ hồ sơ số 2' }));
    const finalText = docxText((await org.run((tx, ctx) => downloadFile(tx, ctx, who('officeAdmin'), finalFile.id))).data);
    expect(finalText).toContain(`Số: ${number as string}`);
    expect(finalText).toContain('ngày 20 tháng 10 năm 2026');
    expect(finalText).toContain('Kính báo cáo Tập đoàn tình hình hoạt động quý IV năm 2026.');
    const finalPdf = await readPdf((await org.run((tx, ctx) => downloadFile(tx, ctx, who('officeAdmin'), finalFile.pdf!.id))).data);
    expect(finalPdf.text).toContain(`Số: ${number as string}`);
    expect(finalPdf.text).toContain('ngày 20 tháng 10 năm 2026');

    const signed = await upload('officeAdmin', 'bao-cao-quy-iv-da-ky.pdf');
    await act('officeAdmin', dongdau.id, { type: 'CompleteStep', result: { banChinh: [signed.id], noiLuu: 'Tủ hồ sơ số 2' } });
    const final = await runOf('head', run.id);
    expect(final.state).toBe('completed');
    // Hai lần xuất (trình duyệt và bản có số): mỗi lần một Word và bản PDF của nó.
    expect(final.files?.filter((f) => f.compiled && f.renditionOf === null)).toHaveLength(2);
    expect(final.files?.filter((f) => f.compiled && f.renditionOf !== null)).toHaveLength(2);
    // Nơi lưu (chỉ biết ở việc đóng dấu) được gộp vào sổ; bằng chứng gửi đi không có thì vẫn xong.
    expect(stepOf(final, 'dongdau').result).not.toHaveProperty('bangChungGuiDi');
  });

  it('bằng chứng gửi đi: đính được nhiều tệp ở bước đóng dấu, thuộc hồ sơ lượt chạy', async () => {
    const run = await upToTonghop({}, 'Báo cáo có bằng chứng gửi đi');
    await finishDraft(run);
    await approveUpToDirector(run);
    await act('officeAdmin', stepOf(await runOf('officeAdmin', run.id), 'capso').id, { type: 'CompleteStep', result: issueBody() });
    const signed = await upload('officeAdmin', 'ban-chinh.pdf');
    const proof = await upload('officeAdmin', 'phieu-gui-buu-dien.pdf');
    await act('officeAdmin', stepOf(await runOf('officeAdmin', run.id), 'dongdau').id, { type: 'CompleteStep', result: { banChinh: [signed.id], bangChungGuiDi: [proof.id] } });
    const final = await runOf('head', run.id);
    expect(final.state).toBe('completed');
    expect(final.files?.map((f) => f.name)).toEqual(expect.arrayContaining(['ban-chinh.pdf', 'phieu-gui-buu-dien.pdf']));
  });

  it('Giám đốc chưa đồng ý: trả về người soạn; làm lại phải xuất tệp mới và đi lại từ soát xét', async () => {
    const run = await upToTonghop({}, 'Báo cáo bị trả lại');
    await finishDraft(run);
    await act('deputy', stepOf(await runOf('deputy', run.id), 'soatxet').id, { type: 'ApproveStep' });
    await act('director', stepOf(await runOf('director', run.id), 'duyet').id, { type: 'RejectStep', reason: 'Bổ sung số liệu doanh thu cụ thể.' });
    const back = stepOf(await runOf('head', run.id), 'tonghop');
    expect(back).toMatchObject({ state: 'ready', compile: { hasFile: false } });
    await expectApiError(act('head', back.id, { type: 'CompleteStep', result: { duThao: 'Đã bổ sung.' } }), 'input_invalid');
    const draft = { duThao: 'Đã bổ sung số liệu doanh thu 85 tỷ đồng.' };
    await org.run((tx, ctx) => compileStep(tx, ctx, who('head'), back.id, draft));
    await act('head', back.id, { type: 'CompleteStep', result: draft });
    expect(stepOf(await runOf('deputy', run.id), 'soatxet')).toMatchObject({ state: 'ready' });
  });

  it('văn bản mật: sau Giám đốc còn Chủ tịch duyệt cuối, rồi mới tới văn thư; Chủ tịch chưa đồng ý thì quay về người soạn', async () => {
    const run = await upToTonghop({ mucMat: 'mat' }, 'Báo cáo mật');
    await finishDraft(run);
    await approveUpToDirector(run);
    const ct = stepOf(await runOf('chairman', run.id), 'chutich');
    expect(ct).toMatchObject({ state: 'ready', assignee: { id: org.users.chairman } });
    // Văn bản mật hạn chế người xem: người soạn (chủ sở hữu) xem tình trạng.
    expect(stepOf(await runOf('head', run.id), 'capso').state).toBe('pending');
    await act('chairman', ct.id, { type: 'RejectStep', reason: 'Cần làm rõ căn cứ pháp lý.' });
    expect(stepOf(await runOf('head', run.id), 'tonghop')).toMatchObject({ state: 'ready' });
    expect(stepOf(await runOf('head', run.id), 'capso').state).not.toBe('ready');
  });

  it('người soạn chọn "Trình Chủ tịch duyệt cuối" (văn bản không mật): Chủ tịch là người duyệt cuối; đồng ý thì văn thư cấp số, chưa đồng ý thì quay về người soạn và đi lại', async () => {
    const run = await upToTonghop({ trinhChuTich: 'co' }, 'Báo cáo trình Chủ tịch');
    await finishDraft(run);
    await approveUpToDirector(run);
    // Giám đốc đã duyệt nhưng văn thư chưa tới lượt: còn Chủ tịch.
    const afterDirector = await runOf('chairman', run.id);
    const ct = stepOf(afterDirector, 'chutich');
    expect(ct).toMatchObject({ state: 'ready', assignee: { id: org.users.chairman } });
    expect(stepOf(afterDirector, 'capso').state).toBe('pending');

    // Chủ tịch chưa đồng ý: về người soạn, xuất tệp mới, đi lại từ soát xét, Giám đốc rồi lại tới Chủ tịch.
    await act('chairman', ct.id, { type: 'RejectStep', reason: 'Chưa đủ căn cứ.' });
    const back = stepOf(await runOf('head', run.id), 'tonghop');
    expect(back).toMatchObject({ state: 'ready', compile: { hasFile: false } });
    const draft = { duThao: 'Đã bổ sung căn cứ pháp lý.' };
    await org.run((tx, ctx) => compileStep(tx, ctx, who('head'), back.id, draft));
    await act('head', back.id, { type: 'CompleteStep', result: draft });
    await approveUpToDirector(run);
    const again = stepOf(await runOf('chairman', run.id), 'chutich');
    expect(again).toMatchObject({ state: 'ready' });
    expect(again.id).not.toBe(ct.id);
    expect(stepOf(await runOf('officeAdmin', run.id), 'capso').state).not.toBe('ready');
    await act('chairman', again.id, { type: 'ApproveStep', comment: 'Đồng ý.' });
    expect(stepOf(await runOf('officeAdmin', run.id), 'capso')).toMatchObject({ state: 'ready', assignee: { id: org.users.officeAdmin } });
  });

  it('"Không trình Chủ tịch" và để trống đều không qua Chủ tịch; "Có" hoặc mức mật khác thường thì qua', async () => {
    for (const [over, viaChairman] of [
      [{ trinhChuTich: 'khong' }, false],
      [{ trinhChuTich: 'co' }, true],
      [{ mucMat: 'tuyet_mat', trinhChuTich: 'khong' }, true],
    ] as const) {
      const run = await upToTonghop(over, `Rẽ nhánh ${JSON.stringify(over)}`);
      await finishDraft(run);
      await approveUpToDirector(run);
      const after = await runOf('head', run.id);
      expect(stepOf(after, 'chutich').state === 'ready', JSON.stringify(over)).toBe(viaChairman);
      expect(stepOf(after, 'capso').state === 'ready', JSON.stringify(over)).toBe(!viaChairman);
    }
  });

  it('mẫu hợp lệ: Chủ tịch là nút duyệt cuối (finalApproval) và không còn nút duyệt nào sau nó', () => {
    const preset = loadPresets().find((p) => p.id === 'van-ban-di')!;
    const chutich = (preset.definition.nodes as { id: string; finalApproval?: boolean; approvers?: unknown }[]).find((n) => n.id === 'chutich')!;
    expect(chutich.finalApproval).toBe(true);
    const checked = validate(preset.definition as unknown as DraftDefinition);
    expect(checked.errors).toEqual([]);
  });

  it('mẫu số văn bản đi do tổ chức đặt: đổi mẫu thì số kế tiếp đổi theo', async () => {
    await org.run((tx, ctx) => upsertRegister(tx, ctx, who('itAdmin'), 'VBDI', { name: 'Sổ văn bản đi', direction: 'outgoing', pattern: '{seq}/VRG-VP', resetPolicy: 'yearly', columns: [{ key: 'noiNhan', label: 'Nơi nhận' }, { key: 'nguoiKy', label: 'Người ký' }] }));
    const run = await upToTonghop({}, 'Báo cáo dùng mẫu số mới');
    await finishDraft(run);
    await approveUpToDirector(run);
    await act('officeAdmin', stepOf(await runOf('officeAdmin', run.id), 'capso').id, { type: 'CompleteStep', result: issueBody({ nguoiKy: 'chu_tich' }) });
    const afterNumber = stepOf(await runOf('head', run.id), 'capso').result?.['soVanBan'];
    expect(afterNumber).toMatch(/^\d+\/VRG-VP$/);
    const entries = await org.run((tx, ctx) => listEntries(tx, ctx, who('head'), 'VBDI', { limit: 50 }));
    expect(entries.items.find((e) => e.number === afterNumber)).toMatchObject({ subject: 'V/v báo cáo tình hình hoạt động quý IV', values: { noiNhan: 'Tập đoàn Công nghiệp Cao su Việt Nam', nguoiKy: 'chu_tich', __nhan: { nguoiKy: 'Chủ tịch' } } });
  });
});
