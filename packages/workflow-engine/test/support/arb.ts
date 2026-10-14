/// <reference types="node" />
import {
  deterministicId,
  EngineEventSchema,
  ProcessDefinitionSchema,
  type AdvanceOutput,
  type AssigneeRule,
  type DueRule,
  type Duration,
  type EngineEvent,
  type Expr,
  type ProcessDefinition,
  type ReminderPolicy,
  type ResolveContext,
  type RunEventRecord,
  type RunState,
  type ScheduleTimerEffect,
  type StepState,
  type WorkCalendar,
} from '@mihato/domain';
import { addCalendarDays, atLocalTime } from '@mihato/domain/calendar';
import fc from 'fast-check';
import { advance, createRun, validate } from '../../src';
import { extraUser, ORG, RUN, SEED_UNITS, SEED_USERS, TEMPLATE, TEMPLATE_VERSION, U, UNIT } from './world';

/**
 * Bộ sinh dữ liệu cho test thuộc tính (SPEC 4.10, 13.4):
 * - định nghĩa quy trình ngẫu nhiên nhưng hợp lệ (đã qua validate()), tới 12 nút, có nhánh song song,
 *   join all/any, condition, timer, notify, webhook và approval có cạnh rejected dẫn tới kết thúc;
 * - chuỗi sự kiện ngẫu nhiên nhưng hợp lệ: mỗi sự kiện được chọn từ các thao tác áp được vào trạng thái lúc đó.
 * Số mẫu đọc từ FC_NUM_RUNS (mặc định 100; chạy đêm 10.000).
 */
export const NUM_RUNS = Number(process.env['FC_NUM_RUNS'] ?? 100);

/**
 * Tham số chung cho fc.assert. Khi một thuộc tính hỏng, fast-check in seed, đường rút gọn và kịch bản đã thu nhỏ
 * (định nghĩa, biểu mẫu, các lựa chọn); `drive()` nối thêm chuỗi sự kiện đã áp vào thông báo lỗi.
 * Chạy lại đúng ca hỏng: thêm `{ seed, path }` vào tham số này.
 */
export const fcParams = { numRuns: NUM_RUNS };

// ───────────────────────── Định nghĩa quy trình ─────────────────────────

const assigneeRuleArb: fc.Arbitrary<AssigneeRule> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(U.LAN, U.NGOCANH, U.TUAN, U.PHUONG, U.HUNG, U.HUY, U.DIRECTOR, U.ADMIN).map((userId) => ({ kind: 'user' as const, userId })) },
  { weight: 1, arbitrary: fc.constantFrom(U.DISABLED, U.GHOST).map((userId) => ({ kind: 'user' as const, userId })) },
  {
    weight: 2,
    arbitrary: fc
      .record({ role: fc.constantFrom('employee' as const, 'deputy' as const, 'office_admin' as const, 'process_designer' as const), unitId: fc.constantFrom(undefined, UNIT.SALES, UNIT.TECH) })
      .map(({ role, unitId }) => (unitId ? { kind: 'role' as const, role, unitId } : { kind: 'role' as const, role })),
  },
  { weight: 1, arbitrary: fc.constantFrom(undefined, UNIT.SALES, UNIT.BOARD, UNIT.TECH).map((unitId) => (unitId ? { kind: 'unit_head' as const, unitId } : { kind: 'unit_head' as const })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'initiator' as const }) },
  { weight: 1, arbitrary: fc.constantFrom(undefined, 1, 2).map((level) => (level ? { kind: 'initiator_manager' as const, level } : { kind: 'initiator_manager' as const })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'form_field' as const, field: 'owner' }) },
);

const atTimeArb = fc.constantFrom(undefined, 'end_of_workday' as const, '11:30');
const dueRuleArb: fc.Arbitrary<DueRule> = fc
  .oneof(
    fc.record({ anchor: fc.constant('run_target' as const), offset: fc.record({ value: fc.integer({ min: -10, max: 0 }), unit: fc.constantFrom('working_day' as const, 'calendar_day' as const) }) }),
    fc.record({
      anchor: fc.constant('activation' as const),
      offset: fc.oneof(
        fc.record({ value: fc.integer({ min: 0, max: 5 }), unit: fc.constant('working_day' as const) }),
        fc.record({ value: fc.integer({ min: 1, max: 7 }), unit: fc.constant('calendar_day' as const) }),
        fc.record({ value: fc.integer({ min: 1, max: 72 }), unit: fc.constant('hour' as const) }),
      ),
    }),
    fc.record({ anchor: fc.constant('run_start' as const), offset: fc.record({ value: fc.integer({ min: 0, max: 10 }), unit: fc.constant('working_day' as const) }) }),
  )
  .chain((rule) => atTimeArb.map((atTime) => (atTime ? { ...rule, atTime } : rule)));

