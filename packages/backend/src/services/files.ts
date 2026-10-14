import { createHash } from 'node:crypto';
import {
  ApiError,
  FILE_EXTENSIONS,
  COMMENT_FILES_FIELD,
  EXTRA_FILES_FIELD,
  FILE_MAX_BYTES,
  newId,
  type FileUpload,
  type FileView,
  type FormField,
} from '@mihato/domain';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { fileHidden, hiddenParts } from '../contribution-privacy';
import { schema, type Tx } from '../db/client';
import { COMPILED_FIELD, toFileView, type FileRow } from '../file-view';
import { fileStorage } from '../storage';
import type { Viewer } from '../views';
import { findVisibleRun, findVisibleStep } from './runs';

/**
 * Tệp đính kèm (docs/DECISIONS.md, 06/10/2026). Hai bước: tải lên (tệp ở trạng thái `pending`, chỉ người tải thấy) rồi gắn vào
 * lượt chạy khi gửi biểu mẫu hoặc báo xong (`attached`, ai thấy lượt chạy thì thấy tệp). Tệp chưa gắn sau 24 giờ bị dọn.
 * Nhật ký và dấu vết không chứa tên tệp (CLAUDE.md luật 6): nơi ghi chỉ có id và cỡ.
 */

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  zip: 'application/zip',
};

const startsWith = (buf: Buffer, sig: number[]): boolean => sig.every((b, i) => buf[i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

/** Phần đầu của tệp có khớp phần mở rộng đã khai không (chặn tệp chạy được đổi tên thành .pdf). */
function signatureMatches(ext: string, buf: Buffer): boolean {
  switch (ext) {
    case 'pdf':
      return startsWith(buf, [0x25, 0x50, 0x44, 0x46]);
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'odt':
    case 'ods':
    case 'zip':
      return startsWith(buf, ZIP);
    case 'doc':
    case 'xls':
    case 'ppt':
      return startsWith(buf, OLE);
    case 'rtf':
      return startsWith(buf, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
    case 'png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47]);
    case 'jpg':
    case 'jpeg':
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'gif':
      return startsWith(buf, [0x47, 0x49, 0x46, 0x38]);
    case 'txt':
    case 'csv':
      return !buf.subarray(0, 8192).includes(0);
    default:
      return false;
  }
}

/** Tên tệp để lưu và hiện: bỏ đường dẫn, ký tự điều khiển; không rỗng. */
export function cleanFileName(raw: string): string {
  const base = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  return name.slice(0, 255);
}

/** Số tệp chờ gắn tối đa của một người: chặn việc tải lên liên tục làm đầy ổ đĩa trước khi việc dọn 24 giờ kịp chạy. */
export const MAX_PENDING_FILES_PER_USER = 60;

const invalid = (code: string, path = 'body.data') => new ApiError('input_invalid', { errors: [{ path, code }] });

export async function uploadFile(tx: Tx, ctx: OrgContext, viewer: Viewer, body: FileUpload): Promise<FileView> {
  const name = cleanFileName(body.name);
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (name === '') throw invalid('required', 'body.name');
  if (!(FILE_EXTENSIONS as readonly string[]).includes(ext)) throw invalid('file_type_not_allowed', 'body.name');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw invalid('invalid_base64');
  const data = Buffer.from(body.data, 'base64');
  if (data.length === 0) throw invalid('file_empty');
  if (data.length > FILE_MAX_BYTES) throw invalid('file_too_large');
  if (!signatureMatches(ext, data)) throw invalid('file_content_mismatch');
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.files)
    .where(and(eq(schema.files.ownerUserId, viewer.id), eq(schema.files.status, 'pending'), eq(schema.files.kind, 'attachment')));
  if ((pending?.n ?? 0) >= MAX_PENDING_FILES_PER_USER) throw invalid('too_many_pending_files');

  const now = clock.now();
  const id = newId(now.getTime());
  const storageKey = `${ctx.orgId}/${now.getUTCFullYear()}/${id}`;
  await fileStorage().put(storageKey, data);
  // Ghi dòng CSDL lỗi thì xoá blob vừa ghi, kẻo để lại tệp mồ côi (audit files-6). Lỗi muộn hơn ở nơi gọi làm quay lui cả giao dịch
  // vẫn có thể để lại blob; việc dọn kho định kỳ theo khoá không có trong bảng files là việc của đợt triển khai kho đối tượng.
  let row: FileRow | undefined;
  try {
    [row] = await tx
      .insert(schema.files)
      .values({
        id,
        orgId: ctx.orgId,
        ownerUserId: viewer.id,
        kind: 'attachment',
        name,
        storageKey,
        mime: MIME[ext] ?? 'application/octet-stream',
        sizeBytes: data.length,
        sha256: createHash('sha256').update(data).digest(),
        status: 'pending',
        // TODO(SPEC 11): quét vi-rút trước khi cho tải xuống; chưa có dịch vụ quét nên ghi 'skipped' [GIẢ ĐỊNH].
        scanStatus: 'skipped',
        createdAt: now,
      })
      .returning();
  } catch (err) {
    await fileStorage().remove(storageKey).catch(() => undefined);
    throw err;
  }
  return toFileView(ctx, row!);
}

async function stepTitlesOf(tx: Tx, rows: FileRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.stepRunId ? [r.stepRunId] : [])))];
  if (ids.length === 0) return new Map();
  const found = await tx.select({ id: schema.stepRuns.id, title: schema.stepRuns.title }).from(schema.stepRuns).where(inArray(schema.stepRuns.id, ids));
  return new Map(found.map((r) => [r.id, r.title]));
}

