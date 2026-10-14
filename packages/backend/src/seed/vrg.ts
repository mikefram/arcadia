import { addCalendarDays, toLocalDate } from '@mihato/domain/calendar';
import { deterministicId, newId, type Role } from '@mihato/domain';
import { stripDiacritics } from '@mihato/domain/vi-normalize';
import { desc, eq, inArray } from 'drizzle-orm';
import { clock } from '../clock';
import { loadOrgContext } from '../context';
import { schema, withOrg, type Tx } from '../db/client';
import { compileStep } from '../services/compile';
import { uploadFile } from '../services/files';
import { loadPresets, presetDefinition } from '../services/presets';
import { DEFAULT_REGISTERS, upsertRegister } from '../services/registers';
import { actOnStep, getRun, startRun } from '../services/runs';
import { createTemplate, publishTemplate, saveTemplateDraft } from '../services/templates';
import { viewerForUser } from '../services/proposals';
import type { Viewer } from '../views';
import { SEED_USERS, type SeedIds, type UserCode } from './org';
import { hashPassword } from '../auth/crypto';

/**
 * Dữ liệu mẫu theo đề cương VRG (docs/DECISIONS.md, 06/10/2026), cộng thêm lên tổ chức mẫu có sẵn:
 * Chủ tịch RA CHỈ THỊ, Giám đốc NHẬN chỉ thị và phân công, Phó giám đốc cùng các trưởng phòng THỰC HIỆN; Văn phòng làm văn thư.
 * Gồm: hai đơn vị (Vận hành KCN, Nhân sự), một Phó giám đốc và ba nhân sự, ba sổ văn bản, ba quy trình mẫu đã xuất bản
 * (Chỉ thị, Văn bản đến, Văn bản đi), và các lượt chạy minh hoạ ở nhiều trạng thái kèm tệp thật.
 * Chạy lặp lại không tạo trùng. Không thêm vào `seedDemoOrg` để các test dùng bộ dữ liệu cũ không đổi.
 */


type ExtraUser = { key: string; fullName: string; givenName: string; honorific: string; role: Role; unit: 'board' | 'operations' | 'hr'; manager: UserCode | 'phuoc'; email: string };
const EXTRA_UNITS = [
  { key: 'operations', name: 'Vận hành KCN' },
  { key: 'hr', name: 'Nhân sự' },
] as const;
export const EXTRA_USERS: ExtraUser[] = [
  { key: 'phuoc', fullName: 'Nguyễn Hữu Phước', givenName: 'Phước', honorific: 'ong', role: 'deputy', unit: 'board', manager: 'U_DIRECTOR', email: 'phuoc' },
  { key: 'khai', fullName: 'Trần Văn Khải', givenName: 'Khải', honorific: 'anh', role: 'employee', unit: 'operations', manager: 'phuoc', email: 'khai' },
  { key: 'ha', fullName: 'Vũ Thanh Hà', givenName: 'Hà', honorific: 'chi', role: 'employee', unit: 'operations', manager: 'phuoc', email: 'ha' },
  { key: 'huong', fullName: 'Lý Thị Hương', givenName: 'Hương', honorific: 'chi', role: 'employee', unit: 'hr', manager: 'phuoc', email: 'huong' },
];

