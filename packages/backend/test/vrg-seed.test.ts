import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, schema, withOrg } from '../src/db/client';
import { loadOrgContext } from '../src/context';
import { seedDemoOrg, generateSeedIds, type SeedIds } from '../src/seed/org';
import { seedVrgScenario } from '../src/seed/vrg';
import { listEntries, listRegisters } from '../src/services/registers';
import { listRuns } from '../src/services/runs';
import { listTemplates } from '../src/services/templates';
import { viewerForUser } from '../src/services/proposals';
import { MemoryFileStorage, setFileStorage } from '../src/storage';

/**
 * Dữ liệu mẫu theo đề cương VRG (docs/DECISIONS.md, 06/10/2026) dựng trên một tổ chức mẫu mới: Chủ tịch ra chỉ thị, Giám đốc nhận,
 * Phó giám đốc và các trưởng phòng thực hiện, Văn phòng làm văn thư. Chạy lặp lại không tạo trùng.
 */
let ids: SeedIds;
beforeAll(async () => {
  setFileStorage(new MemoryFileStorage());
  ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  await seedDemoOrg(ids, { code: `vrg-${tag}`, name: 'Công ty CP Phát triển Đô thị và Khu công nghiệp Cao su Việt Nam', emailDomain: `vrg-${tag}.test` });
});
afterAll(async () => {
  setFileStorage(null);
  await closeDb();
});

const view = <T>(userId: string, fn: (tx: Parameters<Parameters<typeof withOrg>[1]>[0], ctx: Awaited<ReturnType<typeof loadOrgContext>>, v: NonNullable<ReturnType<typeof viewerForUser>>) => Promise<T>) =>
  withOrg(ids.ORG, async (tx) => {
    const ctx = await loadOrgContext(tx, ids.ORG);
    return fn(tx, ctx, viewerForUser(ctx, userId)!);
  });

