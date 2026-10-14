import {
  ApiError,
  EXECUTIVE_ROLES,
  HONORIFICS,
  OrgSettingsSchema,
  ROLES,
  UI_PROFILES,
  UserCreateSchema,
  can,
  deterministicId,
  hasAnyRole,
  newId,
  type ActivationSchema,
  type DelegationCreateSchema,
  type DelegationView,
  type DeviceView,
  type Holiday,
  type HolidaySuggestionSchema,
  type Honorific,
  type OrgSettings,
  type Paged,
  type PasswordLinkSchema,
  type PersonRef,
  type Role,
  type RoleGrant,
  type RouteResponse,
  type UiProfile,
  type UnitCreateSchema,
  type UnitUpdateSchema,
  type UnitView,
  type UserImportResultSchema,
  type UserStatus,
  type UserUpdateSchema,
  type UserView,
} from '@mihato/domain';
import { fixedHolidaySuggestions } from '@mihato/domain/lunar';
import { matchPerson, normalizeText, stripDiacritics } from '@mihato/domain/vi-normalize';
import { vi } from '@mihato/i18n';
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../audit';
import { createActivation, createPasswordLink, requireStepUp, revokeDevice, type RequestMeta } from '../auth/service';
import { clock } from '../clock';
import { loadOrgContext, parseSettings, type OrgContext, type UserRecord } from '../context';
import { schema, type Tx } from '../db/client';
import { applyRunEvent } from '../engine/runner';
import type { Viewer } from '../views';
import { queueInviteEmailOnCreate, requeueInviteEmail } from './invites';
import { assertManagersRemain } from './permissions';

/**
 * Quản trị tổ chức (SPEC 9.5, 10.3): người dùng, vai trò, đơn vị, thiết bị, ủy quyền, ngày nghỉ, cấu hình.
 *
 * Hai điều chi phối mọi hàm ở đây:
 * - Khoá ngoại của PostgreSQL KHÔNG đi qua RLS, nên một id của tổ chức khác vẫn qua được ràng buộc khoá ngoại.
 *   Vì vậy mọi id nhận từ người gọi (đơn vị, người quản lý, người nhận ủy quyền…) đều được tra lại trong
 *   giao dịch có RLS trước khi ghi; không thấy thì `not_found`, không lộ là có tồn tại ở tổ chức khác.
 * - `audit_log.detail` chỉ chứa id, mã và tên khoá; không có tên người, email, số điện thoại (CLAUDE.md luật 6).
 */

type UserRow = typeof schema.users.$inferSelect;
type UnitRow = typeof schema.units.$inferSelect;
type DelegationRow = typeof schema.delegations.$inferSelect;

export type PersonHit = RouteResponse<'people.search'>['items'][number];
export type UserCreateInput = z.output<typeof UserCreateSchema>;
export type UserUpdateInput = z.output<typeof UserUpdateSchema>;
export type UserImportResult = z.infer<typeof UserImportResultSchema>;
export type UnitCreateInput = z.output<typeof UnitCreateSchema>;
export type UnitUpdateInput = z.output<typeof UnitUpdateSchema>;
export type DelegationCreateInput = z.output<typeof DelegationCreateSchema>;
export type HolidaySuggestionView = z.infer<typeof HolidaySuggestionSchema>;
export type ActivationView = z.infer<typeof ActivationSchema>;
export type PasswordLinkView = z.infer<typeof PasswordLinkSchema>;
export type UserListQuery = { limit: number; cursor?: string; q?: string; unitId?: string; status?: UserStatus };

const collator = new Intl.Collator('vi');
/** So sánh không phân biệt dấu, hoa thường và khoảng trắng thừa. */
const fold = (s: string): string => stripDiacritics(normalizeText(s));
const notNull = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const fieldError = (path: string, code: string): ApiError => new ApiError('input_invalid', { errors: [{ path, code }] });
/** Id trong thân yêu cầu không có ở tổ chức này (hoặc thuộc tổ chức khác): 404, kèm tên trường để biểu mẫu chỉ đúng chỗ. */
const refMissing = (path: string): ApiError => new ApiError('not_found', { errors: [{ path, code: 'not_found' }] });

