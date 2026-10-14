import {
  ApiError,
  batchEventId,
  can,
  confidentialityOf,
  deterministicId,
  type ActivityItem,
  type EngineEvent,
  type ExtensionRequestView,
  type FormField,
  type NudgeView,
  type Paged,
  type RunCreate,
  type RunDetail,
  type RunEventRecord,
  type RunEventView,
  type RunSummary,
  type StepDetail,
  type StepHistoryItem,
  type StepResult,
  type StepView,
} from '@mihato/domain';
import { canStartRun } from '@mihato/workflow-engine';
import { and, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { requireStepUp } from '../auth/service';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { inOrder, schema, type Tx } from '../db/client';
import { applyRunEvent, createAndStartRun, loadDefinition } from '../engine/runner';
import { hiddenParts, ownPartOnlySteps, redactEvent } from '../contribution-privacy';
import { buildRunDetail, buildRunSummaries, buildStepViews, dayBounds, runVisibility, seesAllRuns, stepViewsByIds, stepVisibility, visibleStepIds, type Viewer } from '../views';
import { hasCompiledFile } from './compile';
import { fileFieldIds } from './files';
import { assertTargetFarEnough, composeRunTitle, isGuardedCategory } from '../run-guards';
import { eventAlreadyApplied, finalizeForm, prepareForm } from './step-forms';

type RunRow = typeof schema.processRuns.$inferSelect;
type StepRow = typeof schema.stepRuns.$inferSelect;

const userActor = (viewer: Viewer): EngineEvent['actor'] => ({ type: 'user', userId: viewer.id });
const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const offsetOf = (cursor?: string): number => {
  const n = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const cursorOf = (offset: number): string => Buffer.from(String(offset), 'utf8').toString('base64url');
const like = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

async function orderedRuns(tx: Tx, ids: string[]): Promise<RunRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select().from(schema.processRuns).where(inArray(schema.processRuns.id, ids));
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// ───────────────────────── Lượt chạy ─────────────────────────

export async function latestPublishedVersion(tx: Tx, templateId: string) {
  const [tpl] = await tx.select().from(schema.processTemplates).where(eq(schema.processTemplates.id, templateId));
  if (!tpl) throw new ApiError('not_found');
  const [ver] = await tx
    .select()
    .from(schema.processTemplateVersions)
    .where(and(eq(schema.processTemplateVersions.templateId, templateId), eq(schema.processTemplateVersions.status, 'published')))
    .orderBy(desc(schema.processTemplateVersions.version))
    .limit(1);
  return { template: tpl, version: ver ?? null };
}

/** Khởi chạy: lấy bản xuất bản mới nhất, sự kiện StartRun (SPEC 10.5). `eventId` là Idempotency-Key. */
export async function startRun(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: RunCreate,
  eventId: string,
  actor: EngineEvent['actor'] = userActor(viewer),
): Promise<RunDetail> {
  const { template, version } = await latestPublishedVersion(tx, body.templateId);
  // Mẫu một việc ẩn của việc ngoài quy trình không phải quy trình để khởi chạy lại: giao việc mới đi qua createAdhocTask.
  if (template.kind !== 'process') throw new ApiError('not_found');
  if (template.archivedAt) throw new ApiError('state_conflict', { currentState: 'archived' });
  if (!version) throw new ApiError('template_invalid');
  const def = await loadDefinition(tx, version.id);
  // Ai được khởi chạy do chính quy trình quy định (`starters`); không khai báo thì người có quyền `run.start` (docs/DECISIONS.md, 06/10/2026).
  if (!canStartRun(def, viewer.id, ctx.resolve)) throw new ApiError('forbidden');
  // Chỉ thị: hạn phải đủ xa và mức khẩn in lên tiêu đề (run-guards.ts). Gửi lại cùng khoá chống lặp thì không kiểm lại.
  const guarded = isGuardedCategory(template.category);
  if (guarded && !(await eventAlreadyApplied(tx, eventId))) assertTargetFarEnough(def, body.inputs, ctx.calendar, clock.now());
  const prepared = await prepareForm(tx, ctx, def.inputs, body.inputs, eventId);
  const res = await createAndStartRun(tx, ctx, {
    templateId: template.id,
    templateVersionId: version.id,
    title: guarded ? composeRunTitle(def, body.title, body.inputs) : body.title,
    inputs: prepared.values,
    initiatorId: viewer.id,
    eventId,
    actor,
  });
  if (res.applied) {
    // Mức mật tính MỘT LẦN ở đây (docs/DECISIONS.md, 07/10/2026 điểm b), không ở engine: engine thuần và không biết gì về chia sẻ.
    // Cùng giao dịch với StartRun, nên không có khoảnh khắc nào lượt mật còn mang mức thường mà người khác đọc được.
    if (confidentialityOf(def.inputs, prepared.values) === 'restricted') {
      await tx.update(schema.processRuns).set({ confidentiality: 'restricted' }).where(eq(schema.processRuns.id, res.run.id));
    }
    await finalizeForm(tx, ctx, viewer, { runId: res.run.id, runTitle: res.run.title, stepRunId: null, fields: def.inputs, values: prepared.values, source: prepared.values, allocations: prepared.allocations });
  }
  const [row] = await tx.select().from(schema.processRuns).where(eq(schema.processRuns.id, res.run.id));
  return buildRunDetail(tx, ctx, viewer, row!);
}

export type RunListQuery = {
  limit: number;
  cursor?: string;
  state?: string;
  unitId?: string;
  templateId?: string;
  q?: string;
  late?: boolean;
  adhoc?: boolean;
  sort: '-startedAt' | 'startedAt' | 'targetAt' | '-targetAt';
};

export async function listRuns(tx: Tx, ctx: OrgContext, viewer: Viewer, q: RunListQuery): Promise<Paged<RunSummary>> {
  const conds: SQL[] = [runVisibility(ctx, viewer)];
  if (q.state) conds.push(sql`r.state = ${q.state}`);
  if (q.templateId) conds.push(sql`r.template_id = ${q.templateId}`);
  if (q.q) conds.push(sql`unaccent(r.title) ILIKE unaccent(${like(q.q)})`);
  if (q.adhoc !== undefined) conds.push(sql`${q.adhoc ? sql`` : sql`NOT `}EXISTS (SELECT 1 FROM process_templates pt WHERE pt.id = r.template_id AND pt.kind = 'adhoc')`);
  if (q.late)
    conds.push(
      sql`r.state = 'running' AND EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id = r.id AND s.kind IN ('task','approval') AND s.state IN ('unassigned','ready','in_progress') AND s.due_at < app_now())`,
    );
  if (q.unitId)
    conds.push(sql`EXISTS (SELECT 1 FROM step_runs s JOIN users u ON u.id = s.assignee_id WHERE s.run_id = r.id AND u.unit_id = ${q.unitId})`);
  const order =
    q.sort === 'startedAt'
      ? sql`r.started_at ASC NULLS LAST, r.id`
      : q.sort === 'targetAt'
        ? sql`r.target_at ASC NULLS LAST, r.id`
        : q.sort === '-targetAt'
          ? sql`r.target_at DESC NULLS LAST, r.id`
          : sql`r.started_at DESC NULLS LAST, r.id DESC`;
  const offset = offsetOf(q.cursor);
  const res = await tx.execute<{ id: string }>(
    sql`SELECT r.id FROM process_runs r WHERE ${sql.join(conds, sql` AND `)} ORDER BY ${order} LIMIT ${q.limit + 1} OFFSET ${offset}`,
  );
  const ids = res.rows.map((r) => r.id);
  const page = ids.slice(0, q.limit);
  const items = await buildRunSummaries(tx, ctx, await orderedRuns(tx, page));
  return { items, nextCursor: ids.length > q.limit ? cursorOf(offset + q.limit) : null };
}

/** Ngoài tầm nhìn thì 404, không lộ là có tồn tại (SPEC 10.1). */
export async function findVisibleRun(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string): Promise<RunRow> {
  const res = await tx.execute<{ id: string }>(sql`SELECT r.id FROM process_runs r WHERE r.id = ${runId} AND ${runVisibility(ctx, viewer)}`);
  if (res.rows.length === 0) throw new ApiError('not_found');
  const [row] = await tx.select().from(schema.processRuns).where(eq(schema.processRuns.id, runId));
  if (!row) throw new ApiError('not_found');
  return row;
}

export async function getRun(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string): Promise<RunDetail> {
  return buildRunDetail(tx, ctx, viewer, await findVisibleRun(tx, ctx, viewer, runId));
}

type EventRow = typeof schema.runEvents.$inferSelect;

function eventView(ctx: OrgContext, e: EventRow, titles: Map<string, string>): RunEventView {
  const payload = e.payload as RunEventRecord['payload'];
  const { actor: _actor, eventId: _eventId, at: _at, type: _type, ...params } = payload.event as EngineEvent & Record<string, unknown>;
  const stepId = typeof (params as { stepId?: unknown }).stepId === 'string' ? ((params as { stepId: string }).stepId as string) : null;
  return {
    id: e.id,
    seq: e.seq,
    type: e.type,
    at: e.at.toISOString(),
    actorType: e.actorType as RunEventView['actorType'],
    actor: ctx.person(e.actorId),
    proposalId: e.proposalId,
    stepId,
    stepTitle: stepId ? (titles.get(stepId) ?? null) : null,
    payload: { ...params, changes: payload.changes, people: peopleIn(ctx, params, payload.changes), stepTitles: titlesIn(titles, payload.changes) },
  };
}

const PERSON_KEYS = ['toUserId', 'fromUserId', 'assigneeId', 'onBehalfOfId', 'approverId', 'requestedBy', 'decidedBy', 'from', 'to'];

/** PersonRef của mọi người được nhắc tới trong sự kiện, để client dựng câu "giao lại cho chị Lan" mà không gọi thêm. */
function peopleIn(ctx: OrgContext, params: Record<string, unknown>, changes: RunEventRecord['payload']['changes']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (obj: Record<string, unknown>) => {
    for (const k of PERSON_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && !out[v]) {
        const p = ctx.person(v);
        if (p) out[v] = p;
      }
    }
    const list = obj.toUserIds;
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string' && !out[id]) out[id] = ctx.person(id) ?? undefined;
  };
  visit(params);
  for (const c of changes) visit(c as unknown as Record<string, unknown>);
  return out;
}

/** Tên của các việc được nhắc tới trong thay đổi dẫn xuất (ví dụ việc vừa được kích hoạt). */
function titlesIn(titles: Map<string, string>, changes: RunEventRecord['payload']['changes']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of changes) {
    const id = (c as { stepId?: string }).stepId;
    const t = id ? titles.get(id) : undefined;
    if (id && t) out[id] = t;
  }
  return out;
}