describe('kịch bản VRG', () => {
  it('nạp được, chạy lặp lại không tạo trùng; có người, đơn vị, sổ, ba quy trình và các lượt chạy minh hoạ', async () => {
    const first = await seedVrgScenario(ids, { password: 'mat-khau-thu', withRuns: true });
    expect(first.users.map((u) => u.role)).toEqual(['deputy', 'employee', 'employee', 'employee']);
    await seedVrgScenario(ids, { password: 'mat-khau-thu', withRuns: true });

    const counts = await withOrg(ids.ORG, async (tx) => ({
      units: (await tx.select().from(schema.units)).map((u) => u.name).sort(),
      templates: (await tx.select().from(schema.processTemplates).where(eq(schema.processTemplates.kind, 'process'))).map((t) => [t.name, t.category]).sort(),
      runs: (await tx.select().from(schema.processRuns)).length,
      users: (await tx.select().from(schema.users)).length,
    }));
    expect(counts.units).toEqual(expect.arrayContaining(['Nhân sự', 'Vận hành KCN']));
    expect(counts.templates).toEqual(
      expect.arrayContaining([['Chỉ thị của Chủ tịch', 'directive'], ['Văn bản đến', 'incoming'], ['Văn bản đi', 'outgoing']]),
    );
    expect(counts.runs).toBe(7); // bảy lượt chạy minh hoạ, không nhân đôi khi nạp lại
    expect(counts.users).toBe(12 + 4);
  });

  it('Chủ tịch chỉ khởi chạy được chỉ thị; Giám đốc nhận chỉ thị và chưa ra chỉ thị được; Văn phòng làm văn thư', async () => {
    const startable = async (userId: string) => (await view(userId, (tx, ctx, v) => listTemplates(tx, ctx, v))).filter((t) => t.canStart).map((t) => t.name).sort();
    expect(await startable(ids.users.U_CHAIRMAN)).toEqual(['Chỉ thị của Chủ tịch', 'Văn bản đi', 'Đón đoàn nhà đầu tư thăm KCN'].sort());
    expect(await startable(ids.users.U_DIRECTOR)).toEqual(['Văn bản đi', 'Đón đoàn nhà đầu tư thăm KCN'].sort());
    expect(await startable(ids.users.U_ADMIN)).toEqual(['Văn bản đi', 'Văn bản đến', 'Đón đoàn nhà đầu tư thăm KCN'].sort());
    // Nhân viên chỉ soạn văn bản đi.
    expect(await startable(ids.users.U_LAN)).toEqual(['Văn bản đi']);
  });

  it('các lượt chạy minh hoạ ở đúng trạng thái và đúng người nhận việc', async () => {
    const runs = await view(ids.users.U_CHAIRMAN, (tx, ctx, v) => listRuns(tx, ctx, v, { limit: 50, sort: '-startedAt' }));
    const byTitle = new Map(runs.items.map((r) => [r.title, r]));
    expect(byTitle.get('Chỉ thị: Chuẩn bị tổng kết hoạt động năm')?.state).toBe('completed');
    expect(byTitle.get('Báo cáo tình hình nhân sự quý III')?.state).toBe('completed');
    // Chỉ thị khẩn mang nhãn mức khẩn trên tiêu đề.
    expect(byTitle.get('[KHẨN] Chỉ thị: Đẩy nhanh thu hồi công nợ quý IV')?.state).toBe('running');

    const stepsOf = async (title: string) => {
      const run = byTitle.get(title)!;
      const detail = await view(ids.users.U_CHAIRMAN, async (tx, ctx, v) => (await import('../src/services/runs')).getRun(tx, ctx, v, run.id));
      return new Map(detail.steps.map((s) => [s.nodeId, s]));
    };
    // Chỉ thị mới ra: chờ Giám đốc.
    expect((await stepsOf('Chỉ thị: Rà soát quỹ đất trống tại các khu công nghiệp')).get('nhan')).toMatchObject({ state: 'ready', assignee: { id: ids.users.U_DIRECTOR } });
    // Chỉ thị đang thực hiện: Phó giám đốc Huy chủ trì và còn nợ phần của mình.
    const running = await stepsOf('[KHẨN] Chỉ thị: Đẩy nhanh thu hồi công nợ quý IV');
    expect(running.get('thuchien')?.participants?.filter((p) => p.decision === 'approved')).toHaveLength(2);
    expect(running.get('thuchien')?.participants?.find((p) => p.decision === null)?.person.id).toBe(ids.users.U_HUY);
    // Văn bản mật: chờ Chủ tịch; văn bản đi chờ Giám đốc duyệt và đã có tệp Word trình duyệt.
    expect((await stepsOf('Thông báo mật 88/TĐ-TCNS của Tập đoàn')).get('chutich')).toMatchObject({ state: 'ready', assignee: { id: ids.users.U_CHAIRMAN } });
    const approval = await stepsOf('Tờ trình xin chủ trương đầu tư hạ tầng giai đoạn 2');
    expect(approval.get('duyet')).toMatchObject({ state: 'ready', assignee: { id: ids.users.U_DIRECTOR } });
    expect(approval.get('tonghop')?.files?.some((f) => f.compiled && f.name.endsWith('.docx'))).toBe(true);
    // Văn bản đến đang xử lý: Giám đốc đã chọn hướng "giao xử lý" và phân công; Khải chủ trì còn nợ phần của mình.
    const incoming = await stepsOf('Công văn 2345/UBND-KT về kiểm tra phòng cháy chữa cháy');
    expect(incoming.get('phancong')?.state).toBe('done');
    expect(incoming.get('xuly')?.participants?.find((p) => p.decision === null)?.person.fullName).toBe('Trần Văn Khải');
    // Văn bản đi đã ban hành: văn thư đã cấp số, đóng dấu (hai việc riêng) và đính bản chính kèm bằng chứng gửi đi.
    const done = await stepsOf('Báo cáo tình hình nhân sự quý III');
    expect(done.get('capso')).toMatchObject({ state: 'done' });
    expect(done.get('dongdau')).toMatchObject({ state: 'done' });
    expect(done.get('dongdau')?.files?.map((f) => f.name).sort()).toEqual(['bao-cao-nhan-su-quy-iii-da-ky.pdf', 'phieu-gui-bao-cao-nhan-su-quy-iii.pdf']);
    // Tờ trình trình Chủ tịch duyệt cuối: đang chờ Giám đốc, Chủ tịch chưa tới lượt.
    expect(approval.get('chutich')?.state).not.toBe('ready');
  });

  it('sổ văn bản có số đã cấp theo mẫu của VRG', async () => {
    const registers = await view(ids.users.U_ADMIN, (tx, ctx, v) => listRegisters(tx, ctx, v));
    expect(Object.fromEntries(registers.map((r) => [r.code, r.pattern]))).toEqual({ VBDEN: '{seq:4}', VBDI: '{seq}/VRG-VP', CHITHI: '{seq:2}/CT-VRG' });
    const di = await view(ids.users.U_ADMIN, (tx, ctx, v) => listEntries(tx, ctx, v, 'VBDI', { limit: 10 }));
    expect(di.items.map((e) => e.number)).toEqual(['1/VRG-VP']);
    // Sổ hiện nhãn (không phải mã thô) và đủ người ký, số lượng bản, ngày ban hành; trích yếu lấy từ ô trích yếu.
    expect(di.items[0]).toMatchObject({
      subject: 'Báo cáo tình hình nhân sự quý III',
      values: { nguoiKy: 'giam_doc', soLuongBan: 3, noiNhan: 'Tập đoàn Công nghiệp Cao su Việt Nam', __nhan: { loaiVanBan: 'Báo cáo', mucKhan: 'Thường', mucMat: 'Thường', nguoiKy: 'Giám đốc' } },
    });
    expect(di.items[0]!.values).toHaveProperty('ngayBanHanh');
    const den = await view(ids.users.U_ADMIN, (tx, ctx, v) => listEntries(tx, ctx, v, 'VBDEN', { limit: 10 }));
    expect(den.items.map((e) => e.number).sort()).toEqual(['0001', '0002']);
    // Văn bản đến: ngày văn bản, loại, hạn xử lý, người chủ trì (sau khi Giám đốc phân công).
    const cv = den.items.find((e) => e.number === '0001')!;
    expect(cv).toMatchObject({ subject: 'V/v kiểm tra công tác phòng cháy chữa cháy tại các khu công nghiệp', values: { soKyHieu: '2345/UBND-KT', loaiVanBan: 'cong_van', mucKhan: 'khan', __nhan: { loaiVanBan: 'Công văn', mucKhan: 'Khẩn', mucMat: 'Thường', chuTri: 'Trần Văn Khải' } } });
    expect(cv.values).toHaveProperty('ngayVanBan');
    expect(cv.values).toHaveProperty('hanXuLy');
    const ct = await view(ids.users.U_CHAIRMAN, (tx, ctx, v) => listEntries(tx, ctx, v, 'CHITHI', { limit: 10 }));
    expect(ct.items.map((e) => e.number).sort()).toEqual(['01/CT-VRG', '02/CT-VRG', '03/CT-VRG']);
  });
});

