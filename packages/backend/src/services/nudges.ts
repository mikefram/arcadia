import { ApiError, HONORIFIC_LABEL, batchEventId, deterministicId, type EngineEvent, type Honorific, type NudgeDraft } from '@mihato/domain';
import { addWorkingDays, atLocalTime, isWorkingDay, lateWorkingDays, toLocalDate } from '@mihato/domain/calendar';
import { relationOf, renderNudge } from '@mihato/domain/nudge';
import { and, eq, inArray } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { applyRunEvent } from '../engine/runner';
import type { Viewer } from '../views';
import { findVisibleStep } from './runs';

type StepRow = typeof schema.stepRuns.$inferSelect;
type RunRow = typeof schema.processRuns.$inferSelect;
export type NudgeTone = 'down' | 'peer' | 'up';
export type ThrottleReason = NonNullable<NudgeDraft['throttleReason']>;
export type NudgeThrottle = { throttled: boolean; reason: ThrottleReason | null; nextAllowedAt: Date | null };

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Giờ yên tĩnh: trả mốc kết thúc nếu `now` đang nằm trong khoảng, ngược lại null. Không cấu hình giờ yên tĩnh (mặc định,
 * docs/DECISIONS.md 04/10/2026) thì luôn null: không bao giờ chặn.
 */
export function quietUntil(ctx: OrgContext, now: Date, quiet: { start: string; end: string } | null = ctx.settings.quietHours): Date | null {
  if (!quiet) return null;
  const day = toLocalDate(now, ctx.calendar);
  const local = new Date(now.getTime() + ctx.calendar.utcOffsetMinutes * 60_000);
  const cur = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return null;
  const endToday = atLocalTime(day, quiet.end, ctx.calendar);
  if (start > end) {
    // khoảng vắt qua nửa đêm, ví dụ 21:00 đến 07:00
    if (cur >= start) return new Date(endToday.getTime() + 86_400_000);
    if (cur < end) return endToday;
    return null;
  }
  return cur >= start && cur < end ? endToday : null;
}

/**
 * Quy tắc chống làm phiền của đi thúc (SPEC 4.7): không quá một lần mỗi việc mỗi ngày làm việc; không trong
 * giờ yên tĩnh; không đi thúc việc chưa quá hạn trừ khi nêu đích danh; không khi đang có yêu cầu gia hạn chờ duyệt.
 */
export function checkNudgeThrottle(
  ctx: OrgContext,
  step: StepRow,
  run: RunRow,
  hasPendingExtension: boolean,
  now: Date,
  opts: { allowNotOverdue?: boolean } = {},
): NudgeThrottle {
  const working = step.state === 'ready' || step.state === 'in_progress';
  if (run.state !== 'running' || !working || !step.assigneeId) return { throttled: true, reason: 'not_open', nextAllowedAt: null };
  if (hasPendingExtension) return { throttled: true, reason: 'extension_pending', nextAllowedAt: null };
  const quiet = quietUntil(ctx, now);
  if (quiet) return { throttled: true, reason: 'quiet_hours', nextAllowedAt: quiet };
  const today = toLocalDate(now, ctx.calendar);
  if (step.lastNudgedAt && toLocalDate(step.lastNudgedAt, ctx.calendar) === today) {
    const next = addWorkingDays(today, 1, ctx.calendar);
    return { throttled: true, reason: 'already_nudged_today', nextAllowedAt: atLocalTime(next, ctx.settings.quietHours?.end ?? ctx.settings.workStart, ctx.calendar) };
  }
  if (!opts.allowNotOverdue && !(step.dueAt && now > step.dueAt)) return { throttled: true, reason: 'not_overdue', nextAllowedAt: step.dueAt };
  return { throttled: false, reason: null, nextAllowedAt: null };
}

async function pendingExtensionStepIds(tx: Tx, stepIds: string[]): Promise<Set<string>> {
  if (stepIds.length === 0) return new Set();
  const rows = await tx
    .select({ stepRunId: schema.extensionRequests.stepRunId })
    .from(schema.extensionRequests)
    .where(and(inArray(schema.extensionRequests.stepRunId, stepIds), eq(schema.extensionRequests.state, 'pending')));
  return new Set(rows.map((r) => r.stepRunId));
}