const offsetOf = (cursor?: string): number => {
  const n = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const cursorOf = (offset: number): string => Buffer.from(String(offset), 'utf8').toString('base64url');

const byDisplay = (a: Pick<UserRow, 'displayOrder' | 'fullName' | 'id'>, b: Pick<UserRow, 'displayOrder' | 'fullName' | 'id'>): number =>
  a.displayOrder - b.displayOrder || collator.compare(a.fullName, b.fullName) || a.id.localeCompare(b.id);

const roleRank = (role: string): number => {
  const i = (ROLES as readonly string[]).indexOf(role);
  return i < 0 ? ROLES.length : i;
};
const sortRoles = (roles: RoleGrant[]): RoleGrant[] =>
  [...roles].sort((a, b) => roleRank(a.role) - roleRank(b.role) || (a.unitId ?? '').localeCompare(b.unitId ?? ''));

function dedupeRoles(roles: RoleGrant[]): RoleGrant[] {
  const seen = new Set<string>();
  const out: RoleGrant[] = [];
  for (const r of roles) {
    const key = `${r.role}:${r.unitId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role: r.role, unitId: r.unitId ?? null });
  }
  return sortRoles(out);
}

// ───────────────────────── Tìm người ─────────────────────────

/** Khoảng cách sửa chữ có chặn trên: chỉ cần biết hai tiếng lệch nhau không quá `max` ký tự. */
function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

/** Điểm khớp theo chữ đang gõ dở (không dấu): cả họ tên, đầu từng tiếng, một đoạn bất kỳ, rồi tới gõ sai một ký tự. */
function typedScore(needle: string, fullName: string): number {
  const hay = fold(fullName);
  if (hay === needle) return 1;
  const words = hay.split(' ');
  const tokens = needle.split(' ');
  if (tokens.every((t) => words.some((w) => w.startsWith(t)))) {
    // Tên gọi là tiếng cuối của họ tên: gõ trúng tên gọi (hoặc gõ nhiều tiếng) xếp trên gõ trúng họ hay tên đệm.
    const hitsGivenName = words[words.length - 1]!.startsWith(needle);
    return tokens.length > 1 || hitsGivenName ? 0.8 : 0.7;
  }
  if (hay.includes(needle)) return 0.6;
  // Khớp mờ: mỗi tiếng gõ vào lệch không quá một ký tự so với một tiếng của họ tên. Chỉ xét tiếng từ 4 ký tự:
  // tiếng ngắn lệch một ký tự là tên khác ("Lan" với "Văn"), không phải gõ nhầm.
  if (tokens.every((t) => t.length >= 4 && words.some((w) => withinEdits(t, w, 1)))) return 0.4;
  return 0;
}

/** Chức danh hiển thị cạnh tên: vai trò cao nhất của người đó, chữ lấy từ `vi.common.role`. */
function roleTitleOf(roles: RoleGrant[]): string | null {
  const top = sortRoles(roles)[0];
  return top ? vi.common.role[top.role] : null;
}

/**
 * Tìm người theo tên (SPEC 10.3): không phân biệt dấu, khớp mờ. Ô chọn người ở web, ở app và tool `search_people`
 * dùng chung hàm này. Tầm nhìn: mọi người chưa bị vô hiệu hoá của tổ chức [GIẢ ĐỊNH: người `invited` vẫn
 * chọn được, vì Văn phòng giao việc trước khi người đó kích hoạt thiết bị]. Chuỗi rỗng trả danh sách theo thứ tự hiển thị.
 */
export function searchPeople(ctx: OrgContext, q: string, limit = 20): PersonHit[] {
  const people = [...ctx.users.values()].filter((u) => u.status !== 'disabled').sort(byDisplay);
  const unitNameOf = (u: UserRecord): string | null => (u.unitId ? (ctx.units.get(u.unitId)?.name ?? null) : null);
  const hit = (u: UserRecord): PersonHit => ({
    id: u.id,
    fullName: u.fullName,
    givenName: u.givenName,
    honorific: (u.honorific as Honorific | null) ?? null,
    unitName: unitNameOf(u),
    roleTitle: roleTitleOf(u.roles),
  });
  const query = q.trim();
  if (!query) return people.slice(0, limit).map(hit);

  // Cách gọi tự nhiên ("chị Lan", "Lan kinh doanh") chấm bằng matchPerson; chữ gõ dở chấm theo tiền tố.
  const candidates = people.map((u) => ({ id: u.id, fullName: u.fullName, givenName: u.givenName, honorific: u.honorific, unitName: unitNameOf(u) }));
  const spoken = new Map(matchPerson(query, candidates).map((m) => [m.id, m.score]));
  const needle = fold(query);
  return people
    .map((u, order) => ({ u, order, score: Math.max(spoken.get(u.id) ?? 0, typedScore(needle, u.fullName)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((s) => hit(s.u));
}

// ───────────────────────── Người dùng ─────────────────────────

async function userViews(tx: Tx, rows: UserRow[]): Promise<UserView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const unitIds = [...new Set(rows.map((r) => r.unitId).filter(notNull))];
  const managerIds = [...new Set(rows.map((r) => r.managerId).filter(notNull))];
  // Tuần tự: một giao dịch là một kết nối, các truy vấn không chạy song song được.
  const roles = await tx
    .select({ userId: schema.userRoles.userId, role: schema.userRoles.role, unitId: schema.userRoles.unitId })
    .from(schema.userRoles)
    .where(inArray(schema.userRoles.userId, ids));
  const devices = await tx
    .select({ userId: schema.devices.userId, n: sql<number>`count(*)::int` })
    .from(schema.devices)
    .where(and(inArray(schema.devices.userId, ids), isNull(schema.devices.revokedAt)))
    .groupBy(schema.devices.userId);
  const units = unitIds.length ? await tx.select({ id: schema.units.id, name: schema.units.name }).from(schema.units).where(inArray(schema.units.id, unitIds)) : [];
  const managers = managerIds.length ? await tx.select({ id: schema.users.id, fullName: schema.users.fullName }).from(schema.users).where(inArray(schema.users.id, managerIds)) : [];
  const rolesByUser = new Map<string, RoleGrant[]>();
  for (const r of roles) {
    const list = rolesByUser.get(r.userId) ?? [];
    list.push({ role: r.role as Role, unitId: r.unitId });
    rolesByUser.set(r.userId, list);
  }
  const deviceCount = new Map(devices.map((d) => [d.userId, Number(d.n)]));
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const managerName = new Map(managers.map((m) => [m.id, m.fullName]));
  return rows.map((u) => ({
    id: u.id,
    fullName: u.fullName,
    givenName: u.givenName,
    honorific: (u.honorific as Honorific | null) ?? null,
    email: u.email,
    phone: u.phone,
    unitId: u.unitId,
    unitName: u.unitId ? (unitName.get(u.unitId) ?? null) : null,
    managerId: u.managerId,
    managerName: u.managerId ? (managerName.get(u.managerId) ?? null) : null,
    uiProfile: u.uiProfile as UiProfile,
    displayOrder: u.displayOrder,
    status: u.status as UserStatus,
    roles: sortRoles(rolesByUser.get(u.id) ?? []),
    hasPassword: u.passwordHash !== null,
    mfaEnabled: u.totpEnabled,
    deviceCount: deviceCount.get(u.id) ?? 0,
    createdAt: u.createdAt.toISOString(),
  }));
}

async function findUser(tx: Tx, userId: string, opts: { lock?: boolean } = {}): Promise<UserRow> {
  const q = tx.select().from(schema.users).where(eq(schema.users.id, userId));
  const [row] = opts.lock ? await q.for('update') : await q;
  if (!row) throw new ApiError('not_found');
  return row;
}

async function assertUnitExists(tx: Tx, unitId: string, path: string): Promise<void> {
  const [u] = await tx.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.id, unitId));
  if (!u) throw refMissing(path);
}

async function assertRoleUnits(tx: Tx, roles: RoleGrant[]): Promise<void> {
  const unitIds = [...new Set(roles.map((r) => r.unitId).filter(notNull))];
  if (unitIds.length === 0) return;
  const found = await tx.select({ id: schema.units.id }).from(schema.units).where(inArray(schema.units.id, unitIds));
  if (found.length !== unitIds.length) throw refMissing('body.roles.unitId');
}

/** Người quản lý phải thuộc tổ chức, khác chính người đó, và không tạo vòng trong chuỗi quản lý. */
async function assertManager(tx: Tx, userId: string | null, managerId: string): Promise<void> {
  if (managerId === userId) throw fieldError('body.managerId', 'self');
  const all = await tx.select({ id: schema.users.id, managerId: schema.users.managerId }).from(schema.users);
  const managerOf = new Map(all.map((u) => [u.id, u.managerId]));
  if (!managerOf.has(managerId)) throw refMissing('body.managerId');
  let cur: string | null = managerId;
  for (let guard = 0; cur && guard <= all.length; guard++) {
    cur = managerOf.get(cur) ?? null;
    if (cur !== null && cur === userId) throw fieldError('body.managerId', 'cycle');
  }
}

async function assertEmailFree(tx: Tx, email: string, exceptUserId: string | null): Promise<void> {
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`);
  if (rows.some((r) => r.id !== exceptUserId)) throw fieldError('body.email', 'duplicate');
}

const cleanEmail = (email: string | null): string | null => (email ? email.trim().toLowerCase() : null);
const cleanPhone = (phone: string | null): string | null => (phone && phone.trim() ? phone.trim() : null);

export async function listUsers(tx: Tx, q: UserListQuery): Promise<Paged<UserView>> {
  const conds = [];
  if (q.unitId) conds.push(eq(schema.users.unitId, q.unitId));
  if (q.status) conds.push(eq(schema.users.status, q.status));
  let rows = await tx
    .select()
    .from(schema.users)
    .where(conds.length ? and(...conds) : undefined);
  const needle = q.q ? fold(q.q) : '';
  // Lọc không phân biệt dấu ở tầng ứng dụng: danh bạ một tổ chức chỉ vài trăm người, không cần chỉ mục riêng.
  if (needle) rows = rows.filter((u) => fold(u.fullName).includes(needle) || (u.email ?? '').toLowerCase().includes(needle) || (u.phone ?? '').includes(needle));
  rows.sort(byDisplay);
  const offset = offsetOf(q.cursor);
  const page = rows.slice(offset, offset + q.limit);
  return { items: await userViews(tx, page), nextCursor: rows.length > offset + q.limit ? cursorOf(offset + q.limit) : null };
}

export async function getUser(tx: Tx, userId: string): Promise<UserView> {
  const [view] = await userViews(tx, [await findUser(tx, userId)]);
  return view!;
}

/** Thêm người dùng ở trạng thái `invited`; người đó thành `active` khi kích hoạt thiết bị hoặc đặt mật khẩu web (SPEC 9.5). */
export async function createUser(tx: Tx, viewer: Viewer, body: UserCreateInput, meta: RequestMeta = {}): Promise<UserView> {
  const email = cleanEmail(body.email);
  const roles = dedupeRoles(body.roles);
  if (!body.fullName.trim()) throw fieldError('body.fullName', 'required');
  if (!body.givenName.trim()) throw fieldError('body.givenName', 'required');
  if (email) await assertEmailFree(tx, email, null);
  if (body.unitId) await assertUnitExists(tx, body.unitId, 'body.unitId');
  if (body.managerId) await assertManager(tx, null, body.managerId);
  await assertRoleUnits(tx, roles);

  const id = newId();
  await tx.insert(schema.users).values({
    id,
    orgId: viewer.orgId,
    fullName: body.fullName.trim(),
    givenName: body.givenName.trim(),
    honorific: body.honorific,
    email,
    phone: cleanPhone(body.phone),
    unitId: body.unitId,
    managerId: body.managerId,
    uiProfile: body.uiProfile,
    displayOrder: body.displayOrder,
    status: 'invited',
    createdAt: clock.now(),
  });
  await tx.insert(schema.userRoles).values(roles.map((r) => ({ id: newId(), orgId: viewer.orgId, userId: id, role: r.role, unitId: r.unitId })));
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'user_created',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'user',
    targetId: id,
    ip: meta.ip,
    detail: { roles: roles.map((r) => r.role), unitId: body.unitId },
  });
  // Có email thì worker gửi thư kích hoạt tài khoản (đường dẫn đặt mật khẩu web) sau khi giao dịch này cam kết.
  await queueInviteEmailOnCreate(tx, viewer.orgId, { id, email }, viewer.id);
  return getUser(tx, id);
}

