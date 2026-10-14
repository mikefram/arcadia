import {
  EngineError,
  type Action,
  type AdvanceInput,
  type AdvanceOutput,
  type ApprovalNode,
  type ApprovalRecord,
  type AssigneeRule,
  type Effect,
  type EngineErrorCode,
  type EngineEvent,
  type EngineEventOf,
  type NotifyKind,
  type ProcessDefinition,
  type ProcessNode,
  type ResolveContext,
  type RunChange,
  type RunEventRecord,
  type RunState,
  type StepState,
  type StepStateName,
  type TaskNode,
  type TimerData,
  type WorkCalendar,
} from '@mihato/domain';
import { addDuration, computeDue, lateWorkingDays, toLocalDate, workingDaysBetween } from '@mihato/domain/calendar';
import { newStep } from './create-run';
import {
  assignerRecipients,
  buildDirectory,
  byId,
  findDelegation,
  hasPermission,
  isDelegate,
  isUnitHeadOf,
  managerRecipients,
  officeAdmins,
  resolveRule,
  resolveRuleMany,
  usableUser,
  type Directory,
  type RuleEnv,
} from './directory';
import { evalExpr } from './expr';
import { assertFormValues } from './forms';
import { buildGraph, edgeStatus, isManualSkip, nodesBetween, type Graph } from './graph';
import { planReminderTimers, reminderStepsFor } from './reminders';

/**
 * `advance()`: trái tim của engine (SPEC 4.4). Hàm thuần: mọi đầu vào (đồng hồ `now`, danh bạ, lịch)
 * được truyền vào; đầu ra là trạng thái mới, danh sách effect và đúng một dòng sự kiện để ghi.
 * Không có I/O, không đọc đồng hồ, không số ngẫu nhiên. Đầu vào không bao giờ bị sửa tại chỗ.
 *
 * Sáu bước:
 *  1. `eventId` đã áp rồi: trả lượt chạy cũ, không effect, không sự kiện (chống lặp).
 *  2. Kiểm chuyển trạng thái rồi kiểm quyền theo bảng 4.3. Sai thì ném `EngineError`, không đổi gì.
 *  3. Áp sự kiện lên việc hoặc lượt chạy.
 *  4. Lan truyền: kích hoạt hoặc bỏ qua các nút chờ cho tới khi không còn thay đổi.
 *  5. Mọi nút kết thúc đã tới, hoặc không còn việc nào mở: lượt chạy hoàn tất.
 *  6. Trả { run, effects, events }.
 */

export type AdvanceOptions = {
  /** `replay()` tắt kiểm quyền: sự kiện đã được cấp phép lúc xảy ra, và danh bạ có thể đã đổi từ đó. */
  checkPermissions: boolean;
};

const MS_HOUR = 3_600_000;
/** Một việc vừa được đi thúc thì nhắc tự động bị bỏ qua trong 4 giờ (SPEC 4.6). */
const NUDGE_QUIET_MS = 4 * MS_HOUR;

type WorkNode = TaskNode | ApprovalNode;
type ReminderTarget = NonNullable<TimerData['to']>;

type Work = {
  def: ProcessDefinition;
  graph: Graph;
  dir: Directory;
  ctx: ResolveContext;
  cal: WorkCalendar;
  now: Date;
  nowIso: string;
  event: EngineEvent;
  /** người thao tác; null khi là hệ thống */
  actorId: string | null;
  opts: AdvanceOptions;
  /** bản sao đang sửa */
  run: RunState;
  /** nodeId → lần thử mới nhất */
  latest: Map<string, StepState>;
  stepsById: Map<string, StepState>;
  /** seq của sự kiện đang áp */
  seq: number;
  effects: Effect[];
  effectKeys: Set<string>;
  changes: RunChange[];
};

// ───────────────────────── Tiện ích ─────────────────────────

function fail(code: EngineErrorCode, message: string, detail: Record<string, unknown> = {}): never {
  throw new EngineError(code, message, detail);
}

const isOpen = (s: StepStateName): boolean => s === 'unassigned' || s === 'ready' || s === 'in_progress';
const isTerminal = (s: StepStateName): boolean => s === 'done' || s === 'rejected' || s === 'skipped' || s === 'cancelled';

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function cloneStep(s: StepState): StepState {
  return { ...s, result: s.result ? { ...s.result } : null, approvals: s.approvals.map((a) => ({ ...a })) };
}

function cloneRun(run: RunState): RunState {
  return { ...run, appliedEventIds: [...run.appliedEventIds], steps: run.steps.map(cloneStep) };
}

function setState(w: Work, step: StepState, to: StepStateName): void {
  const from = step.state;
  if (from === to) return;
  step.state = to;
  w.changes.push({ type: 'step.state', stepId: step.id, nodeId: step.nodeId, from, to });
}

/** Dữ liệu có cấu trúc đi kèm mọi thông báo về một việc. Câu chữ do worker dựng từ mẫu, không dựng ở đây. */
function stepData(w: Work, step: StepState): Record<string, unknown> {
  return {
    nodeId: step.nodeId,
    stepKind: step.kind,
    stepTitle: step.title,
    runTitle: w.run.title,
    dueAt: step.dueAt,
    assigneeId: step.assigneeId,
    /** lần thử: lớn hơn 1 nghĩa là việc phải làm lại sau khi bị "Chưa đồng ý" */
    attempt: step.attempt,
  };
}

/** Mỗi người nhận một NotifyEffect riêng; khoá chống trùng: run:step:kind:seq:người nhận. */
function notify(w: Work, kind: NotifyKind, toUserId: string, step: StepState | null, data: Record<string, unknown>): void {
  const dedupeKey = `${w.run.id}:${step ? step.id : 'run'}:${kind}:${w.seq}:${toUserId}`;
  if (w.effectKeys.has(dedupeKey)) return;
  w.effectKeys.add(dedupeKey);
  w.effects.push({ kind, dedupeKey, toUserId, runId: w.run.id, stepId: step ? step.id : null, data });
}

/** Gửi cho nhiều người, bỏ qua chính người vừa thao tác (tin về việc mình vừa làm là vô nghĩa). */
function notifyOthers(w: Work, kind: NotifyKind, userIds: readonly string[], step: StepState | null, data: Record<string, unknown>): void {
  for (const id of userIds) if (id !== w.actorId) notify(w, kind, id, step, data);
}

function cancelTimers(w: Work, step: StepState | null): void {
  const dedupeKey = `${w.run.id}:${step ? step.id : 'run'}:cancel_timers:${w.seq}`;
  if (w.effectKeys.has(dedupeKey)) return;
  w.effectKeys.add(dedupeKey);
  w.effects.push({ kind: 'cancel_timers', dedupeKey, runId: w.run.id, stepId: step ? step.id : null });
}

function getStep(w: Work, stepId: string): StepState {
  const step = w.stepsById.get(stepId);
  if (!step) fail('not_found', 'Không tìm thấy việc trong lượt chạy', { stepId });
  return step;
}

