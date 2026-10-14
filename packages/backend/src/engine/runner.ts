import {
  ApiError,
  EngineError,
  PG_NOTIFY_CHANNEL,
  ProcessDefinitionSchema,
  newId,
  type AdvanceOutput,
  type Effect,
  type EngineEvent,
  type NodeKind,
  type ProcessDefinition,
  type RunChange,
  type RunOutcome,
  type RunState,
  type RunStateName,
  type StepState,
  type StepStateName,
  type StreamEvent,
} from '@mihato/domain';
import { advance, assertAppointed, createRun } from '@mihato/workflow-engine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { inOrder, schema, type Tx } from '../db/client';

/**
 * Chạy `advance()` trong giao dịch (SPEC 4.4 [QUYẾT ĐỊNH]):
 * khoá hàng lượt chạy, tải step_runs và phiên bản mẫu, gọi advance(), rồi ghi step_runs đã đổi,
 * tăng version, thêm run_events, effects (dedupe_key UNIQUE) và timers. Worker chỉ thấy effect sau commit.
 * API không có đường tắt ghi thẳng vào bảng việc: mọi thay đổi trạng thái đi qua đây.
 */

const defCache = new Map<string, ProcessDefinition>();

/** Phiên bản đã xuất bản là bất biến nên giữ được trong bộ nhớ. */
export async function loadDefinition(tx: Tx, templateVersionId: string): Promise<ProcessDefinition> {
  const hit = defCache.get(templateVersionId);
  if (hit) return hit;
  const [row] = await tx
    .select({ definition: schema.processTemplateVersions.definition, status: schema.processTemplateVersions.status })
    .from(schema.processTemplateVersions)
    .where(eq(schema.processTemplateVersions.id, templateVersionId));
  if (!row) throw new ApiError('not_found');
  const def = ProcessDefinitionSchema.parse(row.definition);
  if (row.status === 'published') {
    if (defCache.size > 200) defCache.clear();
    defCache.set(templateVersionId, def);
  }
  return def;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const date = (s: string | null): Date | null => (s ? new Date(s) : null);

type RunRow = typeof schema.processRuns.$inferSelect;
type StepRow = typeof schema.stepRuns.$inferSelect;

export function stepRowToState(row: StepRow, approvals: (typeof schema.stepApprovals.$inferSelect)[]): StepState {
  return {
    id: row.id,
    nodeId: row.nodeId,
    attempt: row.attempt,
    kind: row.kind as NodeKind,
    title: row.title,
    description: row.description,
    state: row.state as StepStateName,
    assigneeId: row.assigneeId,
    onBehalfOfId: row.onBehalfOfId,
    assignedBy: row.assignedBy,
    dueAt: iso(row.dueAt),
    dueOriginalAt: iso(row.dueOriginalAt),
    activatedAt: iso(row.activatedAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    result: (row.result as Record<string, unknown> | null) ?? null,
    reason: row.reason,
    blockedReason: row.blockedReason,
    approvals: approvals
      .filter((a) => a.stepRunId === row.id)
      .sort((a, b) => a.approverId.localeCompare(b.approverId))
      .map((a) => ({
        approverId: a.approverId,
        onBehalfOfId: a.onBehalfOfId,
        decision: (a.decision as 'approved' | 'rejected' | null) ?? null,
        reason: a.reason,
        decidedAt: iso(a.decidedAt),
        result: (a.result as Record<string, unknown> | null) ?? null,
        fileIds: a.fileIds ?? [],
      })),
    lastReminderOn: row.lastReminderOn,
    lastNudgedAt: iso(row.lastNudgedAt),
  };
}

export type LoadedRun = { run: RunState; def: ProcessDefinition; row: RunRow };

/** Tải trạng thái lượt chạy; `lock` thì khoá hàng để chỉ một giao dịch xử lý lượt chạy tại một thời điểm. */
export async function loadRun(tx: Tx, runId: string, opts: { lock?: boolean } = {}): Promise<LoadedRun | null> {
  const q = tx.select().from(schema.processRuns).where(eq(schema.processRuns.id, runId));
  const [row] = opts.lock ? await q.for('update') : await q;
  if (!row) return null;
  const def = await loadDefinition(tx, row.templateVersionId);
  const [stepRows, approvalRows, eventRows] = await inOrder([
    tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.runId, runId)),
    tx
      .select({ a: schema.stepApprovals })
      .from(schema.stepApprovals)
      .innerJoin(schema.stepRuns, eq(schema.stepRuns.id, schema.stepApprovals.stepRunId))
      .where(eq(schema.stepRuns.runId, runId)),
    tx.select({ id: schema.runEvents.id, seq: schema.runEvents.seq }).from(schema.runEvents).where(eq(schema.runEvents.runId, runId)).orderBy(schema.runEvents.seq),
  ]);
  const approvals = approvalRows.map((r) => r.a);
  const order = new Map(def.nodes.map((n, i) => [n.id, i]));
  const steps = stepRows
    .map((s) => stepRowToState(s, approvals))
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0) || a.attempt - b.attempt);
  const run: RunState = {
    id: row.id,
    orgId: row.orgId,
    templateId: row.templateId,
    templateVersionId: row.templateVersionId,
    title: row.title,
    initiatorId: row.initiatorId,
    state: row.state as RunStateName,
    outcome: (row.outcome as RunOutcome | null) ?? null,
    inputs: (row.inputs as Record<string, unknown>) ?? {},
    targetAt: iso(row.targetAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    version: row.version,
    seq: eventRows.length ? eventRows[eventRows.length - 1]!.seq : 0,
    appliedEventIds: eventRows.map((e) => e.id),
    steps,
  };
  return { run, def, row };
}

