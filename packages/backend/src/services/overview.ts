import type { Overview } from '@mihato/domain';
import { atLocalTime, lateWorkingDays, toLocalDate } from '@mihato/domain/calendar';
import { inArray, sql } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { buildRunSummaries, dayBounds, runVisibility, stepRunVisibility, stepViewsByIds, viewVisibility, type Viewer } from '../views';

/** Việc quá hạn từ 3 ngày làm việc vào mục "Cần Chủ tịch biết" (SPEC 4.6). */
export const ATTENTION_LATE_WORKING_DAYS = 3;

/**
 * Số liệu tổng quan. Web (Tổng quan), tool `get_overview` của AI và trang Tiến độ của Chủ tịch đều gọi đúng
 * hàm này và đọc từ cùng các view ở SPEC 5.5, nên số liệu không bao giờ lệch nhau.
 *
 * MỌI số đếm và danh sách chỉ tính phần người gọi được thấy (audit runs-2; docs/DECISIONS.md, 07/10/2026 điểm b): người có `overview.view`
 * mà không có `run.view_all` chỉ thấy việc của mình, và lượt mật không lọt vào số nào của người ngoài đường vào, kể cả Chủ tịch.
 */
export async function getOverview(tx: Tx, ctx: OrgContext, viewer: Viewer, opts: { unitId?: string; runId?: string } = {}): Promise<Overview> {
  const now = clock.now();
  const b = dayBounds(now, ctx);
  const weekStart = (() => {
    const day = toLocalDate(now, ctx.calendar);
    const start = atLocalTime(day, '00:00', ctx.calendar);
    const local = new Date(start.getTime() + ctx.calendar.utcOffsetMinutes * 60_000);
    const dow = (local.getUTCDay() + 6) % 7; // Thứ Hai = 0
    return new Date(start.getTime() - dow * 86_400_000);
  })();
  const yesterday = new Date(b.today.getTime() - 86_400_000);

  const unitCond = opts.unitId ? sql`AND EXISTS (SELECT 1 FROM users u WHERE u.id = v.assignee_id AND u.unit_id = ${opts.unitId})` : sql``;
  const runCond = opts.runId ? sql`AND v.run_id = ${opts.runId}` : sql``;
  const seen = viewVisibility(ctx, viewer);

  const counts = await tx.execute<{
    overdue: string;
    due_today: string;
    due_tomorrow: string;
    pending_approval: string;
    unassigned: string;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE v.is_overdue) AS overdue,
      count(*) FILTER (WHERE v.state IN ('unassigned','ready','in_progress') AND v.due_at >= ${now} AND v.due_at < ${b.tomorrow}) AS due_today,
      count(*) FILTER (WHERE v.state IN ('unassigned','ready','in_progress') AND v.due_at >= ${b.nextWorkdayStart} AND v.due_at < ${b.nextWorkdayEnd}) AS due_tomorrow,
      count(*) FILTER (WHERE v.kind = 'approval' AND v.state IN ('ready','in_progress')) AS pending_approval,
      count(*) FILTER (WHERE v.state = 'unassigned') AS unassigned
    FROM v_step_status v WHERE ${seen} ${unitCond} ${runCond}`);

  const misc = await tx.execute<{ running: string; pending_ext: string; my_decisions: string; done_week: string; on_time_week: string }>(sql`
    SELECT
      (SELECT count(*) FROM process_runs r WHERE r.state = 'running' AND NOT EXISTS (SELECT 1 FROM process_templates pt WHERE pt.id = r.template_id AND pt.kind = 'adhoc') AND ${runVisibility(ctx, viewer)} ${opts.runId ? sql`AND r.id = ${opts.runId}` : sql``}) AS running,
      (SELECT count(*) FROM extension_requests x JOIN v_step_status v ON v.id = x.step_run_id WHERE x.state = 'pending' AND ${seen} ${unitCond} ${runCond}) AS pending_ext,
      (SELECT count(*) FROM step_approvals a JOIN v_step_status v ON v.id = a.step_run_id
         WHERE a.approver_id = ${viewer.id} AND a.decision IS NULL AND v.state IN ('ready','in_progress')) AS my_decisions,
      (SELECT count(*) FROM step_runs s WHERE s.kind IN ('task','approval') AND s.state = 'done' AND s.completed_at >= ${weekStart} AND ${stepRunVisibility(ctx, viewer)}) AS done_week,
      (SELECT count(*) FROM step_runs s WHERE s.kind IN ('task','approval') AND s.state = 'done' AND s.completed_at >= ${weekStart} AND ${stepRunVisibility(ctx, viewer)}
         AND s.due_original_at IS NOT NULL AND s.completed_at <= s.due_original_at) AS on_time_week`);

  // Lọc nhanh bằng ngày lịch trong SQL, rồi tính ngày làm việc ở tầng ứng dụng (SPEC 5.5).
  const lateRows = await tx.execute<{ id: string; due_at: string }>(sql`
    SELECT v.id, v.due_at FROM v_step_status v WHERE v.is_overdue AND ${seen} AND v.calendar_days_late >= ${ATTENTION_LATE_WORKING_DAYS - 1} ${unitCond} ${runCond}
    ORDER BY v.due_at ASC LIMIT 200`);
  const attentionIds = lateRows.rows.filter((r) => lateWorkingDays(new Date(r.due_at), now, ctx.calendar) >= ATTENTION_LATE_WORKING_DAYS).map((r) => r.id);
  const needsAttention = (await stepViewsByIds(tx, ctx, viewer, attentionIds.slice(0, 50))).sort((a, b) => b.lateWorkingDays - a.lateWorkingDays);

  const doneRuns = await tx.execute<{ id: string }>(
    sql`SELECT r.id FROM process_runs r WHERE r.state = 'completed' AND NOT EXISTS (SELECT 1 FROM process_templates pt WHERE pt.id = r.template_id AND pt.kind = 'adhoc') AND r.completed_at >= ${yesterday} AND ${runVisibility(ctx, viewer)} ORDER BY r.completed_at DESC LIMIT 20`,
  );
  const runIds = doneRuns.rows.map((r) => r.id);
  const runRows = runIds.length ? await tx.select().from(schema.processRuns).where(inArray(schema.processRuns.id, runIds)) : [];
  const order = new Map(runIds.map((id, i) => [id, i]));
  const recentlyCompletedRuns = await buildRunSummaries(
    tx,
    ctx,
    runRows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
  );

  const c = counts.rows[0]!;
  const m = misc.rows[0]!;
  const doneWeek = Number(m.done_week);
  return {
    asOf: now.toISOString(),
    running: Number(m.running),
    overdue: Number(c.overdue),
    dueToday: Number(c.due_today),
    dueTomorrow: Number(c.due_tomorrow),
    pendingApproval: Number(c.pending_approval),
    awaitingMyDecision: Number(m.my_decisions),
    unassigned: Number(c.unassigned),
    pendingExtensions: Number(m.pending_ext),
    onTimeRateThisWeek: doneWeek > 0 ? Number(m.on_time_week) / doneWeek : null,
    completedThisWeek: doneWeek,
    needsAttention,
    recentlyCompletedRuns,
  };
}
