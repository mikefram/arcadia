import {
  COORDINATOR_ROLES,
  EXECUTIVE_ROLES,
  can,
  type Action,
  type AssigneeRule,
  type DelegationRecord,
  type DirectoryUnit,
  type DirectoryUser,
  type ResolveContext,
  type Role,
} from '@mihato/domain';

/**
 * Danh bạ thuần để xác định người nhận, ủy quyền và người nhận thông báo (SPEC 4.4, 4.6, 4.8).
 * Mọi lựa chọn "một trong nhiều người" đều lấy id nhỏ nhất để kết quả tất định.
 */
export type Directory = {
  users: Map<string, DirectoryUser>;
  units: Map<string, DirectoryUnit>;
  delegations: DelegationRecord[];
};

export function buildDirectory(ctx: ResolveContext): Directory {
  const users = new Map<string, DirectoryUser>();
  for (const u of ctx.users) users.set(u.id, u);
  const units = new Map<string, DirectoryUnit>();
  for (const u of ctx.units) units.set(u.id, u);
  return { users, units, delegations: ctx.delegations };
}

export const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Người có thể nhận việc và nhận tin: có trong danh bạ và chưa bị vô hiệu hoá. */
export function usableUser(dir: Directory, userId: string | null | undefined): DirectoryUser | null {
  if (!userId) return null;
  const u = dir.users.get(userId);
  return u && u.status !== 'disabled' ? u : null;
}

export function hasRole(user: DirectoryUser | null | undefined, roles: readonly Role[]): boolean {
  return !!user && user.roles.some((r) => roles.includes(r.role));
}

/**
 * Người này có quyền làm loại việc này không (docs/DECISIONS.md, 05/10/2026): theo quyền hiệu lực backend đã tính vào danh bạ
 * (`permissions`), hoặc theo bảng mặc định của vai trò khi danh bạ chưa có (test, phát lại cũ).
 */
export function hasPermission(user: DirectoryUser | null | undefined, action: Action): boolean {
  if (!user) return false;
  return user.permissions ? user.permissions.includes(action) : can(user.roles, action);
}

export const isExecutiveUser = (user: DirectoryUser | null | undefined): boolean => hasRole(user, EXECUTIVE_ROLES);
export const isCoordinatorUser = (user: DirectoryUser | null | undefined): boolean => hasRole(user, COORDINATOR_ROLES);

/** Các tài khoản Văn phòng đang hoạt động, sắp theo id. */
export function officeAdmins(dir: Directory): string[] {
  const out: string[] = [];
  for (const u of dir.users.values()) if (u.status === 'active' && hasRole(u, ['office_admin'])) out.push(u.id);
  return out.sort(byId);
}

export type RuleEnv = {
  dir: Directory;
  initiatorId: string;
  inputs: Record<string, unknown>;
  /** kết quả của lần thử mới nhất của một bước (cho quy tắc `step_field`); thiếu thì quy tắc đó không trỏ được tới ai */
  stepResult?: (nodeId: string) => Record<string, unknown> | null;
};

/** Người ở ô `field` của biểu mẫu khởi chạy: ô kiểu `user` là một chuỗi, ô kiểu `users` là danh sách. */
function formFieldUsers(field: string, env: RuleEnv): string[] {
  const v = Object.prototype.hasOwnProperty.call(env.inputs, field) ? env.inputs[field] : null;
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return [...new Set(raw)];
}

/** Người ở ô `field` của bước `node`: ô kiểu `user` là một chuỗi, ô kiểu `users` là danh sách. Giữ thứ tự người chọn, bỏ trùng. */
function stepFieldUsers(rule: Extract<AssigneeRule, { kind: 'step_field' }>, env: RuleEnv): string[] {
  const v = env.stepResult?.(rule.node)?.[rule.field];
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return [...new Set(raw)];
}

