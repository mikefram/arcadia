import {
  OPEN_STEP_STATES,
  can,
  type Bucket,
  type NodeKind,
  type ProcessDefinition,
  type Action,
  type RoleGrant,
  type RunDetail,
  type RunOutcome,
  type RunStateName,
  type RunSummary,
  type FileView,
  type StepAction,
  type StepParticipant,
  type StepStateName,
  type StepView,
} from '@mihato/domain';
import { atLocalTime, addWorkingDays, lateWorkingDays, toLocalDate } from '@mihato/domain/calendar';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { clock } from './clock';
import type { OrgContext } from './context';
import { inOrder, schema, type Tx } from './db/client';
import { loadDefinition } from './engine/runner';
import { fileHidden, hiddenParts, redactStepView, type HiddenParts } from './contribution-privacy';
import { COMPILED_FIELD, toFileView } from './file-view';

/** Người đang gọi API, sau khi đã xác thực. */
export type Viewer = {
  id: string;
  orgId: string;
  roles: RoleGrant[];
  /** quyền hiệu lực (docs/DECISIONS.md, 05/10/2026): mọi kiểm quyền dùng `can(viewer, ...)`, không dùng `viewer.roles` */
  permissions: readonly Action[];
  unitId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  via: 'cookie' | 'bearer';
  /** phiên web: người dùng đã bật TOTP chưa. Vắng mặt (thiết bị, test) thì coi như không áp dụng. */
  mfaEnrolled?: boolean;
};

type StepRow = typeof schema.stepRuns.$inferSelect;
type RunRow = typeof schema.processRuns.$inferSelect;
const isOpen = (s: string) => (OPEN_STEP_STATES as readonly string[]).includes(s);

/** Tầm nhìn (SPEC 4.1): người điều phối thấy mọi lượt chạy THƯỜNG của tổ chức [GIẢ ĐỊNH, DECISIONS.md]; lượt mật thì không (xem `runAccessSql`). */
export const seesAllRuns = (viewer: Viewer) => can(viewer, 'run.view_all');

/** Lượt chạy (bí danh `r`) được chia sẻ cho người xem, mức xem hoặc bình luận. */
const sharedWith = (viewer: Viewer): SQL => sql`EXISTS (SELECT 1 FROM run_shares sh WHERE sh.run_id = r.id AND sh.user_id = ${viewer.id})`;

/**
 * Việc (bí danh `s`, lượt `r`) mà người xem tự có: người nhận, người được thay mặt, người duyệt hoặc góp (kể cả được thay mặt) và, vì
 * người khởi chạy xem được mọi việc của lượt mình, việc trong lượt do mình khởi chạy.
 */
const ownStepRule = (viewer: Viewer): SQL =>
  sql`(s.assignee_id = ${viewer.id} OR s.on_behalf_of_id = ${viewer.id} OR r.initiator_id = ${viewer.id}
    OR EXISTS (SELECT 1 FROM step_approvals a WHERE a.step_run_id = s.id AND (a.approver_id = ${viewer.id} OR a.on_behalf_of_id = ${viewer.id})))`;

/** Việc của người dưới quyền (cấp trên trực tiếp và trưởng đơn vị thấy việc của người nhận). Chỉ áp cho lượt THƯỜNG. */
function teamStepRule(ctx: OrgContext, viewer: Viewer): SQL {
  const team = [...ctx.teamUserIds(viewer.id)];
  return team.length ? sql`s.assignee_id IN (${sql.join(team.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`;
}

/**
 * Người xem có đường vào RIÊNG của một lượt chạy (bí danh SQL `r`): chủ sở hữu (người khởi chạy), người tham gia (đang hoặc đã giữ,
 * được thay mặt, duyệt hoặc góp một việc của lượt) và người được chia sẻ (run_shares, mức xem hoặc bình luận).
 *
 * Đây là điều kiện DUY NHẤT để thấy lượt `restricted` (văn bản mật, docs/DECISIONS.md 07/10/2026 điểm b): `run.view_all` và việc là
 * cấp trên của người nhận không đủ. Với lượt thường nó chỉ cộng thêm người được chia sẻ.
 */
export function runAccessSql(viewer: Viewer): SQL {
  return sql`(r.initiator_id = ${viewer.id} OR ${sharedWith(viewer)} OR EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id = r.id AND ${ownStepRule(viewer)}))`;
}