async function stepTitles(tx: Tx, runIds: string[]): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const rows = await tx.select({ id: schema.stepRuns.id, title: schema.stepRuns.title }).from(schema.stepRuns).where(inArray(schema.stepRuns.runId, runIds));
  return new Map(rows.map((r) => [r.id, r.title]));
}

export async function listRunEvents(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  runId: string,
  q: { limit: number; afterSeq?: number },
): Promise<{ items: RunEventView[]; nextSeq: number | null }> {
  await findVisibleRun(tx, ctx, viewer, runId);
  const rows = await tx
    .select()
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.seq, q.afterSeq ?? 0)))
    .orderBy(schema.runEvents.seq)
    .limit(q.limit + 1);
  const titles = await stepTitles(tx, [runId]);
  const hidden = await ownPartOnlySteps(tx, viewer, [runId]);
  const page = rows.slice(0, q.limit);
  return { items: page.map((e) => redactEvent(eventView(ctx, e, titles), hidden, viewer.id, e.actorId)), nextSeq: rows.length > q.limit ? page[page.length - 1]!.seq : null };
}

export async function listActivity(tx: Tx, ctx: OrgContext, viewer: Viewer, limit: number): Promise<ActivityItem[]> {
  const res = await tx.execute<{ id: string }>(
    sql`SELECT e.id FROM run_events e JOIN process_runs r ON r.id = e.run_id
        WHERE ${runVisibility(ctx, viewer)} AND e.type <> 'TimerFired' ORDER BY e.at DESC, e.seq DESC LIMIT ${limit}`,
  );
  const ids = res.rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ e: schema.runEvents, runTitle: schema.processRuns.title })
    .from(schema.runEvents)
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.runEvents.runId))
    .where(inArray(schema.runEvents.id, ids));
  const runIds = [...new Set(rows.map((r) => r.e.runId))];
  const titles = await stepTitles(tx, runIds);
  const hidden = await ownPartOnlySteps(tx, viewer, runIds);
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.e.id) ?? 0) - (order.get(b.e.id) ?? 0))
    .map((r) => ({ ...redactEvent(eventView(ctx, r.e, titles), hidden, viewer.id, r.e.actorId), runId: r.e.runId, runTitle: r.runTitle }));
}