function usersWithRole(dir: Directory, role: Role, unitId: string | undefined): string[] {
  const out: string[] = [];
  for (const u of dir.users.values()) {
    if (u.status === 'disabled') continue;
    const match = u.roles.some((r) => r.role === role && (unitId === undefined || r.unitId === unitId || (r.unitId === null && u.unitId === unitId)));
    if (match) out.push(u.id);
  }
  return out.sort(byId);
}

/**
 * Xác định MỘT người theo quy tắc (SPEC 4.2). Trả null khi không tìm thấy hoặc người đó đã bị vô hiệu hoá:
 * việc sẽ vào trạng thái `unassigned` để Văn phòng giao.
 * Quy tắc `role` có nhiều người khớp thì chọn người có id nhỏ nhất.
 */
export function resolveRule(rule: AssigneeRule, env: RuleEnv): string | null {
  const { dir } = env;
  let candidate: string | null | undefined;
  switch (rule.kind) {
    case 'user':
      candidate = rule.userId;
      break;
    case 'role':
      candidate = usersWithRole(dir, rule.role, rule.unitId)[0];
      break;
    case 'unit_head': {
      const unitId = rule.unitId ?? dir.users.get(env.initiatorId)?.unitId ?? null;
      candidate = unitId ? dir.units.get(unitId)?.headUserId : null;
      break;
    }
    case 'initiator':
      candidate = env.initiatorId;
      break;
    case 'initiator_manager': {
      let cur: string | null = env.initiatorId;
      for (let i = 0; i < (rule.level ?? 1) && cur; i++) cur = dir.users.get(cur)?.managerId ?? null;
      candidate = cur;
      break;
    }
    case 'form_field': {
      // Ô chọn nhiều người của biểu mẫu khởi chạy: một việc chỉ có một người nhận nên lấy người đầu tiên còn dùng được.
      candidate = formFieldUsers(rule.field, env).find((id) => usableUser(dir, id)) ?? null;
      break;
    }
    case 'step_field':
      // Một việc chỉ có một người nhận: ô nhiều người thì lấy người đầu tiên còn dùng được.
      candidate = stepFieldUsers(rule, env).find((id) => usableUser(dir, id)) ?? null;
      break;
  }
  return usableUser(dir, candidate)?.id ?? null;
}

/** Như `resolveRule` nhưng quy tắc `role` trả mọi người đang giữ vai trò và `step_field` trả mọi người đã chọn: dùng cho nút thông báo và nút đóng góp. */
export function resolveRuleMany(rule: AssigneeRule, env: RuleEnv): string[] {
  if (rule.kind === 'role') return usersWithRole(env.dir, rule.role, rule.unitId);
  if (rule.kind === 'step_field') return stepFieldUsers(rule, env).filter((id) => usableUser(env.dir, id));
  if (rule.kind === 'form_field') return formFieldUsers(rule.field, env).filter((id) => usableUser(env.dir, id));
  const one = resolveRule(rule, env);
  return one ? [one] : [];
}

const SCOPE_ORDER: Record<DelegationRecord['scope'], number> = { process: 0, role: 1, all: 2 };

/**
 * Ủy quyền của `fromUserId` đang hiệu lực tại `now` và phủ được việc này (SPEC 4.8):
 * - `all`: mọi việc;
 * - `process`: `scopeRef` là id mẫu quy trình của lượt chạy;
 * - `role`: việc tới tay người ủy quyền qua quy tắc `role` có đúng vai trò `scopeRef` [GIẢ ĐỊNH].
 * Không bắc cầu: người được ủy quyền không ủy tiếp. Nhiều ủy quyền cùng khớp thì chọn phạm vi hẹp nhất,
 * rồi bản bắt đầu muộn nhất, rồi người nhận ủy có id nhỏ nhất.
 */