const USER_PATCH_KEYS = ['fullName', 'givenName', 'honorific', 'email', 'phone', 'unitId', 'managerId', 'uiProfile', 'displayOrder'] as const;

/**
 * Sửa hồ sơ. Chỉ áp các khoá có trong `rawBody`: Zod 4 điền mặc định cho khoá vắng mặt, nên nếu áp cả `body`
 * thì một yêu cầu chỉ đổi số điện thoại sẽ xoá luôn đơn vị và người quản lý.
 */
export async function updateUser(tx: Tx, viewer: Viewer, userId: string, body: UserUpdateInput, rawBody: Record<string, unknown>, meta: RequestMeta = {}): Promise<UserView> {
  const current = await findUser(tx, userId, { lock: true });
  const patch: Partial<Pick<UserRow, (typeof USER_PATCH_KEYS)[number]>> = {};
  for (const key of USER_PATCH_KEYS) {
    if (!(key in rawBody) || body[key] === undefined) continue;
    if (key === 'email') patch.email = cleanEmail(body.email ?? null);
    else if (key === 'phone') patch.phone = cleanPhone(body.phone ?? null);
    else if (key === 'fullName') patch.fullName = body.fullName!.trim();
    else if (key === 'givenName') patch.givenName = body.givenName!.trim();
    else if (key === 'honorific') patch.honorific = body.honorific ?? null;
    else if (key === 'unitId') patch.unitId = body.unitId ?? null;
    else if (key === 'managerId') patch.managerId = body.managerId ?? null;
    else if (key === 'uiProfile') patch.uiProfile = body.uiProfile!;
    else patch.displayOrder = body.displayOrder!;
  }
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== current[k]);
  if (changed.length === 0) return getUser(tx, userId);

  if (patch.fullName === '') throw fieldError('body.fullName', 'required');
  if (patch.givenName === '') throw fieldError('body.givenName', 'required');
  if (changed.includes('email') && patch.email) await assertEmailFree(tx, patch.email, userId);
  if (changed.includes('unitId') && patch.unitId) await assertUnitExists(tx, patch.unitId, 'body.unitId');
  if (changed.includes('managerId') && patch.managerId) await assertManager(tx, userId, patch.managerId);

  await tx.update(schema.users).set(patch).where(eq(schema.users.id, userId));
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'user_updated',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'user',
    targetId: userId,
    ip: meta.ip,
    detail: { fields: changed },
  });
  return getUser(tx, userId);
}

