import { ApiError, COMMENT_FILES_MAX, COMMENT_MAX, COMMENT_RATE_PER_MINUTE, deterministicId, newId, type FileView, type StepComment, type StepCommentList } from '@mihato/domain';
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { env } from '../env';
import { attachCommentFiles, commentFileViews, removeCommentFiles } from './files';
import type { Viewer } from '../views';
import { createSystemNotification } from './notifications';
import { findVisibleStep } from './runs';
import { runAccessOf } from './shares';
import { notifyStream } from './stream';

/**
 * Bình luận theo việc (docs/DECISIONS.md, 07/10/2026 điểm a): mỗi việc có một chuỗi bình luận. Ai thấy việc thì đọc được; người giữ hoặc
 * duyệt việc, người khởi chạy, người xem mọi lượt (lượt thường) và người được chia sẻ mức bình luận thì viết được. Không có chat nhóm,
 * không có chat nhóm. Từ 12/10/2026 bình luận đính được tối đa COMMENT_FILES_MAX tệp (docs/DECISIONS.md): tệp do chính người viết tải lên
 * rồi gắn khi gửi, ai thấy việc thì tải được, và tệp đi cùng bình luận (xoá bình luận thì xoá tệp).
 *
 * Bình luận KHÔNG phải sự kiện của engine: nó không đổi trạng thái việc hay lượt chạy, không đi qua `advance()` và không ghi `run_events`
 * (CLAUDE.md luật 2 và 3 không bị đụng: engine vẫn thuần, AI không có đường ghi nào ở đây). Mọi bình luận đi qua ba hàm dưới đây.
 * Nhật ký chỉ ghi id, không ghi nội dung (luật 6); tin đẩy chỉ nêu tên việc.
 */

type CommentRow = typeof schema.stepComments.$inferSelect;

function viewOf(ctx: OrgContext, viewer: Viewer, row: CommentRow, files: FileView[] = []): StepComment {
  return {
    id: row.id,
    stepId: row.stepRunId,
    author: ctx.person(row.authorId) ?? { id: row.authorId, fullName: '', givenName: '', honorific: null },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    mine: row.authorId === viewer.id,
    files,
  };
}

const cursorOf = (row: CommentRow): string => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
function parseCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(new Date(at).getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ApiError('input_invalid', { errors: [{ path: 'query.cursor', code: 'invalid' }] });
  }
  return { at, id };
}