/**
 * Tầm nhìn của một việc (bí danh SQL `s` = step_runs, `r` = process_runs của việc đó). Lớp thứ ba, độc lập với can() và RLS (SPEC 11.3).
 * - Lượt `restricted`: chỉ việc của chính mình (người nhận, được thay mặt, duyệt, góp), mọi việc của lượt mình khởi chạy, và mọi việc của
 *   lượt được chia sẻ cho mình. Không có ngoại lệ cho `run.view_all` hay cấp trên của người nhận.
 * - Lượt thường: người có `run.view_all` thấy hết; người khác thấy việc của mình, việc của người dưới quyền và mọi việc của lượt mình
 *   khởi chạy hoặc được chia sẻ.
 */
export function stepVisibility(ctx: OrgContext, viewer: Viewer): SQL {
  if (seesAllRuns(viewer)) return sql`(r.confidentiality = 'normal' OR ${sharedWith(viewer)} OR ${ownStepRule(viewer)})`;
  return sql`(${sharedWith(viewer)} OR ${ownStepRule(viewer)} OR (r.confidentiality = 'normal' AND ${teamStepRule(ctx, viewer)}))`;
}

/** Tầm nhìn của một lượt chạy (bí danh SQL `r` = process_runs). Cùng quy tắc với `stepVisibility`. */
export function runVisibility(ctx: OrgContext, viewer: Viewer): SQL {
  if (seesAllRuns(viewer)) return sql`(r.confidentiality = 'normal' OR ${runAccessSql(viewer)})`;
  return sql`(${runAccessSql(viewer)} OR (r.confidentiality = 'normal' AND EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id = r.id AND ${teamStepRule(ctx, viewer)})))`;
}

/**
 * Chỉ lọc lượt MẬT (bí danh `r`): lượt thường luôn qua, lượt hạn chế chỉ qua với người có đường vào riêng. Dùng cho dữ liệu vốn
 * mở theo quyền khác chứ không theo tầm nhìn lượt chạy, như Sổ văn bản (`document.view`).
 */
export function restrictedRunAccess(viewer: Viewer): SQL {
  return sql`(r.confidentiality = 'normal' OR ${runAccessSql(viewer)})`;
}

/** Điều kiện cho truy vấn trên view `v_step_status` (bí danh `v`): việc nằm trong tầm nhìn của người xem. */
export function viewVisibility(ctx: OrgContext, viewer: Viewer): SQL {
  return sql`EXISTS (SELECT 1 FROM step_runs s JOIN process_runs r ON r.id = s.run_id WHERE s.id = v.id AND ${stepVisibility(ctx, viewer)})`;
}

/** Điều kiện cho truy vấn trên `step_runs` (bí danh `s`) khi chưa nối `process_runs`. */
export function stepRunVisibility(ctx: OrgContext, viewer: Viewer): SQL {
  return sql`EXISTS (SELECT 1 FROM process_runs r WHERE r.id = s.run_id AND ${stepVisibility(ctx, viewer)})`;
}

/** Trong các id việc này, những id người xem được thấy. */
export async function visibleStepIds(tx: Tx, ctx: OrgContext, viewer: Viewer, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const res = await tx.execute<{ id: string }>(sql`SELECT s.id FROM step_runs s JOIN process_runs r ON r.id = s.run_id WHERE s.id IN (${list}) AND ${stepVisibility(ctx, viewer)}`);
  return new Set(res.rows.map((r) => r.id));
}

/** Người xem có được thấy lượt chạy này không (dùng khi không có sẵn dòng lượt chạy: SSE, tool). */
export async function viewerSeesRun(tx: Tx, ctx: OrgContext, viewer: Viewer, runId: string): Promise<boolean> {
  const res = await tx.execute<{ id: string }>(sql`SELECT r.id FROM process_runs r WHERE r.id = ${runId} AND ${runVisibility(ctx, viewer)}`);
  return res.rows.length > 0;
}

export function bucketOf(state: string, dueAt: Date | null, now: Date, ctx: OrgContext): Bucket {
  if (state === 'done' || state === 'rejected') return 'done';
  if (!isOpen(state)) return 'other';
  if (!dueAt) return 'upcoming';
  if (now > dueAt) return 'overdue';
  return toLocalDate(dueAt, ctx.calendar) === toLocalDate(now, ctx.calendar) ? 'today' : 'upcoming';
}

