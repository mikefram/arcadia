import {
  ApiError,
  formatDocumentNumber,
  newId,
  type ProcessDefinition,
  type Paged,
  type RegisterColumn,
  type RegisterEntryView,
  type RegisterUpsert,
  type RegisterView,
  type RunStateName,
} from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { audit } from '../audit';
import { restrictedRunAccess, type Viewer } from '../views';
import { definitionOfRun, fieldIndexOf, snapshotColumns, subjectOf } from './register-values';

/**
 * Sổ văn bản và cấp số (docs/DECISIONS.md, 06/10/2026). Ô `autonumber` của biểu mẫu trỏ tới một sổ bằng mã; lúc gửi biểu mẫu,
 * máy chủ cấp số kế tiếp của sổ (đánh lại từ đầu mỗi năm nếu sổ đặt vậy), ghi vào giá trị của ô TRƯỚC khi gọi engine, nên
 * sự kiện lưu số đã cấp và phát lại không cấp lại. Cấp số bằng một câu UPSERT khoá hàng bộ đếm: hai yêu cầu song song không
 * trùng số; yêu cầu bị huỷ giữa chừng trả số về (giao dịch quay lui), nên sổ không hụt số.
 */

/** Các sổ mặc định (docs/DECISIONS.md, 06/10/2026): tự tạo khi một quy trình mẫu cần mà tổ chức chưa có; tổ chức đổi mẫu số bằng màn Sổ văn bản. */
export const DEFAULT_REGISTERS: Record<string, RegisterUpsert> = {
  VBDEN: {
    name: 'Sổ văn bản đến',
    direction: 'incoming',
    pattern: '{seq:4}',
    resetPolicy: 'yearly',
    columns: [
      { key: 'noiGui', label: 'Nơi gửi' },
      { key: 'soKyHieu', label: 'Số, ký hiệu' },
      { key: 'ngayVanBan', label: 'Ngày văn bản' },
      { key: 'loaiVanBan', label: 'Loại văn bản' },
      { key: 'mucKhan', label: 'Mức khẩn' },
      { key: 'mucMat', label: 'Mức mật' },
      { key: 'hanXuLy', label: 'Hạn xử lý' },
      { key: 'chuTri', label: 'Người chủ trì' },
    ],
  },
  VBDI: {
    name: 'Sổ văn bản đi',
    direction: 'outgoing',
    pattern: '{seq}/VB-{yyyy}',
    resetPolicy: 'yearly',
    columns: [
      { key: 'noiNhan', label: 'Nơi nhận' },
      { key: 'loaiVanBan', label: 'Loại văn bản' },
      { key: 'mucKhan', label: 'Mức khẩn' },
      { key: 'mucMat', label: 'Mức mật' },
      { key: 'nguoiKy', label: 'Người ký' },
      { key: 'soLuongBan', label: 'Số lượng bản' },
      { key: 'ngayBanHanh', label: 'Ngày ban hành' },
    ],
  },
  CHITHI: {
    name: 'Sổ chỉ thị',
    direction: 'internal',
    pattern: '{seq}/CT-{yyyy}',
    resetPolicy: 'yearly',
    columns: [
      { key: 'tieuDe', label: 'Tiêu đề' },
      { key: 'mucKhan', label: 'Mức khẩn' },
      { key: 'hanHoanThanh', label: 'Hạn hoàn thành' },
    ],
  },
};

export type Allocation = { registerId: string; code: string; year: number; seq: number; number: string };

type RegisterRow = typeof schema.documentRegisters.$inferSelect;

/** Mã sổ mà một định nghĩa dùng (ô cấp số ở biểu mẫu khởi chạy và biểu mẫu của các bước), kèm nơi dùng để báo lỗi. */
export function registersUsedBy(def: ProcessDefinition): { code: string; path: string }[] {
  const out: { code: string; path: string }[] = [];
  for (const f of def.inputs) if (f.type === 'autonumber' && f.register) out.push({ code: f.register, path: 'inputs' });
  for (const n of def.nodes) {
    if (n.type !== 'task' && n.type !== 'approval') continue;
    for (const f of n.form ?? []) if (f.type === 'autonumber' && f.register) out.push({ code: f.register, path: n.id });
  }
  return out;
}

/**
 * Sổ mà định nghĩa cần mà tổ chức chưa có. Sổ mặc định (VBDEN, VBDI, CHITHI) được tạo ngay; sổ khác thì trả về để báo lỗi,
 * vì một ô cấp số trỏ vào sổ không tồn tại sẽ làm mọi lần khởi chạy bị từ chối.
 */