/** Số người chưa bị vô hiệu hoá đang giữ vai `it_admin`, không tính `exceptUserId`. */
async function otherItAdmins(tx: Tx, exceptUserId: string): Promise<number> {
  const rows = await tx
    .selectDistinct({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(eq(schema.userRoles.role, 'it_admin'), ne(schema.users.status, 'disabled'), ne(schema.userRoles.userId, exceptUserId)));
  return rows.length;
}

async function rolesOf(tx: Tx, userId: string): Promise<RoleGrant[]> {
  const rows = await tx.select({ role: schema.userRoles.role, unitId: schema.userRoles.unitId }).from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  return sortRoles(rows.map((r) => ({ role: r.role as Role, unitId: r.unitId })));
}

/** Đặt lại toàn bộ vai trò của một người (SPEC 10.3). Tổ chức luôn phải còn ít nhất một `it_admin` đang dùng được. */
export async function setUserRoles(tx: Tx, viewer: Viewer, userId: string, roles: RoleGrant[], meta: RequestMeta = {}): Promise<UserView> {
  const user = await findUser(tx, userId, { lock: true });
  const next = dedupeRoles(roles);
  if (next.length === 0) throw fieldError('body.roles', 'required');
  await assertRoleUnits(tx, next);
  const before = await rolesOf(tx, userId);
  const losesItAdmin = before.some((r) => r.role === 'it_admin') && !next.some((r) => r.role === 'it_admin');
  if (losesItAdmin && user.status !== 'disabled' && (await otherItAdmins(tx, userId)) === 0) throw fieldError('body.roles', 'last_it_admin');
  if (JSON.stringify(before) === JSON.stringify(next)) return getUser(tx, userId);
  // Đổi vai trò cũng không được làm tổ chức hết người giữ quyền quản lý người dùng hay quản lý phân quyền.
  if (user.status === 'active') await assertManagersRemain(tx, viewer.orgId, { rolesOf: { userId, roles: next } });

  await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  await tx.insert(schema.userRoles).values(next.map((r) => ({ id: newId(), orgId: viewer.orgId, userId, role: r.role, unitId: r.unitId })));
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'role_changed',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'user',
    targetId: userId,
    ip: meta.ip,
    detail: { before, after: next },
  });
  return getUser(tx, userId);
}

/**
 * Vô hiệu hoá (SPEC 9.5 điều 4): thu hồi mọi thiết bị, xoá phiên web, huỷ mã kích hoạt còn hạn, và chuyển mọi việc
 * người đó đang giữ sang `unassigned` bằng sự kiện `UnassignStep` của engine để Văn phòng giao lại. Lịch sử giữ nguyên.
 * eventId tất định theo (người, việc, Idempotency-Key) nên gửi lại yêu cầu không tạo sự kiện thứ hai.
 */
export async function disableUser(tx: Tx, viewer: Viewer, userId: string, idempotencyKey: string, meta: RequestMeta = {}): Promise<UserView> {
  const user = await findUser(tx, userId, { lock: true });
  if (user.status === 'disabled') throw new ApiError('state_conflict', { currentState: 'disabled' });
  const roles = await rolesOf(tx, userId);
  if (roles.some((r) => r.role === 'it_admin') && (await otherItAdmins(tx, userId)) === 0) {
    throw new ApiError('state_conflict', { currentState: user.status, errors: [{ path: 'params.id', code: 'last_it_admin' }] });
  }
  if (user.status === 'active') await assertManagersRemain(tx, viewer.orgId, { disabling: userId });
  const now = clock.now();
  await tx.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));

  const devices = await tx
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, userId), isNull(schema.devices.revokedAt)));
  for (const d of devices) await revokeDevice(tx, viewer, d.id, meta);
  await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  await tx.update(schema.activationTokens).set({ usedAt: now }).where(and(eq(schema.activationTokens.userId, userId), isNull(schema.activationTokens.usedAt)));
  await tx.update(schema.passwordTokens).set({ usedAt: now }).where(and(eq(schema.passwordTokens.userId, userId), isNull(schema.passwordTokens.usedAt)));

  // "Đang giữ" theo đúng nghĩa của engine: người nhận của việc, hoặc một người duyệt chưa quyết của nút duyệt
  // (kể cả khi chưa tới lượt mình trong danh sách: để nguyên thì nút duyệt kiểu `all` sẽ kẹt ở người đã nghỉ).
  // Thứ tự cố định theo lượt chạy để hai yêu cầu vô hiệu hoá song song không khoá chéo nhau.
  const held = await tx.execute<{ id: string; run_id: string }>(sql`
    SELECT s.id, s.run_id FROM step_runs s JOIN process_runs r ON r.id = s.run_id
    WHERE r.state = 'running' AND s.kind IN ('task','approval') AND s.state IN ('ready','in_progress')
      AND (s.assignee_id = ${userId}
        OR EXISTS (SELECT 1 FROM step_approvals a WHERE a.step_run_id = s.id AND a.approver_id = ${userId} AND a.decision IS NULL))
    ORDER BY s.run_id, s.id`);
  if (held.rows.length > 0) {
    // Nạp lại danh bạ: engine phải thấy người này đã `disabled`.
    const ctx = await loadOrgContext(tx, viewer.orgId);
    for (const s of held.rows) {
      await applyRunEvent(tx, ctx, s.run_id, {
        type: 'UnassignStep',
        eventId: deterministicId(`disable:${userId}:${s.id}:${idempotencyKey}`),
        at: now.toISOString(),
        actor: { type: 'system' },
        stepId: s.id,
        reason: 'user_disabled',
        userId, // chỉ gỡ người này; các người duyệt hoặc đóng góp còn lại giữ việc
      });
    }
  }
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'user_disabled',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'user',
    targetId: userId,
    ip: meta.ip,
    detail: { devicesRevoked: devices.length, stepsUnassigned: held.rows.length },
  });
  return getUser(tx, userId);
}

/** Bật lại: thiết bị cũ vẫn bị thu hồi, nên người đó cần mã kích hoạt mới (hoặc đăng nhập web nếu đã có mật khẩu). */
export async function enableUser(tx: Tx, viewer: Viewer, userId: string, meta: RequestMeta = {}): Promise<UserView> {
  const user = await findUser(tx, userId, { lock: true });
  if (user.status !== 'disabled') throw new ApiError('state_conflict', { currentState: user.status });
  const [everHadDevice] = await tx.select({ id: schema.devices.id }).from(schema.devices).where(eq(schema.devices.userId, userId)).limit(1);
  const status: UserStatus = user.passwordHash || everHadDevice ? 'active' : 'invited';
  await tx.update(schema.users).set({ status, failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, userId));
  await audit(tx, { orgId: viewer.orgId, action: 'user_enabled', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'user', targetId: userId, ip: meta.ip });
  return getUser(tx, userId);
}

// ───────────────────────── Nhập CSV ─────────────────────────

export type CsvRecord = { line: number; cells: string[] };

/** Đọc CSV theo RFC 4180: bỏ BOM, ô trong nháy kép chứa được dấu phẩy, xuống dòng và `""`. Dòng trống bị bỏ qua. */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Excel ở máy đặt vùng Việt Nam thường xuất dấu chấm phẩy: nhận theo dòng tiêu đề.
  const firstLine = src.slice(0, src.search(/\r?\n/) < 0 ? src.length : src.search(/\r?\n/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) out.push({ line: startLine, cells: cells.map((c) => c.trim()) });
    cells = [];
    cell = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === sep) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return out;
}