/** Mốc đầu ngày hôm nay và ngày mai theo giờ Việt Nam, để lọc bucket trong SQL. */
export function dayBounds(now: Date, ctx: OrgContext): { today: Date; tomorrow: Date; nextWorkdayStart: Date; nextWorkdayEnd: Date } {
  const day = toLocalDate(now, ctx.calendar);
  const today = atLocalTime(day, '00:00', ctx.calendar);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const next = addWorkingDays(day, 1, ctx.calendar);
  const nextWorkdayStart = atLocalTime(next, '00:00', ctx.calendar);
  return { today, tomorrow, nextWorkdayStart, nextWorkdayEnd: new Date(nextWorkdayStart.getTime() + 86_400_000) };
}

function moneyFrom(form: { key: string; type: string }[] | undefined, data: Record<string, unknown> | null | undefined): number | null {
  if (!form || !data) return null;
  for (const f of form) {
    if (f.type !== 'money') continue;
    const v = data[f.key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  }
  return null;
}

/**
 * Số tiền cần duyệt [GIẢ ĐỊNH, Q16]: trường kiểu money trong biểu mẫu kết quả của nút task đứng ngay trước
 * nút approval; không có thì lấy trường money của biểu mẫu khởi chạy.
 */
export function amountForApproval(
  def: ProcessDefinition,
  nodeId: string,
  runInputs: Record<string, unknown>,
  latestResultByNode: Map<string, Record<string, unknown> | null>,
): number | null {
  for (const edge of def.edges) {
    if (edge.to !== nodeId) continue;
    const prev = def.nodes.find((n) => n.id === edge.from);
    if (prev?.type !== 'task') continue;
    const amount = moneyFrom(prev.form, latestResultByNode.get(prev.id));
    if (amount !== null) return amount;
  }
  return moneyFrom(def.inputs, runInputs);
}

type ApproverRow = {
  approverId: string;
  onBehalfOfId: string | null;
  decision: string | null;
  reason: string | null;
  decidedAt: Date | null;
  result: unknown;
  fileIds: string[];
};

type StepExtras = {
  approversByStep: Map<string, ApproverRow[]>;
  /** tệp đã gắn vào từng việc (khi báo xong, khi gửi phần của mình, tệp tổng hợp) */
  filesByStep: Map<string, FileView[]>;
  pendingExtByStep: Map<string, { id: string; proposedDueAt: Date; reason: string }>;
  resultsByRun: Map<string, Map<string, Record<string, unknown> | null>>;
  /** người làm việc đứng trước (theo nút) của từng lượt chạy: nguồn của "người đề nghị" ở việc duyệt */
  doersByRun: Map<string, Map<string, string | null>>;
  defs: Map<string, ProcessDefinition>;
  /** mẫu của các lượt chạy là mẫu một việc ẩn (việc ngoài quy trình) */
  adhocTemplates: Set<string>;
  /** số bình luận chưa xoá của từng việc */
  commentCounts: Map<string, number>;
};

/** Trong các mẫu này, những mẫu là mẫu một việc ẩn của việc ngoài quy trình (docs/DECISIONS.md, 05/10/2026). */
async function adhocTemplateIds(tx: Tx, templateIds: string[]): Promise<Set<string>> {
  if (templateIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: schema.processTemplates.id })
    .from(schema.processTemplates)
    .where(and(inArray(schema.processTemplates.id, templateIds), eq(schema.processTemplates.kind, 'adhoc')));
  return new Set(rows.map((r) => r.id));
}

