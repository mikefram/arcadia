import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_NUDGE_TEMPLATES, ProcessDefinitionSchema, defaultPermissions, newId, type ProcessDefinition, type Role } from '@mihato/domain';
import { validate } from '@mihato/workflow-engine';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/crypto';
import { clock } from '../clock';
import { schema, withOrg, type Tx } from '../db/client';
import { env } from '../env';
import type { Viewer } from '../views';

/**
 * Dữ liệu mẫu (SPEC 15.4): kịch bản vàng, bộ đánh giá AI và các test dùng chung bộ này.
 * Tên là tên giả; đơn vị và cấp trên là dữ liệu mẫu để test, không phản ánh tổ chức thật.
 */
export const USER_CODES = ['U_CHAIRMAN', 'U_DIRECTOR', 'U_HUY', 'U_LAN', 'U_NGOCANH', 'U_TUAN', 'U_PHUONG', 'U_HUNG', 'U_LAN2', 'U_ADMIN', 'U_IT', 'U_DESIGNER'] as const;
export type UserCode = (typeof USER_CODES)[number];
export const UNIT_CODES = ['chairman', 'board', 'sales', 'legal', 'tech', 'accounting', 'office'] as const;
export type UnitCode = (typeof UNIT_CODES)[number];

export type SeedIds = {
  ORG: string;
  users: Record<UserCode, string>;
  units: Record<UnitCode, string>;
  TEMPLATE_DON_DOAN: string;
  TEMPLATE_DON_DOAN_V1: string;
};

export function generateSeedIds(): SeedIds {
  return {
    ORG: newId(),
    users: Object.fromEntries(USER_CODES.map((c) => [c, newId()])) as Record<UserCode, string>,
    units: Object.fromEntries(UNIT_CODES.map((c) => [c, newId()])) as Record<UnitCode, string>,
    TEMPLATE_DON_DOAN: newId(),
    TEMPLATE_DON_DOAN_V1: newId(),
  };
}

const UNIT_NAMES: Record<UnitCode, string> = {
  chairman: 'Ban Chủ tịch',
  board: 'Ban Giám đốc',
  sales: 'Kinh doanh',
  legal: 'Pháp lý',
  tech: 'Kỹ thuật',
  accounting: 'Kế toán',
  office: 'Văn phòng',
};

type SeedUser = {
  code: UserCode;
  fullName: string;
  givenName: string;
  honorific: string | null;
  role: Role;
  unit: UnitCode;
  manager: UserCode | null;
  email: string;
  uiProfile: 'senior' | 'standard';
};