const CSV_COLUMNS: Record<string, 'fullName' | 'givenName' | 'honorific' | 'email' | 'phone' | 'unit' | 'manager' | 'roles' | 'uiProfile'> = {
  fullname: 'fullName',
  givenname: 'givenName',
  honorific: 'honorific',
  email: 'email',
  phone: 'phone',
  unit: 'unit',
  manager: 'manager',
  manageremail: 'manager',
  roles: 'roles',
  role: 'roles',
  uiprofile: 'uiProfile',
};
type CsvColumn = (typeof CSV_COLUMNS)[string];

/** Vai trò nhận cả mã (`office_admin`) lẫn chữ hiển thị ("Văn phòng"), không phân biệt dấu. */
const ROLE_BY_LABEL = new Map<string, Role>(ROLES.flatMap((r) => [[fold(r), r] as const, [fold(vi.common.role[r]), r] as const]));

type ImportCandidate = { id: string; line: number; errors: string[]; data: Omit<UserCreateInput, 'managerId'>; managerEmail: string | null };

/**
 * Nhập người dùng hàng loạt (SPEC 9.5, 10.3). Cột: fullName, givenName, honorific, email, phone, unit (tên đơn vị),
 * manager (email người quản lý, đã có sẵn hoặc nằm trong chính tệp), roles (ngăn bằng `|`), uiProfile.
 * Mỗi dòng trả danh sách MÃ lỗi (chữ hiển thị nằm ở packages/i18n). `dryRun` chỉ kiểm, không ghi.
 * [GIẢ ĐỊNH] Tệp còn dòng lỗi thì không ghi dòng nào: sửa xong nhập lại, khỏi vướng email trùng của lần nhập dở.
 * [GIẢ ĐỊNH] Bỏ trống `givenName` thì lấy tiếng cuối của họ tên; bỏ trống `roles` thì là `employee`.
 */
export async function importUsers(tx: Tx, viewer: Viewer, csv: string, dryRun: boolean, meta: RequestMeta = {}): Promise<UserImportResult> {
  const records = parseCsv(csv);
  const header = records[0];
  if (!header) return { dryRun, total: 0, created: 0, rows: [{ line: 1, ok: false, errors: ['header_missing'] }] };
  const columns = header.cells.map((c) => CSV_COLUMNS[c.toLowerCase().replace(/[^a-z]/g, '')] ?? null);
  if (!columns.includes('fullName')) return { dryRun, total: 0, created: 0, rows: [{ line: header.line, ok: false, errors: ['header_missing_fullName'] }] };

  const existingUsers = await tx.select({ id: schema.users.id, email: schema.users.email }).from(schema.users);
  const unitRows = await tx.select({ id: schema.units.id, name: schema.units.name }).from(schema.units);
  const emailToId = new Map(existingUsers.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u.id]));
  const unitsByName = new Map<string, string[]>();
  for (const u of unitRows) unitsByName.set(fold(u.name), [...(unitsByName.get(fold(u.name)) ?? []), u.id]);

  const candidates: ImportCandidate[] = [];
  const fileEmails = new Map<string, string>();
  for (const rec of records.slice(1)) {
    const id = newId();
    const errors: string[] = [];
    const get = (col: CsvColumn): string => {
      const i = columns.indexOf(col);
      return i >= 0 ? (rec.cells[i] ?? '') : '';
    };
    if (rec.cells.length > columns.length && rec.cells.slice(columns.length).some((c) => c !== '')) errors.push('columns_mismatch');

    const fullName = get('fullName');
    if (!fullName) errors.push('fullName_required');
    const givenName = get('givenName') || fullName.split(/\s+/).pop() || '';

    const honorificRaw = fold(get('honorific'));
    const honorific = (HONORIFICS as readonly string[]).includes(honorificRaw) ? (honorificRaw as Honorific) : null;
    if (honorificRaw && !honorific) errors.push('honorific_invalid');

    const email = cleanEmail(get('email') || null);
    if (email) {
      if (emailToId.has(email) || fileEmails.has(email)) errors.push('email_duplicate');
      else fileEmails.set(email, id);
    }

    let unitId: string | null = null;
    const unitRaw = get('unit');
    if (unitRaw) {
      const matches = unitsByName.get(fold(unitRaw)) ?? [];
      if (matches.length === 1) unitId = matches[0]!;
      else errors.push(matches.length === 0 ? 'unit_not_found' : 'unit_ambiguous');
    }

    const roles: RoleGrant[] = [];
    const roleTokens = get('roles').split('|').map((r) => r.trim()).filter(Boolean);
    for (const token of roleTokens) {
      const role = ROLE_BY_LABEL.get(fold(token).replace(/[\s-]+/g, '_')) ?? ROLE_BY_LABEL.get(fold(token));
      if (role) roles.push({ role, unitId: null });
      else if (!errors.includes('role_invalid')) errors.push('role_invalid');
    }
    if (roleTokens.length === 0) roles.push({ role: 'employee', unitId: null });

    const uiRaw = get('uiProfile').toLowerCase();
    const uiProfile = (UI_PROFILES as readonly string[]).includes(uiRaw) ? (uiRaw as UiProfile) : 'standard';
    if (uiRaw && uiRaw !== uiProfile) errors.push('uiProfile_invalid');

    const data = { fullName, givenName, honorific, email, phone: cleanPhone(get('phone')), unitId, uiProfile, displayOrder: 0, roles: dedupeRoles(roles) };
    // Lưới cuối: cùng schema với POST /v1/users, để hai đường tạo người không lệch luật (độ dài, định dạng email…).
    const check = UserCreateSchema.safeParse({ ...data, managerId: null });
    if (!check.success) {
      for (const issue of check.error.issues) {
        const field = String(issue.path[0] ?? 'row');
        // Họ tên trống đã báo `fullName_required`; tên gọi suy từ họ tên nên không báo lại.
        if (!fullName && (field === 'fullName' || field === 'givenName')) continue;
        if (field === 'roles' && errors.includes('role_invalid')) continue;
        errors.push(`${field}_invalid`);
      }
    }
    candidates.push({ id, line: rec.line, errors: [...new Set(errors)], data, managerEmail: cleanEmail(get('manager') || null) });
  }

  // Người quản lý tra sau cùng, vì có thể nằm ở dòng phía dưới trong cùng tệp.
  const managerIdOf = (c: ImportCandidate): string | null => (c.managerEmail ? (emailToId.get(c.managerEmail) ?? fileEmails.get(c.managerEmail) ?? null) : null);
  for (const c of candidates) {
    if (!c.managerEmail) continue;
    const managerId = managerIdOf(c);
    if (!managerId) c.errors.push('manager_not_found');
    else if (managerId === c.id) c.errors.push('manager_self');
  }

  const rows = candidates.map((c) => ({ line: c.line, ok: c.errors.length === 0, errors: c.errors }));
  if (dryRun || rows.some((r) => !r.ok) || candidates.length === 0) return { dryRun, total: candidates.length, created: 0, rows };

  const now = clock.now();
  for (const c of candidates) {
    await tx.insert(schema.users).values({
      id: c.id,
      orgId: viewer.orgId,
      fullName: c.data.fullName,
      givenName: c.data.givenName,
      honorific: c.data.honorific,
      email: c.data.email,
      phone: c.data.phone,
      unitId: c.data.unitId,
      uiProfile: c.data.uiProfile,
      displayOrder: c.data.displayOrder,
      status: 'invited',
      createdAt: now,
    });
    await tx.insert(schema.userRoles).values(c.data.roles.map((r) => ({ id: newId(), orgId: viewer.orgId, userId: c.id, role: r.role, unitId: r.unitId })));
  }
  for (const c of candidates) {
    const managerId = managerIdOf(c);
    if (managerId) await tx.update(schema.users).set({ managerId }).where(eq(schema.users.id, c.id));
    await audit(tx, {
      orgId: viewer.orgId,
      action: 'user_created',
      actorUserId: viewer.id,
      actorDeviceId: viewer.deviceId,
      targetType: 'user',
      targetId: c.id,
      ip: meta.ip,
      detail: { roles: c.data.roles.map((r) => r.role), unitId: c.data.unitId, via: 'import' },
    });
    await queueInviteEmailOnCreate(tx, viewer.orgId, { id: c.id, email: c.data.email }, viewer.id);
  }
  return { dryRun, total: candidates.length, created: candidates.length, rows };
}