async function loadExtras(tx: Tx, ctx: OrgContext, rows: { step: StepRow; run: RunRow }[]): Promise<StepExtras> {
  const stepIds = rows.map((r) => r.step.id);
  const approvalRunIds = [...new Set(rows.filter((r) => r.step.kind === 'approval').map((r) => r.run.id))];
  const versionIds = [...new Set(rows.map((r) => r.run.templateVersionId))];
  const empty = stepIds.length === 0;
  const approvals = empty ? [] : await tx.select().from(schema.stepApprovals).where(inArray(schema.stepApprovals.stepRunId, stepIds));
  const fileRows = empty
    ? []
    : await tx
        .select()
        .from(schema.files)
        .where(and(inArray(schema.files.stepRunId, stepIds), eq(schema.files.kind, 'attachment'), eq(schema.files.status, 'attached')))
        .orderBy(schema.files.createdAt, schema.files.id);
  const extensions = empty
    ? []
    : await tx
        .select()
        .from(schema.extensionRequests)
        .where(and(inArray(schema.extensionRequests.stepRunId, stepIds), eq(schema.extensionRequests.state, 'pending')));
  const results =
    approvalRunIds.length === 0
      ? []
      : await tx
          .select({ runId: schema.stepRuns.runId, nodeId: schema.stepRuns.nodeId, attempt: schema.stepRuns.attempt, result: schema.stepRuns.result, assigneeId: schema.stepRuns.assigneeId })
          .from(schema.stepRuns)
          .where(and(inArray(schema.stepRuns.runId, approvalRunIds), eq(schema.stepRuns.kind, 'task')));
  const defs: (readonly [string, ProcessDefinition])[] = [];
  for (const id of versionIds) defs.push([id, await loadDefinition(tx, id)] as const);
  const approversByStep = new Map<string, ApproverRow[]>();
  for (const a of [...approvals].sort((x, y) => x.approverId.localeCompare(y.approverId))) {
    const list = approversByStep.get(a.stepRunId) ?? [];
    list.push({ approverId: a.approverId, onBehalfOfId: a.onBehalfOfId, decision: a.decision, reason: a.reason, decidedAt: a.decidedAt, result: a.result, fileIds: a.fileIds ?? [] });
    approversByStep.set(a.stepRunId, list);
  }
  const titles = new Map(rows.map((r) => [r.step.id, r.step.title]));
  const filesByStep = new Map<string, FileView[]>();
  for (const f of fileRows) {
    if (!f.stepRunId) continue;
    const list = filesByStep.get(f.stepRunId) ?? [];
    list.push(toFileView(ctx, f, titles));
    filesByStep.set(f.stepRunId, list);
  }
  const pendingExtByStep = new Map(extensions.map((e) => [e.stepRunId, { id: e.id, proposedDueAt: e.proposedDueAt, reason: e.reason }]));
  const resultsByRun = new Map<string, Map<string, Record<string, unknown> | null>>();
  const doersByRun = new Map<string, Map<string, string | null>>();
  for (const r of [...results].sort((a, b) => a.attempt - b.attempt)) {
    const m = resultsByRun.get(r.runId) ?? new Map<string, Record<string, unknown> | null>();
    m.set(r.nodeId, (r.result as Record<string, unknown> | null) ?? null);
    resultsByRun.set(r.runId, m);
    const d = doersByRun.get(r.runId) ?? new Map<string, string | null>();
    d.set(r.nodeId, r.assigneeId);
    doersByRun.set(r.runId, d);
  }
  const adhocTemplates = await adhocTemplateIds(tx, [...new Set(rows.map((r) => r.run.templateId))]);
  const commentRows = empty
    ? []
    : await tx
        .select({ stepId: schema.stepComments.stepRunId, n: sql<number>`count(*)::int` })
        .from(schema.stepComments)
        .where(and(inArray(schema.stepComments.stepRunId, stepIds), sql`${schema.stepComments.deletedAt} IS NULL`))
        .groupBy(schema.stepComments.stepRunId);
  const commentCounts = new Map(commentRows.map((c) => [c.stepId, Number(c.n)]));
  return { approversByStep, filesByStep, pendingExtByStep, resultsByRun, doersByRun, defs: new Map(defs), adhocTemplates, commentCounts };
}