const reminderPolicyArb: fc.Arbitrary<ReminderPolicy | undefined> = fc.oneof(
  { weight: 4, arbitrary: fc.constant(undefined) },
  { weight: 2, arbitrary: fc.constantFrom('standard' as const, 'strict' as const, 'none' as const).map((preset) => ({ preset })) },
  {
    weight: 1,
    arbitrary: fc
      .array(
        fc.record({
          at: fc.record({
            anchor: fc.constantFrom('assigned' as const, 'due' as const),
            offset: fc.oneof(
              fc.record({ value: fc.integer({ min: -2, max: 3 }), unit: fc.constant('working_day' as const) }),
              fc.record({ value: fc.integer({ min: -6, max: 30 }), unit: fc.constant('hour' as const) }),
            ),
          }),
          to: fc.constantFrom('assignee' as const, 'assigner' as const, 'assignee_manager' as const, 'office_admin' as const),
          kind: fc.constantFrom('reminder' as const, 'overdue' as const, 'escalation' as const),
        }),
        { minLength: 1, maxLength: 4 },
      )
      .map((overrides) => ({ preset: 'standard' as const, overrides })),
  },
);

const waitArb: fc.Arbitrary<Duration> = fc.oneof(
  fc.record({ value: fc.integer({ min: 1, max: 3 }), unit: fc.constant('working_day' as const) }),
  fc.record({ value: fc.integer({ min: 1, max: 48 }), unit: fc.constant('hour' as const) }),
  fc.record({ value: fc.integer({ min: 1, max: 3 }), unit: fc.constant('calendar_day' as const) }),
);

/** Điều kiện ở dạng trung gian: `pick` chọn việc có biểu mẫu đứng trước khi dựng định nghĩa. */
type LeafSpec = { source: 'amount' | 'flag' | 'step'; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: number; pick: number };
type ExprSpec = { leaf: LeafSpec } | { not: ExprSpec } | { and: ExprSpec[] } | { or: ExprSpec[] };
const leafArb: fc.Arbitrary<ExprSpec> = fc
  .record({
    source: fc.constantFrom('amount' as const, 'flag' as const, 'step' as const),
    op: fc.constantFrom('eq' as const, 'ne' as const, 'gt' as const, 'gte' as const, 'lt' as const, 'lte' as const),
    value: fc.integer({ min: 0, max: 4 }),
    pick: fc.nat(),
  })
  .map((leaf) => ({ leaf }));
const exprSpecArb: fc.Arbitrary<ExprSpec> = fc.oneof(
  { weight: 4, arbitrary: leafArb },
  { weight: 1, arbitrary: leafArb.map((e) => ({ not: e })) },
  { weight: 1, arbitrary: fc.array(leafArb, { minLength: 1, maxLength: 3 }).map((and) => ({ and })) },
  { weight: 1, arbitrary: fc.array(leafArb, { minLength: 1, maxLength: 3 }).map((or) => ({ or })) },
);

type MiddleKind = 'task' | 'approval' | 'condition' | 'timer' | 'notify' | 'webhook';
type NodeSpec = {
  kind: MiddleKind;
  parent: number;
  extraParents: number[];
  join: 'all' | 'any' | undefined;
  assignee: AssigneeRule;
  approvers: AssigneeRule[];
  mode: 'any' | 'all';
  due: DueRule;
  reminders: ReminderPolicy | undefined;
  hasForm: boolean;
  wait: Duration;
  rejectedToEnd: boolean;
  /** chỉ dùng cho bộ sinh có vòng làm lại: cạnh rejected quay về nút đứng ngay trước nút duyệt */
  loopBack: boolean;
  exprs: ExprSpec[];
  endPick: number;
  extraEnd: boolean;
};

