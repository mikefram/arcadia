import { z } from 'zod';
import { IdSchema } from './enums';
import { ACTIONS, POLICY, type Action } from './permissions';
import { ROLES, type Role } from './enums';
import type { RoleGrant } from './permissions';

/**
 * Chỉnh quyền (docs/DECISIONS.md, 05/10/2026): tổ chức tự quyết vai trò nào làm được gì, và chỉnh riêng từng người mà không đổi vai trò.
 *
 * Quyền hiệu lực của một người = hợp quyền của các vai trò người đó giữ, rồi áp chỉnh riêng:
 *   quyền của một vai trò  = bảng mặc định (`POLICY`) + quyền tổ chức THÊM cho vai trò đó − quyền tổ chức BỚT khỏi vai trò đó
 *   quyền hiệu lực của người = hợp các vai trò của người + quyền THÊM riêng − quyền BỚT riêng
 * Chỉnh được lưu THƯA (chỉ phần khác bảng mặc định, hoặc khác quyền của vai trò): quyền mới thêm vào mã sau này tự đi theo bảng mặc
 * định cho vai nào chưa bị chỉnh, và đổi vai trò của một người không làm mất chỉnh riêng của họ. BỚT riêng luôn thắng THÊM theo vai trò.
 * Tệp này thuần: không I/O, không chữ giao diện.
 */
export const ActionSchema = z.enum(ACTIONS);

/** Không ai bị bớt quyền này: không có nó thì không đọc được cả hồ sơ của chính mình, tức là không dùng hệ thống được nữa. */
export const LOCKED_ACTIONS: readonly Action[] = ['self.read'];

/** Nhóm hiển thị trên màn Phân quyền. Mỗi quyền thuộc đúng một nhóm (test giữ điều này). Nhãn tiếng Việt ở packages/i18n. */
export const ACTION_GROUPS = [
  { id: 'everyone', actions: ['self.read', 'step.act_own', 'delegation.self'] },
  {
    id: 'coordination',
    actions: [
      'overview.view',
      'run.view_all',
      'run.start',
      'task.assign',
      'run.cancel',
      'run.note',
      'run.share',
      'step.reassign',
      'step.extend',
      'step.skip',
      'step.batch',
      'extension.decide',
      'nudge.send',
      'report.view',
      'holiday.manage',
      'proposal.create_office',
      'document.view',
    ],
  },
  { id: 'executive', actions: ['assistant.use', 'briefing.view'] },
  { id: 'templates', actions: ['template.read_published', 'template.simulate', 'template.edit', 'template.publish', 'template.archive'] },
  {
    id: 'system',
    actions: ['user.manage', 'unit.manage', 'device.manage', 'delegation.manage', 'org.settings', 'audit.view', 'effect.retry', 'notification.audit', 'ai_usage.view', 'permission.manage'],
  },
] as const satisfies readonly { id: string; actions: readonly Action[] }[];
export type ActionGroupId = (typeof ACTION_GROUPS)[number]['id'];

/** Một chỉnh: thêm hoặc bớt MỘT quyền. */
export type RuleEffect = 'grant' | 'revoke';
export type Adjust = { readonly grants: readonly Action[]; readonly revokes: readonly Action[] };
export const EMPTY_ADJUST: Adjust = { grants: [], revokes: [] };

export const AdjustSchema = z.object({ grants: z.array(ActionSchema).max(ACTIONS.length), revokes: z.array(ActionSchema).max(ACTIONS.length) });

/** Chỉnh của tổ chức theo vai trò. Vai trò không có trong bảng = dùng mặc định. */
export type RoleAdjusts = Partial<Record<Role, Adjust>>;

const orderOf = (set: ReadonlySet<Action>): Action[] => ACTIONS.filter((a) => set.has(a));

/** Quyền của một vai trò sau khi áp chỉnh của tổ chức. */
export function rolePermissions(role: Role, adjusts: RoleAdjusts = {}): Action[] {
  const set = new Set<Action>(POLICY[role]);
  const adjust = adjusts[role];
  if (adjust) {
    for (const a of adjust.grants) set.add(a);
    for (const a of adjust.revokes) set.delete(a);
  }
  for (const a of LOCKED_ACTIONS) set.add(a);
  return orderOf(set);
}

/** Quyền theo vai trò của một người (chưa tính chỉnh riêng): hợp quyền của các vai trò người đó giữ. */
export function permissionsFromRoles(roles: readonly (Role | RoleGrant)[], adjusts: RoleAdjusts = {}): Action[] {
  const held = [...new Set(roles.map((r) => (typeof r === 'string' ? r : r.role)))];
  const set = new Set<Action>();
  for (const role of held) for (const a of rolePermissions(role, adjusts)) set.add(a);
  return orderOf(set);
}