export async function fileViews(tx: Tx, ctx: OrgContext, rows: FileRow[]): Promise<FileView[]> {
  const titles = await stepTitlesOf(tx, rows);
  return rows.map((r) => toFileView(ctx, r, titles));
}

/** Tệp tải xuống được: của chính mình khi còn chờ gắn, hoặc đã gắn vào lượt chạy mà mình thấy được. Ngoài ra là 404. */
export async function downloadFile(tx: Tx, ctx: OrgContext, viewer: Viewer, fileId: string): Promise<{ row: FileRow; data: Buffer }> {
  const [row] = await tx.select().from(schema.files).where(and(eq(schema.files.id, fileId), eq(schema.files.kind, 'attachment')));
  if (!row) throw new ApiError('not_found');
  if (row.status === 'pending' || !row.runId) {
    if (row.ownerUserId !== viewer.id) throw new ApiError('not_found');
  } else if (row.commentId) {
    // Tệp của bình luận: thấy được khi thấy việc có bình luận đó (bình luận đã xoá thì tệp đã bị xoá cùng, xem removeCommentFiles).
    const [comment] = await tx.select({ stepRunId: schema.stepComments.stepRunId, deletedAt: schema.stepComments.deletedAt }).from(schema.stepComments).where(eq(schema.stepComments.id, row.commentId));
    if (!comment || comment.deletedAt) throw new ApiError('not_found');
    await findVisibleStep(tx, ctx, viewer, comment.stepRunId);
  } else {
    await findVisibleRun(tx, ctx, viewer, row.runId);
    // Tệp trong phần của người đóng góp khác thì người chỉ cùng bước góp nội dung không tải được (404 như tệp không có).
    if (fileHidden(row, await hiddenParts(tx, viewer, [row.runId]), viewer.id)) throw new ApiError('not_found');
  }
  let data: Buffer;
  try {
    data = await fileStorage().get(row.storageKey);
  } catch {
    throw new ApiError('not_found');
  }
  return { row, data };
}