// ───────────────────────── Kích hoạt và thiết bị ─────────────────────────

/** Mã kích hoạt thiết bị (QR, đường dẫn), dùng một lần, hết hạn sau 72 giờ; mã gốc chỉ hiện ở phản hồi này. */
export async function createUserActivation(tx: Tx, viewer: Viewer, userId: string, app?: 'staff' | 'executive'): Promise<ActivationView> {
  const user = await findUser(tx, userId);
  if (user.status === 'disabled') throw new ApiError('state_conflict', { currentState: 'disabled' });
  const a = await createActivation(tx, viewer.orgId, userId, viewer.id, app);
  return { url: a.url, qrPayload: a.qrPayload, expiresAt: a.expiresAt.toISOString() };
}

/** Đường dẫn đặt mật khẩu web. Đăng nhập web bằng email, nên hồ sơ phải có email trước. */
export async function createUserPasswordLink(tx: Tx, viewer: Viewer, userId: string, meta: RequestMeta = {}): Promise<PasswordLinkView> {
  const user = await findUser(tx, userId);
  if (user.status === 'disabled') throw new ApiError('state_conflict', { currentState: 'disabled' });
  if (!user.email) throw fieldError('user.email', 'required');
  const link = await createPasswordLink(tx, viewer, viewer.orgId, userId);
  await audit(tx, { orgId: viewer.orgId, action: 'password_link_created', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'user', targetId: userId, ip: meta.ip });
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

/** Gửi lại thư kích hoạt tài khoản tới email trong hồ sơ; worker gửi thật, phản hồi chỉ báo đã xếp hàng hay chưa. */
export async function resendInviteEmail(tx: Tx, viewer: Viewer, userId: string, meta: RequestMeta = {}): Promise<{ queued: boolean }> {
  const user = await findUser(tx, userId);
  return requeueInviteEmail(tx, viewer.orgId, user, { id: viewer.id, deviceId: viewer.deviceId, ip: meta.ip });
}

export async function listDevices(tx: Tx, q: { userId?: string } = {}): Promise<DeviceView[]> {
  const rows = await tx
    .select({ d: schema.devices, userName: schema.users.fullName })
    .from(schema.devices)
    .innerJoin(schema.users, eq(schema.users.id, schema.devices.userId))
    .where(q.userId ? eq(schema.devices.userId, q.userId) : undefined)
    .orderBy(desc(schema.devices.enrolledAt), schema.devices.id);
  return rows.map(({ d, userName }) => ({
    id: d.id,
    userId: d.userId,
    userName,
    platform: d.platform as DeviceView['platform'],
    name: d.name,
    hasPushToken: d.pushToken !== null,
    enrolledAt: d.enrolledAt.toISOString(),
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    revokedAt: d.revokedAt?.toISOString() ?? null,
  }));
}

// ───────────────────────── Đơn vị ─────────────────────────

async function unitViews(tx: Tx, rows: UnitRow[]): Promise<UnitView[]> {
  if (rows.length === 0) return [];
  const headIds = [...new Set(rows.map((r) => r.headUserId).filter(notNull))];
  const heads = headIds.length ? await tx.select({ id: schema.users.id, fullName: schema.users.fullName }).from(schema.users).where(inArray(schema.users.id, headIds)) : [];
  const members = await tx
    .select({ unitId: schema.users.unitId, n: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(and(inArray(schema.users.unitId, rows.map((r) => r.id)), ne(schema.users.status, 'disabled')))
    .groupBy(schema.users.unitId);
  const headName = new Map(heads.map((h) => [h.id, h.fullName]));
  const memberCount = new Map(members.map((m) => [m.unitId, Number(m.n)]));
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    parentId: u.parentId,
    headUserId: u.headUserId,
    headName: u.headUserId ? (headName.get(u.headUserId) ?? null) : null,
    memberCount: memberCount.get(u.id) ?? 0,
  }));
}

/** Cây đơn vị dạng phẳng (client tự dựng cây theo `parentId`). `memberCount` đếm người chưa bị vô hiệu hoá thuộc thẳng đơn vị. */
export async function listUnits(tx: Tx): Promise<UnitView[]> {
  const rows = await tx.select().from(schema.units);
  rows.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  return unitViews(tx, rows);
}

async function assertUnitRefs(tx: Tx, refs: { parentId?: string | null; headUserId?: string | null }): Promise<void> {
  if (refs.parentId) await assertUnitExists(tx, refs.parentId, 'body.parentId');
  if (refs.headUserId) {
    const [head] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, refs.headUserId));
    if (!head) throw refMissing('body.headUserId');
  }
}