/** Quyền hiệu lực của một người: quyền theo vai trò rồi áp chỉnh riêng (BỚT luôn thắng). */
export function effectivePermissions(roles: readonly (Role | RoleGrant)[], adjusts: RoleAdjusts = {}, own: Partial<Adjust> = EMPTY_ADJUST): Action[] {
  const set = new Set<Action>(permissionsFromRoles(roles, adjusts));
  for (const a of own.grants ?? []) set.add(a);
  for (const a of own.revokes ?? []) if (!LOCKED_ACTIONS.includes(a)) set.delete(a);
  return orderOf(set);
}

/**
 * Chuẩn hoá một chỉnh so với `base` (quyền sẵn có): bỏ phần không đổi gì, bỏ trùng, sắp theo thứ tự ACTIONS.
 * Lỗi khi cùng một quyền vừa THÊM vừa BỚT, hoặc khi BỚT quyền bị khoá. `conflicts` là các quyền gây lỗi.
 */
export function normalizeAdjust(
  base: readonly Action[],
  adjust: Adjust,
): { ok: true; value: { grants: Action[]; revokes: Action[] } } | { ok: false; reason: 'both' | 'locked'; actions: Action[] } {
  const have = new Set(base);
  const grants = new Set(adjust.grants);
  const revokes = new Set(adjust.revokes);
  const both = ACTIONS.filter((a) => grants.has(a) && revokes.has(a));
  if (both.length > 0) return { ok: false, reason: 'both', actions: both };
  const locked = ACTIONS.filter((a) => revokes.has(a) && LOCKED_ACTIONS.includes(a));
  if (locked.length > 0) return { ok: false, reason: 'locked', actions: locked };
  return { ok: true, value: { grants: ACTIONS.filter((a) => grants.has(a) && !have.has(a)), revokes: ACTIONS.filter((a) => revokes.has(a) && have.has(a)) } };
}

/** Từ bộ quyền MONG MUỐN của một vai trò suy ra chỉnh so với bảng mặc định. Quyền bị khoá luôn nằm trong bộ. */
export function adjustFromAllowed(role: Role, allowed: readonly Action[]): { grants: Action[]; revokes: Action[] } {
  const want = new Set<Action>([...allowed, ...LOCKED_ACTIONS]);
  const base = new Set<Action>(POLICY[role]);
  return { grants: ACTIONS.filter((a) => want.has(a) && !base.has(a)), revokes: ACTIONS.filter((a) => base.has(a) && !want.has(a)) };
}

/** Một dòng chỉnh như lưu ở CSDL. */
export const PermissionRuleSchema = z.discriminatedUnion('subjectType', [
  z.object({ subjectType: z.literal('role'), subject: z.enum(ROLES), action: ActionSchema, effect: z.enum(['grant', 'revoke']) }),
  z.object({ subjectType: z.literal('user'), subject: IdSchema, action: ActionSchema, effect: z.enum(['grant', 'revoke']) }),
]);
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/** Gom các dòng chỉnh theo vai trò. Dòng sai (vai trò hay quyền không còn trong mã) bị bỏ, kẻo một dòng cũ làm hỏng cả tổ chức. */
export function roleAdjustsOf(rows: readonly { subjectType: string; subject: string; action: string; effect: string }[]): RoleAdjusts {
  const out: Partial<Record<Role, { grants: Action[]; revokes: Action[] }>> = {};
  for (const r of rows) {
    if (r.subjectType !== 'role') continue;
    const role = ROLES.find((x) => x === r.subject);
    const action = ACTIONS.find((x) => x === r.action);
    if (!role || !action || (r.effect !== 'grant' && r.effect !== 'revoke')) continue;
    const slot = (out[role] ??= { grants: [], revokes: [] });
    (r.effect === 'grant' ? slot.grants : slot.revokes).push(action);
  }
  return out;
}

/** Gom các dòng chỉnh riêng theo người. */
export function userAdjustsOf(rows: readonly { subjectType: string; subject: string; action: string; effect: string }[]): Map<string, { grants: Action[]; revokes: Action[] }> {
  const out = new Map<string, { grants: Action[]; revokes: Action[] }>();
  for (const r of rows) {
    if (r.subjectType !== 'user') continue;
    const action = ACTIONS.find((x) => x === r.action);
    if (!action || (r.effect !== 'grant' && r.effect !== 'revoke')) continue;
    const slot = out.get(r.subject) ?? { grants: [], revokes: [] };
    (r.effect === 'grant' ? slot.grants : slot.revokes).push(action);
    out.set(r.subject, slot);
  }
  return out;
}