/** Xoá tệp mới tải lên mà chưa gắn; chỉ người tải. Tệp đã gắn là một phần của hồ sơ nên không xoá được. */
export async function removePendingFile(tx: Tx, viewer: Viewer, fileId: string): Promise<void> {
  const [row] = await tx.select().from(schema.files).where(and(eq(schema.files.id, fileId), eq(schema.files.kind, 'attachment')));
  if (!row || row.ownerUserId !== viewer.id) throw new ApiError('not_found');
  if (row.status !== 'pending') throw new ApiError('state_conflict', { currentState: 'attached' });
  // Điều kiện trạng thái nằm trong chính câu DELETE: gắn tệp chạy song song thì câu này không xoá nhầm tệp đã gắn (audit files-5).
  const removed = await tx
    .delete(schema.files)
    .where(and(eq(schema.files.id, fileId), eq(schema.files.status, 'pending'), eq(schema.files.ownerUserId, viewer.id)))
    .returning({ id: schema.files.id });
  if (removed.length === 0) throw new ApiError('state_conflict', { currentState: 'attached' });
  await fileStorage().remove(row.storageKey);
}

export async function listRunFiles(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string): Promise<FileView[]> {
  await findVisibleRun(tx, ctx, viewer, runId);
  const hidden = await hiddenParts(tx, viewer, [runId]);
  const rows = await tx
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.runId, runId), eq(schema.files.kind, 'attachment'), eq(schema.files.status, 'attached'), isNull(schema.files.commentId)))
    .orderBy(desc(schema.files.createdAt), desc(schema.files.id));
  return fileViews(tx, ctx, rows.filter((r) => !fileHidden(r, hidden, viewer.id)));
}

/** Id tệp ở các ô kiểu `file` của một biểu mẫu, theo từng ô. */
export function fileFieldIds(fields: readonly FormField[], values: Record<string, unknown>): { key: string; ids: string[] }[] {
  const out: { key: string; ids: string[] }[] = [];
  for (const f of fields) {
    if (f.type !== 'file') continue;
    const v = values[f.key];
    if (Array.isArray(v)) out.push({ key: f.key, ids: v.filter((x): x is string => typeof x === 'string') });
  }
  return out;
}

/**
 * Gắn tệp vào lượt chạy (và việc). Mỗi tệp phải do chính người gắn tải lên và còn chờ gắn, hoặc đã gắn vào đúng lượt chạy này
 * (gửi lại không làm hỏng). Tệp của người khác, tệp đã gắn vào lượt chạy khác, hay id không có đều là `file_unavailable`.
 */
export async function attachFiles(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  p: { runId: string; stepRunId: string | null; fieldKey: string; fileIds: string[]; path?: string },
): Promise<void> {
  const ids = [...new Set(p.fileIds)];
  if (ids.length === 0) return;
  const rows = await tx.select().from(schema.files).where(and(inArray(schema.files.id, ids), eq(schema.files.kind, 'attachment')));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    const ok = row && ((row.status === 'pending' && row.ownerUserId === viewer.id) || (row.status === 'attached' && row.runId === p.runId));
    if (!ok) throw invalid('file_unavailable', p.path ?? `body.${p.fieldKey}`);
  }
  const pending = ids.filter((id) => byId.get(id)!.status === 'pending');
  if (pending.length === 0) return;
  // Chỉ gắn tệp còn `pending` của chính người gắn; số dòng cập nhật phải bằng số tệp cần gắn, lệch tức là có yêu cầu khác vừa gắn hoặc xoá
  // tệp đó (audit files-5).
  const attached = await tx
    .update(schema.files)
    .set({ runId: p.runId, stepRunId: p.stepRunId, fieldKey: p.fieldKey, status: 'attached' })
    .where(and(inArray(schema.files.id, pending), eq(schema.files.status, 'pending'), eq(schema.files.ownerUserId, viewer.id)))
    .returning({ id: schema.files.id });
  if (attached.length !== pending.length) throw invalid('file_unavailable', p.path ?? `body.${p.fieldKey}`);
}