export async function listStepComments(tx: Tx, ctx: OrgContext, viewer: Viewer, stepId: string, q: { limit: number; cursor?: string }): Promise<StepCommentList> {
  const { run } = await findVisibleStep(tx, ctx, viewer, stepId);
  const after = parseCursor(q.cursor);
  const where = [eq(schema.stepComments.stepRunId, stepId), isNull(schema.stepComments.deletedAt)];
  if (after) where.push(sql`(${schema.stepComments.createdAt}, ${schema.stepComments.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`);
  const rows = await tx
    .select()
    .from(schema.stepComments)
    .where(and(...where))
    .orderBy(asc(schema.stepComments.createdAt), asc(schema.stepComments.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const files = await commentFileViews(tx, ctx, page.map((r) => r.id));
  return {
    items: page.map((r) => viewOf(ctx, viewer, r, files.get(r.id))),
    nextCursor: rows.length > q.limit ? cursorOf(page[page.length - 1]!) : null,
    canComment: (await runAccessOf(tx, viewer, run)).canComment,
  };
}

/** Người nhận tin "có bình luận mới": người giữ việc (người nhận, người được thay mặt, người duyệt chưa quyết), và người khởi chạy; trừ tác giả. */
async function recipientsOf(tx: Tx, ctx: OrgContext, stepId: string, initiatorId: string, authorId: string): Promise<string[]> {
  const [step] = await tx.select({ assigneeId: schema.stepRuns.assigneeId, onBehalfOfId: schema.stepRuns.onBehalfOfId }).from(schema.stepRuns).where(eq(schema.stepRuns.id, stepId));
  const approvers = await tx
    .select({ approverId: schema.stepApprovals.approverId, onBehalfOfId: schema.stepApprovals.onBehalfOfId })
    .from(schema.stepApprovals)
    .where(and(eq(schema.stepApprovals.stepRunId, stepId), isNull(schema.stepApprovals.decision)));
  const ids = new Set<string>([initiatorId]);
  for (const id of [step?.assigneeId, step?.onBehalfOfId, ...approvers.flatMap((a) => [a.approverId, a.onBehalfOfId])]) if (id) ids.add(id);
  ids.delete(authorId);
  return [...ids].filter((id) => ctx.users.get(id)?.status === 'active').sort();
}

/**
 * Viết bình luận. Giới hạn COMMENT_RATE_PER_MINUTE bình luận mỗi phút mỗi người (429 `rate_limited`).
 * Người xem được việc mà không có quyền bình luận (mức "xem", người ngoài tham gia ở lượt mật...) nhận 403 `forbidden`.
 */
export async function addStepComment(tx: Tx, ctx: OrgContext, viewer: Viewer, stepId: string, input: { body: string; fileIds?: string[] }, meta: { ip?: string | null } = {}): Promise<StepComment> {
  const { step, run } = await findVisibleStep(tx, ctx, viewer, stepId);
  if (!(await runAccessOf(tx, viewer, run)).canComment) throw new ApiError('forbidden');
  const body = input.body.trim();
  const fileIds = [...new Set(input.fileIds ?? [])];
  if (body.length === 0 && fileIds.length === 0) throw new ApiError('input_invalid', { errors: [{ path: 'body.body', code: 'required' }] });
  if (fileIds.length > COMMENT_FILES_MAX) throw new ApiError('input_invalid', { errors: [{ path: 'body.fileIds', code: 'too_many' }] });
  if (body.length > COMMENT_MAX) throw new ApiError('input_invalid', { errors: [{ path: 'body.body', code: 'too_long' }] });
  const now = clock.now();
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.stepComments)
    .where(and(eq(schema.stepComments.authorId, viewer.id), gt(schema.stepComments.createdAt, new Date(now.getTime() - 60_000)), lte(schema.stepComments.createdAt, now)));
  if ((recent?.n ?? 0) >= COMMENT_RATE_PER_MINUTE) throw new ApiError('rate_limited');

  const [row] = await tx
    .insert(schema.stepComments)
    .values({ id: newId(now.getTime()), orgId: ctx.orgId, stepRunId: step.id, runId: run.id, authorId: viewer.id, body, createdAt: now })
    .returning();
  await attachCommentFiles(tx, viewer, { runId: run.id, commentId: row!.id, fileIds });
  await audit(tx, {
    orgId: ctx.orgId,
    action: 'step_comment_added',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'step_comment',
    targetId: row!.id,
    ip: meta.ip,
    detail: { stepId: step.id, runId: run.id, fileCount: fileIds.length },
  });
  // Tiêu đề do máy chủ dựng từ mẫu ở packages/i18n, chỉ có tên việc; không có nội dung bình luận, không có tên người viết.
  for (const userId of await recipientsOf(tx, ctx, step.id, run.initiatorId, viewer.id)) {
    await createSystemNotification(tx, ctx, {
      id: deterministicId(`comment-notify:${row!.id}:${userId}`),
      userId,
      kind: 'comment_new',
      vars: { việc: step.title, lượt: run.title },
      runId: run.id,
      stepId: step.id,
      payload: { type: 'comment_new', link: `${env.appScheme}://step/${step.id}`, runId: run.id, stepId: step.id },
      push: true,
    });
  }
  await notifyStream(tx, { kind: 'step.updated', orgId: ctx.orgId, runId: run.id, stepId: step.id, version: run.version });
  const files = await commentFileViews(tx, ctx, [row!.id]);
  return viewOf(ctx, viewer, row!, files.get(row!.id));
}

/** Xoá mềm bình luận của chính mình. Người khác 403; không có hoặc không thấy việc thì 404; xoá lại là không sao. */
export async function deleteStepComment(tx: Tx, ctx: OrgContext, viewer: Viewer, stepId: string, commentId: string, meta: { ip?: string | null } = {}): Promise<void> {
  const { step, run } = await findVisibleStep(tx, ctx, viewer, stepId);
  const [row] = await tx.select().from(schema.stepComments).where(and(eq(schema.stepComments.id, commentId), eq(schema.stepComments.stepRunId, step.id)));
  if (!row) throw new ApiError('not_found');
  if (row.authorId !== viewer.id) throw new ApiError('forbidden');
  if (row.deletedAt) return;
  await tx.update(schema.stepComments).set({ deletedAt: clock.now() }).where(and(eq(schema.stepComments.id, commentId), isNull(schema.stepComments.deletedAt)));
  const removedFiles = await removeCommentFiles(tx, commentId);
  await audit(tx, {
    orgId: ctx.orgId,
    action: 'step_comment_deleted',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'step_comment',
    targetId: commentId,
    ip: meta.ip,
    detail: { stepId: step.id, runId: run.id, fileCount: removedFiles },
  });
  await notifyStream(tx, { kind: 'step.updated', orgId: ctx.orgId, runId: run.id, stepId: step.id, version: run.version });
}