export async function cancelRun(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  runId: string,
  body: { reason: string; confirmTitle: string },
  eventId: string,
): Promise<RunDetail> {
  const run = await findVisibleRun(tx, ctx, viewer, runId);
  if (body.confirmTitle.trim() !== run.title.trim()) throw new ApiError('input_invalid', { errors: [{ path: 'body.confirmTitle', code: 'title_mismatch' }] });
  await applyRunEvent(tx, ctx, runId, { type: 'CancelRun', eventId, at: clock.now().toISOString(), actor: userActor(viewer), reason: body.reason });
  return getRun(tx, ctx, viewer, runId);
}

export async function addRunNote(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string, text: string, eventId: string, actor: EngineEvent['actor'] = userActor(viewer)): Promise<void> {
  await findVisibleRun(tx, ctx, viewer, runId);
  await applyRunEvent(tx, ctx, runId, { type: 'AddNote', eventId, at: clock.now().toISOString(), actor, text });
}

// ───────────────────────── Việc ─────────────────────────

export type StepListQuery = {
  limit: number;
  cursor?: string;
  assignee?: string;
  scope?: 'team';
  bucket?: 'overdue' | 'today' | 'upcoming' | 'done' | 'other';
  state?: string;
  late?: boolean;
  unitId?: string;
  runId?: string;
  kind?: 'task' | 'approval';
  open?: boolean;
  q?: string;
  sort: 'dueAt' | '-dueAt' | '-completedAt';
};

