import { z } from 'zod';
import {
  BlockReasonCodeSchema,
  IdSchema,
  InstantSchema,
  type DelegationScope,
  type HolidayKind,
  type NodeKind,
  type Role,
  type RunOutcome,
  type RunStateName,
  type StepStateName,
  type UserStatus,
} from './enums';
import type { Action } from './permissions';
import type { DefinitionIssue, DraftDefinition, ProcessDefinition, ReminderStep, SimulationRow } from './process';

/**
 * Kiểu dữ liệu của engine quy trình (SPEC 4.3, 4.4). Engine là hàm thuần:
 * mọi đầu vào (đồng hồ, danh bạ, lịch) được truyền vào; đầu ra là trạng thái mới,
 * danh sách effect và sự kiện để ghi. Mọi thời điểm trong trạng thái là chuỗi ISO 8601 UTC
 * để so sánh được từng bit khi phát lại.
 */

// ───────────────────────── Lịch làm việc (SPEC 4.5) ─────────────────────────

export type WorkCalendar = {
  /** Lệch UTC theo phút. Việt Nam: 420, không đổi giờ mùa. */
  utcOffsetMinutes: number;
  /** Ngày làm việc theo ISO: 1 = Thứ Hai … 7 = Chủ Nhật. Mặc định [1,2,3,4,5]. */
  workdays: number[];
  /** 'HH:mm', mặc định '08:00' và '17:00'. */
  workStart: string;
  workEnd: string;
  /** Ngày nghỉ do Văn phòng nhập. `makeup_workday` là ngày làm bù (cuối tuần nhưng vẫn làm). */
  holidays: { day: string; kind: HolidayKind }[];
};

export const DEFAULT_CALENDAR: WorkCalendar = {
  utcOffsetMinutes: 420,
  workdays: [1, 2, 3, 4, 5],
  workStart: '08:00',
  workEnd: '17:00',
  holidays: [],
};

// ───────────────────────── Danh bạ và ngữ cảnh ─────────────────────────

export type DirectoryUser = {
  id: string;
  unitId: string | null;
  managerId: string | null;
  status: UserStatus;
  roles: { role: Role; unitId: string | null }[];
  /**
   * Quyền hiệu lực của người này (đã tính chỉnh của tổ chức và chỉnh riêng; docs/DECISIONS.md, 05/10/2026). Vắng mặt thì engine
   * dùng bảng mặc định theo vai trò, để test và phát lại cũ vẫn chạy.
   */
  permissions?: readonly Action[];
};

export type DirectoryUnit = { id: string; parentId: string | null; headUserId: string | null };

export type DelegationRecord = {
  fromUserId: string;
  toUserId: string;
  validFrom: string;
  validTo: string;
  scope: DelegationScope;
  /** id mẫu quy trình khi scope = 'process', tên vai trò khi scope = 'role' */
  scopeRef: string | null;
};

/** Dữ liệu thuần để engine xác định người nhận, ủy quyền và hạn (SPEC 4.4). */
export type ResolveContext = {
  users: DirectoryUser[];
  units: DirectoryUnit[];
  delegations: DelegationRecord[];
  calendar: WorkCalendar;
  /** Bộ nhắc của tổ chức; thiếu thì dùng bộ `standard` mặc định (SPEC 4.6). */
  reminderPresets?: Partial<Record<'standard' | 'strict', ReminderStep[]>>;
  /** Bộ nhắc mặc định của tổ chức khi nút không khai báo. */
  defaultReminderPreset?: 'standard' | 'strict' | 'none';
  /** Bật thì AcceptStep phát `notify.accepted` cho người giao (SPEC 4.3 "tùy cấu hình"). Mặc định tắt. */
  notifyOnAccept?: boolean;
};

// ───────────────────────── Trạng thái ─────────────────────────

export type ApprovalRecord = {
  approverId: string;
  /** người gốc khi việc duyệt được ủy quyền */
  onBehalfOfId: string | null;
  decision: 'approved' | 'rejected' | null;
  reason: string | null;
  decidedAt: string | null;
  /** phần người này gửi khi nút có biểu mẫu (ý kiến chỉ đạo, nội dung đóng góp); null khi chưa gửi hoặc nút không có biểu mẫu */
  result: Record<string, unknown> | null;
  /** id các tệp người này đính kèm khi gửi */
  fileIds: string[];
};

