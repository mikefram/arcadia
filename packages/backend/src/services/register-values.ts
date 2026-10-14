import type { FormField, ProcessDefinition, RegisterColumn } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { loadDefinition } from '../engine/runner';

/**
 * Ảnh chụp các ô biểu mẫu lên cột của sổ văn bản (docs/DECISIONS.md, 07/10/2026).
 *
 * - Giá trị gốc (mã `khan`, id người, ngày ISO) giữ nguyên ở `values[khoá]`, để lọc và so sánh không phụ thuộc cách đặt nhãn.
 * - Nhãn để HIỂN THỊ (ô chọn: "Khẩn"; ô chọn người: họ tên) nằm ở `values.__nhan[khoá]`, chụp lúc ghi. Sổ không còn hiện mã thô.
 * - Dòng sổ chỉ ghi một lần lúc cấp số, nhưng có cột chỉ biết sau (người chủ trì do Giám đốc chọn, nơi lưu): mỗi lần một việc
 *   (task) trong lượt chạy xong, các ô của việc đó khớp cột của sổ được gộp vào dòng sổ của lượt chạy.
 * Mọi dữ liệu thêm đều nằm trong cột `values` jsonb có sẵn, không cần cột mới.
 */
export const LABELS_KEY = '__nhan';

type FieldIndex = Map<string, FormField>;

/** Ô theo khoá, từ biểu mẫu khởi chạy rồi biểu mẫu từng việc; khoá trùng thì lấy ô gặp trước. */
export function fieldIndexOf(def: ProcessDefinition): FieldIndex {
  const index: FieldIndex = new Map();
  const add = (fields: readonly FormField[] | undefined) => {
    for (const f of fields ?? []) if (!index.has(f.key)) index.set(f.key, f);
  };
  add(def.inputs);
  for (const n of def.nodes) if (n.type === 'task' || n.type === 'approval') add(n.form);
  return index;
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Nhãn hiển thị của một giá trị theo loại ô; không có nhãn riêng (chữ, số, ngày) thì trả `null`. */
function labelOf(field: FormField | undefined, value: unknown, ctx: Pick<OrgContext, 'person'>): string | null {
  if (!field) return null;
  if (field.type === 'select' && typeof value === 'string') {
    const label = field.options?.find((o) => o.value === value)?.label;
    return label && label !== value ? label : null;
  }
  const name = (id: unknown) => (typeof id === 'string' ? (ctx.person(id)?.fullName ?? '') : '');
  if (field.type === 'user') return name(value) || null;
  if (field.type === 'users' && Array.isArray(value)) return value.map(name).filter(Boolean).join(', ') || null;
  return null;
}

/** Ảnh chụp các cột của sổ từ một nguồn dữ liệu. Chỉ gồm cột có giá trị. */
export function snapshotColumns(columns: readonly RegisterColumn[], source: Record<string, unknown>, index: FieldIndex, ctx: Pick<OrgContext, 'person'>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const labels: Record<string, string> = {};
  for (const c of columns) {
    const v = source[c.key];
    if (isEmpty(v)) continue;
    values[c.key] = typeof v === 'string' ? v.slice(0, 500) : v;
    const label = labelOf(index.get(c.key), v, ctx);
    if (label) labels[c.key] = label.slice(0, 500);
  }
  if (Object.keys(labels).length > 0) values[LABELS_KEY] = labels;
  return values;
}

/** Trích yếu của dòng sổ: ô trích yếu (hoặc tiêu đề) của biểu mẫu, không thì tiêu đề lượt chạy, để văn thư khỏi gõ hai lần. */
export function subjectOf(source: Record<string, unknown>, fallback: string): string {
  for (const key of ['trichYeu', 'tieuDe']) {
    const v = source[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return fallback;
}

/** Định nghĩa của phiên bản mẫu mà một lượt chạy đang dùng. */
export async function definitionOfRun(tx: Tx, runId: string): Promise<ProcessDefinition | null> {
  const [run] = await tx.select({ versionId: schema.processRuns.templateVersionId }).from(schema.processRuns).where(eq(schema.processRuns.id, runId));
  return run ? loadDefinition(tx, run.versionId) : null;
}

/**
 * Một việc (task) của lượt chạy vừa xong: gộp các ô của nó khớp cột của sổ vào dòng sổ của lượt chạy.
 * Việc duyệt hoặc đóng góp không gộp (nhiều người gửi, ô trùng khoá sẽ ghi đè nhau).
 */
export async function mergeStepIntoEntries(tx: Tx, ctx: OrgContext, p: { runId: string; stepRunId: string; values: Record<string, unknown> }): Promise<void> {
  if (Object.keys(p.values).length === 0) return;
  const [step] = await tx.select({ kind: schema.stepRuns.kind }).from(schema.stepRuns).where(eq(schema.stepRuns.id, p.stepRunId));
  if (step?.kind !== 'task') return;
  const entries = await tx
    .select({ id: schema.documentEntries.id, registerId: schema.documentEntries.registerId, values: schema.documentEntries.values })
    .from(schema.documentEntries)
    .where(eq(schema.documentEntries.runId, p.runId));
  if (entries.length === 0) return;
  const def = await definitionOfRun(tx, p.runId);
  if (!def) return;
  const index = fieldIndexOf(def);
  for (const e of entries) {
    const [reg] = await tx.select({ columns: schema.documentRegisters.columns }).from(schema.documentRegisters).where(eq(schema.documentRegisters.id, e.registerId));
    const columns = (Array.isArray(reg?.columns) ? (reg!.columns as RegisterColumn[]) : []).filter((c) => !isEmpty(p.values[c.key]) && index.get(c.key)?.type !== 'autonumber');
    if (columns.length === 0) continue;
    const patch = snapshotColumns(columns, p.values, index, ctx);
    const old = (e.values as Record<string, unknown>) ?? {};
    const labels = { ...((old[LABELS_KEY] as Record<string, string> | undefined) ?? {}), ...((patch[LABELS_KEY] as Record<string, string> | undefined) ?? {}) };
    const next: Record<string, unknown> = { ...old, ...patch };
    if (Object.keys(labels).length > 0) next[LABELS_KEY] = labels;
    await tx.update(schema.documentEntries).set({ values: next }).where(eq(schema.documentEntries.id, e.id));
  }
}
