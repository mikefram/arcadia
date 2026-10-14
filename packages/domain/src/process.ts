import { z } from 'zod';
import { IdSchema, RoleSchema, TimeOfDaySchema } from './enums';

/**
 * Định nghĩa quy trình (SPEC 4.2): hợp đồng chung giữa trình thiết kế, engine và AI.
 * `ProcessDefinitionSchema` là bản chặt dùng khi xuất bản; `DraftDefinitionSchema` là bản lỏng
 * cho nháp còn dở (nháp còn lỗi vẫn lưu được, SPEC 10.4).
 */

export const DurationSchema = z.object({
  value: z.number().int(),
  unit: z.enum(['working_day', 'calendar_day', 'hour']),
});
export type Duration = z.infer<typeof DurationSchema>;

export const DueRuleSchema = z.object({
  anchor: z.enum(['activation', 'run_start', 'run_target']),
  /** value âm được khi anchor = run_target */
  offset: DurationSchema,
  /** 'end_of_workday' (mặc định) hoặc 'HH:mm' */
  atTime: z.union([z.literal('end_of_workday'), TimeOfDaySchema]).optional(),
});
export type DueRule = z.infer<typeof DueRuleSchema>;

export const AssigneeRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: IdSchema }),
  z.object({ kind: z.literal('role'), role: RoleSchema, unitId: IdSchema.optional() }),
  /** thiếu unitId = đơn vị của người khởi chạy */
  z.object({ kind: z.literal('unit_head'), unitId: IdSchema.optional() }),
  z.object({ kind: z.literal('initiator') }),
  z.object({ kind: z.literal('initiator_manager'), level: z.number().int().min(1).max(5).optional() }),
  /** người được chọn trong biểu mẫu khởi chạy */
  z.object({ kind: z.literal('form_field'), field: z.string().min(1) }),
  /**
   * người (hoặc những người) được chọn ở ô `field` của biểu mẫu kết quả của bước `node` đứng trước: ví dụ Giám đốc chọn
   * người chủ trì và các đơn vị phối hợp ở bước tiếp nhận chỉ thị, các bước sau giao việc cho đúng những người đó
   * (docs/DECISIONS.md, 06/10/2026). Ô kiểu `user` cho một người, kiểu `users` cho nhiều người.
   */
  z.object({ kind: z.literal('step_field'), node: z.string().min(1), field: z.string().min(1) }),
]);
export type AssigneeRule = z.infer<typeof AssigneeRuleSchema>;

export const ReminderStepSchema = z.object({
  at: z.object({
    anchor: z.enum(['assigned', 'due']),
    /** offset âm = trước hạn */
    offset: DurationSchema,
    /** giờ trong ngày, ví dụ '08:30'; bỏ trống thì giữ giờ của mốc */
    atTime: TimeOfDaySchema.optional(),
  }),
  to: z.enum(['assignee', 'assigner', 'assignee_manager', 'office_admin']),
  kind: z.enum(['reminder', 'overdue', 'escalation']),
});
export type ReminderStep = z.infer<typeof ReminderStepSchema>;

export const ReminderPolicySchema = z.object({
  preset: z.enum(['standard', 'strict', 'none']),
  overrides: z.array(ReminderStepSchema).optional(),
});
export type ReminderPolicy = z.infer<typeof ReminderPolicySchema>;

/**
 * Loại ô của biểu mẫu (khởi chạy và kết quả). Thêm theo docs/DECISIONS.md, 06/10/2026 để phục vụ văn thư và chỉ thị:
 * `longtext` nhiều dòng; `users` chọn nhiều người; `file` là danh sách id tệp đã tải lên; `autonumber` là số văn bản do
 * máy chủ cấp từ một sổ (`register`) lúc gửi, người dùng không nhập.
 */