export function findDelegation(
  dir: Directory,
  fromUserId: string,
  now: Date,
  templateId: string | null,
  ruleRoles: readonly string[],
): DelegationRecord | null {
  const matches = activeDelegations(dir, fromUserId, now, templateId, ruleRoles);
  matches.sort(
    (a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime() ||
      byId(a.toUserId, b.toUserId),
  );
  return matches[0] ?? null;
}

/** `toUserId` có đang được `fromUserId` ủy quyền cho việc này không (dùng khi kiểm "người được ủy quyền"). */
export function isDelegate(
  dir: Directory,
  fromUserId: string,
  toUserId: string,
  now: Date,
  templateId: string | null,
  ruleRoles: readonly string[],
): boolean {
  return activeDelegations(dir, fromUserId, now, templateId, ruleRoles).some((d) => d.toUserId === toUserId);
}

/** Những người đang được `fromUserId` ủy quyền cho việc này, sắp theo id (xem `findDelegation`). */
export function delegatesOf(
  dir: Directory,
  fromUserId: string,
  now: Date,
  templateId: string | null,
  ruleRoles: readonly string[],
): string[] {
  return [...new Set(activeDelegations(dir, fromUserId, now, templateId, ruleRoles).map((d) => d.toUserId))].sort(byId);
}

function activeDelegations(
  dir: Directory,
  fromUserId: string,
  now: Date,
  templateId: string | null,
  ruleRoles: readonly string[],
): DelegationRecord[] {
  const t = now.getTime();
  return dir.delegations.filter((d) => {
    if (d.fromUserId !== fromUserId || d.toUserId === fromUserId) return false;
    const from = new Date(d.validFrom).getTime();
    const to = new Date(d.validTo).getTime();
    if (!(from <= t && t <= to)) return false;
    if (d.scope === 'process' && (templateId === null || d.scopeRef !== templateId)) return false;
    if (d.scope === 'role' && (d.scopeRef === null || !ruleRoles.includes(d.scopeRef))) return false;
    return usableUser(dir, d.toUserId) !== null;
  });
}

/**
 * "Người giao" (SPEC 4.1): người khởi chạy. Khi người khởi chạy là Chủ tịch, giám đốc hoặc phó giám đốc
 * thì mọi tin dành cho người giao đi tới các tài khoản Văn phòng đang hoạt động [QUYẾT ĐỊNH].
 * Người khởi chạy không còn trong danh bạ hoặc đã bị vô hiệu hoá: cũng chuyển cho Văn phòng.
 */
export function assignerRecipients(dir: Directory, initiatorId: string): string[] {
  const initiator = usableUser(dir, initiatorId);
  if (initiator === null || isExecutiveUser(initiator)) return officeAdmins(dir);
  return [initiator.id];
}

/** Người là trưởng đơn vị của `userId` (đơn vị trực tiếp). */
export function isUnitHeadOf(dir: Directory, headId: string, userId: string | null): boolean {
  if (!userId || headId === userId) return false;
  const unitId = dir.users.get(userId)?.unitId;
  return !!unitId && dir.units.get(unitId)?.headUserId === headId;
}

/**
 * "Cấp trên trực tiếp" của người nhận (SPEC 4.6): `managerId`; thiếu thì trưởng đơn vị (leo dần lên đơn vị cha);
 * thiếu nữa thì Văn phòng. Cấp trên là Chủ tịch thì chuyển cho Văn phòng: hệ thống không tự nhắn thẳng
 * cho Chủ tịch [GIẢ ĐỊNH theo SPEC 4.1 và 4.6].
 */
export function managerRecipients(dir: Directory, userId: string): string[] {
  const user = dir.users.get(userId);
  const accept = (candidateId: string | null | undefined): string[] | null => {
    const c = usableUser(dir, candidateId);
    if (c === null || c.id === userId) return null;
    return hasRole(c, ['chairman']) ? officeAdmins(dir) : [c.id];
  };
  if (user) {
    const viaManager = accept(user.managerId);
    if (viaManager) return viaManager;
    let unitId = user.unitId;
    for (let depth = 0; unitId && depth < 20; depth++) {
      const unit = dir.units.get(unitId);
      if (!unit) break;
      const viaHead = accept(unit.headUserId);
      if (viaHead) return viaHead;
      unitId = unit.parentId;
    }
  }
  return officeAdmins(dir);
}