function nodeOf(w: Work, step: StepState): ProcessNode {
  const node = w.graph.nodes.get(step.nodeId);
  if (!node) fail('not_found', 'Việc không thuộc định nghĩa quy trình của lượt chạy', { stepId: step.id });
  return node;
}

/** Nút của một "việc" (task hoặc approval); nút khác không nhận thao tác của người dùng. */
function workNodeOf(w: Work, step: StepState): WorkNode {
  const node = nodeOf(w, step);
  if (node.type !== 'task' && node.type !== 'approval') {
    fail('invalid_transition', 'Bước này không phải là việc giao cho người', { stepId: step.id, kind: step.kind });
  }
  return node;
}

function requireState(step: StepState, allowed: readonly StepStateName[]): void {
  if (!allowed.includes(step.state)) {
    fail('invalid_transition', 'Việc không ở trạng thái cho phép thao tác này', { stepId: step.id, currentState: step.state });
  }
}

/** Những người đang giữ việc: người nhận của task, hoặc những người duyệt chưa quyết của approval. */
function holders(step: StepState): string[] {
  if (step.kind === 'approval') return step.approvals.filter((a) => a.decision === null).map((a) => a.approverId);
  return step.assigneeId ? [step.assigneeId] : [];
}

/** Với nút duyệt, `assigneeId` luôn trỏ tới người duyệt đầu tiên chưa quyết. */
function syncApprovalPointer(step: StepState): void {
  const next = step.approvals.find((a) => a.decision === null);
  if (next) {
    step.assigneeId = next.approverId;
    step.onBehalfOfId = next.onBehalfOfId;
  }
}

function ruleRolesOf(node: WorkNode): string[] {
  const rules: AssigneeRule[] = node.type === 'task' ? [node.assignee] : node.approvers;
  return rules.flatMap((r) => (r.kind === 'role' ? [r.role] : []));
}

// ───────────────────────── Quyền (cột "Ai được phép" của bảng 4.3) ─────────────────────────

const actorIsSystem = (w: Work): boolean => w.event.actor.type === 'system';
const actorUser = (w: Work) => (w.actorId ? w.dir.users.get(w.actorId) : undefined);
/** "Người giao" = người khởi chạy lượt này. */
const actorIsInitiator = (w: Work): boolean => w.actorId !== null && w.actorId === w.run.initiatorId;
/**
 * Người thao tác có QUYỀN làm loại việc này không (cột "Ai được phép" của bảng 4.3, docs/DECISIONS.md, 05/10/2026). Các vai trò
 * Văn phòng, người điều phối, Chủ tịch không còn được gọi tên ở đây: ai làm được gì do bảng quyền của tổ chức quyết, nên chỉnh quyền
 * trên giao diện có hiệu lực cả ở engine. Bảng mặc định giữ đúng hành vi cũ.
 */
const actorCan = (w: Work, action: Action): boolean => hasPermission(actorUser(w), action);

function allow(w: Work, ok: boolean): void {
  if (!w.opts.checkPermissions || ok) return;
  fail('not_allowed', 'Người thao tác không có quyền với sự kiện này', { eventType: w.event.type });
}

/**
 * Người thao tác có đứng thay được `holderId` không: là chính người đó, là người gốc đã ủy quyền
 * (`onBehalfOfId`), hoặc đang được người đó ủy quyền tại `now` (SPEC 4.8).
 */
function actorCovers(w: Work, holderId: string | null, onBehalfOfId: string | null, node: WorkNode): boolean {
  const a = w.actorId;
  if (a === null || holderId === null) return false;
  if (a === holderId || a === onBehalfOfId) return true;
  return isDelegate(w.dir, holderId, a, w.now, w.run.templateId, ruleRolesOf(node));
}

/** Người nhận (kể cả người được ủy quyền); với nút duyệt là bất kỳ người duyệt nào chưa quyết. */
function actorIsHolder(w: Work, step: StepState, node: WorkNode): boolean {
  if (node.type === 'approval') return myApprovals(w, step, node).length > 0;
  return actorCovers(w, step.assigneeId, step.onBehalfOfId, node);
}

function myApprovals(w: Work, step: StepState, node: WorkNode): ApprovalRecord[] {
  return step.approvals.filter((a) => a.decision === null && actorCovers(w, a.approverId, a.onBehalfOfId, node));
}

/** Người giao (người khởi chạy), hoặc người có quyền `action`: dùng cho gia hạn, từ chối gia hạn, huỷ lượt chạy, đi thúc, ghi chú. */
const actorIsAssignerSide = (w: Work, action: Action): boolean => actorIsInitiator(w) || actorCan(w, action);

// ───────────────────────── Nhắc việc (SPEC 4.6) ─────────────────────────

/** Hẹn timer cho từng mốc nhắc còn ở phía trước; mốc đã qua thì bỏ. */
function scheduleReminders(w: Work, node: WorkNode, step: StepState, assignedAt: Date): void {
  const planned = planReminderTimers(
    reminderStepsFor(node, w.ctx),
    { dueAt: step.dueAt ? new Date(step.dueAt) : null, assignedAt },
    w.cal,
  );
  for (const t of planned) {
    if (t.fireAt.getTime() <= w.now.getTime()) continue;
    w.effects.push({
      kind: 'schedule_timer',
      dedupeKey: `${w.run.id}:${step.id}:timer:${w.seq}:${t.data.index ?? 0}`,
      runId: w.run.id,
      stepId: step.id,
      timerKind: t.timerKind,
      fireAt: t.fireAt.toISOString(),
      data: t.data,
    });
  }
}

/** Người nhận tin nhắc, xác định LÚC BẮN (người nhận việc có thể đã đổi từ lúc hẹn timer). */
function reminderRecipients(w: Work, step: StepState, node: WorkNode, to: ReminderTarget): string[] {
  switch (to) {
    case 'assignee':
      return holders(step);
    case 'assigner':
      return assignerRecipients(w.dir, w.run.initiatorId);
    case 'office_admin':
      return officeAdmins(w.dir);
    case 'assignee_manager': {
      // [GIẢ ĐỊNH] nút có `escalateTo` thì leo thang tới người đó thay cho cấp trên trực tiếp.
      if (node.type === 'task' && node.escalateTo) {
        const custom = resolveRule(node.escalateTo, ruleEnv(w));
        if (custom) return [custom];
      }
      const current = holders(step);
      if (current.length === 0) return officeAdmins(w.dir);
      return unique(current.flatMap((h) => managerRecipients(w.dir, h)));
    }
  }
}

function ruleEnv(w: Work): RuleEnv {
  return { dir: w.dir, initiatorId: w.run.initiatorId, inputs: w.run.inputs, stepResult: (nodeId) => w.latest.get(nodeId)?.result ?? null };
}