/** Hành động người gọi được làm trên việc này. App chỉ vẽ nút có trong danh sách; máy chủ vẫn kiểm lại (SPEC 10.5). */
export function allowedActions(
  ctx: OrgContext,
  viewer: Viewer,
  step: StepRow,
  run: RunRow,
  approvers: { approverId: string; decision: string | null }[],
  hasPendingExtension: boolean,
  /** nút đóng góp: mỗi người chỉ có "gửi" (approve), không có "Chưa đồng ý" */
  contribute = false,
): StepAction[] {
  if (run.state !== 'running') return [];
  const out: StepAction[] = [];
  const state = step.state;
  const isAssignee = step.assigneeId === viewer.id;
  const working = state === 'ready' || state === 'in_progress';
  if (step.kind === 'task' && isAssignee) {
    if (state === 'ready') out.push('accept');
    if (working) out.push('complete');
  }
  if (step.kind === 'approval' && working && approvers.some((a) => a.approverId === viewer.id && a.decision === null)) {
    out.push(...(contribute ? (['approve'] as const) : (['approve', 'reject'] as const)));
  }
  if (isAssignee && working) {
    if (!hasPendingExtension) out.push('requestExtension');
    out.push('block');
  }
  const assignee = step.assigneeId ? ctx.users.get(step.assigneeId) : undefined;
  // Khớp luật của engine (bảng 4.3): trưởng trực tiếp của đơn vị người nhận, và không phải việc của chính mình.
  const headsAssigneeUnit = !!assignee?.unitId && assignee.id !== viewer.id && ctx.units.get(assignee.unitId)?.headUserId === viewer.id;
  const isInitiator = run.initiatorId === viewer.id;
  if (isOpen(state) && (can(viewer, 'step.reassign') || isInitiator || headsAssigneeUnit)) out.push('reassign');
  if (isOpen(state) && (can(viewer, 'step.extend') || isInitiator)) out.push('extend');
  // Engine chỉ cho bỏ qua việc chưa nhận (pending, unassigned, ready); việc đã nhận rồi thì không (audit runs-3).
  if ((state === 'pending' || state === 'unassigned' || state === 'ready') && can(viewer, 'step.skip')) out.push('skip');
  if (working && step.assigneeId && step.assigneeId !== viewer.id && can(viewer, 'nudge.send')) out.push('nudge');
  return out;
}

export async function buildStepViews(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  rows: { step: StepRow; run: RunRow }[],
  /** phần góp nội dung mà người xem chỉ được thấy phần của mình, đã tính cho đúng các lượt của `rows`; bỏ trống thì tự tính */
  hiddenIn?: HiddenParts,
): Promise<StepView[]> {
  const extras = await loadExtras(tx, ctx, rows);
  const parts = hiddenIn ?? (await hiddenParts(tx, viewer, rows.map((r) => r.run.id)));
  const hidden = parts.steps;
  const now = clock.now();
  const views = rows.map(({ step, run }) => {
    const def = extras.defs.get(run.templateVersionId);
    const node = def?.nodes.find((n) => n.id === step.nodeId);
    const approvers = extras.approversByStep.get(step.id) ?? [];
    const ext = extras.pendingExtByStep.get(step.id) ?? null;
    const open = isOpen(step.state) && run.state === 'running';
    const overdue = open && !!step.dueAt && now > step.dueAt;
    const amount =
      step.kind === 'approval' && def
        ? amountForApproval(def, step.nodeId, (run.inputs as Record<string, unknown>) ?? {}, extras.resultsByRun.get(run.id) ?? new Map())
        : null;
    const assignee = step.assigneeId ? ctx.users.get(step.assigneeId) : undefined;
    // Người đề nghị của việc duyệt: người làm việc đứng ngay trước nó (ví dụ người lập đề nghị tạm ứng).
    let requestedBy: string | null = null;
    if (step.kind === 'approval' && def) {
      const doers = extras.doersByRun.get(run.id);
      for (const edge of def.edges) {
        if (edge.to !== step.nodeId) continue;
        const doer = doers?.get(edge.from);
        if (doer) {
          requestedBy = doer;
          break;
        }
      }
    }
    return {
      id: step.id,
      runId: run.id,
      runTitle: run.title,
      adhoc: extras.adhocTemplates.has(run.templateId),
      nodeId: step.nodeId,
      kind: step.kind as 'task' | 'approval',
      title: step.title,
      description: step.description,
      state: step.state as StepStateName,
      bucket: run.state === 'running' ? bucketOf(step.state, step.dueAt, now, ctx) : step.state === 'done' ? 'done' : 'other',
      isOverdue: overdue,
      lateWorkingDays: overdue && step.dueAt ? lateWorkingDays(step.dueAt, now, ctx.calendar) : 0,
      dueAt: step.dueAt?.toISOString() ?? null,
      dueOriginalAt: step.dueOriginalAt?.toISOString() ?? null,
      assignee: ctx.person(step.assigneeId),
      assignedBy: ctx.person(step.assignedBy),
      onBehalfOf: ctx.person(step.onBehalfOfId),
      blockedReason: step.blockedReason,
      pendingExtension: ext ? { id: ext.id, proposedDueAt: ext.proposedDueAt.toISOString(), reason: ext.reason } : null,
      amountVnd: amount,
      requiresStepUp: amount !== null && amount > 0,
      allowedActions: allowedActions(ctx, viewer, step, run, approvers, ext !== null, node?.type === 'approval' && node.action === 'contribute'),
      version: run.version,
      checklist: node?.type === 'task' ? (node.checklist ?? []) : [],
      form: node?.type === 'task' || node?.type === 'approval' ? (node.form ?? []) : [],
      result: (step.result as Record<string, unknown> | null) ?? null,
      reason: step.reason,
      activatedAt: step.activatedAt?.toISOString() ?? null,
      completedAt: step.completedAt?.toISOString() ?? null,
      unitName: assignee?.unitId ? (ctx.units.get(assignee.unitId)?.name ?? null) : null,
      lastNudgedAt: step.lastNudgedAt?.toISOString() ?? null,
      requestedBy: ctx.person(requestedBy),
      action: node?.type === 'approval' ? (node.action ?? 'approve') : null,
      participants: participantsOf(ctx, node?.type === 'approval', approvers),
      files: (extras.filesByStep.get(step.id) ?? []).filter((f) => !(f.compiled && parts.runs.has(run.id))),
      compile:
        node?.type === 'task' && node.compile
          ? {
              layout: node.compile.layout,
              title: node.compile.title,
              required: node.compile.required === true,
              hasFile: (extras.filesByStep.get(step.id) ?? []).some((f) => f.fieldKey === COMPILED_FIELD),
            }
          : null,
      commentCount: extras.commentCounts.get(step.id) ?? 0,
    };
  });
  return views.map((v) => (hidden.has(v.id) ? redactStepView(v, viewer.id) : v));
}

