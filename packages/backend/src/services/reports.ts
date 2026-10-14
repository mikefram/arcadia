import { ApiError, type PersonRef, type Report, type ReportQuerySchema } from '@mihato/domain';
import { addCalendarDays, atLocalTime, workingDaysBetween } from '@mihato/domain/calendar';
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, toIso, type Tx } from '../db/client';
import { stepVisibility, type Viewer } from '../views';

/**
 * Báo cáo (SPEC 9.6). Cùng nguồn với Tổng quan và `get_overview` của AI: việc quá hạn đọc từ view `v_step_status`,
 * "đúng hạn" tính theo hạn gốc `due_original_at` để gia hạn không che sự chậm trễ (SPEC 4.8).
 * Ngày làm việc không tính được trong SQL (lịch và ngày nghỉ của tổ chức nằm ở `@mihato/domain/calendar`),
 * nên SQL chỉ lọc và trả dòng, phần cộng chia làm ở tầng ứng dụng (SPEC 5.5).
 */

export type ReportQuery = z.output<typeof ReportQuerySchema>;

type Stamp = string | Date | null;
type DoneRow = { node_id: string; title: string; assignee_id: string | null; activated_at: Stamp; completed_at: Stamp; due_at: Stamp; due_original_at: Stamp; template_id: string };
type OpenRow = { user_id: string | null; open: number | string; overdue: number | string };
type NudgeRow = { to_user_id: string; sent_at: Stamp; replied_at: Stamp };

type Tally = { open: number; overdue: number; completed: number; onTime: number };

const collator = new Intl.Collator('vi');
const dateOf = (v: Stamp): Date | null => {
  const iso = toIso(v);
  return iso ? new Date(iso) : null;
};
const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const mean = (values: number[]): number | null => (values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null);

function tallyOf<K>(map: Map<K, Tally>, key: K): Tally {
  let t = map.get(key);
  if (!t) {
    t = { open: 0, overdue: 0, completed: 0, onTime: 0 };
    map.set(key, t);
  }
  return t;
}

/**
 * Các chỉ số của kỳ [from, to] (ngày lịch theo giờ Việt Nam, tính cả hai đầu):
 * - Việc xong trong kỳ: `state = 'done'` và `completed_at` rơi vào kỳ.
 * - Đúng hạn: `completed_at <= due_original_at`; sau gia hạn: `completed_at <= due_at`. Việc không có hạn không được
 *   tính là đúng hạn nhưng vẫn nằm ở mẫu số, đúng như công thức của Tổng quan, để hai màn không lệch số.
 * - Quá hạn hiện tại, việc đang giữ: trạng thái LÚC NÀY trong `v_step_status`, không phụ thuộc kỳ.
 * - Thời gian xử lý: số ngày làm việc từ `activated_at` tới `completed_at`.
 * - Theo mẫu và bước [GIẢ ĐỊNH]: `count` là số lần bước đó xong trong kỳ; `overdueRate` là phần xong sau hạn gốc.
 * - Đi thúc: lời nhắc gửi trong kỳ, theo người nhận; phản hồi kịp là trả lời không quá một ngày làm việc sau khi gửi.
 * Bộ lọc `unitId` và `userId` xét theo người đang giữ việc (với đi thúc là người nhận lời nhắc).
 */
