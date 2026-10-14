import { COORDINATOR_ROLES, EXECUTIVE_ROLES, ROLES, type Role } from './enums';

/**
 * Bảng quyền theo vai trò (SPEC 9.1). Đây là DỮ LIỆU dùng chung cho `can()` và cho test
 * (SPEC 13.4): test sinh mọi cặp (vai trò, endpoint) từ bảng này. Sửa bảng thì test đổi theo.
 *
 * Bảng chỉ trả lời "vai trò này có được làm loại việc này không". Quyền theo từng tài nguyên
 * (là người nhận của việc, là người khởi chạy, là trưởng đơn vị) do engine kiểm ở bảng 4.3,
 * và tầm nhìn do truy vấn cùng RLS chặn (ba lớp độc lập, SPEC 11.3).
 */
export const ACTIONS = [
  // mọi người dùng đã đăng nhập
  'self.read', // hồ sơ, thông báo, việc của tôi, tìm người, cây đơn vị
  'step.act_own', // đã nhận, báo xong, xin thêm thời gian, báo vướng, duyệt việc của chính mình
  'delegation.self', // ủy quyền cho chính mình khi vắng

  // điều phối
  'overview.view',
  'run.view_all', // mọi lượt chạy của tổ chức (tầm nhìn điều phối)
  'run.start',
  'task.assign', // giao một việc ngoài quy trình cho bất kỳ ai (docs/DECISIONS.md, 05/10/2026)
  'run.cancel',
  'run.note',
  'run.share', // quản lý chia sẻ của lượt chạy mình thấy (chủ sở hữu luôn có quyền này với lượt của mình; docs/DECISIONS.md, 07/10/2026)
  'step.reassign',
  'step.extend',
  'step.skip',
  'step.batch',
  'extension.decide',
  'nudge.send',
  'report.view',
  'holiday.manage',
  'proposal.create_office', // "Trình" (giai đoạn 3)
  'document.view', // xem sổ văn bản đến, đi và chỉ thị (docs/DECISIONS.md, 06/10/2026)

  // điều hành (app Chủ tịch)
  'assistant.use', // phiên Scribe, đề xuất của chính mình
  'briefing.view',

  // mẫu quy trình
  'template.read_published',
  'template.simulate',
  'template.edit', // tạo mẫu, nhân bản, sửa nháp, kiểm tra, xem nháp
  'template.publish', // xuất bản nháp thành phiên bản bất biến (tách khỏi `template.edit` theo docs/DECISIONS.md, 05/10/2026); cũng xem được nháp để duyệt
  'template.archive', // lưu trữ và bỏ lưu trữ mẫu (cũng tách khỏi `template.edit`); cũng thấy mẫu đã lưu trữ

  // quản trị hệ thống
  'user.manage',
  'unit.manage',
  'device.manage',
  'delegation.manage',
  'org.settings',
  'audit.view',
  'effect.retry',
  'notification.audit', // trạng thái gửi và đọc của thông báo
  'ai_usage.view', // chỉ số liệu, không có nội dung hội thoại [QUYẾT ĐỊNH]
  'permission.manage', // xem và sửa bảng quyền của từng vai trò, và quyền riêng của từng người (docs/DECISIONS.md, 05/10/2026)
] as const;
export type Action = (typeof ACTIONS)[number];

const EVERYONE: readonly Action[] = ['self.read', 'step.act_own', 'delegation.self'];

const COORDINATION: readonly Action[] = [
  'overview.view',
  'run.view_all',
  'run.start',
  'task.assign',
  'run.cancel',
  'run.note',
  'step.reassign',
  'step.extend',
  'extension.decide',
  'nudge.send',
  'report.view',
  'document.view',
  'template.read_published',
  'template.simulate',
];

/**
 * Chủ tịch toàn quyền: mọi loại việc ở trên, trừ "Trình". Khác bảng 9.1 của SPEC (chairman "không được sửa mẫu quy trình,
 * quản lý người dùng"); đổi theo yêu cầu ngày 04/10/2026, xem docs/DECISIONS.md. "Trình" là kênh để Văn phòng đưa việc cho
 * người điều hành xác nhận, không phải một quyền: Chủ tịch tự làm thẳng được việc đó nên không cần kênh này.
 */
const FULL_AUTHORITY: readonly Action[] = ACTIONS.filter((action) => action !== 'proposal.create_office');