const nodeSpecArb: fc.Arbitrary<NodeSpec> = fc.record({
  kind: fc.constantFrom<MiddleKind>('task', 'task', 'task', 'task', 'task', 'approval', 'approval', 'condition', 'condition', 'timer', 'notify', 'webhook'),
  parent: fc.nat(),
  extraParents: fc.array(fc.nat(), { maxLength: 2 }),
  join: fc.constantFrom('all' as const, 'any' as const, undefined),
  assignee: assigneeRuleArb,
  approvers: fc.array(assigneeRuleArb, { minLength: 1, maxLength: 3 }),
  mode: fc.constantFrom('any' as const, 'all' as const),
  due: dueRuleArb,
  reminders: reminderPolicyArb,
  hasForm: fc.boolean(),
  wait: waitArb,
  rejectedToEnd: fc.boolean(),
  loopBack: fc.boolean(),
  exprs: fc.array(exprSpecArb, { minLength: 4, maxLength: 4 }),
  endPick: fc.nat(),
  extraEnd: fc.boolean(),
});

type Blueprint = { specs: NodeSpec[]; endCount: number; endJoin: 'all' | 'any' | undefined };

const DEF_INPUTS = [
  { key: 'delegation', label: 'Tên đoàn', type: 'text', required: true },
  { key: 'visitDate', label: 'Ngày đoàn đến', type: 'date', required: true },
  { key: 'amount', label: 'Số tiền', type: 'money' },
  { key: 'owner', label: 'Người phụ trách', type: 'user' },
  { key: 'flag', label: 'Khẩn', type: 'select', options: [{ value: 'yes', label: 'Có' }, { value: 'no', label: 'Không' }] },
];

function buildDefinition(bp: Blueprint, loops: boolean): unknown {
  const idOf = (i: number): string => (i === 0 ? 'start' : `n${i}`);
  const endIds = Array.from({ length: bp.endCount }, (_, k) => `end${k + 1}`);
  // cạnh giữa các nút: mỗi nút có ít nhất một nút đứng trước (nút có chỉ số nhỏ hơn) nên đồ thị không có chu trình
  const targets = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = targets.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    targets.set(from, list);
  };
  bp.specs.forEach((spec, k) => {
    const i = k + 1;
    link(idOf(spec.parent % i), idOf(i));
    for (const p of spec.extraParents) link(idOf(p % i), idOf(i));
  });
  bp.specs.forEach((spec, k) => {
    const id = idOf(k + 1);
    const end = endIds[spec.endPick % endIds.length] as string;
    if (!targets.has(id) || spec.extraEnd) link(id, end);
  });

  const formTasks = (before: number): string[] => bp.specs.flatMap((s, k) => (k + 1 < before && s.kind === 'task' && s.hasForm ? [idOf(k + 1)] : []));
  const toExpr = (spec: ExprSpec, before: number): Expr => {
    if ('not' in spec) return { op: 'not', arg: toExpr(spec.not, before) };
    if ('and' in spec) return { op: 'and', args: spec.and.map((e) => toExpr(e, before)) };
    if ('or' in spec) return { op: 'or', args: spec.or.map((e) => toExpr(e, before)) };
    const { source, op, value, pick } = spec.leaf;
    const forms = formTasks(before);
    if (source === 'flag') return { op: op === 'ne' ? 'ne' : 'eq', left: { ref: 'inputs.flag' }, right: { value: value % 2 === 0 ? 'yes' : 'no' } };
    const ref = source === 'step' && forms.length > 0 ? `steps.${forms[pick % forms.length] as string}.result.amount` : 'inputs.amount';
    return { op, left: { ref }, right: { value: value * 10_000_000 } };
  };

  const edges: Record<string, unknown>[] = [];
  const backEdges = new Set<string>();
  let edgeNo = 0;
  const addEdge = (from: string, to: string, extra: Record<string, unknown> = {}): void => {
    edges.push({ id: `e${++edgeNo}`, from, to, ...extra });
  };
  const nodes: Record<string, unknown>[] = [{ id: 'start', type: 'start', label: 'Bắt đầu' }];
  for (const to of targets.get('start') ?? []) addEdge('start', to);

  bp.specs.forEach((spec, k) => {
    const i = k + 1;
    const id = idOf(i);
    const out = targets.get(id) ?? [];
    const base: Record<string, unknown> = { id, label: `Bước ${i}` };
    switch (spec.kind) {
      case 'task':
        nodes.push({
          ...base,
          type: 'task',
          title: `Việc ${i}`,
          assignee: spec.assignee,
          due: spec.due,
          ...(spec.reminders ? { reminders: spec.reminders } : {}),
          ...(spec.hasForm ? { form: [{ key: 'amount', label: 'Số tiền', type: 'money', required: true }] } : {}),
        });
        for (const to of out) addEdge(id, to);
        break;
      case 'approval':
        nodes.push({ ...base, type: 'approval', title: `Duyệt ${i}`, approvers: spec.approvers, mode: spec.mode, due: spec.due, ...(spec.reminders ? { reminders: spec.reminders } : {}) });
        out.forEach((to, j) => addEdge(id, to, j % 2 === 0 ? { outcome: 'approved' } : {}));
        if (loops && spec.loopBack && spec.parent % i !== 0) {
          // vòng làm lại (giai đoạn 3): "Chưa đồng ý" quay về nút đứng ngay trước
          addEdge(id, idOf(spec.parent % i), { outcome: 'rejected' });
          backEdges.add(`e${edgeNo}`);
        } else if (spec.rejectedToEnd) {
          addEdge(id, endIds[spec.endPick % endIds.length] as string, { outcome: 'rejected' });
        }
        break;
      case 'condition': {
        // cạnh đầu tiên là 'else'; mỗi cạnh còn lại là một nhánh riêng
        const branches = out.slice(1).map((_, j) => ({ id: `b${j + 1}`, when: toExpr(spec.exprs[j % spec.exprs.length] as ExprSpec, i) }));
        nodes.push({ ...base, type: 'condition', branches });
        out.forEach((to, j) => addEdge(id, to, { branch: j === 0 ? 'else' : `b${j}` }));
        break;
      }
      case 'timer':
        nodes.push({ ...base, type: 'timer', wait: spec.wait });
        for (const to of out) addEdge(id, to);
        break;
      case 'notify':
        nodes.push({ ...base, type: 'notify', to: spec.approvers, template: 'mẫu tin thử' });
        for (const to of out) addEdge(id, to);
        break;
      case 'webhook':
        nodes.push({ ...base, type: 'webhook', url: 'https://example.invalid/hook', bodyTemplate: '{}' });
        for (const to of out) addEdge(id, to);
        break;
    }
  });

  // join chỉ đặt cho nút có từ hai cạnh đến; nút kết thúc không có cạnh đến thì bỏ
  const incoming = (id: string): number => edges.filter((e) => e['to'] === id && !backEdges.has(e['id'] as string)).length;
  bp.specs.forEach((spec, k) => {
    const node = nodes[k + 1] as Record<string, unknown>;
    if (spec.join && incoming(node['id'] as string) >= 2) node['join'] = spec.join;
  });
  for (const endId of endIds) {
    const count = incoming(endId);
    if (count === 0) continue;
    nodes.push({ id: endId, type: 'end', label: 'Kết thúc', ...(bp.endJoin && count >= 2 ? { join: bp.endJoin } : {}) });
  }
  return { schemaVersion: 1, name: 'Quy trình sinh ngẫu nhiên', inputs: DEF_INPUTS, targetField: 'visitDate', nodes, edges };
}