export async function getReport(tx: Tx, ctx: OrgContext, viewer: Viewer, query: ReportQuery): Promise<Report> {
  if (query.from > query.to) throw new ApiError('input_invalid', { errors: [{ path: 'query.from', code: 'after_to' }] });
  const fromAt = atLocalTime(query.from, '00:00', ctx.calendar);
  const toAt = atLocalTime(addCalendarDays(query.to, 1), '00:00', ctx.calendar);

  const visible = stepVisibility(ctx, viewer);
  const stepFilters: SQL[] = [visible];
  if (query.unitId) stepFilters.push(sql`u.unit_id = ${query.unitId}`);
  if (query.userId) stepFilters.push(sql`s.assignee_id = ${query.userId}`);
  if (query.templateId) stepFilters.push(sql`r.template_id = ${query.templateId}`);
  const stepWhere = sql.join(stepFilters, sql` AND `);

  const nudgeFilters: SQL[] = [visible];
  if (query.unitId) nudgeFilters.push(sql`u.unit_id = ${query.unitId}`);
  if (query.userId) nudgeFilters.push(sql`n.to_user_id = ${query.userId}`);
  if (query.templateId) nudgeFilters.push(sql`r.template_id = ${query.templateId}`);
  const nudgeWhere = sql.join(nudgeFilters, sql` AND `);

  // Ba truy vấn chạy tuần tự: một giao dịch là một kết nối.
  const done = await tx.execute<DoneRow>(sql`
    SELECT s.node_id, s.title, s.assignee_id, s.activated_at, s.completed_at, s.due_at, s.due_original_at, r.template_id
    FROM step_runs s JOIN process_runs r ON r.id = s.run_id LEFT JOIN users u ON u.id = s.assignee_id
    WHERE s.kind IN ('task','approval') AND s.state = 'done' AND s.completed_at >= ${fromAt} AND s.completed_at < ${toAt} AND ${stepWhere}
    ORDER BY s.completed_at, s.id`);
  const open = await tx.execute<OpenRow>(sql`
    SELECT s.assignee_id AS user_id,
           count(*) FILTER (WHERE v.state IN ('ready','in_progress'))::int AS open,
           count(*) FILTER (WHERE v.is_overdue)::int AS overdue
    FROM v_step_status v JOIN step_runs s ON s.id = v.id JOIN process_runs r ON r.id = v.run_id LEFT JOIN users u ON u.id = s.assignee_id
    WHERE v.state IN ('unassigned','ready','in_progress') AND ${stepWhere}
    GROUP BY s.assignee_id`);
  const nudges = await tx.execute<NudgeRow>(sql`
    SELECT n.to_user_id, n.sent_at, n.replied_at
    FROM nudges n JOIN step_runs s ON s.id = n.step_run_id JOIN process_runs r ON r.id = s.run_id LEFT JOIN users u ON u.id = n.to_user_id
    WHERE n.sent_at >= ${fromAt} AND n.sent_at < ${toAt} AND ${nudgeWhere}`);

  const byUserTally = new Map<string, Tally>();
  let overdueNow = 0;
  for (const row of open.rows) {
    overdueNow += Number(row.overdue);
    if (!row.user_id) continue; // việc "Cần giao người": tính vào tổng quá hạn, không thuộc về ai
    const t = tallyOf(byUserTally, row.user_id);
    t.open += Number(row.open);
    t.overdue += Number(row.overdue);
  }

  type StepAgg = { templateId: string; nodeId: string; title: string; count: number; late: number; days: number[] };
  const byStep = new Map<string, StepAgg>();
  const handling: number[] = [];
  let onTime = 0;
  let onTimeAfterExtension = 0;
  for (const row of done.rows) {
    const completedAt = dateOf(row.completed_at)!;
    const dueOriginal = dateOf(row.due_original_at);
    const due = dateOf(row.due_at);
    const activatedAt = dateOf(row.activated_at);
    const isOnTime = dueOriginal !== null && completedAt <= dueOriginal;
    if (isOnTime) onTime++;
    if (due !== null && completedAt <= due) onTimeAfterExtension++;
    const days = activatedAt ? workingDaysBetween(activatedAt, completedAt, ctx.calendar) : null;
    if (days !== null) handling.push(days);

    if (row.assignee_id) {
      const t = tallyOf(byUserTally, row.assignee_id);
      t.completed++;
      if (isOnTime) t.onTime++;
    }
    const key = `${row.template_id}:${row.node_id}`;
    let agg = byStep.get(key);
    if (!agg) {
      agg = { templateId: row.template_id, nodeId: row.node_id, title: row.title, count: 0, late: 0, days: [] };
      byStep.set(key, agg);
    }
    agg.title = row.title;
    agg.count++;
    if (dueOriginal !== null && completedAt > dueOriginal) agg.late++;
    if (days !== null) agg.days.push(days);
  }

  const unknown = (id: string): PersonRef => ({ id, fullName: '', givenName: '', honorific: null });
  const unitOf = (userId: string): string | null => ctx.users.get(userId)?.unitId ?? null;
  const byLoad = <T extends { overdue: number; open: number }>(a: T, b: T): number => b.overdue - a.overdue || b.open - a.open;

  const byUser: Report['byUser'] = [...byUserTally.entries()]
    .map(([userId, t]) => {
      const unitId = unitOf(userId);
      return {
        user: ctx.person(userId) ?? unknown(userId),
        unitName: unitId ? (ctx.units.get(unitId)?.name ?? null) : null,
        open: t.open,
        overdue: t.overdue,
        completed: t.completed,
        onTimeRate: rate(t.onTime, t.completed),
      };
    })
    .sort((a, b) => byLoad(a, b) || collator.compare(a.user.fullName, b.user.fullName) || a.user.id.localeCompare(b.user.id));

  const byUnitTally = new Map<string | null, Tally>();
  for (const [userId, t] of byUserTally) {
    const u = tallyOf(byUnitTally, unitOf(userId));
    u.open += t.open;
    u.overdue += t.overdue;
    u.completed += t.completed;
    u.onTime += t.onTime;
  }
  // Người chưa thuộc đơn vị nào gom vào dòng unitId = null, tên để trống: chữ hiển thị do giao diện lấy từ packages/i18n.
  const byUnit: Report['byUnit'] = [...byUnitTally.entries()]
    .map(([unitId, t]) => ({
      unitId,
      unitName: unitId ? (ctx.units.get(unitId)?.name ?? '') : '',
      open: t.open,
      overdue: t.overdue,
      completed: t.completed,
      onTimeRate: rate(t.onTime, t.completed),
    }))
    .sort((a, b) => byLoad(a, b) || collator.compare(a.unitName, b.unitName));

  const templateIds = [...new Set([...byStep.values()].map((s) => s.templateId))];
  const templates = templateIds.length
    ? await tx.select({ id: schema.processTemplates.id, name: schema.processTemplates.name, kind: schema.processTemplates.kind }).from(schema.processTemplates).where(inArray(schema.processTemplates.id, templateIds))
    : [];
  const templateName = new Map(templates.map((t) => [t.id, t.name]));
  const adhocTemplates = new Set(templates.filter((t) => t.kind === 'adhoc').map((t) => t.id));
  // Việc ngoài quy trình tính vào khối lượng của từng người và đơn vị, nhưng không phải một "quy trình" có nút thắt để phân tích.
  const byTemplateStep: Report['byTemplateStep'] = [...byStep.values()]
    .filter((s) => !adhocTemplates.has(s.templateId))
    .map((s) => ({
      templateId: s.templateId,
      templateName: templateName.get(s.templateId) ?? '',
      nodeId: s.nodeId,
      title: s.title,
      count: s.count,
      avgWorkingDays: mean(s.days),
      overdueRate: rate(s.late, s.count),
    }))
    // Trong mỗi mẫu, bước chậm nhất đứng đầu: đó là "nút thắt".
    .sort((a, b) => collator.compare(a.templateName, b.templateName) || a.templateId.localeCompare(b.templateId) || (b.avgWorkingDays ?? -1) - (a.avgWorkingDays ?? -1) || a.nodeId.localeCompare(b.nodeId));

  const nudgeTally = new Map<string, { received: number; replied: number }>();
  for (const row of nudges.rows) {
    const sentAt = dateOf(row.sent_at)!;
    const repliedAt = dateOf(row.replied_at);
    let t = nudgeTally.get(row.to_user_id);
    if (!t) {
      t = { received: 0, replied: 0 };
      nudgeTally.set(row.to_user_id, t);
    }
    t.received++;
    if (repliedAt && workingDaysBetween(sentAt, repliedAt, ctx.calendar) <= 1) t.replied++;
  }
  const nudgeRows: Report['nudges'] = [...nudgeTally.entries()]
    .map(([userId, t]) => ({ user: ctx.person(userId) ?? unknown(userId), received: t.received, repliedWithinOneWorkingDay: t.replied, replyRate: rate(t.replied, t.received) }))
    .sort((a, b) => b.received - a.received || collator.compare(a.user.fullName, b.user.fullName) || a.user.id.localeCompare(b.user.id));

  return {
    from: query.from,
    to: query.to,
    asOf: clock.now().toISOString(),
    onTimeRate: rate(onTime, done.rows.length),
    onTimeRateAfterExtension: rate(onTimeAfterExtension, done.rows.length),
    completedCount: done.rows.length,
    overdueNow,
    avgHandlingWorkingDays: mean(handling),
    byUser,
    byUnit,
    byTemplateStep,
    nudges: nudgeRows,
  };
}