export const FORM_FIELD_TYPES = ['text', 'longtext', 'date', 'number', 'money', 'select', 'user', 'users', 'file', 'autonumber'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Giới hạn cỡ giá trị của ô, để một yêu cầu không mang cả cuốn sách vào CSDL. */
export const FORM_LIMITS = { text: 500, longtext: 50_000, users: 50, files: 20 } as const;

export const FormFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1),
  required: z.boolean().optional(),
  /** money = số nguyên đồng VND */
  type: z.enum(FORM_FIELD_TYPES),
  /** chỉ cho select */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** `file`: cho đính nhiều tệp; `users`: luôn nhiều người */
  multiple: z.boolean().optional(),
  /** `autonumber`: mã sổ văn bản cấp số (ví dụ VBDEN, VBDI) */
  register: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/).optional(),
  /** dòng chú thích nhỏ dưới ô */
  hint: z.string().max(300).optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const OperandSchema = z.union([
  /** 'inputs.<key>' hoặc 'steps.<nodeId>.result.<key>' */
  z.object({ ref: z.string().min(1) }),
  z.object({ value: z.union([z.string(), z.number(), z.boolean()]) }),
]);
export type Operand = z.infer<typeof OperandSchema>;

export type Expr =
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; left: Operand; right: Operand };

/** Cây JSON an toàn. Tuyệt đối không eval (SPEC 4.2). */
export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['and', 'or']), args: z.array(ExprSchema).min(1) }),
    z.object({ op: z.literal('not'), arg: ExprSchema }),
    z.object({ op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']), left: OperandSchema, right: OperandSchema }),
  ]),
);

/**
 * Cách dựng tệp tổng hợp (văn bản đi, báo cáo). Mỗi mục lấy dữ liệu từ `ref`:
 * `inputs.<ô>` (biểu mẫu khởi chạy), `steps.<bước>.<ô>` (kết quả của một việc), `responses.<bước>.<ô>` (phần của từng người
 * trong bước đóng góp, mỗi người một đoạn kèm tên). Mục không có `ref` chỉ in `text`.
 */
export const DocSectionSchema = z.object({
  heading: z.string().max(200),
  ref: z.string().max(200).optional(),
  text: z.string().max(5000).optional(),
});
export const DocSpecSchema = z.object({
  /** 'official': khổ công văn (quốc hiệu, số ký hiệu, trích yếu, nơi nhận); 'report': báo cáo tổng hợp */
  layout: z.enum(['official', 'report']),
  /** tiêu đề tệp, có thể chứa {tên ô} của biểu mẫu khởi chạy */
  title: z.string().min(1).max(300),
  sections: z.array(DocSectionSchema).max(30),
  /** in danh mục tệp đính kèm của lượt chạy ở cuối */
  includeAttachments: z.boolean().optional(),
  /** bắt buộc xuất tệp trước khi báo xong */
  required: z.boolean().optional(),
});
export type DocSection = z.infer<typeof DocSectionSchema>;
export type DocSpec = z.infer<typeof DocSpecSchema>;

const nodeBase = {
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  label: z.string().min(1),
  /** mặc định 'all' */
  join: z.enum(['all', 'any']).optional(),
};

export const StartNodeSchema = z.object({ ...nodeBase, type: z.literal('start') });
export const EndNodeSchema = z.object({ ...nodeBase, type: z.literal('end') });
export const TaskNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('task'),
  title: z.string().min(1),
  description: z.string().optional(),
  assignee: AssigneeRuleSchema,
  due: DueRuleSchema,
  checklist: z.array(z.string().min(1)).optional(),
  form: z.array(FormFieldSchema).optional(),
  reminders: ReminderPolicySchema.optional(),
  escalateTo: AssigneeRuleSchema.optional(),
  /** việc tổng hợp: cho người làm xuất một tệp Word từ dữ liệu của lượt chạy (văn bản đi, báo cáo tổng hợp) */
  compile: DocSpecSchema.optional(),
});
export const ApprovalNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('approval'),
  title: z.string().min(1),
  description: z.string().optional(),
  approvers: z.array(AssigneeRuleSchema).min(1),
  mode: z.enum(['any', 'all']),
  due: DueRuleSchema,
  reminders: ReminderPolicySchema.optional(),
  /**
   * 'approve' (mặc định): mỗi người Đồng ý hoặc Chưa đồng ý. 'contribute': nhiều người cùng đóng góp, mỗi người gửi phần của
   * mình (nội dung, ý kiến, tệp) và không có "Chưa đồng ý"; dùng để lấy ý kiến các phòng ban hoặc thu nội dung cho văn bản đi.
   */
  action: z.enum(['approve', 'contribute']).optional(),
  /** biểu mẫu mỗi người điền khi gửi (ý kiến chỉ đạo, nội dung phần mình, tệp); kết quả gom ở `result.responses` */
  form: z.array(FormFieldSchema).optional(),
  /**
   * Nút duyệt cuối (ví dụ Chủ tịch duyệt văn bản đi): sau nút này không được còn nút duyệt nào khác trên đường đi tiến
   * (đường "Chưa đồng ý" quay lại thì được). `validate()` chặn xuất bản khi vi phạm.
   */
  finalApproval: z.boolean().optional(),
});
export const ConditionNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('condition'),
  /** cạnh 'else' bắt buộc */
  branches: z.array(z.object({ id: z.string().min(1), label: z.string().optional(), when: ExprSchema })),
});
export const TimerNodeSchema = z.object({ ...nodeBase, type: z.literal('timer'), wait: DurationSchema });
export const NotifyNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('notify'),
  to: z.array(AssigneeRuleSchema).min(1),
  template: z.string().min(1),
});
/** giai đoạn 4 */
export const WebhookNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('webhook'),
  url: z.url(),
  bodyTemplate: z.string(),
});