const blueprintArb: fc.Arbitrary<Blueprint> = fc.record({
  specs: fc.array(nodeSpecArb, { minLength: 2, maxLength: 9 }),
  endCount: fc.integer({ min: 1, max: 2 }),
  endJoin: fc.constantFrom('all' as const, 'any' as const, undefined),
});

const validOnly = (raw: fc.Arbitrary<unknown>): fc.Arbitrary<ProcessDefinition> =>
  raw.filter((def) => validate(def as ProcessDefinition).errors.length === 0).map((def) => ProcessDefinitionSchema.parse(def));

/** Bản thô của bộ sinh, chưa lọc qua validate(): dùng để kiểm chính bộ sinh. */
export const rawDefinitionArb: fc.Arbitrary<unknown> = blueprintArb.map((bp) => buildDefinition(bp, false));
/** Như trên nhưng nút duyệt có thể có cạnh rejected quay về nút đứng trước (vòng làm lại, giai đoạn 3). */
export const rawLoopDefinitionArb: fc.Arbitrary<unknown> = blueprintArb.map((bp) => buildDefinition(bp, true));

/** Định nghĩa quy trình ngẫu nhiên, hợp lệ theo validate(), tới 12 nút; cạnh rejected chỉ dẫn tới kết thúc (giai đoạn 1). */
export const definitionArb: fc.Arbitrary<ProcessDefinition> = validOnly(rawDefinitionArb);
/** Định nghĩa có thể chứa vòng làm lại. */
export const loopDefinitionArb: fc.Arbitrary<ProcessDefinition> = validOnly(rawLoopDefinitionArb);