function stepValues(orgId: string, runId: string, s: StepState) {
  return {
    id: s.id,
    orgId,
    runId,
    nodeId: s.nodeId,
    attempt: s.attempt,
    kind: s.kind,
    title: s.title,
    description: s.description,
    state: s.state,
    assigneeId: s.assigneeId,
    onBehalfOfId: s.onBehalfOfId,
    assignedBy: s.assignedBy,
    dueAt: date(s.dueAt),
    dueOriginalAt: date(s.dueOriginalAt),
    activatedAt: date(s.activatedAt),
    startedAt: date(s.startedAt),
    completedAt: date(s.completedAt),
    result: s.result,
    reason: s.reason,
    blockedReason: s.blockedReason,
    lastReminderOn: s.lastReminderOn,
    lastNudgedAt: date(s.lastNudgedAt),
  };
}

async function notify(tx: Tx, event: StreamEvent): Promise<void> {
  await tx.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
}

/** Chèn một effect vào hộp thư đi. Trùng dedupe_key thì bỏ qua: chạy lại không gửi trùng. */
export async function insertEffect(
  tx: Tx,
  orgId: string,
  e: { kind: string; dedupeKey: string; runId?: string | null; payload: unknown; nextAttemptAt?: Date },
): Promise<boolean> {
  const rows = await tx
    .insert(schema.effects)
    .values({ id: newId(), orgId, runId: e.runId ?? null, kind: e.kind, payload: e.payload, dedupeKey: e.dedupeKey, nextAttemptAt: e.nextAttemptAt ?? clock.now() })
    .onConflictDoNothing({ target: schema.effects.dedupeKey })
    .returning({ id: schema.effects.id });
  return rows.length > 0;
}

async function persistEffects(tx: Tx, orgId: string, effects: Effect[]): Promise<void> {
  for (const e of effects) {
    if (e.kind === 'schedule_timer') {
      await tx
        .insert(schema.timers)
        .values({ id: newId(), orgId, runId: e.runId, stepRunId: e.stepId, kind: e.timerKind, fireAt: new Date(e.fireAt), dedupeKey: e.dedupeKey, data: e.data })
        .onConflictDoNothing({ target: schema.timers.dedupeKey });
    } else if (e.kind === 'cancel_timers') {
      const cond = e.stepId
        ? and(eq(schema.timers.runId, e.runId), eq(schema.timers.stepRunId, e.stepId), eq(schema.timers.state, 'pending'))
        : and(eq(schema.timers.runId, e.runId), eq(schema.timers.state, 'pending'));
      await tx.update(schema.timers).set({ state: 'cancelled' }).where(cond);
    } else {
      await insertEffect(tx, orgId, { kind: e.kind, dedupeKey: e.dedupeKey, runId: e.runId, payload: e });
    }
  }
}