/** Lưu một tệp do máy chủ dựng (tệp tổng hợp) và gắn thẳng vào việc. */
export async function storeGeneratedFile(
  tx: Tx,
  ctx: OrgContext,
  p: { runId: string; stepRunId: string; ownerUserId: string; name: string; mime: string; data: Buffer; /** tệp tổng hợp mà tệp này là bản PDF của nó */ sourceFileId?: string },
): Promise<FileView> {
  const now = clock.now();
  const id = newId(now.getTime());
  const storageKey = `${ctx.orgId}/${now.getUTCFullYear()}/${id}`;
  await fileStorage().put(storageKey, p.data);
  const [row] = await tx
    .insert(schema.files)
    .values({
      id,
      orgId: ctx.orgId,
      ownerUserId: p.ownerUserId,
      runId: p.runId,
      stepRunId: p.stepRunId,
      kind: 'attachment',
      name: cleanFileName(p.name),
      storageKey,
      mime: p.mime,
      sizeBytes: p.data.length,
      sha256: createHash('sha256').update(p.data).digest(),
      status: 'attached',
      fieldKey: COMPILED_FIELD,
      scanStatus: 'clean',
      sourceFileId: p.sourceFileId ?? null,
      createdAt: now,
    })
    .returning();
  const titles = await stepTitlesOf(tx, [row!]);
  return toFileView(ctx, row!, titles);
}

/** Dọn tệp tải lên mà không gắn sau `olderThan`. Trả số tệp đã xoá. */
export async function purgePendingFiles(tx: Tx, olderThan: Date): Promise<number> {
  const rows = await tx
    .select({ id: schema.files.id, storageKey: schema.files.storageKey })
    .from(schema.files)
    .where(and(eq(schema.files.status, 'pending'), eq(schema.files.kind, 'attachment'), lt(schema.files.createdAt, olderThan)))
    .limit(500);
  if (rows.length === 0) return 0;
  await tx.delete(schema.files).where(inArray(schema.files.id, rows.map((r) => r.id)));
  for (const r of rows) await fileStorage().remove(r.storageKey);
  return rows.length;
}

/** Người từng giữ một việc của lượt chạy (làm, duyệt, hay góp phần): thuộc về lượt chạy nên được đính thêm tài liệu cho nó. */
async function heldStepIn(tx: Tx, runId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.stepRuns.id })
    .from(schema.stepRuns)
    .where(and(eq(schema.stepRuns.runId, runId), eq(schema.stepRuns.assigneeId, userId)))
    .limit(1);
  if (row) return true;
  const res = await tx.execute<{ ok: number }>(
    sql`SELECT 1 AS ok FROM step_approvals a JOIN step_runs s ON s.id = a.step_run_id WHERE s.run_id = ${runId} AND a.approver_id = ${userId} LIMIT 1`,
  );
  return res.rows.length > 0;
}

/**
 * Đính THÊM tài liệu vào lượt chạy đang chạy, ngoài các ô `file` của biểu mẫu (ví dụ bản scan bổ sung, văn bản liên quan).
 * Ai: người thấy được lượt chạy VÀ (người khởi chạy, hoặc người từng giữ một việc của lượt, hoặc người có quyền `run.note`)
 * [GIẢ ĐỊNH, docs/DECISIONS.md 12/10/2026]. Lượt chạy đã xong hay đã huỷ thì không đính thêm (hồ sơ đã khép). Tệp phải do chính
 * người gọi tải lên và còn chờ gắn; tệp đã gắn thì không đổi (gửi lại không hỏng). Tệp vào hồ sơ không gắn với việc nào
 * (`stepId` null) và mang `fieldKey = __extra`. Nhật ký chỉ ghi số tệp, không ghi tên tệp.
 */