export async function listSteps(tx: Tx, ctx: OrgContext, viewer: Viewer, q: StepListQuery): Promise<Paged<StepView>> {
  const conds: SQL[] = [sql`s.kind IN ('task','approval')`, stepVisibility(ctx, viewer)];
  const now = clock.now();
  const b = dayBounds(now, ctx);
  const OPEN = sql`s.state IN ('unassigned','ready','in_progress')`;
  let needsRunning = false;

  if (q.assignee) {
    const who = q.assignee === 'me' ? viewer.id : q.assignee;
    // Nút duyệt hoặc đóng góp nhiều người: khi việc còn mở, chỉ người CHƯA quyết (chưa gửi phần của mình) còn thấy nó là việc của mình;
    // việc đã xong thì mọi người tham gia đều thấy ở lịch sử.
    conds.push(
      sql`(s.assignee_id = ${who} OR EXISTS (SELECT 1 FROM step_approvals a WHERE a.step_run_id = s.id AND a.approver_id = ${who} AND (a.decision IS NULL OR s.state NOT IN ('unassigned','ready','in_progress'))))`,
    );
    conds.push(sql`s.state <> 'pending'`);
  }
  if (q.scope === 'team') {
    const team = [...ctx.teamUserIds(viewer.id)];
    if (team.length === 0) return { items: [], nextCursor: null };
    conds.push(sql`s.assignee_id IN (${uuidList(team)})`);
  }
  if (q.bucket === 'overdue') {
    conds.push(OPEN, sql`s.due_at < ${now}`);
    needsRunning = true;
  } else if (q.bucket === 'today') {
    conds.push(OPEN, sql`s.due_at >= ${now} AND s.due_at < ${b.tomorrow}`);
    needsRunning = true;
  } else if (q.bucket === 'upcoming') {
    conds.push(OPEN, sql`(s.due_at IS NULL OR s.due_at >= ${b.tomorrow})`);
    needsRunning = true;
  } else if (q.bucket === 'done') {
    conds.push(sql`s.state IN ('done','rejected')`);
  } else if (q.bucket === 'other') {
    conds.push(sql`s.state IN ('pending','skipped','cancelled')`);
  }
  if (q.state) conds.push(sql`s.state = ${q.state}`);
  if (q.late) {
    conds.push(OPEN, sql`s.due_at < ${now}`);
    needsRunning = true;
  }
  if (q.open) {
    conds.push(OPEN);
    needsRunning = true;
  }
  if (needsRunning) conds.push(sql`r.state = 'running'`);
  if (q.unitId) conds.push(sql`EXISTS (SELECT 1 FROM users u WHERE u.id = s.assignee_id AND u.unit_id = ${q.unitId})`);
  if (q.runId) conds.push(sql`s.run_id = ${q.runId}`);
  if (q.kind) conds.push(sql`s.kind = ${q.kind}`);
  if (q.q) conds.push(sql`(unaccent(s.title) ILIKE unaccent(${like(q.q)}) OR unaccent(r.title) ILIKE unaccent(${like(q.q)}))`);

  const order =
    q.sort === '-dueAt' ? sql`s.due_at DESC NULLS LAST, s.id` : q.sort === '-completedAt' ? sql`s.completed_at DESC NULLS LAST, s.id` : sql`s.due_at ASC NULLS LAST, s.id`;
  const offset = offsetOf(q.cursor);
  const res = await tx.execute<{ id: string }>(
    sql`SELECT s.id FROM step_runs s JOIN process_runs r ON r.id = s.run_id
        WHERE ${sql.join(conds, sql` AND `)} ORDER BY ${order} LIMIT ${q.limit + 1} OFFSET ${offset}`,
  );
  const ids = res.rows.map((r) => r.id);
  const items = await stepViewsByIds(tx, ctx, viewer, ids.slice(0, q.limit));
  return { items, nextCursor: ids.length > q.limit ? cursorOf(offset + q.limit) : null };
}