/** Ghi các bảng phụ theo thay đổi dẫn xuất của engine: yêu cầu gia hạn, lời đi thúc. */
async function persistChanges(tx: Tx, orgId: string, event: EngineEvent, changes: RunChange[]): Promise<void> {
  const at = new Date(event.at);
  for (const c of changes) {
    if (c.type === 'extension.requested') {
      await tx
        .insert(schema.extensionRequests)
        .values({ id: c.requestId, orgId, stepRunId: c.stepId, requestedBy: c.requestedBy, proposedDueAt: new Date(c.proposedDueAt), reason: c.reason, createdAt: at })
        .onConflictDoNothing();
    } else if (c.type === 'extension.decided') {
      await tx
        .update(schema.extensionRequests)
        .set({ state: c.decision, decidedBy: c.decidedBy, decidedAt: at })
        .where(and(eq(schema.extensionRequests.id, c.requestId), eq(schema.extensionRequests.state, 'pending')));
    } else if (c.type === 'nudge.sent') {
      await tx
        .insert(schema.nudges)
        .values({
          id: c.nudgeId,
          orgId,
          stepRunId: c.stepId,
          fromUserId: c.fromUserId,
          toUserId: c.toUserId,
          proposalId: event.actor.proposalId ?? null,
          message: c.message,
          aiDrafted: c.aiDrafted,
          sentAt: at,
        })
        .onConflictDoNothing();
    } else if (c.type === 'nudge.replied') {
      const [nudge] = await tx
        .update(schema.nudges)
        .set({ reply: c.reply, repliedAt: at })
        .where(and(eq(schema.nudges.id, c.nudgeId), eq(schema.nudges.stepRunId, c.stepId)))
        .returning({ fromUserId: schema.nudges.fromUserId });
      // Mỗi nút trả lời nhanh báo ngược cho người điều phối (SPEC 4.7 bước 5).
      if (nudge) {
        await insertEffect(tx, orgId, {
          kind: 'notify.nudge_reply',
          dedupeKey: `nudge-reply:${c.nudgeId}`,
          runId: null,
          payload: { kind: 'notify.nudge_reply', toUserId: nudge.fromUserId, stepId: c.stepId, data: { nudgeId: c.nudgeId, reply: c.reply } },
        });
      }
    }
  }
}

async function persist(tx: Tx, orgId: string, before: RunState | null, out: AdvanceOutput): Promise<void> {
  const run = out.run;
  const runValues = {
    state: run.state,
    outcome: run.outcome,
    targetAt: date(run.targetAt),
    startedAt: date(run.startedAt),
    completedAt: date(run.completedAt),
    version: run.version,
  };
  if (before === null) {
    await tx.insert(schema.processRuns).values({
      id: run.id,
      orgId,
      templateId: run.templateId,
      templateVersionId: run.templateVersionId,
      title: run.title,
      initiatorId: run.initiatorId,
      inputs: run.inputs,
      createdAt: clock.now(),
      ...runValues,
    });
  } else {
    await tx.update(schema.processRuns).set(runValues).where(eq(schema.processRuns.id, run.id));
  }

  const prev = new Map((before?.steps ?? []).map((s) => [s.id, JSON.stringify(s)]));
  const changed = run.steps.filter((s) => prev.get(s.id) !== JSON.stringify(s));
  for (const s of changed) {
    const v = stepValues(orgId, run.id, s);
    const { id: _id, orgId: _o, runId: _r, nodeId: _n, attempt: _a, kind: _k, ...mutable } = v;
    await tx.insert(schema.stepRuns).values(v).onConflictDoUpdate({ target: schema.stepRuns.id, set: mutable });
  }
  const withApprovals = changed.filter((s) => s.kind === 'approval');
  if (withApprovals.length) {
    await tx.delete(schema.stepApprovals).where(
      inArray(
        schema.stepApprovals.stepRunId,
        withApprovals.map((s) => s.id),
      ),
    );
    const rows = withApprovals.flatMap((s) =>
      s.approvals.map((a) => ({ stepRunId: s.id, orgId, approverId: a.approverId, onBehalfOfId: a.onBehalfOfId, decision: a.decision, reason: a.reason, decidedAt: date(a.decidedAt), result: a.result, fileIds: a.fileIds })),
    );
    if (rows.length) await tx.insert(schema.stepApprovals).values(rows);
  }

  for (const ev of out.events) {
    await tx.insert(schema.runEvents).values({
      id: ev.id,
      orgId,
      runId: run.id,
      seq: ev.seq,
      type: ev.type,
      actorType: ev.actorType,
      actorId: ev.actorId,
      proposalId: ev.proposalId,
      payload: ev.payload,
      at: new Date(ev.at),
    });
    await persistChanges(tx, orgId, ev.payload.event, ev.payload.changes);
  }
  await persistEffects(tx, orgId, out.effects);

  await notify(tx, { kind: 'run.updated', orgId, runId: run.id, version: run.version });
  for (const s of changed.filter((c) => c.kind === 'task' || c.kind === 'approval').slice(0, 20)) {
    await notify(tx, { kind: 'step.updated', orgId, runId: run.id, stepId: s.id, version: run.version });
  }
}

/** Đổi lỗi của engine sang mã lỗi API ổn định (SPEC 10.1). */
export function mapEngineError(err: unknown, run?: RunState): never {
  if (err instanceof EngineError) {
    if (err.code === 'invalid_transition') {
      const current = typeof err.detail.currentState === 'string' ? err.detail.currentState : run?.state;
      throw new ApiError('state_conflict', { currentState: current, detail: err.message });
    }
    if (err.code === 'not_allowed') throw new ApiError('forbidden', { detail: err.message });
    if (err.code === 'not_found') throw new ApiError('not_found');
    const raw = Array.isArray(err.detail.errors) ? (err.detail.errors as { path?: unknown; code?: unknown }[]) : [];
    const errors = raw.length ? raw.map((e) => ({ path: String(e.path ?? 'body'), code: String(e.code ?? 'invalid') })) : [{ path: String(err.detail.path ?? 'body'), code: String(err.detail.code ?? 'invalid') }];
    throw new ApiError('input_invalid', { detail: err.message, errors });
  }
  throw err;
}