export async function attachRunFiles(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  runId: string,
  fileIds: string[],
  meta: { ip?: string | null } = {},
): Promise<FileView[]> {
  const run = await findVisibleRun(tx, ctx, viewer, runId);
  if (run.state !== 'running') throw new ApiError('state_conflict', { currentState: run.state });
  const allowed = viewer.permissions.includes('run.note') || run.initiatorId === viewer.id || (await heldStepIn(tx, runId, viewer.id));
  if (!allowed) throw new ApiError('forbidden');
  const ids = [...new Set(fileIds)];
  const before = await tx.select({ id: schema.files.id, status: schema.files.status }).from(schema.files).where(inArray(schema.files.id, ids));
  const pendingBefore = new Set(before.filter((r) => r.status === 'pending').map((r) => r.id));
  await attachFiles(tx, ctx, viewer, { runId, stepRunId: null, fieldKey: EXTRA_FILES_FIELD, fileIds: ids, path: 'body.fileIds' });
  const rows = await tx.select().from(schema.files).where(and(inArray(schema.files.id, ids), eq(schema.files.kind, 'attachment')));
  const added = rows.filter((r) => pendingBefore.has(r.id));
  if (added.length > 0) {
    await audit(tx, {
      orgId: viewer.orgId,
      action: 'run_files_attached',
      actorUserId: viewer.id,
      actorDeviceId: viewer.deviceId,
      targetType: 'run',
      targetId: runId,
      ip: meta.ip,
      detail: { count: added.length, bytes: added.reduce((n, r) => n + r.sizeBytes, 0) },
    });
  }
  return fileViews(tx, ctx, rows);
}

/**
 * Gắn tệp vào một bình luận vừa tạo (docs/DECISIONS.md, 12/10/2026). Chặt hơn `attachFiles`: MỌI tệp phải do chính người viết tải lên
 * và còn chờ gắn; tệp đã gắn ở đâu khác, tệp của người khác hay id không có đều là `file_unavailable`. Tệp mang `fieldKey = __comment`,
 * `commentId`, thuộc lượt chạy của việc nhưng không gắn vào việc nào, nên không hiện ở hồ sơ lượt chạy và không lẫn vào tệp tổng hợp.
 */
export async function attachCommentFiles(tx: Tx, viewer: Viewer, p: { runId: string; commentId: string; fileIds: string[] }): Promise<void> {
  const ids = [...new Set(p.fileIds)];
  if (ids.length === 0) return;
  const attached = await tx
    .update(schema.files)
    .set({ runId: p.runId, stepRunId: null, fieldKey: COMMENT_FILES_FIELD, commentId: p.commentId, status: 'attached' })
    .where(and(inArray(schema.files.id, ids), eq(schema.files.kind, 'attachment'), eq(schema.files.status, 'pending'), eq(schema.files.ownerUserId, viewer.id)))
    .returning({ id: schema.files.id });
  if (attached.length !== ids.length) throw invalid('file_unavailable', 'body.fileIds');
}

/** Tệp đính kèm của các bình luận, theo id bình luận, cũ nhất trước. */
export async function commentFileViews(tx: Tx, ctx: OrgContext, commentIds: string[]): Promise<Map<string, FileView[]>> {
  const out = new Map<string, FileView[]>();
  if (commentIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(schema.files)
    .where(and(inArray(schema.files.commentId, commentIds), eq(schema.files.kind, 'attachment'), eq(schema.files.status, 'attached')))
    .orderBy(schema.files.createdAt, schema.files.id);
  for (const r of rows) {
    const list = out.get(r.commentId!) ?? [];
    list.push(toFileView(ctx, r));
    out.set(r.commentId!, list);
  }
  return out;
}

/** Xoá tệp của một bình luận đang bị xoá (tệp là của người viết, đi cùng bình luận). Trả số tệp đã xoá. */
export async function removeCommentFiles(tx: Tx, commentId: string): Promise<number> {
  const rows = await tx.delete(schema.files).where(eq(schema.files.commentId, commentId)).returning({ storageKey: schema.files.storageKey });
  for (const r of rows) await fileStorage().remove(r.storageKey).catch(() => undefined);
  return rows.length;
}