// ───────────────────────── Kích hoạt nút (bước 4) ─────────────────────────

/** Nút hệ thống xong ngay khi tới lượt. */
function completeInstantly(w: Work, step: StepState): void {
  step.activatedAt = w.nowIso;
  step.completedAt = w.nowIso;
  setState(w, step, 'done');
}

/** task, approval: resolveAssignee → applyDelegation → computeDue → ready | unassigned. */
function activateWork(w: Work, node: WorkNode, step: StepState): void {
  const due = computeDue(
    node.due,
    {
      activation: w.now,
      runStart: new Date(w.run.startedAt ?? w.nowIso),
      runTarget: w.run.targetAt ? new Date(w.run.targetAt) : null,
    },
    w.cal,
  );
  step.dueAt = due ? due.toISOString() : null;
  step.dueOriginalAt = step.dueAt;
  step.activatedAt = w.nowIso;

  // Người nhận được chỉ định sẵn (assigneeOverrides của StartRun, hoặc người làm lần trước khi làm lại) ưu tiên hơn quy tắc.
  const preassigned = step.assigneeId;
  const records: ApprovalRecord[] = [];
  const add = (baseId: string | null, ruleRoles: readonly string[]): void => {
    const base = usableUser(w.dir, baseId);
    if (!base) return;
    const delegation = findDelegation(w.dir, base.id, w.now, w.run.templateId, ruleRoles);
    const approverId = delegation ? delegation.toUserId : base.id;
    if (records.some((r) => r.approverId === approverId)) return;
    records.push({ approverId, onBehalfOfId: delegation ? base.id : null, decision: null, reason: null, decidedAt: null, result: null, fileIds: [] });
  };
  if (preassigned !== null) {
    add(preassigned, []);
  } else {
    const rules: AssigneeRule[] = node.type === 'task' ? [node.assignee] : node.approvers;
    const env = ruleEnv(w);
    for (const rule of rules) {
      const roles = rule.kind === 'role' ? [rule.role] : [];
      // Ô chọn nhiều người (ở bước trước hoặc ở biểu mẫu khởi chạy): mỗi người một dòng ở nút duyệt hoặc đóng góp; nút task chỉ nhận người đầu tiên.
      // Quy tắc `role` ở bước đóng góp: mọi người giữ vai trò đều được gửi phần của mình (khớp "Người được bổ nhiệm").
      const many = node.type === 'approval' && (rule.kind === 'step_field' || rule.kind === 'form_field' || (rule.kind === 'role' && node.action === 'contribute'));
      if (many) for (const id of resolveRuleMany(rule, env)) add(id, roles);
      else add(resolveRule(rule, env), roles);
    }
  }

  const first = records[0];
  step.assigneeId = first ? first.approverId : null;
  step.onBehalfOfId = first ? first.onBehalfOfId : null;
  step.approvals = node.type === 'approval' ? records : [];
  step.assignedBy = first ? (step.assignedBy ?? w.run.initiatorId) : null;
  step.state = first ? 'ready' : 'unassigned';
  w.changes.push({
    type: 'step.activated',
    stepId: step.id,
    nodeId: step.nodeId,
    state: step.state,
    assigneeId: step.assigneeId,
    onBehalfOfId: step.onBehalfOfId,
    dueAt: step.dueAt,
  });

  if (first) {
    // Việc mới luôn báo cho người nhận, kể cả khi chính họ vừa thao tác (việc kế tiếp vẫn là việc mới).
    for (const r of node.type === 'approval' ? records : [first]) {
      notify(w, 'notify.assigned', r.approverId, step, { ...stepData(w, step), assignedBy: step.assignedBy, onBehalfOfId: r.onBehalfOfId });
    }
    scheduleReminders(w, node, step, w.now);
  } else {
    // Chưa xác định được người nhận: Văn phòng thấy ở "Cần giao người". Việc chưa có người thì chưa hẹn nhắc.
    for (const admin of officeAdmins(w.dir)) {
      notify(w, 'notify.assigned', admin, step, { ...stepData(w, step), needsAssignee: true });
    }
  }
}

function activate(w: Work, node: ProcessNode, step: StepState): void {
  switch (node.type) {
    case 'task':
    case 'approval':
      activateWork(w, node, step);
      return;
    case 'condition': {
      const scope = { inputs: w.run.inputs, stepResult: (id: string) => w.latest.get(id)?.result ?? null };
      let chosen = 'else';
      for (const b of node.branches) {
        if (evalExpr(b.when, scope)) {
          chosen = b.id;
          break;
        }
      }
      step.result = { branch: chosen };
      completeInstantly(w, step);
      return;
    }
    case 'timer': {
      step.activatedAt = w.nowIso;
      step.startedAt = w.nowIso;
      setState(w, step, 'in_progress');
      w.effects.push({
        kind: 'schedule_timer',
        dedupeKey: `${w.run.id}:${step.id}:timer:${w.seq}:wait`,
        runId: w.run.id,
        stepId: step.id,
        timerKind: 'wait',
        fireAt: addDuration(w.now, node.wait, w.cal).toISOString(),
        data: {},
      });
      return;
    }
    case 'notify': {
      const env = ruleEnv(w);
      const users = unique(node.to.flatMap((rule) => resolveRuleMany(rule, env)));
      for (const u of users) {
        notify(w, 'notify.custom', u, step, { nodeId: node.id, nodeLabel: node.label, template: node.template, runTitle: w.run.title });
      }
      completeInstantly(w, step);
      return;
    }
    case 'webhook':
      // Giai đoạn 4: `body` là nguyên mẫu `bodyTemplate`; việc điền biến do adapter webhook đảm nhận [GIẢ ĐỊNH].
      w.effects.push({
        kind: 'webhook',
        dedupeKey: `${w.run.id}:${step.id}:webhook:${w.seq}`,
        runId: w.run.id,
        stepId: step.id,
        url: node.url,
        body: node.bodyTemplate,
      });
      completeInstantly(w, step);
      return;
    case 'end':
      completeInstantly(w, step);
      return;
    case 'start':
      return;
  }
}

/**
 * Lặp tới khi không còn thay đổi. Với mỗi nút đang chờ:
 * - mọi cạnh đến đều bị bỏ qua → nút bị bỏ qua (lan truyền đường chết);
 * - `join: 'all'`: mọi cạnh đến đã giải quyết và có ít nhất một cạnh xong → kích hoạt;
 * - `join: 'any'`: cạnh đến đầu tiên xong → kích hoạt, không kích hoạt lần hai.
 * Việc được Văn phòng cho qua khi chưa tới lượt cũng chờ ở đây: tới lượt thì chỉ ghi `activatedAt`
 * để các cạnh ra của nó được coi là xong.
 */
