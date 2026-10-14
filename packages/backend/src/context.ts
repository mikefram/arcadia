import {
  DEFAULT_CALENDAR,
  OrgSettingsSchema,
  effectivePermissions,
  roleAdjustsOf,
  userAdjustsOf,
  type Action,
  type Adjust,
  type RoleAdjusts,
  type DelegationRecord,
  type DirectoryUnit,
  type DirectoryUser,
  type Honorific,
  type OrgSettings,
  type PersonRef,
  type ResolveContext,
  type Role,
  type RoleGrant,
  type UserStatus,
  type WorkCalendar,
} from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { inOrder, schema, type Tx } from './db/client';

export type UserRecord = typeof schema.users.$inferSelect & {
  roles: RoleGrant[];
  /** quyền hiệu lực: vai trò, chỉnh của tổ chức theo vai trò và chỉnh riêng (docs/DECISIONS.md, 05/10/2026) */
  permissions: Action[];
};
export type UnitRecord = typeof schema.units.$inferSelect;

/** Dữ liệu của một tổ chức cần cho engine và cho việc dựng view: nạp một lần mỗi giao dịch. */
export type OrgContext = {
  orgId: string;
  org: { id: string; code: string; name: string };
  settings: OrgSettings;
  calendar: WorkCalendar;
  users: Map<string, UserRecord>;
  /** chỉnh quyền của tổ chức theo vai trò (đã đọc từ permission_rules) */
  roleAdjusts: RoleAdjusts;
  /** chỉnh quyền riêng theo người (chỉ người có chỉnh mới có mặt) */
  userAdjusts: Map<string, Adjust>;
  units: Map<string, UnitRecord>;
  delegations: (typeof schema.delegations.$inferSelect)[];
  /** dữ liệu thuần truyền cho engine */
  resolve: ResolveContext;
  person(id: string | null | undefined): PersonRef | null;
  /** đơn vị mà người này làm trưởng, kể cả đơn vị con */
  headedUnitIds(userId: string): Set<string>;
  /** người dưới quyền: thành viên các đơn vị mình làm trưởng và người có manager_id là mình */
  teamUserIds(userId: string): Set<string>;
  officeAdminIds(): string[];
};

export function parseSettings(raw: unknown): OrgSettings {
  return OrgSettingsSchema.parse(raw ?? {});
}

export function calendarOf(settings: OrgSettings, holidays: { day: string; kind: string }[]): WorkCalendar {
  return {
    utcOffsetMinutes: DEFAULT_CALENDAR.utcOffsetMinutes,
    workdays: settings.workdays,
    workStart: settings.workStart,
    workEnd: settings.workEnd,
    holidays: holidays.map((h) => ({ day: h.day, kind: h.kind as WorkCalendar['holidays'][number]['kind'] })),
  };
}

export function personRef(u: Pick<UserRecord, 'id' | 'fullName' | 'givenName' | 'honorific'>): PersonRef {
  return { id: u.id, fullName: u.fullName, givenName: u.givenName, honorific: (u.honorific as Honorific | null) ?? null };
}

export async function loadOrgContext(tx: Tx, orgId: string): Promise<OrgContext> {
  const [orgRows, userRows, roleRows, unitRows, delegationRows, holidayRows, ruleRows] = await inOrder([
    tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)),
    tx.select().from(schema.users),
    tx.select().from(schema.userRoles),
    tx.select().from(schema.units),
    tx.select().from(schema.delegations),
    tx.select().from(schema.holidays),
    tx.select().from(schema.permissionRules),
  ]);
  const org = orgRows[0];
  if (!org) throw new Error('Không tìm thấy tổ chức trong ngữ cảnh RLS hiện tại');

  const settings = parseSettings(org.settings);
  const calendar = calendarOf(settings, holidayRows);

  const users = new Map<string, UserRecord>();
  for (const u of userRows) users.set(u.id, { ...u, roles: [], permissions: [] });
  for (const r of roleRows) users.get(r.userId)?.roles.push({ role: r.role as Role, unitId: r.unitId });
  const roleAdjusts = roleAdjustsOf(ruleRows);
  const userAdjusts = userAdjustsOf(ruleRows);
  for (const u of users.values()) u.permissions = effectivePermissions(u.roles, roleAdjusts, userAdjusts.get(u.id));
  const units = new Map<string, UnitRecord>(unitRows.map((u) => [u.id, u]));

  const dirUsers: DirectoryUser[] = [...users.values()].map((u) => ({
    id: u.id,
    unitId: u.unitId,
    managerId: u.managerId,
    status: u.status as UserStatus,
    roles: u.roles.map((r) => ({ role: r.role, unitId: r.unitId })),
    permissions: u.permissions,
  }));
  const dirUnits: DirectoryUnit[] = unitRows.map((u) => ({ id: u.id, parentId: u.parentId, headUserId: u.headUserId }));
  const delegations: DelegationRecord[] = delegationRows.map((d) => ({
    fromUserId: d.fromUserId,
    toUserId: d.toUserId,
    validFrom: d.validFrom.toISOString(),
    validTo: d.validTo.toISOString(),
    scope: d.scope as DelegationRecord['scope'],
    scopeRef: d.scopeRef,
  }));

  const resolve: ResolveContext = {
    users: dirUsers,
    units: dirUnits,
    delegations,
    calendar,
    defaultReminderPreset: settings.reminderPreset,
    reminderPresets: settings.reminderSteps ? { standard: settings.reminderSteps } : undefined,
  };

  const headedCache = new Map<string, Set<string>>();
  function headedUnitIds(userId: string): Set<string> {
    const hit = headedCache.get(userId);
    if (hit) return hit;
    const out = new Set<string>();
    const queue = unitRows.filter((u) => u.headUserId === userId).map((u) => u.id);
    while (queue.length) {
      const id = queue.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      for (const child of unitRows) if (child.parentId === id) queue.push(child.id);
    }
    headedCache.set(userId, out);
    return out;
  }

  function teamUserIds(userId: string): Set<string> {
    const headed = headedUnitIds(userId);
    const out = new Set<string>();
    for (const u of users.values()) {
      if (u.id === userId) continue;
      if ((u.unitId && headed.has(u.unitId)) || u.managerId === userId) out.add(u.id);
    }
    return out;
  }

  return {
    orgId,
    org: { id: org.id, code: org.code, name: org.name },
    settings,
    calendar,
    users,
    roleAdjusts,
    userAdjusts,
    units,
    delegations: delegationRows,
    resolve,
    person: (id) => {
      const u = id ? users.get(id) : undefined;
      return u ? personRef(u) : null;
    },
    headedUnitIds,
    teamUserIds,
    officeAdminIds: () =>
      [...users.values()].filter((u) => u.status !== 'disabled' && u.roles.some((r) => r.role === 'office_admin')).map((u) => u.id),
  };
}