/** Từng người của nút duyệt hoặc đóng góp: đã quyết chưa và phần họ gửi. Việc thường thì rỗng. */
function participantsOf(ctx: OrgContext, isApproval: boolean, rows: ApproverRow[]): StepParticipant[] {
  if (!isApproval) return [];
  return rows.flatMap((a) => {
    const person = ctx.person(a.approverId);
    if (!person) return [];
    return [
      {
        person,
        onBehalfOf: ctx.person(a.onBehalfOfId),
        decision: (a.decision as StepParticipant['decision']) ?? null,
        comment: a.reason,
        decidedAt: a.decidedAt?.toISOString() ?? null,
        result: (a.result as Record<string, unknown> | null) ?? null,
        fileIds: a.fileIds,
      },
    ];
  });
}

/** Tải các việc (task, approval) theo id rồi dựng view; giữ thứ tự theo `ids`. */
export async function stepViewsByIds(tx: Tx, ctx: OrgContext, viewer: Viewer, ids: string[]): Promise<StepView[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ step: schema.stepRuns, run: schema.processRuns })
    .from(schema.stepRuns)
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
    .where(inArray(schema.stepRuns.id, ids));
  const views = await buildStepViews(tx, ctx, viewer, rows);
  const order = new Map(ids.map((id, i) => [id, i]));
  return views.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

type ProgressRow = { run_id: string; total: string | number; done: string | number; overdue: string | number; earliest_overdue_due_at: string | Date | null };