/** Một tệp PDF một trang đủ để trình duyệt mở được. Chữ không dấu vì phông PDF chuẩn không có chữ Việt. */
export function demoPdf(title: string): Buffer {
  const text = stripDiacritics(title).replace(/[()\\]/g, ' ').slice(0, 90);
  const content = `BT /F1 16 Tf 72 740 Td (${text}) Tj ET\nBT /F1 11 Tf 72 710 Td (Tep minh hoa cua du lieu mau MIHATO) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** JSON có thứ tự khoá cố định, để so hai định nghĩa cùng nội dung mà khác thứ tự khoá. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export type VrgSeedOptions = { password: string; withRuns: boolean };

export async function seedVrgScenario(ids: SeedIds, opts: VrgSeedOptions): Promise<{ users: { email: string; role: Role; fullName: string }[] }> {
  const passwordHash = await hashPassword(opts.password);
  // Id tất định theo tổ chức (nạp lại không tạo trùng, hai tổ chức không giẫm id nhau); nếu người hay đơn vị đã có sẵn
  // (nạp bằng bản cũ của kịch bản này) thì dùng lại đúng id đó.
  const salt = (key: string): string => deterministicId(`vrg-demo:${ids.ORG}:${key}`);
  const known = await withOrg(ids.ORG, async (tx) => ({
    users: new Map((await tx.select({ id: schema.users.id, email: schema.users.email }).from(schema.users)).map((u) => [u.email, u.id])),
    units: new Map((await tx.select({ id: schema.units.id, name: schema.units.name }).from(schema.units)).map((u) => [u.name, u.id])),
  }));
  const unitIds: Record<string, string> = {};
  for (const u of EXTRA_UNITS) unitIds[u.key] = known.units.get(u.name) ?? salt(`unit:${u.key}`);
  const extraIds: Record<string, string> = {};
  for (const u of EXTRA_USERS) extraIds[u.key] = known.users.get(`${u.email}@demo.mihato.local`) ?? salt(`user:${u.key}`);
  const unitId = (k: 'board' | 'operations' | 'hr') => (k === 'board' ? ids.units.board : unitIds[k]!);
  const userId = (k: string) => extraIds[k] ?? ids.users[k as UserCode];

  // 1. Đơn vị và người
  await withOrg(ids.ORG, async (tx) => {
    const now = clock.now();
    for (const u of EXTRA_UNITS) await tx.insert(schema.units).values({ id: unitIds[u.key]!, orgId: ids.ORG, name: u.name }).onConflictDoNothing();
    for (const [i, u] of EXTRA_USERS.entries()) {
      await tx
        .insert(schema.users)
        .values({
          id: userId(u.key),
          orgId: ids.ORG,
          fullName: u.fullName,
          givenName: u.givenName,
          honorific: u.honorific,
          email: `${u.email}@demo.mihato.local`,
          unitId: unitId(u.unit),
          uiProfile: 'standard',
          displayOrder: SEED_USERS.length + i,
          status: 'active',
          passwordHash,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
    for (const u of EXTRA_USERS) {
      await tx.update(schema.users).set({ managerId: userId(u.manager) }).where(eq(schema.users.id, userId(u.key)));
      const existing = await tx.select({ id: schema.userRoles.id }).from(schema.userRoles).where(eq(schema.userRoles.userId, userId(u.key)));
      if (existing.length === 0) await tx.insert(schema.userRoles).values({ id: newId(), orgId: ids.ORG, userId: userId(u.key), role: u.role, unitId: null });
    }
    // Trưởng đơn vị của hai đơn vị mới. Các đơn vị cũ giữ nguyên để không đổi hành vi của dữ liệu mẫu đã có.
    await tx.update(schema.units).set({ headUserId: userId('khai') }).where(eq(schema.units.id, unitIds['operations']!));
    await tx.update(schema.units).set({ headUserId: userId('huong') }).where(eq(schema.units.id, unitIds['hr']!));
  });

  // 2. Sổ văn bản (mẫu số theo thông lệ văn thư của VRG), ba quy trình mẫu đã xuất bản
  await withOrg(ids.ORG, async (tx) => {
    const ctx = await loadOrgContext(tx, ids.ORG);
    const it = viewerOf(ctx, ids.users.U_IT);
    const patterns: Record<string, string> = { VBDEN: '{seq:4}', VBDI: '{seq}/VRG-VP', CHITHI: '{seq:2}/CT-VRG' };
    for (const [code, preset] of Object.entries(DEFAULT_REGISTERS)) await upsertRegister(tx, ctx, it, code, { ...preset, pattern: patterns[code] ?? preset.pattern });
    const designer = viewerOf(ctx, ids.users.U_DESIGNER);
    for (const p of loadPresets()) {
      const [existing] = await tx.select({ id: schema.processTemplates.id }).from(schema.processTemplates).where(eq(schema.processTemplates.name, p.name));
      if (!existing) {
        const created = await createTemplate(tx, ctx, designer, { name: p.name, description: p.description, category: p.category, definition: p.definition });
        await publishTemplate(tx, ctx, designer, created.id);
        continue;
      }
      // Mẫu đã có nhưng bản xuất bản khác bản mẫu hiện hành (mẫu được sửa sau khi nạp lần đầu): xuất bản phiên bản mới, lượt chạy cũ giữ phiên bản cũ.
      const [latest] = await tx
        .select({ definition: schema.processTemplateVersions.definition, status: schema.processTemplateVersions.status, rev: schema.processTemplateVersions.draftRev })
        .from(schema.processTemplateVersions)
        .where(eq(schema.processTemplateVersions.templateId, existing.id))
        .orderBy(desc(schema.processTemplateVersions.version))
        .limit(1);
      if (latest?.status === 'published' && canonical(latest.definition) !== canonical(presetDefinition(p.id))) {
        await saveTemplateDraft(tx, designer, existing.id, { definition: p.definition }, String(latest.rev));
        await publishTemplate(tx, ctx, designer, existing.id);
      }
    }
  });

  if (opts.withRuns) await seedRuns(ids, userId);

  return {
    users: EXTRA_USERS.map((u) => ({ email: `${u.email}@demo.mihato.local`, role: u.role, fullName: u.fullName })),
  };
}

function viewerOf(ctx: Awaited<ReturnType<typeof loadOrgContext>>, userId: string): Viewer {
  const v = viewerForUser(ctx, userId);
  if (!v) throw new Error('Không dựng được người dùng mẫu');
  return v;
}

// ───────────────────────── Các lượt chạy minh hoạ ─────────────────────────

async function seedRuns(ids: SeedIds, userId: (k: string) => string): Promise<void> {
  // Đã nạp rồi thì thôi (kể cả bản nạp cũ, khi tiêu đề chưa có nhãn mức khẩn).
  const exists = await withOrg(ids.ORG, async (tx) => (await tx.select({ id: schema.processRuns.id }).from(schema.processRuns).where(inArray(schema.processRuns.title, [TITLES.directiveRunning, 'Chỉ thị: Đẩy nhanh thu hồi công nợ quý IV']))).length > 0);
  if (exists) return;

  const U = {
    chairman: ids.users.U_CHAIRMAN,
    director: ids.users.U_DIRECTOR,
    huy: ids.users.U_HUY,
    phuoc: userId('phuoc'),
    lan: ids.users.U_LAN,
    ngocanh: ids.users.U_NGOCANH,
    tuan: ids.users.U_TUAN,
    phuong: ids.users.U_PHUONG,
    khai: userId('khai'),
    ha: userId('ha'),
    huong: userId('huong'),
    office: ids.users.U_ADMIN,
  };
  const today = (n: number): string => addCalendarDays(toLocalDate(clock.now(), { utcOffsetMinutes: 420, workdays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', holidays: [] }), n);

  const step = (run: Awaited<ReturnType<typeof getRun>>, nodeId: string) => {
    const s = run.steps.find((x) => x.nodeId === nodeId);
    if (!s) throw new Error(`Không có bước ${nodeId}`);
    return s;
  };

  /** Chạy một bước trong giao dịch riêng, thay một người; trả lượt chạy sau khi áp. */
  async function as<T>(user: string, fn: (tx: Tx, ctx: Awaited<ReturnType<typeof loadOrgContext>>, v: Viewer) => Promise<T>): Promise<T> {
    return withOrg(ids.ORG, async (tx) => {
      const ctx = await loadOrgContext(tx, ids.ORG);
      return fn(tx, ctx, viewerOf(ctx, user));
    });
  }
  const templateId = async (name: string) => withOrg(ids.ORG, async (tx) => (await tx.select({ id: schema.processTemplates.id }).from(schema.processTemplates).where(eq(schema.processTemplates.name, name)))[0]!.id);
  const upload = (user: string, name: string, title: string) => as(user, (tx, ctx, v) => uploadFile(tx, ctx, v, { name, data: demoPdf(title).toString('base64') }));
  const begin = (user: string, tpl: string, title: string, inputs: Record<string, unknown>) => as(user, (tx, ctx, v) => startRun(tx, ctx, v, { templateId: tpl, title, inputs }, newId()));
  const act = (user: string, stepId: string, input: Parameters<typeof actOnStep>[5]) => as(user, (tx, ctx, v) => actOnStep(tx, ctx, v, stepId, newId(), input));
  const get = (user: string, runId: string) => as(user, (tx, ctx, v) => getRun(tx, ctx, v, runId));
  const compile = (user: string, stepId: string, result: Record<string, unknown>) => as(user, (tx, ctx, v) => compileStep(tx, ctx, v, stepId, result));

  const chiThi = await templateId('Chỉ thị của Chủ tịch');
  const vbDen = await templateId('Văn bản đến');
  const vbDi = await templateId('Văn bản đi');

  // ── Chỉ thị 1: đang thực hiện (hai người đã gửi, người chủ trì chưa) ──
  {
    const tep = await upload(U.chairman, 'chi-thi-cong-no-quy-iv.pdf', 'Chi thi: day nhanh thu hoi cong no quy IV');
    const run = await begin(U.chairman, chiThi, TITLES.directiveRunning, {
      tieuDe: 'Đẩy nhanh thu hồi công nợ quý IV',
      noiDung: 'Các đơn vị rà soát toàn bộ khoản phải thu quá hạn trên 30 ngày, lập kế hoạch thu hồi và báo cáo kết quả trước hạn. Ưu tiên các khách thuê có hợp đồng sắp hết hạn.',
      mucKhan: 'khan',
      hanHoanThanh: today(10),
      tep: [tep.id],
    });
    await act(U.director, step(run, 'nhan').id, {
      type: 'CompleteStep',
      result: { yKien: 'Phó giám đốc Huy chủ trì. Kế toán lập danh sách công nợ, Kinh doanh làm việc trực tiếp với từng khách thuê.', chuTri: U.huy, phoiHop: [U.phuong, U.lan] },
    });
    const gui = step(await get(U.huy, run.id), 'thuchien');
    const bang = await upload(U.phuong, 'danh-sach-cong-no.pdf', 'Danh sach cong no qua han tren 30 ngay');
    await act(U.phuong, gui.id, { type: 'ApproveStep', result: { ketQua: 'Đã lập danh sách 14 khoản phải thu quá hạn, tổng 8,2 tỷ đồng. Gửi kèm bảng chi tiết.', tep: [bang.id] } });
    await act(U.lan, gui.id, { type: 'ApproveStep', result: { ketQua: 'Đã hẹn lịch làm việc với 9 trên 14 khách thuê trong tuần này.' } });
  }

  // ── Chỉ thị 2: vừa ra, chờ Giám đốc tiếp nhận ──
  await begin(U.chairman, chiThi, TITLES.directiveNew, {
    tieuDe: 'Rà soát quỹ đất trống tại các khu công nghiệp',
    noiDung: 'Lập báo cáo hiện trạng quỹ đất và nhà xưởng còn trống theo từng khu công nghiệp, phân khu; đề xuất phương án khai thác.',
    mucKhan: 'thuong',
    hanHoanThanh: today(21),
  });

  // ── Chỉ thị 0: đã hoàn tất ──
  {
    const run = await begin(U.chairman, chiThi, TITLES.directiveDone, {
      tieuDe: 'Chuẩn bị tổng kết hoạt động năm',
      noiDung: 'Các đơn vị tổng hợp kết quả hoạt động năm, chuẩn bị tài liệu cho hội nghị tổng kết.',
      mucKhan: 'thuong',
      hanHoanThanh: today(20),
    });
    await act(U.director, step(run, 'nhan').id, { type: 'CompleteStep', result: { yKien: 'Ông Phước chủ trì, các phòng phối hợp.', chuTri: U.phuoc, phoiHop: [U.khai, U.huong] } });
    const gui = step(await get(U.phuoc, run.id), 'thuchien');
    await act(U.khai, gui.id, { type: 'ApproveStep', result: { ketQua: 'Vận hành KCN: tỷ lệ lấp đầy đạt 91%, không có sự cố lớn.' } });
    await act(U.huong, gui.id, { type: 'ApproveStep', result: { ketQua: 'Nhân sự: hoàn thành đánh giá cuối năm, 100% hồ sơ đầy đủ.' } });
    await act(U.phuoc, gui.id, { type: 'ApproveStep', result: { ketQua: 'Tổng hợp chung toàn công ty đã hoàn tất.' } });
    const tong = step(await get(U.phuoc, run.id), 'tonghop');
    const baoCao = { baoCao: 'Các đơn vị đã hoàn thành tổng hợp. Tài liệu hội nghị sẵn sàng.' };
    await compile(U.phuoc, tong.id, baoCao);
    await act(U.phuoc, tong.id, { type: 'CompleteStep', result: baoCao });
    await act(U.chairman, step(await get(U.chairman, run.id), 'xacnhan').id, { type: 'ApproveStep', comment: 'Đạt yêu cầu.' });
  }

  // ── Văn bản đến 1: Giám đốc đã phân công, đang xử lý ──
  {
    const scan = await upload(U.office, 'cong-van-2345-ubnd.pdf', 'Cong van 2345 UBND: kiem tra phong chay chua chay');
    const run = await begin(U.office, vbDen, TITLES.incomingRunning, {
      trichYeu: 'V/v kiểm tra công tác phòng cháy chữa cháy tại các khu công nghiệp',
      noiGui: 'Ủy ban nhân dân tỉnh',
      soKyHieu: '2345/UBND-KT',
      ngayVanBan: today(-2),
      loaiVanBan: 'cong_van',
      mucKhan: 'khan',
      mucMat: 'thuong',
      hanXuLy: today(7),
      tep: [scan.id],
    });
    await act(U.director, step(run, 'giamdoc').id, {
      type: 'CompleteStep',
      result: { yKien: 'Vận hành KCN chủ trì rà soát hệ thống PCCC, Kỹ thuật phối hợp. Báo cáo trước hạn.', huongXuLy: 'giao_xu_ly' },
    });
    await act(U.director, step(await get(U.director, run.id), 'phancong').id, { type: 'CompleteStep', result: { chuTri: U.khai, phoiHop: [U.tuan] } });
    const xuly = step(await get(U.khai, run.id), 'xuly');
    await act(U.tuan, xuly.id, { type: 'ApproveStep', result: { ketQua: 'Đã kiểm tra bình chữa cháy và hệ thống báo cháy khu A, B; phát hiện 6 bình hết hạn.' } });
  }

  // ── Văn bản đến 2 (mật): chờ Chủ tịch xem ──
  {
    const scan = await upload(U.office, 'thong-bao-mat-tap-doan.pdf', 'Thong bao mat cua Tap doan');
    await begin(U.office, vbDen, TITLES.incomingSecret, {
      trichYeu: 'V/v nhân sự cấp cao (mật)',
      noiGui: 'Tập đoàn Công nghiệp Cao su Việt Nam',
      soKyHieu: '88/TĐ-TCNS',
      ngayVanBan: today(-1),
      loaiVanBan: 'thong_bao',
      mucKhan: 'thuong',
      mucMat: 'mat',
      hanXuLy: today(5),
      tep: [scan.id],
    });
  }

  // ── Văn bản đi 1: đã tổng hợp và xuất tệp Word, chờ Giám đốc duyệt ──
  {
    const tham = await upload(U.lan, 'ke-hoach-ha-tang-gd2.pdf', 'Ke hoach ha tang giai doan 2');
    const run = await begin(U.lan, vbDi, TITLES.outgoingApproval, {
      trichYeu: 'Tờ trình xin chủ trương đầu tư hạ tầng giai đoạn 2',
      loaiVanBan: 'to_trinh',
      noiNhan: 'Hội đồng quản trị',
      mucKhan: 'thuong',
      mucMat: 'thuong',
      phoiHop: [U.phuong, U.ngocanh, U.tuan],
      // Tờ trình gửi Hội đồng quản trị: người soạn trình Chủ tịch duyệt cuối (sau Giám đốc).
      trinhChuTich: 'co',
      hanHoanThanh: today(8),
      tep: [tham.id],
    });
    const gop = step(run, 'gop');
    await act(U.phuong, gop.id, { type: 'ApproveStep', result: { noiDung: 'Kế toán: tổng mức đầu tư dự kiến 120 tỷ đồng; nguồn vốn từ lợi nhuận giữ lại và vay ngân hàng.' } });
    await act(U.ngocanh, gop.id, { type: 'ApproveStep', result: { noiDung: 'Pháp chế: quỹ đất đã đủ điều kiện pháp lý; cần hoàn tất thủ tục điều chỉnh quy hoạch chi tiết.' } });
    await act(U.tuan, gop.id, { type: 'ApproveStep', result: { noiDung: 'Kỹ thuật: phương án hạ tầng điện, nước, đường nội bộ đã có thiết kế cơ sở.' } });
    const tong = step(await get(U.lan, run.id), 'tonghop');
    const draft = {
      duThao: 'Kính trình Hội đồng quản trị xem xét, chấp thuận chủ trương đầu tư hạ tầng giai đoạn 2 theo nội dung các đơn vị đã góp ý dưới đây.',
      kienNghi: 'Đề nghị Hội đồng quản trị chấp thuận chủ trương và giao Ban Giám đốc triển khai các bước tiếp theo.',
    };
    await compile(U.lan, tong.id, draft);
    await act(U.lan, tong.id, { type: 'CompleteStep', result: draft });
    await act(U.huy, step(await get(U.huy, run.id), 'soatxet').id, { type: 'ApproveStep' });
  }

  // ── Văn bản đi 2: đã ban hành (cấp số, đóng dấu, đính bản chính và bằng chứng gửi đi) ──
  {
    const run = await begin(U.huong, vbDi, TITLES.outgoingDone, {
      trichYeu: 'Báo cáo tình hình nhân sự quý III',
      loaiVanBan: 'bao_cao',
      noiNhan: 'Tập đoàn Công nghiệp Cao su Việt Nam',
      mucKhan: 'thuong',
      mucMat: 'thuong',
      phoiHop: [U.khai],
      trinhChuTich: 'khong',
      hanHoanThanh: today(2),
    });
    await act(U.khai, step(run, 'gop').id, { type: 'ApproveStep', result: { noiDung: 'Vận hành KCN: 42 lao động, không biến động.' } });
    const tong = step(await get(U.huong, run.id), 'tonghop');
    const draft = { duThao: 'Kính báo cáo Tập đoàn tình hình nhân sự quý III năm nay: tổng số lao động ổn định, không có biến động lớn.' };
    await compile(U.huong, tong.id, draft);
    await act(U.huong, tong.id, { type: 'CompleteStep', result: draft });
    await act(U.phuoc, step(await get(U.phuoc, run.id), 'soatxet').id, { type: 'ApproveStep' });
    await act(U.director, step(await get(U.director, run.id), 'duyet').id, { type: 'ApproveStep', comment: 'Đồng ý ban hành.' });
    // Văn thư cấp số và ghi ngày ban hành trước, rồi đóng dấu, đính bản chính đã ký và bằng chứng gửi đi.
    await act(U.office, step(await get(U.office, run.id), 'capso').id, { type: 'CompleteStep', result: { ngayBanHanh: today(0), nguoiKy: 'giam_doc', soLuongBan: 3 } });
    const signed = await upload(U.office, 'bao-cao-nhan-su-quy-iii-da-ky.pdf', 'Bao cao tinh hinh nhan su quy III (ban chinh)');
    const sent = await upload(U.office, 'phieu-gui-bao-cao-nhan-su-quy-iii.pdf', 'Phieu gui bao cao nhan su quy III (bang chung gui di)');
    await act(U.office, step(await get(U.office, run.id), 'dongdau').id, { type: 'CompleteStep', result: { banChinh: [signed.id], bangChungGuiDi: [sent.id], noiLuu: 'Tủ hồ sơ Văn phòng, ngăn 2' } });
  }
}

const TITLES = {
  // Chỉ thị khẩn mang nhãn mức khẩn trên tiêu đề (máy chủ tự thêm khi khởi chạy).
  directiveRunning: '[KHẨN] Chỉ thị: Đẩy nhanh thu hồi công nợ quý IV',
  directiveNew: 'Chỉ thị: Rà soát quỹ đất trống tại các khu công nghiệp',
  directiveDone: 'Chỉ thị: Chuẩn bị tổng kết hoạt động năm',
  incomingRunning: 'Công văn 2345/UBND-KT về kiểm tra phòng cháy chữa cháy',
  incomingSecret: 'Thông báo mật 88/TĐ-TCNS của Tập đoàn',
  outgoingApproval: 'Tờ trình xin chủ trương đầu tư hạ tầng giai đoạn 2',
  outgoingDone: 'Báo cáo tình hình nhân sự quý III',
} as const;