/** Tìm việc trong tầm nhìn; ngoài tầm nhìn thì 404. */
export async function findVisibleStep(tx: Tx, ctx: OrgContext, viewer: Viewer, stepId: string): Promise<{ step: StepRow; run: RunRow }> {
  const res = await tx.execute<{ id: string }>(
    sql`SELECT s.id FROM step_runs s JOIN process_runs r ON r.id = s.run_id
        WHERE s.id = ${stepId} AND s.kind IN ('task','approval') AND ${stepVisibility(ctx, viewer)}`,
  );
  if (res.rows.length === 0) throw new ApiError('not_found');
  const [row] = await tx
    .select({ step: schema.stepRuns, run: schema.processRuns })
    .from(schema.stepRuns)
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
    .where(eq(schema.stepRuns.id, stepId));
  if (!row) throw new ApiError('not_found');
  return row;
}

export function nudgeView(ctx: OrgContext, n: typeof schema.nudges.$inferSelect): NudgeView {
  return {
    id: n.id,
    message: n.message,
    senderName: ctx.settings.nudgeTemplates.senderName,
    aiDisclosure: n.aiDrafted ? ctx.settings.nudgeTemplates.aiDisclosure : null,
    sentAt: n.sentAt.toISOString(),
    reply: (n.reply as NudgeView['reply']) ?? null,
    repliedAt: n.repliedAt?.toISOString() ?? null,
  };
}

const REMINDER_KINDS = ['reminder_due_tomorrow', 'reminder_due_today', 'reminder', 'overdue', 'escalation'];