export async function ensureRegistersFor(tx: Tx, ctx: OrgContext, def: ProcessDefinition): Promise<{ path: string; code: string }[]> {
  const missing: { path: string; code: string }[] = [];
  for (const { code, path } of registersUsedBy(def)) {
    const existing = await findRegister(tx, code);
    if (existing && !existing.archivedAt) continue;
    const preset = DEFAULT_REGISTERS[code];
    if (!preset || existing) {
      missing.push({ path, code: 'register_unknown' });
      continue;
    }
    await tx.insert(schema.documentRegisters).values({ id: newId(clock.now().getTime()), orgId: ctx.orgId, code, name: preset.name, direction: preset.direction, pattern: preset.pattern, resetPolicy: preset.resetPolicy, columns: preset.columns, createdAt: clock.now() });
  }
  return missing;
}

export const asColumns = (v: unknown): RegisterColumn[] =>
  Array.isArray(v) ? v.filter((c): c is RegisterColumn => !!c && typeof c === 'object' && typeof (c as RegisterColumn).key === 'string' && typeof (c as RegisterColumn).label === 'string') : [];

const yearOf = (ctx: OrgContext, now: Date): number => Number(toLocalDate(now, ctx.calendar).slice(0, 4));

async function findRegister(tx: Tx, code: string): Promise<RegisterRow | null> {
  const [row] = await tx.select().from(schema.documentRegisters).where(eq(schema.documentRegisters.code, code));
  return row ?? null;
}

/** Cấp số kế tiếp của sổ `code`. Sổ không có hoặc đã lưu trữ thì 422 `register_unknown`. */
export async function allocateNumber(tx: Tx, ctx: OrgContext, code: string, now: Date = clock.now()): Promise<Allocation> {
  const reg = await findRegister(tx, code);
  if (!reg || reg.archivedAt) throw new ApiError('input_invalid', { errors: [{ path: `register.${code}`, code: 'register_unknown' }] });
  const year = yearOf(ctx, now);
  const counterYear = reg.resetPolicy === 'yearly' ? year : 0;
  const [counter] = await tx
    .insert(schema.documentCounters)
    .values({ orgId: ctx.orgId, registerId: reg.id, year: counterYear, lastSeq: 1 })
    .onConflictDoUpdate({ target: [schema.documentCounters.registerId, schema.documentCounters.year], set: { lastSeq: sql`${schema.documentCounters.lastSeq} + 1` } })
    .returning({ lastSeq: schema.documentCounters.lastSeq });
  const seq = counter!.lastSeq;
  return { registerId: reg.id, code, year: counterYear, seq, number: formatDocumentNumber(reg.pattern, seq, year) };
}

/** Ghi dòng sổ cho một số đã cấp; `values` là ảnh chụp các ô lên cột của sổ. */
export async function recordEntry(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  p: { allocation: Allocation; runId: string; fieldKey: string; subject: string; source: Record<string, unknown> },
): Promise<void> {
  const reg = await findRegister(tx, p.allocation.code);
  // Giá trị gốc kèm nhãn hiển thị (register-values.ts): sổ không hiện mã thô như `khan`, `to_trinh`.
  const def = await definitionOfRun(tx, p.runId);
  const values = snapshotColumns(asColumns(reg?.columns), p.source, def ? fieldIndexOf(def) : new Map(), ctx);
  const now = clock.now();
  await tx.insert(schema.documentEntries).values({
    id: newId(now.getTime()),
    orgId: ctx.orgId,
    registerId: p.allocation.registerId,
    year: p.allocation.year,
    seq: p.allocation.seq,
    number: p.allocation.number,
    runId: p.runId,
    fieldKey: p.fieldKey,
    // Trích yếu lấy từ ô trích yếu của biểu mẫu để văn thư khỏi gõ hai lần; không có ô đó thì dùng tiêu đề lượt chạy.
    subject: subjectOf(p.source, p.subject).slice(0, 300),
    values,
    createdBy: viewer.id,
    createdAt: now,
  });
}

/**
 * Dòng sổ của lượt chạy mật (docs/DECISIONS.md, 07/10/2026 điểm b) chỉ hiện cho người được xem lượt đó; người khác không thấy dòng
 * và số đếm cũng không tính, kể cả người có `run.view_all`. Dòng của lượt thường vẫn mở cho mọi người có quyền xem sổ như trước.
 */
const entryVisible = (_ctx: OrgContext, viewer: Viewer) =>
  sql`EXISTS (SELECT 1 FROM process_runs r WHERE r.id = ${schema.documentEntries.runId} AND ${restrictedRunAccess(viewer)})`;