function propagate(w: Work): void {
  if (w.run.state !== 'running') return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of w.graph.order) {
      const step = w.latest.get(nodeId);
      const node = w.graph.nodes.get(nodeId);
      if (!step || !node || node.type === 'start') continue;
      const waitingManualSkip = isManualSkip(step) && step.activatedAt === null;
      if (step.state !== 'pending' && !waitingManualSkip) continue;

      const incoming = w.graph.incoming.get(nodeId) ?? [];
      if (incoming.length === 0) continue;
      let done = 0;
      let skipped = 0;
      for (const e of incoming) {
        const source = w.graph.nodes.get(e.from);
        const sourceStep = w.latest.get(e.from);
        if (!source || !sourceStep) continue;
        const status = edgeStatus(e, source, sourceStep);
        if (status === 'done') done++;
        else if (status === 'skipped') skipped++;
      }

      if (skipped === incoming.length) {
        if (waitingManualSkip) step.result = null;
        else setState(w, step, 'skipped');
        changed = true;
        continue;
      }
      const satisfied = (node.join ?? 'all') === 'any' ? done > 0 : done > 0 && done + skipped === incoming.length;
      if (!satisfied) continue;
      if (waitingManualSkip) step.activatedAt = w.nowIso;
      else activate(w, node, step);
      changed = true;
    }
  }
}

// ───────────────────────── Hoàn tất lượt chạy (bước 5) ─────────────────────────

/**
 * Lượt chạy hoàn tất khi mọi nút kết thúc đã tới, hoặc không còn việc nào mở (không còn nút nào kích hoạt được).
 * Trường hợp mọi nút kết thúc đã tới mà vẫn còn việc dở (chỉ xảy ra với nút kết thúc `join: 'any'`):
 * các việc dở chuyển `skipped` ("Không cần làm") và timer của chúng bị huỷ [GIẢ ĐỊNH].
 */
function finishIfComplete(w: Work): void {
  if (w.run.state !== 'running') return;
  const current = [...w.latest.values()];
  const ends = current.filter((s) => s.kind === 'end');
  const allEndsReached = ends.length > 0 && ends.every((s) => s.state === 'done');
  const anyOpen = current.some((s) => isOpen(s.state));
  if (!allEndsReached && anyOpen) return;
  // Bế tắc: không còn việc nào mở nhưng còn một nút duyệt chưa tới lượt mà cạnh đến chưa giải quyết xong (ví dụ chờ một nút
  // không bao giờ tới). Đồ thị hợp lệ không thể như vậy; nếu có (bản vẽ cũ) thì để lượt chạy ở `running` cho Văn phòng xử lý,
  // tuyệt đối không coi là "thành công" và bỏ qua một bước duyệt chưa ai duyệt.
  if (!allEndsReached && current.some((s) => s.kind === 'approval' && s.state === 'pending' && (w.graph.incoming.get(s.nodeId)?.length ?? 0) > 0)) return;

  for (const step of current) {
    if (isTerminal(step.state)) continue;
    if (isOpen(step.state)) cancelTimers(w, step);
    step.blockedReason = null;
    setState(w, step, 'skipped');
  }
  const rejected = current.some((s) => s.kind === 'approval' && s.state === 'rejected');
  w.run.state = 'completed';
  w.run.outcome = rejected ? 'rejected' : 'success';
  w.run.completedAt = w.nowIso;
  w.changes.push({ type: 'run.completed', outcome: w.run.outcome });
  notifyOthers(w, 'notify.run_completed', assignerRecipients(w.dir, w.run.initiatorId), null, {
    runTitle: w.run.title,
    outcome: w.run.outcome,
  });
}

// ───────────────────────── Vòng làm lại (giai đoạn 3) ─────────────────────────

/**
 * Nút duyệt bị "Chưa đồng ý" và có cạnh `rejected` trỏ về một nút đứng trước: tạo lần thử mới
 * (attempt + 1, id mới theo stepRunId) cho nút đích và mọi nút đã kết thúc nằm trên đường từ nút đích
 * tới nút duyệt, kể cả nút duyệt. Lần thử mới ở `pending`; vòng lan truyền sẽ kích hoạt lại nút đích.
 * Việc làm lại được giao sẵn cho người đã làm lần trước [GIẢ ĐỊNH]; ủy quyền áp lại lúc kích hoạt. Ngoại lệ: người đó đã bị
 * vô hiệu hoá, hoặc quy tắc `step_field` lấy người từ một bước cũng nằm trong vòng làm lại (người chọn có thể đã đổi): tính lại theo quy tắc.
 * Nút còn dở hoặc chưa tới lượt trên đường đó được giữ nguyên.
 */
function rework(w: Work, approval: ApprovalNode): void {
  for (const edge of w.graph.backOut.get(approval.id) ?? []) {
    const between = nodesBetween(w.graph, edge.to, approval.id);
    for (const nodeId of w.graph.order) {
      if (!between.has(nodeId)) continue;
      const node = w.graph.nodes.get(nodeId);
      const prev = w.latest.get(nodeId);
      if (!node || !prev || !isTerminal(prev.state)) continue;
      const next = newStep(w.run.id, node, prev.attempt + 1);
      if (node.type === 'task') {
        // Quy tắc lấy người từ kết quả của một bước cũng nằm trong vòng làm lại: người ở lần làm lại có thể đã đổi,
        // nên để activateWork tính lại từ kết quả mới thay vì giao sẵn cho người cũ.
        const rule = node.assignee;
        const recompute = rule.kind === 'step_field' && between.has(rule.node);
        // Người làm lần trước đã bị vô hiệu hoá thì cũng tính lại theo quy tắc (vai trò có thể còn người khác).
        const before = prev.onBehalfOfId ?? prev.assigneeId;
        next.assigneeId = recompute || !usableUser(w.dir, before) ? null : before;
        next.assignedBy = next.assigneeId ? prev.assignedBy : null;
      }
      w.run.steps.push(next);
      w.latest.set(nodeId, next);
      w.stepsById.set(next.id, next);
    }
  }
}

// ───────────────────────── Áp từng sự kiện (bước 2 và 3) ─────────────────────────

function onStartRun(w: Work, e: EngineEventOf<'StartRun'>): void {
  allow(w, actorIsInitiator(w) || actorCan(w, 'run.start'));
  const overrides = e.assigneeOverrides ?? {};
  for (const nodeId of Object.keys(overrides).sort(byId)) {
    const node = w.graph.nodes.get(nodeId);
    const userId = overrides[nodeId];
    const step = w.latest.get(nodeId);
    if (!node || !step || (node.type !== 'task' && node.type !== 'approval')) {
      fail('invalid_input', 'Chỉ định người nhận cho một bước không tồn tại hoặc không phải việc', { nodeId });
    }
    if (!userId || !w.dir.users.has(userId)) fail('invalid_input', 'Người nhận được chỉ định không có trong danh bạ', { nodeId });
    // Ghi sẵn vào dòng `pending`; lúc kích hoạt sẽ dùng người này thay cho quy tắc của nút.
    step.assigneeId = userId;
    step.assignedBy = w.actorId ?? w.run.initiatorId;
  }
  w.run.state = 'running';
  w.run.startedAt = w.nowIso;
  w.changes.push({ type: 'run.started' });
  for (const nodeId of w.graph.order) {
    const step = w.latest.get(nodeId);
    if (step && step.kind === 'start') completeInstantly(w, step);
  }
}