/** Soạn lời nhắc theo ma trận xưng hô của tổ chức (SPEC 4.7). Mẫu là dữ liệu cấu hình, không viết cứng. */
export function composeNudge(ctx: OrgContext, senderId: string, step: StepRow, now: Date, tone?: NudgeTone): { message: string; relation: NudgeTone; lateDays: number } {
  const to = step.assigneeId ? ctx.users.get(step.assigneeId) : undefined;
  const relation = tone ?? (to ? relationOf(senderId, to.id, ctx.resolve.users) : 'down');
  const lateDays = step.dueAt && now > step.dueAt ? lateWorkingDays(step.dueAt, now, ctx.calendar) : 0;
  const message = renderNudge(ctx.settings.nudgeTemplates[relation], {
    honorific: to?.honorific ? HONORIFIC_LABEL[to.honorific as Honorific] : null,
    givenName: to?.givenName ?? '',
    stepTitle: step.title,
    lateDays,
  });
  return { message, relation, lateDays };
}

export async function draftNudges(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: { stepIds: string[]; tone?: NudgeTone },
  opts: { allowNotOverdue?: boolean } = { allowNotOverdue: true },
): Promise<{ items: NudgeDraft[]; senderName: string }> {
  const now = clock.now();
  const pending = await pendingExtensionStepIds(tx, body.stepIds);
  const items: NudgeDraft[] = [];
  for (const stepId of body.stepIds) {
    const { step, run } = await findVisibleStep(tx, ctx, viewer, stepId);
    const t = checkNudgeThrottle(ctx, step, run, pending.has(stepId), now, opts);
    const { message, relation, lateDays } = composeNudge(ctx, viewer.id, step, now, body.tone);
    items.push({
      stepId,
      stepTitle: step.title,
      runTitle: run.title,
      toUser: ctx.person(step.assigneeId),
      lateWorkingDays: lateDays,
      relation,
      message,
      throttled: t.throttled,
      throttleReason: t.reason,
      nextAllowedAt: t.nextAllowedAt?.toISOString() ?? null,
    });
  }
  return { items, senderName: ctx.settings.nudgeTemplates.senderName };
}

/**
 * Gửi một lời đi thúc: kiểm lại quyền xem, kiểm chống làm phiền, rồi tạo NudgeSent cho advance().
 * Dùng chung cho nút Đi thúc trên web (người soạn) và cho đề xuất đã được xác nhận (AI soạn).
 */
export async function sendOneNudge(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  input: { stepId: string; message: string; eventId: string; aiDrafted: boolean; actor?: EngineEvent['actor']; allowNotOverdue?: boolean },
): Promise<{ nudgeId: string }> {
  const { step, run } = await findVisibleStep(tx, ctx, viewer, input.stepId);
  const now = clock.now();
  const pending = await pendingExtensionStepIds(tx, [input.stepId]);
  const t = checkNudgeThrottle(ctx, step, run, pending.has(input.stepId), now, { allowNotOverdue: input.allowNotOverdue ?? true });
  if (t.throttled) {
    if (t.reason === 'not_open') throw new ApiError('state_conflict', { currentState: step.state });
    throw new ApiError('nudge_throttled', { nextAllowedAt: t.nextAllowedAt?.toISOString(), detail: t.reason ?? undefined });
  }
  const nudgeId = deterministicId(`nudge:${input.eventId}`);
  await applyRunEvent(tx, ctx, run.id, {
    type: 'NudgeSent',
    eventId: input.eventId,
    at: now.toISOString(),
    actor: input.actor ?? { type: 'user', userId: viewer.id },
    stepId: input.stepId,
    nudgeId,
    fromUserId: viewer.id,
    toUserId: step.assigneeId!,
    message: input.message,
    aiDrafted: input.aiDrafted,
  });
  return { nudgeId };
}

export async function sendNudges(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: { items: { stepId: string; message: string }[]; allowNotOverdue?: boolean },
  idempotencyKey: string,
): Promise<{ results: { stepId: string; ok: boolean; nudgeId?: string; error?: { code: string; nextAllowedAt?: string } }[] }> {
  const results: { stepId: string; ok: boolean; nudgeId?: string; error?: { code: string; nextAllowedAt?: string } }[] = [];
  for (const item of body.items) {
    try {
      // Mục bị chặn trả nudge_throttled, các mục khác vẫn gửi (SPEC 10.6): mỗi mục một savepoint.
      const { nudgeId } = await tx.transaction((sp) =>
        sendOneNudge(sp, ctx, viewer, {
          stepId: item.stepId,
          message: item.message,
          eventId: batchEventId(idempotencyKey, item.stepId),
          aiDrafted: false,
          allowNotOverdue: body.allowNotOverdue ?? true,
        }),
      );
      results.push({ stepId: item.stepId, ok: true, nudgeId });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      results.push({ stepId: item.stepId, ok: false, error: { code: err.code, nextAllowedAt: err.extra.nextAllowedAt } });
    }
  }
  return { results };
}

export { isWorkingDay };