/** Lượt chạy của một việc ngoài quy trình: mẫu là mẫu một việc ẩn do máy chủ dựng. */
export async function isAdhocTemplate(tx: Tx, templateId: string): Promise<boolean> {
  const [row] = await tx.select({ kind: schema.processTemplates.kind }).from(schema.processTemplates).where(eq(schema.processTemplates.id, templateId));
  return row?.kind === 'adhoc';
}

export type ApplyResult = { run: RunState; def: ProcessDefinition; output: AdvanceOutput; applied: boolean };

/**
 * Áp một sự kiện lên lượt chạy. `event.eventId` là khoá chống lặp: gửi lại bao nhiêu lần cũng chỉ có
 * hiệu lực một lần (SPEC 10.1); lần lặp trả trạng thái hiện tại với `applied = false`.
 */
export async function applyRunEvent(
  tx: Tx,
  ctx: OrgContext,
  runId: string,
  makeEvent: EngineEvent | ((run: RunState, def: ProcessDefinition) => EngineEvent),
): Promise<ApplyResult> {
  const loaded = await loadRun(tx, runId, { lock: true });
  if (!loaded) throw new ApiError('not_found');
  const { run, def } = loaded;
  const event = typeof makeEvent === 'function' ? makeEvent(run, def) : makeEvent;
  const guarded = (event.type === 'Reassign' || event.type === 'AssignStep') && event.actor.type !== 'system' ? event : null;
  const inProcess = guarded !== null && !(await isAdhocTemplate(tx, run.templateId));
  let output: AdvanceOutput;
  try {
    // Việc nằm trong quy trình chỉ giao được cho người được bổ nhiệm (docs/DECISIONS.md, 05/10/2026). Kiểm ở đây thay vì trong
    // advance() để phát lại (replay) các sự kiện giao lại cũ vẫn đúng từng bit; việc ngoài quy trình thì người giao chọn tự do.
    if (guarded && inProcess) {
      const step = run.steps.find((s) => s.id === guarded.stepId);
      if (step) assertAppointed(def, run, step, guarded.toUserId, ctx.resolve, new Date(event.at));
    }
    output = advance({ def, run, event, ctx: ctx.resolve, now: new Date(event.at) });
  } catch (err) {
    mapEngineError(err, run);
  }
  if (output.events.length === 0) return { run: output.run, def, output, applied: false };
  await persist(tx, ctx.orgId, run, output);
  return { run: output.run, def, output, applied: true };
}

/** Tạo lượt chạy từ một phiên bản mẫu đã xuất bản và áp ngay StartRun trong cùng giao dịch. */
export async function createAndStartRun(
  tx: Tx,
  ctx: OrgContext,
  input: {
    runId?: string;
    templateId: string;
    templateVersionId: string;
    title: string;
    inputs: Record<string, unknown>;
    initiatorId: string;
    eventId: string;
    actor: EngineEvent['actor'];
    at?: Date;
  },
): Promise<ApplyResult> {
  // eventId đã áp (gửi lại): trả lượt chạy đã tạo.
  const [existing] = await tx.select({ runId: schema.runEvents.runId }).from(schema.runEvents).where(eq(schema.runEvents.id, input.eventId));
  if (existing) {
    const loaded = await loadRun(tx, existing.runId);
    if (!loaded) throw new ApiError('not_found');
    return { run: loaded.run, def: loaded.def, output: { run: loaded.run, effects: [], events: [] }, applied: false };
  }
  const def = await loadDefinition(tx, input.templateVersionId);
  const at = input.at ?? clock.now();
  let output: AdvanceOutput;
  let draft: RunState | undefined;
  try {
    draft = createRun(def, {
      id: input.runId ?? newId(at.getTime()),
      orgId: ctx.orgId,
      templateId: input.templateId,
      templateVersionId: input.templateVersionId,
      title: input.title,
      initiatorId: input.initiatorId,
      inputs: input.inputs,
    });
    output = advance({
      def,
      run: draft,
      event: { type: 'StartRun', eventId: input.eventId, at: at.toISOString(), actor: input.actor },
      ctx: ctx.resolve,
      now: at,
    });
  } catch (err) {
    mapEngineError(err, draft);
  }
  await persist(tx, ctx.orgId, null, output);
  return { run: output.run, def, output, applied: true };
}