export type StepState = {
  /** UUID v5 dẫn xuất: stepRunId(runId, nodeId, attempt) */
  id: string;
  nodeId: string;
  attempt: number;
  kind: NodeKind;
  title: string;
  description: string | null;
  state: StepStateName;
  assigneeId: string | null;
  onBehalfOfId: string | null;
  assignedBy: string | null;
  dueAt: string | null;
  dueOriginalAt: string | null;
  activatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown> | null;
  reason: string | null;
  blockedReason: string | null;
  /** Người duyệt của nút approval (một dòng mỗi người). Rỗng với nút khác. */
  approvals: ApprovalRecord[];
  /** Ngày (giờ Việt Nam) của lần nhắc tự động gần nhất: tối đa một nhắc mỗi ngày làm việc (SPEC 4.6). */
  lastReminderOn: string | null;
  /** Lần đi thúc gần nhất: nhắc tự động bị bỏ qua trong 4 giờ sau đó (SPEC 4.6). */
  lastNudgedAt: string | null;
};

export type RunState = {
  id: string;
  orgId: string;
  templateId: string;
  templateVersionId: string;
  title: string;
  initiatorId: string;
  state: RunStateName;
  outcome: RunOutcome | null;
  inputs: Record<string, unknown>;
  targetAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** tăng mỗi lần advance() đổi trạng thái */
  version: number;
  /** số sự kiện đã áp; sự kiện kế tiếp có seq = seq + 1 */
  seq: number;
  /** eventId đã áp, để chống lặp (SPEC 4.4 bước 1) */
  appliedEventIds: string[];
  steps: StepState[];
};

// ───────────────────────── Sự kiện (SPEC 4.3) ─────────────────────────