export const NodeSchema = z.discriminatedUnion('type', [
  StartNodeSchema,
  EndNodeSchema,
  TaskNodeSchema,
  ApprovalNodeSchema,
  ConditionNodeSchema,
  TimerNodeSchema,
  NotifyNodeSchema,
  WebhookNodeSchema,
]);
export type StartNode = z.infer<typeof StartNodeSchema>;
export type EndNode = z.infer<typeof EndNodeSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type ApprovalNode = z.infer<typeof ApprovalNodeSchema>;
export type ConditionNode = z.infer<typeof ConditionNodeSchema>;
export type TimerNode = z.infer<typeof TimerNodeSchema>;
export type NotifyNode = z.infer<typeof NotifyNodeSchema>;
export type WebhookNode = z.infer<typeof WebhookNodeSchema>;
export type ProcessNode = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** cạnh ra khỏi approval */
  outcome: z.enum(['approved', 'rejected']).optional(),
  /** cạnh ra khỏi condition: id nhánh hoặc 'else' */
  branch: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

const LayoutSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));

/**
 * Ai được khởi chạy quy trình này (docs/DECISIONS.md, 06/10/2026). Bỏ trống = những người có quyền `run.start` (cách cũ).
 * Có khai báo thì chỉ những người khớp một dòng mới khởi chạy được: Chỉ thị chỉ Chủ tịch, Văn bản đến chỉ Văn thư,
 * Văn bản đi mọi cán bộ.
 */
export const StarterRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everyone') }),
  /** người có quyền `run.start` */
  z.object({ kind: z.literal('permission') }),
  z.object({ kind: z.literal('role'), role: RoleSchema }),
  /** mọi thành viên của đơn vị */
  z.object({ kind: z.literal('unit'), unitId: IdSchema }),
  z.object({ kind: z.literal('user'), userId: IdSchema }),
]);
export type StarterRule = z.infer<typeof StarterRuleSchema>;

export const ProcessDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  /** biểu mẫu khi khởi chạy */
  inputs: z.array(FormFieldSchema),
  /** ai được khởi chạy; bỏ trống = người có quyền `run.start` */
  starters: z.array(StarterRuleSchema).max(20).optional(),
  /** khoá của input kiểu date dùng làm run_target */
  targetField: z.string().optional(),
  /** toạ độ nút trên trình thiết kế; engine bỏ qua (SPEC 9.3) */
  layout: LayoutSchema.optional(),
  /** lịch làm việc; mặc định lịch của tổ chức */
  calendarId: z.string().optional(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});
export type ProcessDefinition = z.infer<typeof ProcessDefinitionSchema>;

/**
 * Nháp: giữ được nút còn thiếu trường (chưa chọn người nhận, chưa đặt hạn).
 * `validate()` của engine là nơi báo lỗi từng nút cho người vẽ.
 */