/** Bảng người dùng của ORG_DEMO ở SPEC 15.4, thêm tài khoản người vẽ quy trình để web quản trị dùng được ngay. */
export const SEED_USERS: SeedUser[] = [
  { code: 'U_CHAIRMAN', fullName: 'Trần Đức Minh', givenName: 'Minh', honorific: 'ong', role: 'chairman', unit: 'chairman', manager: null, email: 'chutich', uiProfile: 'senior' },
  { code: 'U_DIRECTOR', fullName: 'Lê Thanh Sơn', givenName: 'Sơn', honorific: 'ong', role: 'director', unit: 'board', manager: 'U_CHAIRMAN', email: 'giamdoc', uiProfile: 'standard' },
  { code: 'U_HUY', fullName: 'Phạm Quang Huy', givenName: 'Huy', honorific: 'ong', role: 'deputy', unit: 'board', manager: 'U_DIRECTOR', email: 'huy', uiProfile: 'standard' },
  { code: 'U_LAN', fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi', role: 'employee', unit: 'sales', manager: 'U_HUY', email: 'lan', uiProfile: 'standard' },
  { code: 'U_NGOCANH', fullName: 'Hoàng Ngọc Anh', givenName: 'Ngọc Anh', honorific: 'chi', role: 'employee', unit: 'legal', manager: 'U_HUY', email: 'ngocanh', uiProfile: 'standard' },
  { code: 'U_TUAN', fullName: 'Bùi Quốc Tuấn', givenName: 'Tuấn', honorific: 'anh', role: 'employee', unit: 'tech', manager: 'U_HUY', email: 'tuan', uiProfile: 'standard' },
  { code: 'U_PHUONG', fullName: 'Đặng Mai Phương', givenName: 'Phương', honorific: 'chi', role: 'employee', unit: 'accounting', manager: 'U_HUY', email: 'phuong', uiProfile: 'standard' },
  { code: 'U_HUNG', fullName: 'Võ Hoàng Hùng', givenName: 'Hùng', honorific: 'anh', role: 'employee', unit: 'sales', manager: 'U_HUY', email: 'hung', uiProfile: 'standard' },
  { code: 'U_LAN2', fullName: 'Phạm Thị Lan', givenName: 'Lan', honorific: 'chi', role: 'employee', unit: 'accounting', manager: 'U_HUY', email: 'lan2', uiProfile: 'standard' },
  { code: 'U_ADMIN', fullName: 'Tài khoản văn phòng', givenName: 'Văn phòng', honorific: null, role: 'office_admin', unit: 'office', manager: 'U_DIRECTOR', email: 'vanphong', uiProfile: 'standard' },
  { code: 'U_IT', fullName: 'Tài khoản quản trị hệ thống', givenName: 'Quản trị', honorific: null, role: 'it_admin', unit: 'office', manager: 'U_DIRECTOR', email: 'it', uiProfile: 'standard' },
  { code: 'U_DESIGNER', fullName: 'Tài khoản thiết kế quy trình', givenName: 'Thiết kế', honorific: null, role: 'process_designer', unit: 'office', manager: 'U_DIRECTOR', email: 'thietke', uiProfile: 'standard' },
];

/** Mẫu "Đón đoàn nhà đầu tư thăm KCN" (SPEC 4.2): thay chỗ giữ U_* bằng UUID thật. */
export function loadDonDoanTemplate(ids: SeedIds, opts: { s3Title?: string } = {}): ProcessDefinition {
  let raw = readFileSync(join(env.root, 'db', 'seed', 'templates', 'don-doan.json'), 'utf8');
  for (const code of USER_CODES) raw = raw.replaceAll(`"${code}"`, `"${ids.users[code]}"`);
  const json = JSON.parse(raw) as { nodes: { id: string; title?: string }[] };
  if (opts.s3Title) {
    const s3 = json.nodes.find((n) => n.id === 's3');
    if (s3) s3.title = opts.s3Title;
  }
  const def = ProcessDefinitionSchema.parse(json);
  const check = validate(def);
  if (check.errors.length) throw new Error(`Mẫu Đón đoàn không hợp lệ: ${check.errors.map((e) => e.code).join(', ')}`);
  return def;
}

export type SeedOrgOptions = {
  code: string;
  name: string;
  /** đuôi email, ví dụ 'demo.mihato.local' */
  emailDomain: string;
  /** mật khẩu web cho mọi tài khoản mẫu; bỏ trống thì không đặt mật khẩu */
  password?: string;
  /** nhánh B4 của kịch bản vàng: tên việc s3 chứa chuỗi chèn lệnh */
  s3Title?: string;
  settings?: Record<string, unknown>;
};

/** Dựng tổ chức mẫu đầy đủ. Chạy lặp lại không tạo trùng (mọi dòng dùng id cố định và ON CONFLICT). */
export async function seedDemoOrg(ids: SeedIds, opts: SeedOrgOptions): Promise<void> {
  const passwordHash = opts.password ? await hashPassword(opts.password) : null;
  await withOrg(ids.ORG, async (tx) => {
    const settings = {
      workdays: [1, 2, 3, 4, 5],
      workStart: '08:00',
      workEnd: '17:00',
      quietHours: null,
      nudgeTemplates: DEFAULT_NUDGE_TEMPLATES,
      reminderPreset: 'standard',
      ai: { enabled: true, stt: 'deepgram', llm: 'anthropic', tts: 'vbee', dailyCallLimit: 200, monthlyBudgetUsd: null },
      ...(opts.settings ?? {}),
    };
    await tx.insert(schema.organizations).values({ id: ids.ORG, code: opts.code, name: opts.name, settings, createdAt: clock.now() }).onConflictDoNothing();

    for (const code of UNIT_CODES) {
      await tx.insert(schema.units).values({ id: ids.units[code], orgId: ids.ORG, name: UNIT_NAMES[code] }).onConflictDoNothing();
    }
    // Hai lượt: tạo người trước, gán cấp trên sau (khoá ngoại tự tham chiếu).
    for (const u of SEED_USERS) {
      await tx
        .insert(schema.users)
        .values({
          id: ids.users[u.code],
          orgId: ids.ORG,
          fullName: u.fullName,
          givenName: u.givenName,
          honorific: u.honorific,
          email: `${u.email}@${opts.emailDomain}`,
          unitId: ids.units[u.unit],
          uiProfile: u.uiProfile,
          displayOrder: SEED_USERS.indexOf(u),
          status: 'active',
          passwordHash,
          createdAt: clock.now(),
        })
        .onConflictDoNothing();
    }
    for (const u of SEED_USERS) {
      if (u.manager) await tx.update(schema.users).set({ managerId: ids.users[u.manager] }).where(eq(schema.users.id, ids.users[u.code]));
      const existing = await tx.select({ id: schema.userRoles.id }).from(schema.userRoles).where(eq(schema.userRoles.userId, ids.users[u.code]));
      if (existing.length === 0) await tx.insert(schema.userRoles).values({ id: newId(), orgId: ids.ORG, userId: ids.users[u.code], role: u.role, unitId: null });
    }
    // Trưởng đơn vị [GIẢ ĐỊNH của dữ liệu mẫu]: để màn "Nhóm của tôi" và leo thang có dữ liệu.
    await tx.update(schema.units).set({ headUserId: ids.users.U_CHAIRMAN }).where(eq(schema.units.id, ids.units.chairman));
    await tx.update(schema.units).set({ headUserId: ids.users.U_DIRECTOR }).where(eq(schema.units.id, ids.units.board));
    await tx.update(schema.units).set({ headUserId: ids.users.U_LAN }).where(eq(schema.units.id, ids.units.sales));
    await tx.update(schema.units).set({ headUserId: ids.users.U_ADMIN }).where(eq(schema.units.id, ids.units.office));

    await seedTemplate(tx, ids, loadDonDoanTemplate(ids, { s3Title: opts.s3Title }));
  });
}

async function seedTemplate(tx: Tx, ids: SeedIds, def: ProcessDefinition): Promise<void> {
  const now = clock.now();
  await tx
    .insert(schema.processTemplates)
    .values({ id: ids.TEMPLATE_DON_DOAN, orgId: ids.ORG, name: def.name, description: 'Sáu việc, hạn tính lùi từ ngày đoàn đến.', createdBy: ids.users.U_DESIGNER, createdAt: now })
    .onConflictDoNothing();
  await tx
    .insert(schema.processTemplateVersions)
    .values({
      id: ids.TEMPLATE_DON_DOAN_V1,
      orgId: ids.ORG,
      templateId: ids.TEMPLATE_DON_DOAN,
      version: 1,
      definition: def,
      status: 'published',
      publishedAt: now,
      publishedBy: ids.users.U_DESIGNER,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/** Dựng Viewer của một người mẫu để gọi service thay họ (seed và test). */
export function seedViewer(ids: SeedIds, code: UserCode): Viewer {
  const u = SEED_USERS.find((x) => x.code === code)!;
  return { id: ids.users[code], orgId: ids.ORG, roles: [{ role: u.role, unitId: null }], permissions: defaultPermissions([u.role]), unitId: ids.units[u.unit], deviceId: null, sessionId: null, via: 'cookie' };
}