export async function createUnit(tx: Tx, viewer: Viewer, body: UnitCreateInput, meta: RequestMeta = {}): Promise<UnitView> {
  await assertUnitRefs(tx, body);
  const id = newId();
  const [row] = await tx.insert(schema.units).values({ id, orgId: viewer.orgId, name: body.name.trim(), parentId: body.parentId, headUserId: body.headUserId }).returning();
  await audit(tx, { orgId: viewer.orgId, action: 'unit_created', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'unit', targetId: id, ip: meta.ip, detail: { parentId: body.parentId, headUserId: body.headUserId } });
  const [view] = await unitViews(tx, [row!]);
  return view!;
}

/** Sửa đơn vị; chỉ áp khoá có trong `rawBody`. Đơn vị cha không được là chính nó hay một đơn vị con cháu của nó. */
export async function updateUnit(tx: Tx, viewer: Viewer, unitId: string, body: UnitUpdateInput, rawBody: Record<string, unknown>, meta: RequestMeta = {}): Promise<UnitView> {
  const [current] = await tx.select().from(schema.units).where(eq(schema.units.id, unitId)).for('update');
  if (!current) throw new ApiError('not_found');
  const patch: Partial<Pick<UnitRow, 'name' | 'parentId' | 'headUserId'>> = {};
  if ('name' in rawBody && body.name !== undefined) patch.name = body.name.trim();
  if ('parentId' in rawBody && body.parentId !== undefined) patch.parentId = body.parentId;
  if ('headUserId' in rawBody && body.headUserId !== undefined) patch.headUserId = body.headUserId;
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== current[k]);
  if (changed.length > 0) {
    await assertUnitRefs(tx, { parentId: changed.includes('parentId') ? patch.parentId : null, headUserId: changed.includes('headUserId') ? patch.headUserId : null });
    if (changed.includes('parentId') && patch.parentId) {
      const all = await tx.select({ id: schema.units.id, parentId: schema.units.parentId }).from(schema.units);
      const parentOf = new Map(all.map((u) => [u.id, u.parentId]));
      let cur: string | null = patch.parentId;
      for (let guard = 0; cur && guard <= all.length; guard++) {
        if (cur === unitId) throw fieldError('body.parentId', 'cycle');
        cur = parentOf.get(cur) ?? null;
      }
    }
    await tx.update(schema.units).set(patch).where(eq(schema.units.id, unitId));
    await audit(tx, { orgId: viewer.orgId, action: 'unit_updated', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'unit', targetId: unitId, ip: meta.ip, detail: { fields: changed } });
  }
  const [row] = await tx.select().from(schema.units).where(eq(schema.units.id, unitId));
  const [view] = await unitViews(tx, [row!]);
  return view!;
}

// ───────────────────────── Ủy quyền (SPEC 4.8) ─────────────────────────

function delegationView(ctx: OrgContext, d: DelegationRow, now: Date): DelegationView {
  const person = (id: string): PersonRef => ctx.person(id) ?? { id, fullName: '', givenName: '', honorific: null };
  return {
    id: d.id,
    fromUser: person(d.fromUserId),
    toUser: person(d.toUserId),
    validFrom: d.validFrom.toISOString(),
    validTo: d.validTo.toISOString(),
    scope: d.scope as DelegationView['scope'],
    scopeRef: d.scopeRef,
    active: d.validFrom <= now && d.validTo > now,
  };
}

/** Quản trị (`delegation.manage`) thấy tất cả; người thường chỉ thấy ủy quyền mình giao đi hoặc mình nhận. */
export async function listDelegations(tx: Tx, ctx: OrgContext, viewer: Viewer): Promise<DelegationView[]> {
  const mine = or(eq(schema.delegations.fromUserId, viewer.id), eq(schema.delegations.toUserId, viewer.id));
  const rows = await tx
    .select()
    .from(schema.delegations)
    .where(can(viewer, 'delegation.manage') ? undefined : mine)
    .orderBy(desc(schema.delegations.validFrom), schema.delegations.id);
  const now = clock.now();
  return rows.map((d) => delegationView(ctx, d, now));
}

/**
 * Tạo ủy quyền. Người thường chỉ tạo cho chính mình. Điều hành (chairman, director, deputy) tự ủy quyền thì bắt buộc
 * X-Step-Up-Token (SPEC 10.3): một ủy quyền của Chủ tịch chuyển cả quyền duyệt sang người khác.
 */
export async function createDelegation(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: DelegationCreateInput,
  opts: { stepUpToken?: string; meta?: RequestMeta } = {},
): Promise<DelegationView> {
  const self = body.fromUserId === viewer.id;
  if (!self && !can(viewer, 'delegation.manage')) throw new ApiError('forbidden');
  if (self && hasAnyRole(viewer.roles, EXECUTIVE_ROLES)) await requireStepUp(viewer, opts.stepUpToken);

  const [from] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, body.fromUserId));
  if (!from) throw refMissing('body.fromUserId');
  const [to] = await tx.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, body.toUserId));
  if (!to) throw refMissing('body.toUserId');
  if (body.fromUserId === body.toUserId) throw fieldError('body.toUserId', 'same_as_from');
  if (to.status === 'disabled') throw fieldError('body.toUserId', 'disabled');
  const validFrom = new Date(body.validFrom);
  const validTo = new Date(body.validTo);
  if (validTo <= validFrom) throw fieldError('body.validTo', 'before_valid_from');

  let scopeRef: string | null = null;
  if (body.scope === 'process') {
    if (!body.scopeRef || !/^[0-9a-f-]{36}$/i.test(body.scopeRef)) throw fieldError('body.scopeRef', 'required');
    const [tpl] = await tx.select({ id: schema.processTemplates.id }).from(schema.processTemplates).where(and(eq(schema.processTemplates.id, body.scopeRef), eq(schema.processTemplates.kind, 'process')));
    if (!tpl) throw refMissing('body.scopeRef');
    scopeRef = tpl.id;
  } else if (body.scope === 'role') {
    if (!body.scopeRef || !(ROLES as readonly string[]).includes(body.scopeRef)) throw fieldError('body.scopeRef', 'role_invalid');
    scopeRef = body.scopeRef;
  }

  const id = newId();
  const [row] = await tx
    .insert(schema.delegations)
    .values({ id, orgId: viewer.orgId, fromUserId: body.fromUserId, toUserId: body.toUserId, validFrom, validTo, scope: body.scope, scopeRef, createdBy: viewer.id })
    .returning();
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'delegation_created',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'delegation',
    targetId: id,
    ip: opts.meta?.ip,
    detail: { fromUserId: body.fromUserId, toUserId: body.toUserId, scope: body.scope, scopeRef, validFrom: validFrom.toISOString(), validTo: validTo.toISOString() },
  });
  // Người nhận có thể vừa được tạo trong cùng giao dịch: nạp lại danh bạ nếu ctx chưa có.
  const fresh = ctx.users.has(body.fromUserId) && ctx.users.has(body.toUserId) ? ctx : await loadOrgContext(tx, viewer.orgId);
  return delegationView(fresh, row!, clock.now());
}