export async function getStepDetail(tx: Tx, ctx: OrgContext, viewer: Viewer, stepId: string): Promise<StepDetail> {
  const found = await findVisibleStep(tx, ctx, viewer, stepId);
  const hiddenAll = await hiddenParts(tx, viewer, [found.run.id]);
  const hiddenSteps = hiddenAll.steps;
  const [view] = await buildStepViews(tx, ctx, viewer, [found], hiddenAll);
  // Phần của người đóng góp khác không lọt vào lịch sử: câu ý kiến và dữ liệu đi kèm sự kiện gửi phần bị bỏ.
  const hideContent = hiddenSteps.has(stepId);
  const [events, nudgeRows, reminderRows] = await inOrder([
    tx.select().from(schema.runEvents).where(eq(schema.runEvents.runId, found.run.id)).orderBy(schema.runEvents.seq),
    tx.select().from(schema.nudges).where(eq(schema.nudges.stepRunId, stepId)).orderBy(schema.nudges.sentAt),
    tx
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.stepRunId, stepId), inArray(schema.notifications.kind, REMINDER_KINDS)))
      .orderBy(schema.notifications.createdAt),
  ]);

  const history: StepHistoryItem[] = [];
  for (const e of events) {
    if (e.type === 'TimerFired' || e.type === 'NudgeSent') continue;
    const payload = e.payload as RunEventRecord['payload'];
    const ev = payload.event as EngineEvent & { stepId?: string; reason?: string; note?: string; comment?: string };
    const base = { at: e.at.toISOString(), actor: ctx.person(e.actorId), actorType: e.actorType as StepHistoryItem['actorType'] };
    if (ev.stepId === stepId) {
      const { actor: _a, eventId: _e, at: _t, type: _ty, ...data } = ev as Record<string, unknown>;
      const others = hideContent && e.type === 'ApproveStep' && e.actorId !== viewer.id;
      if (others) for (const k of ['result', 'comment', 'fileIds']) delete data[k];
      history.push({ ...base, type: 'event', code: e.type, text: others ? null : (ev.reason ?? ev.note ?? ev.comment ?? null), data: { ...data, people: peopleIn(ctx, data, payload.changes) } });
    } else {
      for (const c of payload.changes) {
        if ('stepId' in c && c.stepId === stepId && (c.type === 'step.activated' || c.type === 'step.state')) {
          history.push({ ...base, type: 'event', code: c.type, text: null, data: { ...(c as unknown as Record<string, unknown>), people: peopleIn(ctx, {}, [c]) } });
        }
      }
    }
  }
  for (const n of reminderRows) {
    // Người xem chỉ thấy lời nhắc gửi cho chính mình, hoặc mọi lời nhắc nếu là người điều phối.
    if (n.userId !== viewer.id && !seesAllRuns(viewer)) continue;
    history.push({ at: n.createdAt.toISOString(), type: 'reminder', code: n.kind, actor: null, actorType: 'system', text: n.title, data: { toUserId: n.userId, state: n.state } });
  }
  const nudges = nudgeRows.map((n) => nudgeView(ctx, n));
  for (const n of nudgeRows) {
    history.push({ at: n.sentAt.toISOString(), type: 'nudge', code: 'nudge', actor: null, actorType: n.aiDrafted ? 'ai' : 'user', text: n.message, data: { nudgeId: n.id, aiDrafted: n.aiDrafted } });
    if (n.reply && n.repliedAt) {
      history.push({ at: n.repliedAt.toISOString(), type: 'nudge_reply', code: n.reply, actor: ctx.person(n.toUserId), actorType: 'user', text: null, data: { nudgeId: n.id } });
    }
  }
  history.sort((a, b) => a.at.localeCompare(b.at));
  const open = [...nudgeRows].reverse().find((n) => !n.reply && n.toUserId === viewer.id);
  return { ...view!, history, openNudge: open && view!.allowedActions.length > 0 ? nudgeView(ctx, open) : null, nudges };
}

type StepEventInput =
  | { type: 'AcceptStep' }
  | { type: 'CompleteStep'; note?: string; result?: Record<string, unknown>; fileIds?: string[]; nudgeId?: string }
  | { type: 'ApproveStep'; comment?: string; result?: Record<string, unknown>; fileIds?: string[] }
  | { type: 'RejectStep'; reason: string }
  | { type: 'RequestExtension'; proposedDueAt: string; reason: string; nudgeId?: string }
  | { type: 'ReportBlocked'; reasonCode: 'missing_info' | 'waiting_on_other' | 'need_decision' | 'other'; note?: string; nudgeId?: string }
  | { type: 'Reassign'; toUserId: string; reason: string }
  | { type: 'AssignStep'; toUserId: string; reason?: string }
  | { type: 'ExtendDue'; newDueAt: string; reason: string; extensionRequestId?: string }
  | { type: 'DeclineExtension'; requestId: string; comment?: string }
  | { type: 'SkipStep'; reason: string };

/**
 * Áp một sự kiện của người dùng lên một việc và trả trạng thái sau khi áp (SPEC 10.5).
 * Sai trạng thái (việc đã xong, đã đổi người, lượt chạy đã huỷ) thì 409 state_conflict.
 */