async function viewOf(tx: Tx, ctx: OrgContext, viewer: Viewer, row: RegisterRow): Promise<RegisterView> {
  const year = yearOf(ctx, clock.now());
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.documentEntries)
    .where(and(eq(schema.documentEntries.registerId, row.id), entryVisible(ctx, viewer)));
  const counterYear = row.resetPolicy === 'yearly' ? year : 0;
  const [counter] = await tx
    .select({ lastSeq: schema.documentCounters.lastSeq })
    .from(schema.documentCounters)
    .where(and(eq(schema.documentCounters.registerId, row.id), eq(schema.documentCounters.year, counterYear)));
  return {
    code: row.code,
    name: row.name,
    direction: row.direction as RegisterView['direction'],
    pattern: row.pattern,
    resetPolicy: row.resetPolicy as RegisterView['resetPolicy'],
    columns: asColumns(row.columns),
    entryCount: Number(count?.n ?? 0),
    nextNumber: formatDocumentNumber(row.pattern, (counter?.lastSeq ?? 0) + 1, year),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export async function listRegisters(tx: Tx, ctx: OrgContext, viewer: Viewer): Promise<RegisterView[]> {
  const rows = await tx.select().from(schema.documentRegisters).orderBy(schema.documentRegisters.direction, schema.documentRegisters.name);
  const out: RegisterView[] = [];
  for (const row of rows) out.push(await viewOf(tx, ctx, viewer, row));
  return out;
}

export async function upsertRegister(tx: Tx, ctx: OrgContext, viewer: Viewer, code: string, body: RegisterUpsert, meta: { ip?: string | null } = {}): Promise<RegisterView> {
  const existing = await findRegister(tx, code);
  const values = { name: body.name.trim(), direction: body.direction, pattern: body.pattern, resetPolicy: body.resetPolicy, columns: body.columns, archivedAt: null };
  let row: RegisterRow;
  if (existing) {
    // Đổi cách đánh lại số khi sổ đã cấp số làm bộ đếm năm 0 và bộ đếm từng năm tách nhau, nên có thể cấp lại số đã dùng (audit files-4).
    // Sổ đã có số thì giữ nguyên chính sách; muốn đổi thì lưu trữ sổ này và tạo sổ mới.
    if (existing.resetPolicy !== body.resetPolicy) {
      const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.documentCounters).where(eq(schema.documentCounters.registerId, existing.id));
      const [issued] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.documentEntries).where(eq(schema.documentEntries.registerId, existing.id));
      if ((used?.n ?? 0) > 0 || (issued?.n ?? 0) > 0) {
        throw new ApiError('state_conflict', { currentState: existing.resetPolicy, errors: [{ path: 'body.resetPolicy', code: 'register_has_numbers' }] });
      }
    }
    [row] = await tx.update(schema.documentRegisters).set(values).where(eq(schema.documentRegisters.id, existing.id)).returning();
  } else {
    [row] = await tx.insert(schema.documentRegisters).values({ id: newId(clock.now().getTime()), orgId: ctx.orgId, code, createdAt: clock.now(), ...values }).returning();
  }
  // Nhật ký chỉ ghi mã sổ, không ghi tên sổ hay mẫu số (CLAUDE.md luật 6).
  await audit(tx, { orgId: ctx.orgId, action: existing ? 'register_updated' : 'register_created', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'register', targetId: row!.id, ip: meta.ip, detail: { code } });
  return viewOf(tx, ctx, viewer, row!);
}

const offsetOf = (cursor?: string): number => {
  const n = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export async function listEntries(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  code: string,
  q: { limit: number; cursor?: string; year?: number; q?: string },
): Promise<Paged<RegisterEntryView>> {
  const reg = await findRegister(tx, code);
  if (!reg) throw new ApiError('not_found');
  const conds = [eq(schema.documentEntries.registerId, reg.id), entryVisible(ctx, viewer)];
  if (q.year) conds.push(eq(schema.documentEntries.year, reg.resetPolicy === 'yearly' ? q.year : 0));
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(or(ilike(schema.documentEntries.number, like), sql`unaccent(${schema.documentEntries.subject}) ILIKE unaccent(${like})`)!);
  }
  const offset = offsetOf(q.cursor);
  const rows = await tx
    .select({ e: schema.documentEntries, runState: schema.processRuns.state })
    .from(schema.documentEntries)
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.documentEntries.runId))
    .where(and(...conds))
    .orderBy(desc(schema.documentEntries.createdAt), desc(schema.documentEntries.seq))
    .limit(q.limit + 1)
    .offset(offset);
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(({ e, runState }) => ({
      id: e.id,
      number: e.number,
      year: e.year,
      seq: e.seq,
      createdAt: e.createdAt.toISOString(),
      subject: e.subject,
      createdBy: ctx.person(e.createdBy),
      run: { id: e.runId, state: runState as RunStateName },
      values: (e.values as Record<string, unknown>) ?? {},
    })),
    nextCursor: rows.length > q.limit ? Buffer.from(String(offset + q.limit), 'utf8').toString('base64url') : null,
  };
}