export async function buildRunSummaries(tx: Tx, ctx: OrgContext, runs: RunRow[]): Promise<RunSummary[]> {
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.id);
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const [progress, versions] = await inOrder([
    tx.execute<ProgressRow>(sql`SELECT run_id, total, done, overdue, earliest_overdue_due_at FROM v_run_progress WHERE run_id IN (${idList})`),
    tx
      .select({ id: schema.processTemplateVersions.id, version: schema.processTemplateVersions.version, name: schema.processTemplates.name, kind: schema.processTemplates.kind })
      .from(schema.processTemplateVersions)
      .innerJoin(schema.processTemplates, eq(schema.processTemplates.id, schema.processTemplateVersions.templateId))
      .where(inArray(schema.processTemplateVersions.id, [...new Set(runs.map((r) => r.templateVersionId))])),
  ]);
  const progressByRun = new Map(progress.rows.map((p) => [p.run_id, p]));
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const now = clock.now();
  return runs.map((r) => {
    const p = progressByRun.get(r.id);
    const overdue = Number(p?.overdue ?? 0);
    const finished = r.state !== 'running' && r.state !== 'draft';
    const earliest = p?.earliest_overdue_due_at ? new Date(p.earliest_overdue_due_at) : null;
    const v = versionById.get(r.templateVersionId);
    const initiator = ctx.person(r.initiatorId);
    return {
      id: r.id,
      title: r.title,
      templateId: r.templateId,
      templateName: v?.name ?? '',
      templateVersion: v?.version ?? 0,
      adhoc: v?.kind === 'adhoc',
      state: r.state as RunStateName,
      outcome: (r.outcome as RunOutcome | null) ?? null,
      targetAt: r.targetAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      progress: { done: Number(p?.done ?? 0), total: Number(p?.total ?? 0) },
      schedule: finished
        ? { status: 'done', lateWorkingDays: 0 }
        : overdue > 0 && earliest
          ? { status: 'late', lateWorkingDays: lateWorkingDays(earliest, now, ctx.calendar) }
          : { status: 'on_track', lateWorkingDays: 0 },
      initiator: initiator ?? { id: r.initiatorId, fullName: '', givenName: '', honorific: null },
      version: r.version,
      confidentiality: r.confidentiality as RunSummary['confidentiality'],
    };
  });
}

export async function buildRunDetail(tx: Tx, ctx: OrgContext, viewer: Viewer, run: RunRow): Promise<RunDetail> {
  const [summary] = await buildRunSummaries(tx, ctx, [run]);
  const def = await loadDefinition(tx, run.templateVersionId);
  const stepRows = await tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.runId, run.id));
  // Mỗi nút chỉ hiện lần thử mới nhất.
  const latest = new Map<string, StepRow>();
  for (const s of stepRows) {
    const cur = latest.get(s.nodeId);
    if (!cur || s.attempt > cur.attempt) latest.set(s.nodeId, s);
  }
  const order = new Map(def.nodes.map((n, i) => [n.id, i]));
  const human = [...latest.values()]
    .filter((s) => s.kind === 'task' || s.kind === 'approval')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0));
  const hidden = await hiddenParts(tx, viewer, [run.id]);
  const steps = await buildStepViews(
    tx,
    ctx,
    viewer,
    human.map((step) => ({ step, run })),
    hidden,
  );
  const nodeStates: RunDetail['nodeStates'] = {};
  for (const s of latest.values()) nodeStates[s.nodeId] = { kind: s.kind as NodeKind, state: s.state as StepStateName };
  return {
    ...summary!,
    steps,
    edges: def.edges.map((e) => ({ from: e.from, to: e.to })),
    inputs: (run.inputs as Record<string, unknown>) ?? {},
    inputForm: def.inputs,
    files: await runFiles(tx, ctx, run.id, viewer.id, hidden),
    nodeStates,
  };
}

/** Mọi tệp đã gắn vào lượt chạy mà người xem được thấy, mới nhất trước. */
async function runFiles(tx: Tx, ctx: OrgContext, runId: string, viewerId: string, hidden: HiddenParts): Promise<FileView[]> {
  const rows = (
    await tx
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.runId, runId), eq(schema.files.kind, 'attachment'), eq(schema.files.status, 'attached'), isNull(schema.files.commentId)))
      .orderBy(sql`${schema.files.createdAt} DESC`, sql`${schema.files.id} DESC`)
  ).filter((r) => !fileHidden(r, hidden, viewerId));
  const stepIds = [...new Set(rows.flatMap((r) => (r.stepRunId ? [r.stepRunId] : [])))];
  const titles = new Map<string, string>();
  if (stepIds.length > 0) {
    for (const s of await tx.select({ id: schema.stepRuns.id, title: schema.stepRuns.title }).from(schema.stepRuns).where(inArray(schema.stepRuns.id, stepIds))) titles.set(s.id, s.title);
  }
  return rows.map((r) => toFileView(ctx, r, titles));
}