export const ActorSchema = z.object({
  type: z.enum(['user', 'system', 'ai']),
  /** người thao tác; với 'ai' là người đã xác nhận đề xuất */
  userId: IdSchema.optional(),
  proposalId: IdSchema.optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

const eventBase = { eventId: IdSchema, at: InstantSchema, actor: ActorSchema };
const resultSchema = z.record(z.string(), z.unknown());

export const TimerDataSchema = z.object({
  /** 'reminder' | 'overdue' | 'escalation' dùng cho nhắc việc; 'wait' cho nút timer */
  to: z.enum(['assignee', 'assigner', 'assignee_manager', 'office_admin']).optional(),
  /** thứ tự mốc trong bộ nhắc */
  index: z.number().int().optional(),
  /** số ngày làm việc so với hạn (âm = trước hạn) */
  offsetWorkingDays: z.number().int().optional(),
  /**
   * Các mốc nhắc trùng thời điểm của một việc được gom vào MỘT timer (ví dụ người nhận và người giao
   * cùng nhận tin quá hạn lúc +1 ngày): mỗi phần tử là một đối tượng nhận kèm loại tin của nó.
   * Thiếu trường này thì engine dùng `to` và `kind` của sự kiện TimerFired.
   */
  recipients: z
    .array(
      z.object({
        to: z.enum(['assignee', 'assigner', 'assignee_manager', 'office_admin']),
        kind: z.enum(['reminder', 'overdue', 'escalation']),
        /** cấp leo thang: 1 = mốc leo thang đầu tiên của bộ nhắc, 2 = mốc kế tiếp… */
        level: z.number().int().optional(),
      }),
    )
    .optional(),
});
export type TimerData = z.infer<typeof TimerDataSchema>;

export const EngineEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('StartRun'), assigneeOverrides: z.record(z.string(), IdSchema).optional() }),
  z.object({ ...eventBase, type: z.literal('AssignStep'), stepId: IdSchema, toUserId: IdSchema, reason: z.string().optional() }),
  z.object({
    ...eventBase,
    type: z.literal('UnassignStep'),
    stepId: IdSchema,
    reason: z.string(),
    /**
     * Người bị gỡ khỏi việc (do vô hiệu hoá người dùng). Có thì engine chỉ gỡ người này khỏi danh sách duyệt hoặc đóng góp và giữ
     * những người còn lại; thiếu thì gỡ cả bước như trước (sự kiện cũ đã ghi trong lịch sử phải phát lại y nguyên).
     */
    userId: IdSchema.optional(),
  }),
  z.object({ ...eventBase, type: z.literal('AcceptStep'), stepId: IdSchema }),
  z.object({
    ...eventBase,
    type: z.literal('CompleteStep'),
    stepId: IdSchema,
    note: z.string().optional(),
    result: resultSchema.optional(),
    fileIds: z.array(IdSchema).optional(),
    nudgeId: IdSchema.optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('ApproveStep'),
    stepId: IdSchema,
    comment: z.string().optional(),
    /** biểu mẫu của nút duyệt hoặc nút đóng góp */
    result: resultSchema.optional(),
    fileIds: z.array(IdSchema).optional(),
  }),
  z.object({ ...eventBase, type: z.literal('RejectStep'), stepId: IdSchema, reason: z.string().min(1) }),
  z.object({
    ...eventBase,
    type: z.literal('RequestExtension'),
    stepId: IdSchema,
    requestId: IdSchema,
    proposedDueAt: InstantSchema,
    reason: z.string().min(1),
    nudgeId: IdSchema.optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('DeclineExtension'),
    stepId: IdSchema,
    requestId: IdSchema,
    comment: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('ExtendDue'),
    stepId: IdSchema,
    newDueAt: InstantSchema,
    reason: z.string().min(1),
    /** có khi gia hạn là kết quả duyệt một yêu cầu của người nhận */
    extensionRequestId: IdSchema.optional(),
  }),
  z.object({ ...eventBase, type: z.literal('Reassign'), stepId: IdSchema, toUserId: IdSchema, reason: z.string().min(1) }),
  z.object({ ...eventBase, type: z.literal('SkipStep'), stepId: IdSchema, reason: z.string().min(1) }),
  z.object({ ...eventBase, type: z.literal('CancelRun'), reason: z.string().min(1) }),
  z.object({
    ...eventBase,
    type: z.literal('TimerFired'),
    /** dedupe_key của dòng timers */
    timerKey: z.string(),
    stepId: IdSchema.nullable(),
    kind: z.enum(['reminder', 'overdue', 'escalation', 'wait']),
    data: TimerDataSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('NudgeSent'),
    stepId: IdSchema,
    nudgeId: IdSchema,
    fromUserId: IdSchema,
    toUserId: IdSchema,
    message: z.string().min(1),
    /** true khi lời nhắc do Trợ lý AI soạn: người nhận thấy dòng "do Trợ lý AI soạn" */
    aiDrafted: z.boolean(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('ReportBlocked'),
    stepId: IdSchema,
    reasonCode: BlockReasonCodeSchema,
    note: z.string().optional(),
    nudgeId: IdSchema.optional(),
  }),
  z.object({ ...eventBase, type: z.literal('AddNote'), text: z.string().min(1) }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;
export type EngineEventType = EngineEvent['type'];
export type EngineEventOf<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;

// ───────────────────────── Effect và dấu vết ─────────────────────────

export const NOTIFY_KINDS = [
  'notify.assigned',
  'notify.reassigned',
  'notify.accepted',
  'notify.completed',
  'notify.rejected',
  'notify.extension_requested',
  'notify.extension_declined',
  'notify.due_changed',
  'notify.run_cancelled',
  'notify.run_completed',
  'notify.reminder',
  'notify.overdue',
  'notify.escalation',
  'notify.nudge',
  'notify.blocked',
  'notify.custom',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifyEffect = {
  kind: NotifyKind;
  /** run:step:kind:seq:người nhận. Ràng buộc UNIQUE ở bảng effects chống gửi trùng. */
  dedupeKey: string;
  /** người nhận đã xác định (engine tự áp quy tắc "người giao là điều hành thì gửi Văn phòng") */
  toUserId: string;
  runId: string;
  stepId: string | null;
  /** dữ liệu để worker dựng câu chữ từ mẫu: không chứa câu chữ dựng sẵn, trừ lời đi thúc */
  data: Record<string, unknown>;
};

export type ScheduleTimerEffect = {
  kind: 'schedule_timer';
  dedupeKey: string;
  runId: string;
  stepId: string | null;
  timerKind: 'reminder' | 'overdue' | 'escalation' | 'wait';
  fireAt: string;
  data: TimerData;
};

export type CancelTimersEffect = {
  kind: 'cancel_timers';
  dedupeKey: string;
  runId: string;
  /** null = mọi timer của lượt chạy */
  stepId: string | null;
};

export type WebhookEffect = {
  kind: 'webhook';
  dedupeKey: string;
  runId: string;
  stepId: string | null;
  url: string;
  body: string;
};

export type Effect = NotifyEffect | ScheduleTimerEffect | CancelTimersEffect | WebhookEffect;

/** Thay đổi dẫn xuất của một lần advance(): dùng để vẽ dòng thời gian và để tầng lưu trữ ghi các bảng phụ. */
export type RunChange =
  | { type: 'run.started' }
  | { type: 'run.completed'; outcome: RunOutcome }
  | { type: 'run.cancelled'; reason: string }
  | { type: 'step.activated'; stepId: string; nodeId: string; state: StepStateName; assigneeId: string | null; onBehalfOfId: string | null; dueAt: string | null }
  | { type: 'step.state'; stepId: string; nodeId: string; from: StepStateName; to: StepStateName }
  | { type: 'step.assignee'; stepId: string; from: string | null; to: string | null; onBehalfOfId: string | null }
  | { type: 'step.due'; stepId: string; from: string | null; to: string }
  | { type: 'step.blocked'; stepId: string; reasonCode: string; note: string | null }
  | { type: 'extension.requested'; stepId: string; requestId: string; requestedBy: string; proposedDueAt: string; reason: string }
  | { type: 'extension.decided'; stepId: string; requestId: string; decision: 'approved' | 'declined'; decidedBy: string | null }
  | { type: 'approval.decided'; stepId: string; approverId: string; decision: 'approved' | 'rejected' }
  | { type: 'nudge.sent'; stepId: string; nudgeId: string; fromUserId: string; toUserId: string; message: string; aiDrafted: boolean }
  | { type: 'nudge.replied'; stepId: string; nudgeId: string; reply: 'done' | 'need_time' | 'blocked' }
  | { type: 'reminder.sent'; stepId: string; timerKind: string; toUserIds: string[] }
  | { type: 'reminder.suppressed'; stepId: string; why: 'not_open' | 'already_reminded_today' | 'recently_nudged' | 'no_recipient' }
  | { type: 'note'; text: string };

/** Một dòng run_events: đúng một dòng cho mỗi lần advance() có hiệu lực. id chính là eventId. */
export type RunEventRecord = {
  id: string;
  runId: string;
  seq: number;
  type: EngineEventType;
  actorType: 'user' | 'system' | 'ai';
  actorId: string | null;
  proposalId: string | null;
  payload: { event: EngineEvent; changes: RunChange[] };
  at: string;
};

// ───────────────────────── Chữ ký hàm của engine ─────────────────────────

export type AdvanceInput = {
  def: ProcessDefinition;
  /** run cùng mọi step_run, đã tải trong giao dịch */
  run: RunState;
  event: EngineEvent;
  ctx: ResolveContext;
  now: Date;
};

export type AdvanceOutput = {
  run: RunState;
  effects: Effect[];
  /** rỗng khi eventId đã áp trước đó (chống lặp) */
  events: RunEventRecord[];
};

export type EngineErrorCode =
  /** sai trạng thái: việc đã xong, đã đổi người, lượt chạy đã huỷ → API trả 409 state_conflict */
  | 'invalid_transition'
  /** người thao tác không có quyền với sự kiện này → 403 forbidden */
  | 'not_allowed'
  /** không tìm thấy việc trong lượt chạy → 404 */
  | 'not_found'
  /** dữ liệu sự kiện sai (thiếu ô bắt buộc của biểu mẫu kết quả, người nhận không tồn tại) → 422 */
  | 'invalid_input';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: EngineErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

export type ValidateResult = {
  errors: DefinitionIssue[];
  warnings: DefinitionIssue[];
  /** có khi không còn lỗi: bản đã chuẩn hoá để xuất bản */
  definition: ProcessDefinition | null;
};

export type SimulateInput = {
  def: ProcessDefinition;
  inputs: Record<string, unknown>;
  initiatorId: string;
  ctx: ResolveContext;
  now: Date;
  /** nodeId → userId */
  assigneeOverrides?: Record<string, string>;
  /** id mẫu, để áp ủy quyền theo phạm vi 'process' */
  templateId?: string;
};

export type SimulateResult = {
  rows: SimulationRow[];
  warnings: DefinitionIssue[];
  targetAt: string | null;
};

export type NewRunInput = {
  id: string;
  orgId: string;
  templateId: string;
  templateVersionId: string;
  title: string;
  initiatorId: string;
  inputs: Record<string, unknown>;
  /** Lệch UTC (phút) của lịch tổ chức, để đặt `targetAt` vào 00:00 giờ địa phương của ngày mốc đích. Mặc định 420. */
  utcOffsetMinutes?: number;
};

/** Chữ ký công khai của `@mihato/workflow-engine`. */
export type WorkflowEngine = {
  /** Dựng lượt chạy ở trạng thái `draft` với mọi nút `pending`; chưa có sự kiện nào. */
  createRun(def: ProcessDefinition, input: NewRunInput): RunState;
  advance(input: AdvanceInput): AdvanceOutput;
  validate(draft: DraftDefinition | ProcessDefinition, opts?: { now?: Date; calendar?: WorkCalendar }): ValidateResult;
  simulate(input: SimulateInput): SimulateResult;
  /** Áp lại toàn bộ sự kiện từ lượt chạy `draft`: phải cho đúng trạng thái hiện tại, từng bit. */
  replay(input: { def: ProcessDefinition; initial: RunState; events: RunEventRecord[]; ctx: ResolveContext }): RunState;
};
