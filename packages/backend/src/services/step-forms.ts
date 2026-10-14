import type { FormField } from '@mihato/domain';
import { eq } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import type { Viewer } from '../views';
import { attachFiles, fileFieldIds } from './files';
import { allocateNumber, recordEntry, type Allocation } from './registers';
import { mergeStepIntoEntries } from './register-values';

/**
 * Xử lý phần "ngoài engine" của một biểu mẫu (docs/DECISIONS.md, 06/10/2026), dùng chung cho biểu mẫu khởi chạy, biểu mẫu kết quả
 * của việc và biểu mẫu của người duyệt hoặc đóng góp:
 *  1. TRƯỚC khi gọi engine: cấp số cho các ô `autonumber` và ghi số vào giá trị, để sự kiện lưu đúng số đã cấp (phát lại không cấp lại).
 *  2. SAU khi engine chấp nhận: gắn các tệp ở ô `file` vào lượt chạy và việc, ghi các dòng vào sổ văn bản.
 * Sự kiện đã áp rồi (gửi lại cùng khoá chống lặp) thì bỏ qua cả hai bước, kẻo cấp thừa số.
 */
export type PreparedForm = { values: Record<string, unknown>; allocations: (Allocation & { key: string })[] };

export async function eventAlreadyApplied(tx: Tx, eventId: string): Promise<boolean> {
  const [row] = await tx.select({ id: schema.runEvents.id }).from(schema.runEvents).where(eq(schema.runEvents.id, eventId));
  return !!row;
}

export async function prepareForm(tx: Tx, ctx: OrgContext, fields: readonly FormField[], values: Record<string, unknown>, eventId: string): Promise<PreparedForm> {
  const numbered = fields.filter((f) => f.type === 'autonumber' && f.register);
  if (numbered.length === 0 || (await eventAlreadyApplied(tx, eventId))) return { values, allocations: [] };
  const out: Record<string, unknown> = { ...values };
  const allocations: PreparedForm['allocations'] = [];
  for (const f of numbered) {
    // Số do máy chủ cấp: giá trị người dùng gửi lên ở ô này bị bỏ.
    const a = await allocateNumber(tx, ctx, f.register!, clock.now());
    out[f.key] = a.number;
    allocations.push({ ...a, key: f.key });
  }
  return { values: out, allocations };
}

export async function finalizeForm(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  p: {
    runId: string;
    runTitle: string;
    stepRunId: string | null;
    fields: readonly FormField[];
    values: Record<string, unknown>;
    /** ngữ cảnh cho các cột của sổ: biểu mẫu khởi chạy cộng kết quả */
    source: Record<string, unknown>;
    allocations: PreparedForm['allocations'];
    /** tệp đính kèm không thuộc ô nào (ví dụ đính kèm khi báo xong) */
    extraFileIds?: string[];
  },
): Promise<void> {
  for (const f of fileFieldIds(p.fields, p.values)) {
    await attachFiles(tx, ctx, viewer, { runId: p.runId, stepRunId: p.stepRunId, fieldKey: f.key, fileIds: f.ids, path: `body.result.${f.key}` });
  }
  if (p.extraFileIds?.length) await attachFiles(tx, ctx, viewer, { runId: p.runId, stepRunId: p.stepRunId, fieldKey: 'attachments', fileIds: p.extraFileIds, path: 'body.fileIds' });
  for (const a of p.allocations) await recordEntry(tx, ctx, viewer, { allocation: a, runId: p.runId, fieldKey: a.key, subject: p.runTitle, source: p.source });
  // Ô của việc (task) khớp cột của sổ (người chủ trì, nơi lưu...) được gộp vào dòng sổ của lượt chạy.
  if (p.stepRunId) await mergeStepIntoEntries(tx, ctx, { runId: p.runId, stepRunId: p.stepRunId, values: p.values });
}