export const DraftNodeSchema = z.looseObject({
  id: z.string().min(1),
  type: z.enum(['start', 'end', 'task', 'approval', 'condition', 'timer', 'notify', 'webhook']),
  label: z.string(),
});
export type DraftNode = z.infer<typeof DraftNodeSchema> & Partial<{
  join: 'all' | 'any';
  title: string;
  description: string;
  assignee: AssigneeRule;
  due: DueRule;
  checklist: string[];
  form: FormField[];
  reminders: ReminderPolicy;
  escalateTo: AssigneeRule;
  approvers: AssigneeRule[];
  mode: 'any' | 'all';
  action: 'approve' | 'contribute';
  compile: DocSpec;
  branches: { id: string; label?: string; when: Expr }[];
  wait: Duration;
  to: AssigneeRule[];
  template: string;
  url: string;
  bodyTemplate: string;
}>;

export const DraftDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  inputs: z.array(z.looseObject({ key: z.string(), label: z.string(), type: z.string() })).default([]),
  starters: z.array(z.looseObject({ kind: z.string() })).optional(),
  targetField: z.string().optional(),
  layout: LayoutSchema.optional(),
  calendarId: z.string().optional(),
  nodes: z.array(DraftNodeSchema),
  edges: z.array(EdgeSchema),
});
export type DraftDefinition = Omit<z.infer<typeof DraftDefinitionSchema>, 'nodes' | 'inputs' | 'starters'> & {
  nodes: DraftNode[];
  inputs: FormField[];
  starters?: StarterRule[];
};

/** Một lỗi hoặc cảnh báo của validate() / simulate(), có câu tiếng Việt cho người vẽ. */
export const DefinitionIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});
export type DefinitionIssue = z.infer<typeof DefinitionIssueSchema>;

/** Mã lỗi của validate(), theo bảy điều ở SPEC 4.2. */
export const VALIDATION_CODES = {
  schema: 'schema_invalid',
  startCount: 'start_count', // 1
  endMissing: 'end_missing', // 1
  unreachable: 'node_unreachable', // 2
  /** nút chỉ tới được qua cạnh "Chưa đồng ý" quay lại, không có đường tiến từ Bắt đầu */
  onlyViaReturn: 'node_only_via_return', // 2
  deadEnd: 'node_dead_end', // 2
  cycle: 'cycle_not_allowed', // 3
  conditionElse: 'condition_else_missing', // 4
  approvalApproved: 'approval_approved_missing', // 4
  assigneeMissing: 'assignee_missing', // 5
  dueMissing: 'due_missing', // 5
  joinAny: 'join_any_needs_two', // 6
  edgeUnknownNode: 'edge_unknown_node',
  duplicateId: 'duplicate_id',
  targetFieldInvalid: 'target_field_invalid',
  formFieldUnknown: 'form_field_unknown',
  /** quy tắc `step_field` trỏ tới bước không đứng trước, hoặc ô không phải kiểu chọn người */
  stepFieldInvalid: 'step_field_invalid',
  /** ô `autonumber` thiếu mã sổ, hoặc `compile` trỏ tới dữ liệu không có */
  formFieldInvalid: 'form_field_invalid',
  compileInvalid: 'compile_invalid',
  startersInvalid: 'starters_invalid',
  /** sau nút duyệt cuối (`finalApproval`) còn một nút duyệt khác trên đường đi tiến */
  finalApprovalNotLast: 'final_approval_not_last',
  // 7: chỉ cảnh báo
  dueBeforePredecessor: 'due_before_predecessor',
  dueInPast: 'due_in_past',
} as const;

/** Bảng dự kiến "ai làm gì, hạn nào" do simulate() trả về. */
export const SimulationRowSchema = z.object({
  nodeId: z.string(),
  kind: z.enum(['task', 'approval']),
  title: z.string(),
  assigneeId: IdSchema.nullable(),
  onBehalfOfId: IdSchema.nullable(),
  dueAt: z.string().nullable(),
  /** hạn đã qua so với `now`: phải báo trước, không tự dịch hạn (SPEC 4.5) */
  pastDue: z.boolean(),
  order: z.number().int(),
  /** việc duyệt kiểu góp nội dung (nhiều người, mỗi người gửi phần của mình); các việc khác bỏ trống */
  action: z.literal('contribute').optional(),
  /** người nhận do một bước đứng trước chọn lúc chạy (quy tắc `step_field`), nên chưa biết lúc chạy thử */
  assigneeChosenLater: z.boolean().optional(),
});
export type SimulationRow = z.infer<typeof SimulationRowSchema>;