export async function actOnStep(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  stepId: string,
  eventId: string,
  input: StepEventInput,
  opts: { actor?: EngineEvent['actor']; stepUpToken?: string } = {},
): Promise<StepResult> {
  const found = await findVisibleStep(tx, ctx, viewer, stepId);
  let event: EngineEvent;
  const base = { eventId, at: clock.now().toISOString(), actor: opts.actor ?? userActor(viewer), stepId };

  // Biểu mẫu của việc (kết quả khi báo xong, phần của người duyệt hoặc đóng góp): cấp số cho ô cấp số trước khi vào engine.
  let form: { fields: readonly FormField[]; prepared: Awaited<ReturnType<typeof prepareForm>>; extraFileIds: string[] } | null = null;
  if (input.type === 'CompleteStep' || input.type === 'ApproveStep') {
    const def = await loadDefinition(tx, found.run.templateVersionId);
    const node = def.nodes.find((n) => n.id === found.step.nodeId);
    const fields = node && (node.type === 'task' || node.type === 'approval') ? (node.form ?? []) : [];
    if (input.type === 'CompleteStep' && node?.type === 'task' && node.compile?.required && !(await hasCompiledFile(tx, stepId))) {
      throw new ApiError('input_invalid', { errors: [{ path: 'body', code: 'compile_required' }] });
    }
    const prepared = await prepareForm(tx, ctx, fields, input.result ?? {}, eventId);
    if (fields.length > 0 && input.result !== undefined) input = { ...input, result: prepared.values };
    else if (prepared.allocations.length > 0) input = { ...input, result: prepared.values };
    // Người duyệt hoặc đóng góp: gom cả tệp ở các ô `file` vào danh sách tệp của họ, để biết tệp nào của ai.
    if (input.type === 'ApproveStep') {
      const fromFields = fileFieldIds(fields, input.result ?? {}).flatMap((f) => f.ids);
      if (fromFields.length > 0) input = { ...input, fileIds: [...new Set([...(input.fileIds ?? []), ...fromFields])] };
    }
    form = { fields, prepared, extraFileIds: input.fileIds ?? [] };
  }

  if (input.type === 'ApproveStep') {
    // Việc có số tiền thì bắt buộc mã nâng quyền (SPEC 10.5); thiếu thì 403 step_up_required.
    const [view] = await buildStepViews(tx, ctx, viewer, [found]);
    if (view!.requiresStepUp) await requireStepUp(viewer, opts.stepUpToken);
    event = { ...base, ...input };
  } else if (input.type === 'RequestExtension') {
    event = { ...base, ...input, requestId: deterministicId(`extension:${eventId}`) };
  } else if (input.type === 'Reassign' && found.step.state === 'unassigned') {
    // Việc "Cần giao người" thì giao bằng AssignStep (bảng 4.3).
    event = { ...base, type: 'AssignStep', toUserId: input.toUserId, reason: input.reason };
  } else {
    event = { ...base, ...input } as EngineEvent;
  }

  const applied = await applyRunEvent(tx, ctx, found.run.id, event);
  if (applied.applied && form) {
    const values = (event.type === 'CompleteStep' || event.type === 'ApproveStep' ? event.result : undefined) ?? {};
    await finalizeForm(tx, ctx, viewer, {
      runId: found.run.id,
      runTitle: found.run.title,
      stepRunId: found.step.id,
      fields: form.fields,
      values,
      source: { ...((found.run.inputs as Record<string, unknown>) ?? {}), ...values },
      allocations: form.prepared.allocations,
      extraFileIds: form.extraFileIds,
    });
  }
  const after = await tx
    .select({ step: schema.stepRuns, run: schema.processRuns })
    .from(schema.stepRuns)
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
    .where(eq(schema.stepRuns.id, stepId));
  const [step] = await buildStepViews(tx, ctx, viewer, after);
  const [run] = await buildRunSummaries(tx, ctx, [after[0]!.run]);
  return { step: step!, run: run! };
}

/** Giao lại hoặc gia hạn hàng loạt, tối đa 50. Mỗi mục là một sự kiện riêng, eventId là UUID v5 của (khoá, stepId). */
export async function batchSteps(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: { action: 'reassign'; stepIds: string[]; params: { toUserId: string; reason: string } } | { action: 'extend'; stepIds: string[]; params: { newDueAt: string; reason: string } },
  idempotencyKey: string,
): Promise<{ results: { stepId: string; ok: boolean; error?: { code: string } }[] }> {
  const results: { stepId: string; ok: boolean; error?: { code: string } }[] = [];
  for (const stepId of body.stepIds) {
    try {
      // Mỗi mục chạy trong savepoint riêng: một mục lỗi không kéo đổ các mục khác.
      await tx.transaction(async (sp) => {
        const input: StepEventInput = body.action === 'reassign' ? { type: 'Reassign', ...body.params } : { type: 'ExtendDue', ...body.params };
        await actOnStep(sp, ctx, viewer, stepId, batchEventId(idempotencyKey, stepId), input);
      });
      results.push({ stepId, ok: true });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // Việc trong quy trình giao cho người không được bổ nhiệm: nêu rõ mã con để màn hình giải thích được.
      const notAppointed = err.code === 'input_invalid' && err.extra.errors?.some((e) => e.code === 'not_appointed');
      results.push({ stepId, ok: false, error: { code: notAppointed ? 'not_appointed' : err.code } });
    }
  }
  return { results };
}