/** Vai trò → các loại việc được làm. Không có trong danh sách = không được làm. */
export const POLICY: Record<Role, readonly Action[]> = {
  chairman: FULL_AUTHORITY,
  director: [...EVERYONE, ...COORDINATION, 'assistant.use', 'briefing.view'],
  deputy: [...EVERYONE, ...COORDINATION, 'assistant.use', 'briefing.view'],
  office_admin: [
    ...EVERYONE,
    ...COORDINATION,
    'run.share',
    'step.skip',
    'step.batch',
    'holiday.manage',
    'proposal.create_office',
    'notification.audit',
  ],
  process_designer: [...EVERYONE, 'template.read_published', 'template.simulate', 'template.edit', 'template.publish', 'template.archive'],
  it_admin: [
    ...EVERYONE,
    'user.manage',
    'unit.manage',
    'device.manage',
    'delegation.manage',
    'org.settings',
    'audit.view',
    'effect.retry',
    'notification.audit',
    'ai_usage.view',
    'permission.manage',
  ],
  employee: [...EVERYONE],
};

/**
 * Quyền về mẫu quy trình tách làm bốn việc (docs/DECISIONS.md, 05/10/2026): xem bản xuất bản, tạo và sửa nháp, xuất bản, lưu trữ.
 * Mặc định Chủ tịch và Nhà thiết kế quy trình có đủ cả bốn như trước khi tách. Ba nhóm dưới đây là "ai thấy gì":
 * - xem danh sách mẫu: người đọc bản xuất bản hoặc người làm một trong ba việc quản lý mẫu;
 * - thấy bản nháp và mẫu chưa xuất bản: người sửa, và người xuất bản (phải xem được cái mình sắp xuất bản);
 * - thấy cả mẫu đã lưu trữ: ba việc quản lý mẫu (người lưu trữ cần thấy mẫu để bỏ lưu trữ).
 */
export const TEMPLATE_MANAGE_ACTIONS = ['template.edit', 'template.publish', 'template.archive'] as const satisfies readonly Action[];
export const TEMPLATE_DRAFT_ACTIONS = ['template.edit', 'template.publish'] as const satisfies readonly Action[];
export const TEMPLATE_VIEW_ACTIONS = ['template.read_published', ...TEMPLATE_MANAGE_ACTIONS] as const satisfies readonly Action[];

export type RoleGrant = { role: Role; unitId: string | null };

/**
 * Bảng quyền MẶC ĐỊNH của các vai trò gộp lại: những gì một người có nếu tổ chức chưa chỉnh quyền của vai trò và chưa chỉnh quyền riêng.
 * Quyền THẬT của một người là `effectivePermissions` (permission-rules.ts): bảng mặc định cộng chỉnh của tổ chức theo vai trò, cộng chỉnh riêng.
 */
export function defaultPermissions(roles: readonly (Role | RoleGrant)[]): Action[] {
  const held = new Set<Role>(roles.map((r) => (typeof r === 'string' ? r : r.role)));
  return ACTIONS.filter((action) => [...held].some((role) => POLICY[role]?.includes(action)));
}

/** Người đã tính xong quyền hiệu lực (`Viewer`, `Me`, hồ sơ trong danh bạ): có `permissions` là danh sách quyền thật. */
export type HasPermissions = { readonly permissions: readonly Action[] | ReadonlySet<Action> };
export type PermissionSubject = readonly (Role | RoleGrant)[] | HasPermissions;

/**
 * Người này có được làm loại việc này không.
 * - Truyền người đã tính quyền hiệu lực (`can(viewer, 'run.start')`): theo quyền thật, gồm chỉnh của tổ chức và chỉnh riêng.
 * - Truyền danh sách vai trò (`can(['chairman'], ...)`): chỉ theo bảng mặc định. Dành cho test và nơi chưa có quyền hiệu lực;
 *   mã chạy thật PHẢI truyền người, kẻo bỏ sót chỉnh quyền.
 */
export function can(subject: PermissionSubject, action: Action): boolean {
  if ('permissions' in subject) return subject.permissions instanceof Set ? subject.permissions.has(action) : (subject.permissions as readonly Action[]).includes(action);
  for (const r of subject as readonly (Role | RoleGrant)[]) {
    const role = typeof r === 'string' ? r : r.role;
    if (POLICY[role]?.includes(action)) return true;
  }
  return false;
}

/** Có ít nhất một trong các loại việc này. */
export function canAny(subject: PermissionSubject, actions: readonly Action[]): boolean {
  return actions.some((action) => can(subject, action));
}

export function hasAnyRole(roles: readonly (Role | RoleGrant)[], wanted: readonly Role[]): boolean {
  return roles.some((r) => wanted.includes(typeof r === 'string' ? r : r.role));
}

export const isExecutive = (roles: readonly (Role | RoleGrant)[]) => hasAnyRole(roles, EXECUTIVE_ROLES);
export const isCoordinator = (roles: readonly (Role | RoleGrant)[]) => hasAnyRole(roles, COORDINATOR_ROLES);

/** Ma trận đầy đủ, để test và để màn quản trị hiển thị. */
export function policyMatrix(): { role: Role; action: Action; allowed: boolean }[] {
  const out: { role: Role; action: Action; allowed: boolean }[] = [];
  for (const role of ROLES) for (const action of ACTIONS) out.push({ role, action, allowed: POLICY[role].includes(action) });
  return out;
}