function onAssign(w: Work, e: EngineEventOf<'AssignStep'> | EngineEventOf<'Reassign'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  requireState(step, e.type === 'AssignStep' ? ['unassigned', 'ready'] : ['ready', 'in_progress']);
  // Trưởng đơn vị của người đang nhận; việc chưa có người thì trưởng đơn vị của người sắp nhận.
  const headOf = step.assigneeId ?? e.toUserId;
  allow(w, actorIsInitiator(w) || actorCan(w, 'step.reassign') || (w.actorId !== null && isUnitHeadOf(w.dir, w.actorId, headOf)));

  if (!usableUser(w.dir, e.toUserId)) {
    fail('invalid_input', 'Người nhận mới không có trong danh bạ hoặc đã bị vô hiệu hoá', { stepId: step.id });
  }
  const previous = step.assigneeId;
  if (previous === e.toUserId) fail('invalid_input', 'Người này đang là người nhận của việc', { stepId: step.id });

  if (node.type === 'approval') {
    // Thay người duyệt đang được trỏ tới (người đầu tiên chưa quyết); người mới đã có tên thì chỉ bỏ người cũ.
    const fresh: ApprovalRecord = { approverId: e.toUserId, onBehalfOfId: null, decision: null, reason: null, decidedAt: null, result: null, fileIds: [] };
    const already = step.approvals.some((a) => a.decision === null && a.approverId === e.toUserId);
    const next: ApprovalRecord[] = [];
    let replaced = false;
    for (const a of step.approvals) {
      if (a.decision === null && a.approverId === previous && !replaced) {
        replaced = true;
        if (!already) next.push(fresh);
      } else {
        next.push(a);
      }
    }
    if (!replaced && !already) next.push(fresh);
    step.approvals = next;
    syncApprovalPointer(step);
  } else {
    step.assigneeId = e.toUserId;
    step.onBehalfOfId = null;
  }
  step.assignedBy = w.actorId;
  step.blockedReason = null;
  w.changes.push({ type: 'step.assignee', stepId: step.id, from: previous, to: e.toUserId, onBehalfOfId: null });

  const wasUnassigned = step.state === 'unassigned';
  if (wasUnassigned) setState(w, step, 'ready');
  notifyOthers(w, 'notify.assigned', [e.toUserId], step, { ...stepData(w, step), assignedBy: step.assignedBy, onBehalfOfId: null, reassigned: previous !== null });
  if (previous !== null) {
    notifyOthers(w, 'notify.reassigned', [previous], step, { ...stepData(w, step), toUserId: e.toUserId, reason: e.reason ?? null });
  }
  // Timer của việc chưa có người đã bị huỷ (hoặc chưa từng hẹn): dựng lại theo hạn hiện tại.
  if (wasUnassigned) scheduleReminders(w, node, step, w.now);
}

function onUnassign(w: Work, e: EngineEventOf<'UnassignStep'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  requireState(step, ['ready', 'in_progress']);
  // Hệ thống, khi it_admin vô hiệu hoá người dùng.
  allow(w, actorIsSystem(w) || actorCan(w, 'user.manage'));
  const previous = step.assigneeId;

  // Có `userId` ở bước nhiều người (duyệt, đóng góp): chỉ gỡ người đó, những người còn chưa quyết vẫn giữ việc.
  // Sự kiện cũ không mang `userId` thì gỡ cả bước như trước, để lịch sử phát lại đúng từng bit.
  if (e.userId !== undefined && node.type === 'approval') {
    const kept = step.approvals.filter((a) => !(a.decision === null && a.approverId === e.userId));
    const removed = kept.length < step.approvals.length;
    if (removed && kept.some((a) => a.decision === null)) {
      step.approvals = kept;
      syncApprovalPointer(step);
      w.changes.push({ type: 'step.assignee', stepId: step.id, from: previous, to: step.assigneeId, onBehalfOfId: step.onBehalfOfId });
      return;
    }
    if (!removed && previous !== e.userId) return; // người này không giữ phần nào chưa quyết ở bước này: không có gì để gỡ
  }

  step.assigneeId = null;
  step.onBehalfOfId = null;
  step.assignedBy = null;
  step.startedAt = null;
  step.blockedReason = null;
  step.approvals = step.approvals.filter((a) => a.decision !== null);
  w.changes.push({ type: 'step.assignee', stepId: step.id, from: previous, to: null, onBehalfOfId: null });
  setState(w, step, 'unassigned');
  cancelTimers(w, step);
  for (const admin of officeAdmins(w.dir)) {
    notify(w, 'notify.assigned', admin, step, { ...stepData(w, step), needsAssignee: true, reason: e.reason });
  }
}

function onAccept(w: Work, e: EngineEventOf<'AcceptStep'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  requireState(step, ['ready']);
  allow(w, actorIsHolder(w, step, node));
  step.startedAt = w.nowIso;
  setState(w, step, 'in_progress');
  if (w.ctx.notifyOnAccept) {
    notifyOthers(w, 'notify.accepted', assignerRecipients(w.dir, w.run.initiatorId), step, { ...stepData(w, step), acceptedBy: w.actorId });
  }
}

/** Việc kết thúc (xong, chưa đồng ý): ghi giờ, xoá cờ vướng, huỷ mọi timer của việc trong cùng giao dịch. */
function closeStep(w: Work, step: StepState, to: 'done' | 'rejected'): void {
  step.completedAt = w.nowIso;
  step.blockedReason = null;
  setState(w, step, to);
  cancelTimers(w, step);
}

function onComplete(w: Work, e: EngineEventOf<'CompleteStep'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  if (node.type !== 'task') fail('invalid_transition', 'Việc cần duyệt phải dùng "Đồng ý" hoặc "Chưa đồng ý"', { stepId: step.id });
  requireState(step, ['ready', 'in_progress']);
  allow(w, actorIsHolder(w, step, node));
  const result = e.result ?? {};
  if (node.form) assertFormValues(node.form, result, 'Biểu mẫu kết quả');
  step.result = e.result !== undefined || e.note !== undefined ? { ...result, ...(e.note !== undefined ? { note: e.note } : {}) } : null;
  closeStep(w, step, 'done');
  notifyOthers(w, 'notify.completed', assignerRecipients(w.dir, w.run.initiatorId), step, { ...stepData(w, step), completedBy: w.actorId });
  if (e.nudgeId) w.changes.push({ type: 'nudge.replied', stepId: step.id, nudgeId: e.nudgeId, reply: 'done' });
}