// ───────────────────────── Yêu cầu gia hạn ─────────────────────────

export async function listExtensionRequests(tx: Tx, ctx: OrgContext, viewer: Viewer, state: 'pending' | 'approved' | 'declined'): Promise<ExtensionRequestView[]> {
  const rows = await tx
    .select({ x: schema.extensionRequests, step: schema.stepRuns, run: schema.processRuns })
    .from(schema.extensionRequests)
    .innerJoin(schema.stepRuns, eq(schema.stepRuns.id, schema.extensionRequests.stepRunId))
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
    .where(eq(schema.extensionRequests.state, state))
    .orderBy(desc(schema.extensionRequests.createdAt))
    .limit(200);
  // Yêu cầu gia hạn của việc nằm trong lượt mật mà người xem không có đường vào thì không hiện, kể cả người có quyền quyết gia hạn.
  const seen = await visibleStepIds(tx, ctx, viewer, rows.map((r) => r.step.id));
  const mine = rows.filter((r) => seen.has(r.step.id) && (canDecideExtension(ctx, viewer, r.run, r.x.requestedBy) || r.x.requestedBy === viewer.id));
  const views = await buildStepViews(tx, ctx, viewer, mine);
  return mine.map((r, i) => ({
    id: r.x.id,
    step: views[i]!,
    requestedBy: ctx.person(r.x.requestedBy)!,
    proposedDueAt: r.x.proposedDueAt.toISOString(),
    reason: r.x.reason,
    state: r.x.state as ExtensionRequestView['state'],
    createdAt: r.x.createdAt.toISOString(),
  }));
}

/** Người giao, cấp trên trực tiếp của người xin, hoặc người điều phối (SPEC 10.5). */
function canDecideExtension(ctx: OrgContext, viewer: Viewer, run: RunRow, requestedBy: string): boolean {
  if (can(viewer, 'extension.decide')) return true;
  if (run.initiatorId === viewer.id) return true;
  return ctx.users.get(requestedBy)?.managerId === viewer.id;
}

export async function decideExtension(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  requestId: string,
  body: { decision: 'approved' | 'declined'; comment?: string },
  eventId: string,
): Promise<StepResult> {
  const [row] = await tx
    .select({ x: schema.extensionRequests, run: schema.processRuns })
    .from(schema.extensionRequests)
    .innerJoin(schema.stepRuns, eq(schema.stepRuns.id, schema.extensionRequests.stepRunId))
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
    .where(eq(schema.extensionRequests.id, requestId))
    .for('update', { of: schema.extensionRequests });
  if (!row) throw new ApiError('not_found');
  if (!canDecideExtension(ctx, viewer, row.run, row.x.requestedBy)) throw new ApiError('forbidden');
  if (row.x.state !== 'pending') {
    // Gửi lại cùng eventId: trả trạng thái hiện tại; quyết định lần hai thì báo xung đột.
    const [seen] = await tx.select({ id: schema.runEvents.id }).from(schema.runEvents).where(eq(schema.runEvents.id, eventId));
    if (!seen) throw new ApiError('state_conflict', { currentState: row.x.state });
  }
  const result = await actOnStep(
    tx,
    ctx,
    viewer,
    row.x.stepRunId,
    eventId,
    body.decision === 'approved'
      ? { type: 'ExtendDue', newDueAt: row.x.proposedDueAt.toISOString(), reason: body.comment ?? row.x.reason, extensionRequestId: requestId }
      : { type: 'DeclineExtension', requestId, comment: body.comment },
    // Cấp trên trực tiếp được quyết theo SPEC 10.5 dù bảng 4.3 của engine không liệt kê: quyền đã kiểm ở trên,
    // nên sự kiện đi vào engine dưới danh nghĩa hệ thống nhưng vẫn ghi id người quyết.
    { actor: can(viewer, 'extension.decide') || row.run.initiatorId === viewer.id ? { type: 'user', userId: viewer.id } : { type: 'system', userId: viewer.id } },
  );
  await tx
    .update(schema.extensionRequests)
    .set({ state: body.decision, decidedBy: viewer.id, decidedAt: clock.now() })
    .where(and(eq(schema.extensionRequests.id, requestId), eq(schema.extensionRequests.state, 'pending')));
  return { ...result, step: { ...result.step, pendingExtension: null } };
}