/** Quản trị xoá được mọi ủy quyền; người thường chỉ xoá ủy quyền do chính mình giao đi. Ngoài tầm nhìn thì 404. */
export async function deleteDelegation(tx: Tx, viewer: Viewer, delegationId: string, meta: RequestMeta = {}): Promise<void> {
  const [row] = await tx.select().from(schema.delegations).where(eq(schema.delegations.id, delegationId)).for('update');
  const admin = can(viewer, 'delegation.manage');
  if (!row || (!admin && row.fromUserId !== viewer.id && row.toUserId !== viewer.id)) throw new ApiError('not_found');
  if (!admin && row.fromUserId !== viewer.id) throw new ApiError('forbidden');
  await tx.delete(schema.delegations).where(eq(schema.delegations.id, delegationId));
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'delegation_deleted',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'delegation',
    targetId: delegationId,
    ip: meta.ip,
    detail: { fromUserId: row.fromUserId, toUserId: row.toUserId, scope: row.scope },
  });
}

// ───────────────────────── Ngày nghỉ (SPEC 4.5) ─────────────────────────

const holidayOf = (h: typeof schema.holidays.$inferSelect): Holiday => ({ day: h.day, name: h.name, kind: h.kind as Holiday['kind'] });

export async function listHolidays(tx: Tx, year: number): Promise<Holiday[]> {
  const rows = await tx
    .select()
    .from(schema.holidays)
    .where(and(gte(schema.holidays.day, `${year}-01-01`), lte(schema.holidays.day, `${year}-12-31`)))
    .orderBy(schema.holidays.day);
  return rows.map(holidayOf);
}

/** Gợi ý ngày lễ cố định của năm; hệ thống không tự áp, Văn phòng xem rồi nhập (SPEC 4.5). */
export async function holidaySuggestions(tx: Tx, year: number): Promise<HolidaySuggestionView[]> {
  const added = new Set((await listHolidays(tx, year)).map((h) => h.day));
  return fixedHolidaySuggestions(year).map((s) => ({ day: s.day, name: s.name, kind: s.kind, lunarLabel: s.lunarLabel, alreadyAdded: added.has(s.day) }));
}

export async function putHoliday(tx: Tx, viewer: Viewer, day: string, body: Pick<Holiday, 'name' | 'kind'>, meta: RequestMeta = {}): Promise<Holiday> {
  const [row] = await tx
    .insert(schema.holidays)
    .values({ orgId: viewer.orgId, day, name: body.name.trim(), kind: body.kind })
    .onConflictDoUpdate({ target: [schema.holidays.orgId, schema.holidays.day], set: { name: body.name.trim(), kind: body.kind } })
    .returning();
  await audit(tx, { orgId: viewer.orgId, action: 'holiday_changed', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'holiday', ip: meta.ip, detail: { op: 'put', day, kind: body.kind } });
  return holidayOf(row!);
}

export async function deleteHoliday(tx: Tx, viewer: Viewer, day: string, meta: RequestMeta = {}): Promise<void> {
  const rows = await tx.delete(schema.holidays).where(eq(schema.holidays.day, day)).returning({ day: schema.holidays.day });
  if (rows.length === 0) throw new ApiError('not_found');
  await audit(tx, { orgId: viewer.orgId, action: 'holiday_changed', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'holiday', ip: meta.ip, detail: { op: 'delete', day } });
}

// ───────────────────────── Cấu hình tổ chức ─────────────────────────

/** Khoá là đối tượng con: gộp sâu một cấp, để gửi `{ ai: { enabled: false } }` không xoá `stt`, `llm`, `tts`. */
const MERGED_SETTING_KEYS: readonly string[] = ['ai', 'nudgeTemplates', 'quietHours', 'retention'];

export function getOrgSettings(ctx: OrgContext): OrgSettings {
  return ctx.settings;
}

/**
 * Sửa cấu hình tổ chức. Nhận thân yêu cầu THÔ: chỉ khoá người gọi thật sự gửi mới được áp (Zod 4 điền mặc định
 * cho khoá vắng mặt, áp bản đã qua Zod sẽ ghi đè cấu hình hiện có bằng mặc định). Kết quả gộp được kiểm lại bằng
 * `OrgSettingsSchema`. Nhật ký chỉ ghi TÊN khoá đã đổi, không ghi giá trị (số điện thoại, lời chúc, mẫu lời nhắc).
 */
export async function patchOrgSettings(tx: Tx, viewer: Viewer, rawBody: Record<string, unknown>, meta: RequestMeta = {}): Promise<OrgSettings> {
  const [org] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, viewer.orgId)).for('update');
  if (!org) throw new ApiError('not_found');
  const current = parseSettings(org.settings) as OrgSettings & Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(OrgSettingsSchema.shape)) {
    if (!(key in rawBody)) continue;
    const value = rawBody[key];
    const base = current[key];
    merged[key] = MERGED_SETTING_KEYS.includes(key) && isRecord(value) && isRecord(base) ? { ...base, ...value } : value;
  }
  const parsed = OrgSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ApiError('input_invalid', { errors: parsed.error.issues.slice(0, 50).map((i) => ({ path: ['body', ...i.path].join('.'), code: i.code })) });
  }
  const next = parsed.data as OrgSettings & Record<string, unknown>;
  if (next.workStart >= next.workEnd) throw fieldError('body.workEnd', 'before_work_start');
  // Giờ yên tĩnh có đầu trùng cuối là mơ hồ (không có, hay cả ngày): từ chối. Muốn không có giờ yên tĩnh thì gửi `quietHours: null`.
  if (next.quietHours && next.quietHours.start === next.quietHours.end) throw fieldError('body.quietHours.end', 'same_as_start');

  const changed: string[] = [];
  for (const key of Object.keys(OrgSettingsSchema.shape)) {
    const a = current[key];
    const b = next[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (MERGED_SETTING_KEYS.includes(key) && isRecord(a) && isRecord(b)) {
      for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[sub]) !== JSON.stringify(b[sub])) changed.push(`${key}.${sub}`);
    } else changed.push(key);
  }
  if (changed.length === 0) return current;

  await tx.update(schema.organizations).set({ settings: parsed.data }).where(eq(schema.organizations.id, viewer.orgId));
  await audit(tx, { orgId: viewer.orgId, action: 'org_settings_changed', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'organization', targetId: viewer.orgId, ip: meta.ip, detail: { keys: changed } });
  return parsed.data;
}
