import {
  DEFAULT_CALENDAR,
  ProcessDefinitionSchema,
  type DirectoryUnit,
  type DirectoryUser,
  type NewRunInput,
  type ProcessDefinition,
  type ResolveContext,
  type Role,
  type WorkCalendar,
} from '@mihato/domain';
import { atLocalTime } from '@mihato/domain/calendar';

/**
 * Dữ liệu mẫu của kịch bản vàng (SPEC 13.2, 15.4) với UUID cố định. Tên là tên giả.
 * `db/seed` sinh UUID v7 thật; ở đây đặt tay để test tất định.
 */
const uid = (n: number): string => `01920000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const U = {
  CHAIRMAN: uid(1),
  DIRECTOR: uid(2),
  HUY: uid(3),
  LAN: uid(4),
  NGOCANH: uid(5),
  TUAN: uid(6),
  PHUONG: uid(7),
  HUNG: uid(8),
  LAN2: uid(9),
  ADMIN: uid(10),
  IT: uid(11),
  /** tài khoản Văn phòng thứ hai, dùng ở vài test (không có trong seed) */
  ADMIN2: uid(12),
  /** người đã bị vô hiệu hoá */
  DISABLED: uid(13),
  /** id không có trong danh bạ */
  GHOST: uid(99),
} as const;

export const UNIT = {
  CHAIRMAN_OFFICE: uid(0x101),
  BOARD: uid(0x102),
  SALES: uid(0x103),
  LEGAL: uid(0x104),
  TECH: uid(0x105),
  ACCOUNTING: uid(0x106),
  OFFICE: uid(0x107),
} as const;

export const ORG = uid(0x201);
export const TEMPLATE = uid(0x202);
export const TEMPLATE_VERSION = uid(0x203);
export const RUN = uid(0x204);

const user = (id: string, role: Role, unitId: string, managerId: string | null, status: DirectoryUser['status'] = 'active'): DirectoryUser => ({
  id,
  unitId,
  managerId,
  status,
  roles: [{ role, unitId: null }],
});

/** Mười một người của SPEC 15.4. Cấp trên của mọi nhân viên là U_HUY. */
export const SEED_USERS: DirectoryUser[] = [
  user(U.CHAIRMAN, 'chairman', UNIT.CHAIRMAN_OFFICE, null),
  user(U.DIRECTOR, 'director', UNIT.BOARD, U.CHAIRMAN),
  user(U.HUY, 'deputy', UNIT.BOARD, U.DIRECTOR),
  user(U.LAN, 'employee', UNIT.SALES, U.HUY),
  user(U.NGOCANH, 'employee', UNIT.LEGAL, U.HUY),
  user(U.TUAN, 'employee', UNIT.TECH, U.HUY),
  user(U.PHUONG, 'employee', UNIT.ACCOUNTING, U.HUY),
  user(U.HUNG, 'employee', UNIT.SALES, U.HUY),
  user(U.LAN2, 'employee', UNIT.ACCOUNTING, U.HUY),
  user(U.ADMIN, 'office_admin', UNIT.OFFICE, U.DIRECTOR),
  user(U.IT, 'it_admin', UNIT.OFFICE, U.DIRECTOR),
];

/** Đơn vị mẫu. Trưởng đơn vị chỉ để test quyền "trưởng đơn vị": Lan là trưởng Kinh doanh (đơn vị của Hùng). */
export const SEED_UNITS: DirectoryUnit[] = [
  { id: UNIT.CHAIRMAN_OFFICE, parentId: null, headUserId: U.CHAIRMAN },
  { id: UNIT.BOARD, parentId: UNIT.CHAIRMAN_OFFICE, headUserId: U.DIRECTOR },
  { id: UNIT.SALES, parentId: UNIT.BOARD, headUserId: U.LAN },
  { id: UNIT.LEGAL, parentId: UNIT.BOARD, headUserId: null },
  { id: UNIT.TECH, parentId: UNIT.BOARD, headUserId: null },
  { id: UNIT.ACCOUNTING, parentId: UNIT.BOARD, headUserId: null },
  { id: UNIT.OFFICE, parentId: UNIT.BOARD, headUserId: U.ADMIN },
];

/** Lịch của kịch bản: Thứ Hai đến Thứ Sáu, 08:00–17:00, không ngày lễ. */
export const VN: WorkCalendar = DEFAULT_CALENDAR;

export function makeCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  return { users: SEED_USERS, units: SEED_UNITS, delegations: [], calendar: VN, ...over };
}

/** Thêm người vào danh bạ mẫu (bản sao, không sửa SEED_USERS). */
export function withUsers(...extra: DirectoryUser[]): DirectoryUser[] {
  const ids = new Set(extra.map((u) => u.id));
  return [...SEED_USERS.filter((u) => !ids.has(u.id)), ...extra];
}

export const extraUser = user;

/** Giờ Việt Nam → thời điểm UTC. `vn('2026-10-02', '09:00')` */
export const vn = (day: string, time: string): Date => atLocalTime(day, time, VN);

/** Hạn 17:00 giờ Việt Nam của một ngày, dạng chuỗi ISO UTC (10:00Z). */
export const due17 = (day: string): string => vn(day, '17:00').toISOString();

/** Quy trình "Đón đoàn nhà đầu tư thăm KCN" ở SPEC 4.2, đã thay U_* bằng UUID. */
export const GOLDEN_DEF: ProcessDefinition = ProcessDefinitionSchema.parse({
  schemaVersion: 1,
  name: 'Đón đoàn nhà đầu tư thăm KCN',
  inputs: [
    { key: 'delegation', label: 'Tên đoàn', type: 'text', required: true },
    { key: 'visitDate', label: 'Ngày đoàn đến', type: 'date', required: true },
  ],
  targetField: 'visitDate',
  nodes: [
    { id: 'start', type: 'start', label: 'Bắt đầu' },
    {
      id: 's1',
      type: 'task',
      label: 'Chương trình đón đoàn',
      title: 'Lập chương trình đón đoàn',
      assignee: { kind: 'user', userId: U.LAN },
      due: { anchor: 'run_target', offset: { value: -7, unit: 'working_day' } },
    },
    {
      id: 's4',
      type: 'task',
      label: 'Tạm ứng',
      title: 'Lập đề nghị tạm ứng',
      assignee: { kind: 'user', userId: U.PHUONG },
      form: [{ key: 'amount', label: 'Số tiền đề nghị tạm ứng', type: 'money', required: true }],
      due: { anchor: 'run_target', offset: { value: -7, unit: 'working_day' } },
    },
    {
      id: 's2',
      type: 'task',
      label: 'Hồ sơ pháp lý',
      title: 'Hồ sơ pháp lý đất và tài liệu giới thiệu',
      assignee: { kind: 'user', userId: U.NGOCANH },
      due: { anchor: 'run_target', offset: { value: -5, unit: 'working_day' } },
    },
    {
      id: 's3',
      type: 'task',
      label: 'Tuyến tham quan',
      title: 'Kiểm tra tuyến tham quan',
      assignee: { kind: 'user', userId: U.TUAN },
      due: { anchor: 'run_target', offset: { value: -6, unit: 'working_day' } },
    },
    {
      id: 's6',
      type: 'approval',
      label: 'Duyệt tạm ứng',
      title: 'Duyệt đề nghị tạm ứng',
      approvers: [{ kind: 'user', userId: U.HUY }],
      mode: 'any',
      due: { anchor: 'run_target', offset: { value: -6, unit: 'working_day' } },
    },
    {
      id: 's5',
      type: 'task',
      label: 'Báo giá',
      title: 'Báo giá thuê nhà xưởng cho đoàn',
      assignee: { kind: 'user', userId: U.HUNG },
      due: { anchor: 'run_target', offset: { value: -4, unit: 'working_day' } },
    },
    { id: 'end', type: 'end', label: 'Hoàn tất' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 's1' },
    { id: 'e2', from: 'start', to: 's4' },
    { id: 'e3', from: 's1', to: 's2' },
    { id: 'e4', from: 's1', to: 's3' },
    { id: 'e5', from: 's4', to: 's6' },
    { id: 'e6', from: 's2', to: 's5' },
    { id: 'e7', from: 's3', to: 'end' },
    { id: 'e8', from: 's5', to: 'end' },
    { id: 'e9', from: 's6', to: 'end', outcome: 'approved' },
  ],
});

export function goldenRunInput(initiatorId: string): NewRunInput {
  return {
    id: RUN,
    orgId: ORG,
    templateId: TEMPLATE,
    templateVersionId: TEMPLATE_VERSION,
    title: 'Đón đoàn nhà đầu tư Nhật Bản',
    initiatorId,
    inputs: { delegation: 'Đoàn nhà đầu tư Nhật Bản', visitDate: '2026-10-15' },
  };
}

/** Dựng nhanh một định nghĩa nhỏ cho test ví dụ: tự thêm schemaVersion, name, inputs mặc định. */
export function defOf(partial: { nodes: unknown[]; edges: unknown[]; inputs?: unknown[]; targetField?: string }): ProcessDefinition {
  return ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'Quy trình thử',
    inputs: partial.inputs ?? [],
    ...(partial.targetField ? { targetField: partial.targetField } : {}),
    nodes: partial.nodes,
    edges: partial.edges,
  });
}

export function runInput(initiatorId: string, inputs: Record<string, unknown> = {}): NewRunInput {
  return { id: RUN, orgId: ORG, templateId: TEMPLATE, templateVersionId: TEMPLATE_VERSION, title: 'Lượt chạy thử', initiatorId, inputs };
}

/** Nút task tối giản: hạn 2 ngày làm việc kể từ lúc tới lượt. */
export const task = (id: string, userId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'task',
  label: `Việc ${id}`,
  title: `Việc ${id}`,
  assignee: { kind: 'user', userId },
  due: { anchor: 'activation', offset: { value: 2, unit: 'working_day' } },
  ...extra,
});

export const START = { id: 'start', type: 'start', label: 'Bắt đầu' };
export const END = { id: 'end', type: 'end', label: 'Kết thúc' };
export const edge = (from: string, to: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: `${from}>${to}${extra['outcome'] ? `:${String(extra['outcome'])}` : ''}${extra['branch'] ? `:${String(extra['branch'])}` : ''}`, from, to, ...extra });
