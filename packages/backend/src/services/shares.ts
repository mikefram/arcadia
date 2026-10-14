import { ApiError, newId, can, type RunShareRole, type RunShares, type RunShareView } from '@mihato/domain';
import { and, eq, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import type { Viewer } from '../views';
import { findVisibleRun } from './runs';
import { notifyStream } from './stream';

/**
 * Chia sẻ lượt chạy kiểu Google Drive (docs/DECISIONS.md, 07/10/2026 điểm b). Mỗi lượt có danh sách chia sẻ hai mức: `viewer` (xem) và
 * `commenter` (xem và bình luận). Chủ sở hữu (người khởi chạy) và người tham gia lượt (đang hoặc đã giữ, duyệt, góp một việc) luôn có
 * quyền, không thêm vào danh sách và không gỡ được.
 *
 * Ai quản lý chia sẻ: chủ sở hữu, hoặc người có quyền `run.share` (mặc định Chủ tịch và Văn phòng) và xem được lượt đó. Với lượt mật,
 * "xem được" nghĩa là có đường vào riêng; `run.share` một mình không mở lượt mật ra.
 *
 * Mọi quy tắc "ai thấy lượt" nằm ở views.ts (`runAccessSql`); tệp này chỉ quản lý dòng `run_shares` và trả bảng quyền cho màn hình.
 */

type RunRow = typeof schema.processRuns.$inferSelect;

/** Những người tham gia lượt: giữ, được thay mặt, duyệt hoặc góp một việc nào đó của lượt (không gồm chủ sở hữu). */
export async function runParticipantIds(tx: Tx, runId: string): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT u AS user_id FROM (
      SELECT assignee_id AS u FROM step_runs WHERE run_id = ${runId}
      UNION ALL SELECT on_behalf_of_id FROM step_runs WHERE run_id = ${runId}
      UNION ALL SELECT a.approver_id FROM step_approvals a JOIN step_runs s ON s.id = a.step_run_id WHERE s.run_id = ${runId}
      UNION ALL SELECT a.on_behalf_of_id FROM step_approvals a JOIN step_runs s ON s.id = a.step_run_id WHERE s.run_id = ${runId}
    ) t WHERE u IS NOT NULL`);
  return res.rows.map((r) => r.user_id);
}

export type RunAccess = {
  owner: boolean;
  participant: boolean;
  /** mức được chia sẻ, nếu có */
  share: RunShareRole | null;
  canComment: boolean;
  canManage: boolean;
};

/** Quyền của người xem trên một lượt đã biết là xem được. */
export async function runAccessOf(tx: Tx, viewer: Viewer, run: RunRow): Promise<RunAccess> {
  const owner = run.initiatorId === viewer.id;
  const participant = owner ? false : (await runParticipantIds(tx, run.id)).includes(viewer.id);
  const [shared] = await tx
    .select({ role: schema.runShares.role })
    .from(schema.runShares)
    .where(and(eq(schema.runShares.runId, run.id), eq(schema.runShares.userId, viewer.id)));
  const share = (shared?.role as RunShareRole | undefined) ?? null;
  // Người xem mọi lượt bình luận được ở lượt thường; ở lượt mật họ chỉ bình luận được nếu có đường vào riêng (khi đó đã là chủ, người tham gia hay người được chia sẻ).
  const coordinator = run.confidentiality === 'normal' && can(viewer, 'run.view_all');
  return {
    owner,
    participant,
    share,
    canComment: owner || participant || share === 'commenter' || coordinator,
    canManage: owner || can(viewer, 'run.share'),
  };
}

async function sharesView(tx: Tx, ctx: OrgContext, viewer: Viewer, run: RunRow): Promise<RunShares> {
  const rows = await tx.select().from(schema.runShares).where(eq(schema.runShares.runId, run.id)).orderBy(schema.runShares.createdAt, schema.runShares.id);
  const shares: RunShareView[] = rows.flatMap((r) => {
    const person = ctx.person(r.userId);
    return person ? [{ person, role: r.role as RunShareRole, grantedBy: ctx.person(r.grantedBy), createdAt: r.createdAt.toISOString() }] : [];
  });
  const fixed: RunShares['fixed'] = [];
  const owner = ctx.person(run.initiatorId);
  if (owner) fixed.push({ person: owner, role: 'owner' });
  const shared = new Set(rows.map((r) => r.userId));
  for (const id of await runParticipantIds(tx, run.id)) {
    if (id === run.initiatorId || shared.has(id)) continue;
    const person = ctx.person(id);
    if (person) fixed.push({ person, role: 'participant' });
  }
  const access = await runAccessOf(tx, viewer, run);
  return { confidentiality: run.confidentiality as RunShares['confidentiality'], shares, fixed, canManage: access.canManage, canComment: access.canComment };
}

/** Ai xem được lượt thì xem được danh sách chia sẻ của nó (như Drive: biết ai đang có quyền). */
export async function getRunShares(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string): Promise<RunShares> {
  return sharesView(tx, ctx, viewer, await findVisibleRun(tx, ctx, viewer, runId));
}

async function manageableRun(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string): Promise<RunRow> {
  const run = await findVisibleRun(tx, ctx, viewer, runId);
  if (!(await runAccessOf(tx, viewer, run)).canManage) throw new ApiError('forbidden');
  return run;
}

const SHARE_AUDIT = { added: 'run_share_added', changed: 'run_share_changed', removed: 'run_share_removed' } as const;

/** Thêm người vào danh sách chia sẻ hoặc đổi mức. Chủ sở hữu và người tham gia đã luôn có quyền nên không thêm được (422). */
export async function setRunShare(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  runId: string,
  userId: string,
  role: RunShareRole,
  meta: { ip?: string | null } = {},
): Promise<RunShares> {
  const run = await manageableRun(tx, ctx, viewer, runId);
  const target = ctx.users.get(userId);
  if (!target || target.status === 'disabled') throw new ApiError('input_invalid', { errors: [{ path: 'params.userId', code: 'user_unavailable' }] });
  if (userId === run.initiatorId || (await runParticipantIds(tx, run.id)).includes(userId)) {
    throw new ApiError('input_invalid', { errors: [{ path: 'params.userId', code: 'already_has_access' }] });
  }
  const [existing] = await tx.select().from(schema.runShares).where(and(eq(schema.runShares.runId, run.id), eq(schema.runShares.userId, userId)));
  if (existing?.role !== role) {
    if (existing) await tx.update(schema.runShares).set({ role, grantedBy: viewer.id }).where(eq(schema.runShares.id, existing.id));
    else await tx.insert(schema.runShares).values({ id: newId(clock.now().getTime()), orgId: ctx.orgId, runId: run.id, userId, role, grantedBy: viewer.id, createdAt: clock.now() });
    // Nhật ký chỉ có id và mức, không có tên người hay tên lượt (CLAUDE.md luật 6).
    await audit(tx, {
      orgId: ctx.orgId,
      action: existing ? SHARE_AUDIT.changed : SHARE_AUDIT.added,
      actorUserId: viewer.id,
      actorDeviceId: viewer.deviceId,
      targetType: 'run',
      targetId: run.id,
      ip: meta.ip,
      detail: { userId, role, ...(existing ? { previousRole: existing.role } : {}), confidentiality: run.confidentiality },
    });
    await notifyStream(tx, { kind: 'run.updated', orgId: ctx.orgId, runId: run.id, version: run.version });
  }
  return sharesView(tx, ctx, viewer, run);
}

/** Gỡ người khỏi danh sách chia sẻ. Gỡ người không có trong danh sách là 404; chủ sở hữu và người tham gia không gỡ được (422). */
export async function removeRunShare(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string, userId: string, meta: { ip?: string | null } = {}): Promise<RunShares> {
  const run = await manageableRun(tx, ctx, viewer, runId);
  const [existing] = await tx.select().from(schema.runShares).where(and(eq(schema.runShares.runId, run.id), eq(schema.runShares.userId, userId)));
  if (!existing) {
    if (userId === run.initiatorId || (await runParticipantIds(tx, run.id)).includes(userId)) {
      throw new ApiError('input_invalid', { errors: [{ path: 'params.userId', code: 'cannot_remove_participant' }] });
    }
    throw new ApiError('not_found');
  }
  await tx.delete(schema.runShares).where(eq(schema.runShares.id, existing.id));
  await audit(tx, {
    orgId: ctx.orgId,
    action: SHARE_AUDIT.removed,
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'run',
    targetId: run.id,
    ip: meta.ip,
    detail: { userId, previousRole: existing.role, confidentiality: run.confidentiality },
  });
  await notifyStream(tx, { kind: 'run.updated', orgId: ctx.orgId, runId: run.id, version: run.version });
  // Người vừa bị gỡ: nếu còn xem được lượt qua đường khác (lượt thường) thì danh sách vẫn trả bình thường; nếu không, người gọi (người quản lý) không bị ảnh hưởng.
  return sharesView(tx, ctx, viewer, run);
}