/** Các dòng duyệt mà người thao tác được quyết. Khi phát lại (không kiểm quyền) mà danh bạ đã đổi: lấy dòng chưa quyết đầu tiên. */
function approvalsToDecide(w: Work, step: StepState, node: WorkNode): ApprovalRecord[] {
  const mine = myApprovals(w, step, node);
  allow(w, mine.length > 0);
  if (mine.length > 0) return mine;
  const first = step.approvals.find((a) => a.decision === null);
  if (!first) fail('invalid_transition', 'Không còn người duyệt nào chưa quyết', { stepId: step.id });
  return [first];
}

function onApprove(w: Work, e: EngineEventOf<'ApproveStep'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  if (node.type !== 'approval') fail('invalid_transition', 'Việc này không phải việc cần duyệt', { stepId: step.id });
  requireState(step, ['ready', 'in_progress']);
  // Nút có biểu mẫu (ý kiến chỉ đạo, nội dung đóng góp): kiểm ô bắt buộc trước khi ghi nhận bất kỳ ai.
  const result = e.result ?? {};
  if (node.form) assertFormValues(node.form, result, 'Biểu mẫu của người duyệt');
  const contribute = node.action === 'contribute';
  for (const record of approvalsToDecide(w, step, node)) {
    record.decision = 'approved';
    record.reason = e.comment ?? null;
    record.decidedAt = w.nowIso;
    if (node.form) record.result = { ...result };
    record.fileIds = [...(e.fileIds ?? [])];
    w.changes.push({ type: 'approval.decided', stepId: step.id, approverId: record.approverId, decision: 'approved' });
  }
  // mode any: một người đồng ý là xong; mode all: mọi người đều phải đồng ý.
  const complete = node.mode === 'any' || step.approvals.every((a) => a.decision === 'approved');
  if (!complete) {
    syncApprovalPointer(step);
    return;
  }
  step.result = { decision: 'approved', ...(e.comment !== undefined ? { comment: e.comment } : {}) };
  if (node.form || contribute) {
    // Gom phần của từng người (theo thứ tự người nhận) để các bước sau, bước tổng hợp và nút rẽ nhánh dùng.
    step.result['responses'] = step.approvals
      .filter((a) => a.decision === 'approved')
      .map((a) => ({
        userId: a.onBehalfOfId ?? a.approverId,
        ...(a.reason !== null ? { comment: a.reason } : {}),
        result: a.result ?? {},
        fileIds: a.fileIds,
      }));
    // Ô của người đầu tiên cũng đứng ở mức ngoài cùng, để `steps.<bước>.result.<ô>` dùng được khi chỉ có một người (ví dụ ý kiến chỉ đạo).
    const first = step.approvals.find((a) => a.decision === 'approved' && a.result !== null)?.result;
    if (first) for (const [k, v] of Object.entries(first)) if (!(k in step.result)) step.result[k] = v;
  }
  closeStep(w, step, 'done');
  notifyOthers(w, 'notify.completed', assignerRecipients(w.dir, w.run.initiatorId), step, {
    ...stepData(w, step),
    completedBy: w.actorId,
    decision: 'approved',
  });
}

function onReject(w: Work, e: EngineEventOf<'RejectStep'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  if (node.type !== 'approval') fail('invalid_transition', 'Việc này không phải việc cần duyệt', { stepId: step.id });
  if (node.action === 'contribute') fail('invalid_transition', 'Bước đóng góp chỉ có "Gửi", không có "Chưa đồng ý"', { stepId: step.id });
  requireState(step, ['ready', 'in_progress']);
  if (e.reason.trim() === '') fail('invalid_input', '"Chưa đồng ý" bắt buộc có lý do', { stepId: step.id });
  // Bất kỳ người duyệt nào "Chưa đồng ý" là việc bị từ chối, ở cả hai chế độ.
  for (const record of approvalsToDecide(w, step, node)) {
    record.decision = 'rejected';
    record.reason = e.reason;
    record.decidedAt = w.nowIso;
    w.changes.push({ type: 'approval.decided', stepId: step.id, approverId: record.approverId, decision: 'rejected' });
  }
  step.reason = e.reason;
  step.result = { decision: 'rejected' };
  closeStep(w, step, 'rejected');
  const recipients = unique([...assignerRecipients(w.dir, w.run.initiatorId), ...officeAdmins(w.dir)]);
  notifyOthers(w, 'notify.rejected', recipients, step, { ...stepData(w, step), rejectedBy: w.actorId, reason: e.reason });
  rework(w, node);
}

function onRequestExtension(w: Work, e: EngineEventOf<'RequestExtension'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  requireState(step, ['ready', 'in_progress']);
  allow(w, actorIsHolder(w, step, node));
  const proposed = new Date(e.proposedDueAt);
  if (Number.isNaN(proposed.getTime()) || proposed.getTime() <= w.now.getTime()) {
    fail('invalid_input', 'Hạn đề nghị phải ở sau thời điểm hiện tại', { stepId: step.id });
  }
  const requestedBy = w.actorId ?? step.assigneeId ?? w.run.initiatorId;
  const proposedDueAt = proposed.toISOString();
  w.changes.push({ type: 'extension.requested', stepId: step.id, requestId: e.requestId, requestedBy, proposedDueAt, reason: e.reason });
  notifyOthers(w, 'notify.extension_requested', assignerRecipients(w.dir, w.run.initiatorId), step, {
    ...stepData(w, step),
    requestId: e.requestId,
    requestedBy,
    proposedDueAt,
    reason: e.reason,
  });
  if (e.nudgeId) w.changes.push({ type: 'nudge.replied', stepId: step.id, nudgeId: e.nudgeId, reply: 'need_time' });
}

function onDeclineExtension(w: Work, e: EngineEventOf<'DeclineExtension'>): void {
  const step = getStep(w, e.stepId);
  workNodeOf(w, step);
  requireState(step, ['ready', 'in_progress']);
  allow(w, actorIsAssignerSide(w, 'extension.decide'));
  w.changes.push({ type: 'extension.decided', stepId: step.id, requestId: e.requestId, decision: 'declined', decidedBy: w.actorId });
  notifyOthers(w, 'notify.extension_declined', holders(step), step, {
    ...stepData(w, step),
    requestId: e.requestId,
    declinedBy: w.actorId,
    comment: e.comment ?? null,
  });
}