// ───────────────────────── Bối cảnh và kịch bản ─────────────────────────

const calendarArb: fc.Arbitrary<WorkCalendar> = fc
  .record({
    saturday: fc.boolean(),
    holidays: fc.array(
      fc.record({
        day: fc.integer({ min: 0, max: 45 }).map((d) => addCalendarDays('2026-10-01', d)),
        kind: fc.constantFrom('public' as const, 'company' as const, 'makeup_workday' as const),
      }),
      { maxLength: 4 },
    ),
  })
  .map(({ saturday, holidays }) => ({ utcOffsetMinutes: 420, workdays: saturday ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', holidays }));

const PROP_USERS = [...SEED_USERS, extraUser(U.DISABLED, 'employee', UNIT.TECH, U.HUY, 'disabled'), extraUser(U.ADMIN2, 'office_admin', UNIT.OFFICE, U.DIRECTOR)];

const ctxArb: fc.Arbitrary<ResolveContext> = fc
  .record({ calendar: calendarArb, delegate: fc.boolean(), preset: fc.constantFrom(undefined, 'standard' as const, 'strict' as const, 'none' as const), notifyOnAccept: fc.boolean() })
  .map(({ calendar, delegate, preset, notifyOnAccept }) => ({
    users: PROP_USERS,
    units: SEED_UNITS,
    delegations: delegate
      ? [
          { fromUserId: U.LAN, toUserId: U.LAN2, validFrom: '2026-10-01T00:00:00.000Z', validTo: '2026-10-12T00:00:00.000Z', scope: 'all' as const, scopeRef: null },
          { fromUserId: U.HUY, toUserId: U.DIRECTOR, validFrom: '2026-10-05T00:00:00.000Z', validTo: '2026-11-30T00:00:00.000Z', scope: 'role' as const, scopeRef: 'deputy' },
          { fromUserId: U.TUAN, toUserId: U.HUNG, validFrom: '2026-10-03T00:00:00.000Z', validTo: '2026-10-20T00:00:00.000Z', scope: 'process' as const, scopeRef: TEMPLATE },
        ]
      : [],
    calendar,
    notifyOnAccept,
    ...(preset ? { defaultReminderPreset: preset } : {}),
  }));

export type Scenario = {
  def: ProcessDefinition;
  ctx: ResolveContext;
  initiatorId: string;
  inputs: Record<string, unknown>;
  startAt: Date;
  /** mỗi số chọn một thao tác trong các thao tác đang áp được, và quyết định đồng hồ nhảy bao xa */
  choices: number[];
};

const scenarioOf = (defArb: fc.Arbitrary<ProcessDefinition>): fc.Arbitrary<Scenario> => fc
  .record({
    def: defArb,
    ctx: ctxArb,
    initiatorId: fc.constantFrom(U.ADMIN, U.CHAIRMAN, U.HUNG, U.HUY),
    startDay: fc.integer({ min: 0, max: 9 }),
    startMinute: fc.integer({ min: 0, max: 1439 }),
    targetDays: fc.integer({ min: 0, max: 20 }),
    amount: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
    owner: fc.constantFrom(undefined, U.NGOCANH, U.PHUONG, U.GHOST),
    flag: fc.constantFrom(undefined, 'yes', 'no'),
    choices: fc.array(fc.noBias(fc.nat({ max: 1_000_000 })), { minLength: 8, maxLength: 60 }),
  })
  .map(({ def, ctx, initiatorId, startDay, startMinute, targetDays, amount, owner, flag, choices }) => {
    const day = addCalendarDays('2026-10-01', startDay);
    const startAt = new Date(atLocalTime(day, '00:00', ctx.calendar).getTime() + startMinute * 60_000);
    const inputs: Record<string, unknown> = { delegation: 'Đoàn thử', visitDate: addCalendarDays(day, targetDays) };
    if (amount !== undefined) inputs['amount'] = amount * 10_000_000;
    if (owner !== undefined) inputs['owner'] = owner;
    if (flag !== undefined) inputs['flag'] = flag;
    const scenario: Scenario = { def, ctx, initiatorId, inputs, startAt, choices };
    // Bản in gọn khi thuộc tính hỏng: đủ để dựng lại kịch bản, bỏ danh bạ cố định cho dễ đọc.
    const summary = (): string =>
      JSON.stringify({ initiatorId, startAt: startAt.toISOString(), inputs, choices, calendar: ctx.calendar, delegations: ctx.delegations.length, preset: ctx.defaultReminderPreset ?? null, def });
    return Object.defineProperty(scenario, fc.toStringMethod, { value: summary, enumerable: false });
  });

/** Kịch bản ngẫu nhiên trên định nghĩa giai đoạn 1 (cạnh rejected chỉ dẫn tới kết thúc). */
export const scenarioArb: fc.Arbitrary<Scenario> = scenarioOf(definitionArb);
/** Kịch bản ngẫu nhiên trên định nghĩa có vòng làm lại. */
export const loopScenarioArb: fc.Arbitrary<Scenario> = scenarioOf(loopDefinitionArb);

// ───────────────────────── Chạy kịch bản ─────────────────────────

export type TraceStep = {
  index: number;
  event: EngineEvent;
  now: Date;
  before: RunState;
  out: AdvanceOutput;
  /** timer còn chờ sau khi áp effect của bước này */
  timers: ReadonlyMap<string, ScheduleTimerEffect>;
};

export type Trace = { scenario: Scenario; initial: RunState; final: RunState; records: RunEventRecord[]; steps: TraceStep[]; timers: ReadonlyMap<string, ScheduleTimerEffect> };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const ACTIVE_POOL = [U.LAN, U.NGOCANH, U.TUAN, U.PHUONG, U.HUNG, U.LAN2, U.HUY];
const SYSTEM = { type: 'system' as const };
const asUser = (userId: string) => ({ type: 'user' as const, userId });

function latestSteps(run: RunState): StepState[] {
  const latest = new Map<string, StepState>();
  for (const s of run.steps) {
    const cur = latest.get(s.nodeId);
    if (!cur || s.attempt > cur.attempt) latest.set(s.nodeId, s);
  }
  return [...latest.values()];
}

export function holdersOf(step: StepState): string[] {
  if (step.kind === 'approval') return step.approvals.filter((a) => a.decision === null).map((a) => a.approverId);
  return step.assigneeId ? [step.assigneeId] : [];
}

type Candidate = { weight: number; make: (c: number, now: Date) => Record<string, unknown>; at?: (now: Date) => Date };

/** Các thao tác áp được vào trạng thái hiện tại (bảng 4.3), kèm trọng số: thao tác đẩy luồng đi tiếp nặng hơn. */
function candidates(run: RunState, def: ProcessDefinition, timers: Map<string, ScheduleTimerEffect>, c: number): Candidate[] {
  const list: Candidate[] = [];
  const add = (weight: number, make: Candidate['make'], at?: Candidate['at']): void => {
    list.push(at ? { weight, make, at } : { weight, make });
  };
  if (run.state === 'draft') {
    add(1, () => ({ type: 'StartRun', actor: asUser(run.initiatorId), ...(c % 7 === 0 ? { assigneeOverrides: overridesFor(def, c) } : {}) }));
    return list;
  }
  // timer: bắn timer sớm nhất (như worker), thỉnh thoảng bắn một timer khác trễ hoặc sai thứ tự
  const sorted = [...timers.values()].sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : a.dedupeKey < b.dedupeKey ? -1 : 1));
  const fire = (t: ScheduleTimerEffect): Candidate['make'] => () => ({ type: 'TimerFired', actor: SYSTEM, timerKey: t.dedupeKey, stepId: t.stepId, kind: t.timerKind, data: t.data });
  const notBefore = (t: ScheduleTimerEffect) => (now: Date): Date => new Date(Math.max(now.getTime(), new Date(t.fireAt).getTime()));
  const addCommon = (): void => {
    if (sorted[0]) add(6, fire(sorted[0]), notBefore(sorted[0]));
    if (sorted.length > 1) {
      const other = sorted[c % sorted.length] as ScheduleTimerEffect;
      add(1, fire(other), notBefore(other));
    }
    add(1, () => ({ type: 'AddNote', actor: asUser(U.ADMIN), text: 'ghi chú thử' }));
  };
  if (run.state !== 'running') {
    addCommon();
    return list;
  }

  if (c % 6 === 1) add(3, () => ({ type: 'CancelRun', actor: asUser(U.ADMIN), reason: 'huỷ thử' }));
  const nodeOf = (step: StepState) => def.nodes.find((n) => n.id === step.nodeId);
  let pendingSkipOffered = false;
  for (const step of latestSteps(run)) {
    if (step.kind !== 'task' && step.kind !== 'approval') continue;
    const stepId = step.id;
    const holders = holdersOf(step);
    const holder = holders[c % Math.max(holders.length, 1)];
    const other = ACTIVE_POOL.filter((u) => u !== step.assigneeId)[c % (ACTIVE_POOL.length - 1)] as string;
    const days = (n: number, now: Date): string => new Date(now.getTime() + n * 86_400_000 + ((c % 59) + 1) * 60_000).toISOString();
    const extend = (): void =>
      add(1, (_c, now) => {
        const newDueAt = days(1 + (c % 5), now);
        return { type: 'ExtendDue', actor: asUser(U.ADMIN), stepId, newDueAt: newDueAt === step.dueAt ? days(7, now) : newDueAt, reason: 'gia hạn thử' };
      });

    if (step.state === 'pending') {
      if (!pendingSkipOffered) add(1, () => ({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId, reason: 'không cần' }));
      pendingSkipOffered = true;
      continue;
    }
    if (step.state === 'unassigned') {
      add(6, () => ({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId, toUserId: other }));
      add(1, () => ({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId, reason: 'không cần' }));
      extend();
      continue;
    }
    if ((step.state !== 'ready' && step.state !== 'in_progress') || !holder) continue;

    if (step.kind === 'task') {
      const form = nodeOf(step);
      const needsAmount = form?.type === 'task' && (form.form ?? []).length > 0;
      add(6, () => ({
        type: 'CompleteStep',
        actor: asUser(holder),
        stepId,
        ...(needsAmount ? { result: { amount: (c % 5) * 10_000_000 } } : {}),
        ...(c % 3 === 0 ? { note: 'xong' } : {}),
        ...(c % 11 === 0 ? { nudgeId: deterministicId(`nudge:${c}`) } : {}),
      }));
    } else {
      add(5, () => ({ type: 'ApproveStep', actor: asUser(holder), stepId, ...(c % 4 === 0 ? { comment: 'đồng ý' } : {}) }));
      add(2, () => ({ type: 'RejectStep', actor: asUser(holder), stepId, reason: 'chưa đạt' }));
    }
    if (step.state === 'ready') {
      add(3, () => ({ type: 'AcceptStep', actor: asUser(holder), stepId }));
      add(1, () => ({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId, reason: 'không cần' }));
      add(1, () => ({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId, toUserId: other, reason: 'giao lại' }));
    }
    add(1, () => ({ type: 'Reassign', actor: asUser(U.ADMIN), stepId, toUserId: other, reason: 'đổi người' }));
    extend();
    add(1, (_c, now) => ({ type: 'RequestExtension', actor: asUser(holder), stepId, requestId: deterministicId(`req:${c}`), proposedDueAt: days(2, now), reason: 'xin thêm' }));
    add(1, () => ({ type: 'DeclineExtension', actor: asUser(U.ADMIN), stepId, requestId: deterministicId(`req:${c}`) }));
    add(1, () => ({ type: 'ReportBlocked', actor: asUser(holder), stepId, reasonCode: 'waiting_on_other', ...(c % 2 === 0 ? { note: 'chờ' } : {}) }));
    add(1, () => ({ type: 'NudgeSent', actor: c % 2 === 0 ? SYSTEM : asUser(U.ADMIN), stepId, nudgeId: deterministicId(`nudge:${c}`), fromUserId: U.ADMIN, toUserId: holder, message: 'Nhắc việc', aiDrafted: c % 4 === 0 }));
    add(1, () => ({ type: 'UnassignStep', actor: SYSTEM, stepId, reason: 'user_disabled' }));
    add(1, () => ({ type: 'UnassignStep', actor: SYSTEM, stepId, reason: 'user_disabled', userId: holder }));
  }
  addCommon();
  return list;
}

function overridesFor(def: ProcessDefinition, c: number): Record<string, string> {
  const work = def.nodes.filter((n) => n.type === 'task' || n.type === 'approval');
  const node = work[c % Math.max(work.length, 1)];
  return node ? { [node.id]: [...ACTIVE_POOL, U.DISABLED][c % (ACTIVE_POOL.length + 1)] as string } : {};
}

export function newRun(s: Scenario): RunState {
  return createRun(s.def, { id: RUN, orgId: ORG, templateId: TEMPLATE, templateVersionId: TEMPLATE_VERSION, title: 'Lượt chạy thử', initiatorId: s.initiatorId, inputs: s.inputs });
}

/**
 * Chạy một kịch bản: mỗi số trong `choices` chọn một thao tác hợp lệ ở trạng thái lúc đó rồi áp bằng `advance()`.
 * Timer được mô phỏng như ở tầng lưu trữ: áp effect theo thứ tự, `dedupeKey` trùng là lỗi.
 * Lượt chạy truyền vào `advance()` luôn bị đóng băng sâu: engine sửa đầu vào tại chỗ là hỏng ngay.
 * `visit` được gọi sau mỗi sự kiện để test kiểm bất biến.
 */
export function drive(s: Scenario, visit?: (step: TraceStep) => void): Trace {
  const initial = deepFreeze(newRun(s));
  deepFreeze(s.def);
  deepFreeze(s.ctx);
  let run = initial;
  let clock = s.startAt.getTime();
  const timers = new Map<string, ScheduleTimerEffect>();
  const keys = new Set<string>();
  const records: RunEventRecord[] = [];
  const steps: TraceStep[] = [];

  // sự kiện đầu luôn là StartRun; sau đó mỗi lựa chọn một sự kiện
  const picks = [0, ...s.choices];
  let afterEnd = 0;
  picks.forEach((c, index) => {
    // lượt chạy đã kết thúc: thử thêm vài sự kiện (ghi chú, timer bắn muộn) rồi dừng
    if ((run.state === 'completed' || run.state === 'cancelled') && ++afterEnd > 2) return;
    const list = candidates(run, s.def, timers, c);
    if (list.length === 0) return;
    const total = list.reduce((sum, x) => sum + x.weight, 0);
    let r = c % total;
    const chosen = list.find((x) => (r -= x.weight) < 0) ?? (list[0] as Candidate);
    if (index > 0) clock += ((c >>> 3) % 2000) * 60_000;
    const now = chosen.at ? chosen.at(new Date(clock)) : new Date(clock);
    clock = now.getTime();
    const event = EngineEventSchema.parse({ ...chosen.make(c, now), eventId: deterministicId(`prop-event:${index}`), at: now.toISOString() });

    const before = run;
    let out: AdvanceOutput;
    try {
      out = advance({ def: s.def, run, event, ctx: s.ctx, now });
    } catch (cause) {
      throw new Error(`advance() ném lỗi ở sự kiện hợp lệ #${index} ${event.type}: ${String(cause)}\n${explain(steps)}`, { cause });
    }
    run = deepFreeze(out.run);
    records.push(...out.events);
    for (const effect of out.effects) {
      if (keys.has(effect.dedupeKey)) throw new Error(`dedupeKey trùng: ${effect.dedupeKey}`);
      keys.add(effect.dedupeKey);
      if (effect.kind === 'schedule_timer') timers.set(effect.dedupeKey, effect);
      else if (effect.kind === 'cancel_timers') {
        for (const [key, t] of timers) if (effect.stepId === null || t.stepId === effect.stepId) timers.delete(key);
      }
    }
    if (event.type === 'TimerFired') timers.delete(event.timerKey);
    const step: TraceStep = { index, event, now, before, out, timers: new Map(timers) };
    steps.push(step);
    try {
      visit?.(step);
    } catch (cause) {
      // In chuỗi sự kiện dẫn tới lỗi, đủ để chép thành một test ví dụ cố định (SPEC 13.4).
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\n${explain(steps)}`, { cause });
    }
  });
  return { scenario: s, initial, final: run, records, steps, timers };
}

/** Chuỗi sự kiện đã áp, dạng gọn: thứ tự, giờ, loại sự kiện, nút, người thao tác. */
export function explain(steps: readonly TraceStep[]): string {
  const lines = steps.map((t) => {
    const e = t.event;
    const stepId = 'stepId' in e ? e.stepId : null;
    const nodeId = stepId ? (t.out.run.steps.find((x) => x.id === stepId)?.nodeId ?? '?') : '-';
    return `  #${t.index} ${t.now.toISOString()} ${e.type} nút=${nodeId} người=${e.actor.userId ?? e.actor.type}`;
  });
  return `Chuỗi sự kiện:\n${lines.join('\n')}`;
}

export { latestSteps };