function onExtendDue(w: Work, e: EngineEventOf<'ExtendDue'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  requireState(step, ['unassigned', 'ready', 'in_progress']);
  allow(w, actorIsAssignerSide(w, 'step.extend'));
  const next = new Date(e.newDueAt);
  if (Number.isNaN(next.getTime()) || next.getTime() <= w.now.getTime()) {
    fail('invalid_input', 'Hạn mới phải ở sau thời điểm hiện tại', { stepId: step.id });
  }
  const to = next.toISOString();
  const from = step.dueAt;
  if (from === to) fail('invalid_input', 'Hạn mới trùng với hạn hiện tại', { stepId: step.id });
  // Hạn hiện tại đổi, hạn gốc giữ nguyên: báo cáo "đúng hạn" tính theo hạn gốc (SPEC 4.8).
  step.dueAt = to;
  if (step.dueOriginalAt === null) step.dueOriginalAt = to;
  w.changes.push({ type: 'step.due', stepId: step.id, from, to });
  if (e.extensionRequestId) {
    w.changes.push({ type: 'extension.decided', stepId: step.id, requestId: e.extensionRequestId, decision: 'approved', decidedBy: w.actorId });
  }
  // Huỷ trước, hẹn sau: tầng lưu trữ phải áp effect theo đúng thứ tự trong mảng.
  cancelTimers(w, step);
  if (step.state !== 'unassigned') scheduleReminders(w, node, step, new Date(step.activatedAt ?? w.nowIso));
  notifyOthers(w, 'notify.due_changed', holders(step), step, {
    ...stepData(w, step),
    previousDueAt: from,
    reason: e.reason,
    changedBy: w.actorId,
    extensionRequestId: e.extensionRequestId ?? null,
  });
}

function onSkip(w: Work, e: EngineEventOf<'SkipStep'>): void {
  const step = getStep(w, e.stepId);
  workNodeOf(w, step);
  // Bảng 4.3 ghi `pending`, `ready`; việc `unassigned` cũng cho qua được vì chỉ Văn phòng thấy nó [GIẢ ĐỊNH].
  requireState(step, ['pending', 'unassigned', 'ready']);
  allow(w, actorCan(w, 'step.skip'));
  if (e.reason.trim() === '') fail('invalid_input', 'Cho qua một việc bắt buộc có lý do', { stepId: step.id });
  const wasOpen = isOpen(step.state);
  step.reason = e.reason;
  // [GIẢ ĐỊNH] Văn phòng "cho qua có lý do": việc không cần làm nhưng luồng vẫn đi tiếp (xem edgeStatus).
  step.result = { skippedManually: true };
  step.completedAt = w.nowIso;
  step.blockedReason = null;
  setState(w, step, 'skipped');
  if (wasOpen) cancelTimers(w, step);
}

function onCancelRun(w: Work, e: EngineEventOf<'CancelRun'>): void {
  allow(w, actorIsAssignerSide(w, 'run.cancel'));
  if (e.reason.trim() === '') fail('invalid_input', 'Huỷ lượt chạy bắt buộc có lý do', {});
  w.run.state = 'cancelled';
  w.run.completedAt = w.nowIso;
  w.changes.push({ type: 'run.cancelled', reason: e.reason });
  const holding = new Set<string>();
  for (const step of w.run.steps) {
    if (isTerminal(step.state)) continue;
    if (step.state === 'ready' || step.state === 'in_progress') for (const h of holders(step)) holding.add(h);
    step.blockedReason = null;
    setState(w, step, 'cancelled');
  }
  cancelTimers(w, null);
  notifyOthers(w, 'notify.run_cancelled', [...holding].sort(byId), null, { runTitle: w.run.title, reason: e.reason, cancelledBy: w.actorId });
}

function suppress(w: Work, step: StepState, why: Extract<RunChange, { type: 'reminder.suppressed' }>['why']): void {
  w.changes.push({ type: 'reminder.suppressed', stepId: step.id, why });
}

function onTimerFired(w: Work, e: EngineEventOf<'TimerFired'>): void {
  allow(w, actorIsSystem(w));
  if (e.stepId === null) return;
  const step = getStep(w, e.stepId);
  const node = nodeOf(w, step);
  const running = w.run.state === 'running';

  if (e.kind === 'wait') {
    // Nút timer hết thời gian chờ. Timer bắn muộn sau khi lượt chạy đã kết thúc thì bỏ qua, không lỗi.
    if (!running || node.type !== 'timer' || step.state !== 'in_progress') return suppress(w, step, 'not_open');
    step.completedAt = w.nowIso;
    setState(w, step, 'done');
    return;
  }

  if (!running || (node.type !== 'task' && node.type !== 'approval') || !isOpen(step.state)) return suppress(w, step, 'not_open');
  // Chống làm phiền: tối đa một nhắc tự động cho mỗi việc mỗi ngày; vừa được đi thúc thì nghỉ 4 giờ.
  const today = toLocalDate(w.now, w.cal);
  if (step.lastReminderOn === today) return suppress(w, step, 'already_reminded_today');
  if (step.lastNudgedAt !== null) {
    const since = w.now.getTime() - new Date(step.lastNudgedAt).getTime();
    if (since >= 0 && since < NUDGE_QUIET_MS) return suppress(w, step, 'recently_nudged');
  }

  const entries = e.data.recipients ?? [{ to: e.data.to ?? 'assignee', kind: e.kind, level: undefined }];
  const dueAt = step.dueAt ? new Date(step.dueAt) : null;
  const overdue = dueAt !== null && w.now.getTime() > dueAt.getTime();
  const late = dueAt ? lateWorkingDays(dueAt, w.now, w.cal) : 0;
  const sent: string[] = [];
  let stale = false;
  // Mốc "trước hạn" hoặc "đúng ngày hạn" (tính theo ngày làm việc) mà bắn ra khi việc đã quá hạn, do worker chạy trễ.
  const preDueFiredLate = overdue && e.data.offsetWorkingDays !== undefined && e.data.offsetWorkingDays <= 0;
  for (const entry of entries) {
    // Mốc lỗi thời thì bỏ qua, để không chiếm lượt nhắc trong ngày của mốc còn đúng:
    // mốc quá hạn khi việc không còn quá hạn (hạn vừa được dời), và mốc trước hạn khi việc đã quá hạn.
    if (entry.kind === 'reminder' ? preDueFiredLate : !overdue) {
      stale = true;
      continue;
    }
    const base = { ...stepData(w, step), audience: entry.to };
    for (const userId of reminderRecipients(w, step, node, entry.to)) {
      if (entry.kind === 'reminder') {
        let variant: 'due_tomorrow' | 'due_today' | 'custom' = 'custom';
        if (dueAt !== null && !overdue) {
          if (toLocalDate(dueAt, w.cal) === today) variant = 'due_today';
          else if (workingDaysBetween(w.now, dueAt, w.cal) === 1) variant = 'due_tomorrow';
        }
        notify(w, 'notify.reminder', userId, step, { ...base, variant });
      } else if (entry.kind === 'overdue') {
        notify(w, 'notify.overdue', userId, step, { ...base, lateWorkingDays: late });
      } else {
        notify(w, 'notify.escalation', userId, step, { ...base, lateWorkingDays: late, level: entry.level ?? 1 });
      }
      sent.push(userId);
    }
  }
  if (sent.length === 0) return suppress(w, step, stale ? 'not_open' : 'no_recipient');
  step.lastReminderOn = today;
  w.changes.push({ type: 'reminder.sent', stepId: step.id, timerKind: e.kind, toUserIds: unique(sent) });
}

function onNudgeSent(w: Work, e: EngineEventOf<'NudgeSent'>): void {
  const step = getStep(w, e.stepId);
  workNodeOf(w, step);
  requireState(step, ['ready', 'in_progress']);
  // Hệ thống sau khi đề xuất được xác nhận; hoặc người điều phối, người giao bấm nút Đi thúc.
  allow(w, actorIsSystem(w) || actorIsAssignerSide(w, 'nudge.send'));
  if (!holders(step).includes(e.toUserId)) {
    fail('invalid_transition', 'Việc đã đổi người nhận', { stepId: step.id, currentState: step.state });
  }
  step.lastNudgedAt = w.nowIso;
  w.changes.push({
    type: 'nudge.sent',
    stepId: step.id,
    nudgeId: e.nudgeId,
    fromUserId: e.fromUserId,
    toUserId: e.toUserId,
    message: e.message,
    aiDrafted: e.aiDrafted,
  });
  notify(w, 'notify.nudge', e.toUserId, step, {
    ...stepData(w, step),
    nudgeId: e.nudgeId,
    message: e.message,
    aiDrafted: e.aiDrafted,
    fromUserId: e.fromUserId,
    lateWorkingDays: step.dueAt ? lateWorkingDays(step.dueAt, w.now, w.cal) : 0,
  });
}

function onReportBlocked(w: Work, e: EngineEventOf<'ReportBlocked'>): void {
  const step = getStep(w, e.stepId);
  const node = workNodeOf(w, step);
  requireState(step, ['ready', 'in_progress']);
  allow(w, actorIsHolder(w, step, node));
  step.blockedReason = e.reasonCode;
  w.changes.push({ type: 'step.blocked', stepId: step.id, reasonCode: e.reasonCode, note: e.note ?? null });
  const recipients = unique([...assignerRecipients(w.dir, w.run.initiatorId), ...officeAdmins(w.dir)]);
  notifyOthers(w, 'notify.blocked', recipients, step, { ...stepData(w, step), reasonCode: e.reasonCode, note: e.note ?? null, reportedBy: w.actorId });
  if (e.nudgeId) w.changes.push({ type: 'nudge.replied', stepId: step.id, nudgeId: e.nudgeId, reply: 'blocked' });
}

function onAddNote(w: Work, e: EngineEventOf<'AddNote'>): void {
  allow(w, actorIsSystem(w) || actorIsAssignerSide(w, 'run.note'));
  w.changes.push({ type: 'note', text: e.text });
}

function applyEvent(w: Work): void {
  const e = w.event;
  switch (e.type) {
    case 'StartRun':
      return onStartRun(w, e);
    case 'AssignStep':
    case 'Reassign':
      return onAssign(w, e);
    case 'UnassignStep':
      return onUnassign(w, e);
    case 'AcceptStep':
      return onAccept(w, e);
    case 'CompleteStep':
      return onComplete(w, e);
    case 'ApproveStep':
      return onApprove(w, e);
    case 'RejectStep':
      return onReject(w, e);
    case 'RequestExtension':
      return onRequestExtension(w, e);
    case 'DeclineExtension':
      return onDeclineExtension(w, e);
    case 'ExtendDue':
      return onExtendDue(w, e);
    case 'SkipStep':
      return onSkip(w, e);
    case 'CancelRun':
      return onCancelRun(w, e);
    case 'TimerFired':
      return onTimerFired(w, e);
    case 'NudgeSent':
      return onNudgeSent(w, e);
    case 'ReportBlocked':
      return onReportBlocked(w, e);
    case 'AddNote':
      return onAddNote(w, e);
  }
}

/** Trạng thái lượt chạy mà sự kiện đòi hỏi (bảng 4.3). */
function checkRunState(run: RunState, event: EngineEvent): void {
  const wrong = (): never =>
    fail('invalid_transition', 'Lượt chạy không ở trạng thái cho phép sự kiện này', { currentState: run.state, eventType: event.type });
  switch (event.type) {
    case 'StartRun':
      if (run.state !== 'draft') wrong();
      return;
    case 'TimerFired':
      // Timer có thể bắn muộn sau khi lượt chạy đã kết thúc: không lỗi, chỉ ghi "đã bỏ qua".
      if (run.state === 'draft') wrong();
      return;
    case 'AddNote':
      if (run.state === 'draft') wrong();
      return;
    default:
      if (run.state !== 'running') wrong();
  }
}

/** Lõi của `advance()`, có tuỳ chọn tắt kiểm quyền cho `replay()`. */
export function runAdvance(input: AdvanceInput, opts: AdvanceOptions): AdvanceOutput {
  const { def, event, ctx, now } = input;
  // Bước 1: chống lặp.
  if (input.run.appliedEventIds.includes(event.eventId)) return { run: input.run, effects: [], events: [] };
  if (Number.isNaN(now.getTime())) fail('invalid_input', 'Thời điểm `now` không hợp lệ');
  checkRunState(input.run, event);
  if (opts.checkPermissions && event.actor.type !== 'system' && !event.actor.userId) {
    fail('not_allowed', 'Sự kiện của người dùng phải ghi rõ người thao tác', { eventType: event.type });
  }

  const run = cloneRun(input.run);
  const latest = new Map<string, StepState>();
  const stepsById = new Map<string, StepState>();
  for (const s of run.steps) {
    stepsById.set(s.id, s);
    const cur = latest.get(s.nodeId);
    if (!cur || s.attempt > cur.attempt) latest.set(s.nodeId, s);
  }
  const w: Work = {
    def,
    graph: buildGraph(def),
    dir: buildDirectory(ctx),
    ctx,
    cal: ctx.calendar,
    now,
    nowIso: now.toISOString(),
    event,
    actorId: event.actor.type === 'system' ? null : (event.actor.userId ?? null),
    opts,
    run,
    latest,
    stepsById,
    seq: run.seq + 1,
    effects: [],
    effectKeys: new Set<string>(),
    changes: [],
  };

  applyEvent(w); // bước 2 và 3
  propagate(w); // bước 4
  finishIfComplete(w); // bước 5

  run.version += 1;
  run.seq = w.seq;
  run.appliedEventIds.push(event.eventId);
  const record: RunEventRecord = {
    id: event.eventId,
    runId: run.id,
    seq: w.seq,
    type: event.type,
    actorType: event.actor.type,
    actorId: event.actor.userId ?? null,
    proposalId: event.actor.proposalId ?? null,
    payload: { event, changes: w.changes },
    at: w.nowIso,
  };
  return { run, effects: w.effects, events: [record] };
}

/** `advance()` công khai: luôn kiểm quyền. */
export function advance(input: AdvanceInput): AdvanceOutput {
  return runAdvance(input, { checkPermissions: true });
}
