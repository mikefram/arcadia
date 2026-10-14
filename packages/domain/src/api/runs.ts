import { z } from 'zod';
import {
  BlockReasonCodeSchema,
  IdSchema,
  InstantSchema,
  NodeKindSchema,
  NudgeReplySchema,
  RunOutcomeSchema,
  RunStateSchema,
  StepStateSchema,
} from '../enums';
import { CONFIDENTIALITIES, RUN_SHARE_ROLES } from '../confidentiality';
import { FormFieldSchema } from '../process';
import { PageQuerySchema, PersonRefSchema, QueryBoolSchema } from './common';
import { FileViewSchema } from './files';

/** SPEC 10.5: hợp đồng chung của web và hai app. */

export const STEP_ACTIONS = ['accept', 'complete', 'approve', 'reject', 'requestExtension', 'block', 'reassign', 'extend', 'skip', 'nudge'] as const;
export const StepActionSchema = z.enum(STEP_ACTIONS);
export type StepAction = z.infer<typeof StepActionSchema>;

export const BUCKETS = ['overdue', 'today', 'upcoming', 'done', 'other'] as const;
export const BucketSchema = z.enum(BUCKETS);
export type Bucket = z.infer<typeof BucketSchema>;

export const PendingExtensionSchema = z.object({ id: IdSchema, proposedDueAt: InstantSchema, reason: z.string() });

/** Một người tham gia bước duyệt hoặc đóng góp: đã quyết chưa, ý kiến, phần đã gửi (docs/DECISIONS.md, 06/10/2026). */
export const StepParticipantSchema = z.object({
  person: PersonRefSchema,
  onBehalfOf: PersonRefSchema.nullable(),
  decision: z.enum(['approved', 'rejected']).nullable(),
  comment: z.string().nullable(),
  decidedAt: InstantSchema.nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  fileIds: z.array(IdSchema),
  /** phần của người này có thể đã gửi nhưng người xem không được đọc (bước góp nội dung: chỉ người chủ trì, người duyệt và lãnh đạo thấy hết) */
  contentHidden: z.boolean().optional(),
});
export type StepParticipant = z.infer<typeof StepParticipantSchema>;

/** Việc tổng hợp có cấu hình xuất tệp Word: nút "Xuất tệp" hiện ở chi tiết việc. */
export const StepCompileInfoSchema = z.object({
  layout: z.enum(['official', 'report']),
  title: z.string(),
  required: z.boolean(),
  /** đã có ít nhất một tệp tổng hợp ở việc này */
  hasFile: z.boolean(),
});
export type StepCompileInfo = z.infer<typeof StepCompileInfoSchema>;

export const StepViewSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  runTitle: z.string(),
  /** việc ngoài quy trình (giao riêng): không có quy trình bao quanh, người giao chọn người nhận tự do */
  adhoc: z.boolean(),
  nodeId: z.string(),
  /** view chỉ trả hai loại nút giao cho người */
  kind: z.enum(['task', 'approval']),
  title: z.string(),
  description: z.string().nullable(),
  state: StepStateSchema,
  /** máy chủ tính theo lịch làm việc (SPEC 4.5) */
  bucket: BucketSchema,
  /** dẫn xuất, không lưu (SPEC 4.3) */
  isOverdue: z.boolean(),
  /** 0 nếu chưa trễ */
  lateWorkingDays: z.number().int(),
  dueAt: InstantSchema.nullable(),
  dueOriginalAt: InstantSchema.nullable(),
  assignee: PersonRefSchema.nullable(),
  assignedBy: PersonRefSchema.nullable(),
  onBehalfOf: PersonRefSchema.nullable(),
  blockedReason: z.string().nullable(),
  pendingExtension: PendingExtensionSchema.nullable(),
  /** số tiền cần duyệt (M6 viết hai lần); null nếu không có */
  amountVnd: z.number().int().nullable(),
  /** = amountVnd !== null && amountVnd > 0 */
  requiresStepUp: z.boolean(),
  /** máy chủ tính; app chỉ vẽ nút có trong danh sách, máy chủ vẫn kiểm lại */
  allowedActions: z.array(StepActionSchema),
  /** = process_runs.version */
  version: z.number().int(),
  // Trường bổ sung ngoài bảng ở SPEC 10.5 (client phải bỏ qua trường lạ):
  checklist: z.array(z.string()),
  form: z.array(FormFieldSchema),
  result: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  activatedAt: InstantSchema.nullable(),
  completedAt: InstantSchema.nullable(),
  unitName: z.string().nullable(),
  lastNudgedAt: InstantSchema.nullable(),
  /** việc duyệt: người đề nghị (người làm việc đứng ngay trước); null với việc thường */
  requestedBy: PersonRefSchema.nullable(),
  /** nút duyệt: 'approve' (Đồng ý, Chưa đồng ý) hoặc 'contribute' (mỗi người gửi phần của mình); null với việc thường */
  action: z.enum(['approve', 'contribute']).nullable().optional(),
  /** nút duyệt, đóng góp: từng người và phần của họ. Máy chủ luôn gửi, client cũ bỏ qua. */
  participants: z.array(StepParticipantSchema).optional(),
  /** tệp đính kèm của việc này (khi báo xong, khi gửi phần của mình, tệp tổng hợp) */
  files: z.array(FileViewSchema).optional(),
  compile: StepCompileInfoSchema.nullable().optional(),
  /** số bình luận chưa xoá của việc (docs/DECISIONS.md, 07/10/2026 điểm a); máy chủ luôn gửi */
  commentCount: z.number().int().optional(),
});
export type StepView = z.infer<typeof StepViewSchema>;

export const StepHistoryItemSchema = z.object({
  at: InstantSchema,
  type: z.enum(['event', 'reminder', 'nudge', 'nudge_reply']),
  /** loại sự kiện engine hoặc loại thông báo */
  code: z.string(),
  actor: PersonRefSchema.nullable(),
  actorType: z.enum(['user', 'system', 'ai']),
  /** lời nhắc đã gửi, lý do, ghi chú */
  text: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type StepHistoryItem = z.infer<typeof StepHistoryItemSchema>;

export const NudgeViewSchema = z.object({
  id: IdSchema,
  message: z.string(),
  /** danh tính người gửi hiện cho người nhận, ví dụ "Văn phòng Chủ tịch" */
  senderName: z.string(),
  /** dòng nhỏ "do Trợ lý AI soạn…" hoặc null khi người soạn */
  aiDisclosure: z.string().nullable(),
  sentAt: InstantSchema,
  reply: NudgeReplySchema.nullable(),
  repliedAt: InstantSchema.nullable(),
});
export type NudgeView = z.infer<typeof NudgeViewSchema>;

export const StepDetailSchema = StepViewSchema.extend({
  history: z.array(StepHistoryItemSchema),
  /** lời đi thúc gần nhất chưa trả lời: app hiện ba nút trả lời nhanh */
  openNudge: NudgeViewSchema.nullable(),
  nudges: z.array(NudgeViewSchema),
});
export type StepDetail = z.infer<typeof StepDetailSchema>;

export const RunSummarySchema = z.object({
  id: IdSchema,
  title: z.string(),
  templateId: IdSchema,
  templateName: z.string(),
  templateVersion: z.number().int(),
  /** lượt chạy của một việc ngoài quy trình; `templateName` khi đó là tên việc */
  adhoc: z.boolean(),
  state: RunStateSchema,
  outcome: RunOutcomeSchema.nullable(),
  targetAt: InstantSchema.nullable(),
  startedAt: InstantSchema.nullable(),
  completedAt: InstantSchema.nullable(),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  /** `late` khi có ít nhất một việc quá hạn; lateWorkingDays là số lớn nhất [QUYẾT ĐỊNH] */
  schedule: z.object({ status: z.enum(['on_track', 'late', 'done']), lateWorkingDays: z.number().int() }),
  initiator: PersonRefSchema,
  version: z.number().int(),
  /** `restricted` (văn bản mật): chỉ chủ sở hữu, người tham gia và người được chia sẻ thấy; máy chủ luôn gửi */
  confidentiality: z.enum(CONFIDENTIALITIES).optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunDetailSchema = RunSummarySchema.extend({
  steps: z.array(StepViewSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  inputs: z.record(z.string(), z.unknown()),
  /** biểu mẫu khởi chạy của phiên bản mẫu: để hiện nhãn, loại ô và tệp ở màn chi tiết */
  inputForm: z.array(FormFieldSchema).optional(),
  /** mọi tệp đã đính kèm vào lượt chạy (khởi chạy, từng việc, tệp tổng hợp), mới nhất trước */
  files: z.array(FileViewSchema).optional(),
  /** trạng thái của mọi nút (kể cả nút không giao cho người) để tô màu sơ đồ trên web */
  nodeStates: z.record(z.string(), z.object({ kind: NodeKindSchema, state: StepStateSchema })),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RunCreateSchema = z.object({
  /** lấy bản xuất bản mới nhất */
  templateId: IdSchema,
  title: z.string().min(1).max(200),
  inputs: z.record(z.string(), z.unknown()),
});

/**
 * Giao một việc ngoài quy trình (docs/DECISIONS.md, 05/10/2026): người giao chọn người nhận tự do, khác việc nằm trong
 * quy trình (chỉ về người được bổ nhiệm). `dueDate` là ngày lịch; hạn thật là hết giờ làm việc của ngày đó (SPEC 4.5).
 */
export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 2000;
export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(TASK_TITLE_MAX),
  description: z.string().max(TASK_DESCRIPTION_MAX).optional(),
  assigneeId: IdSchema,
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type RunCreate = z.infer<typeof RunCreateSchema>;

export const RunListQuerySchema = PageQuerySchema.extend({
  state: RunStateSchema.optional(),
  unitId: IdSchema.optional(),
  templateId: IdSchema.optional(),
  q: z.string().optional(),
  late: QueryBoolSchema.optional(),
  /** true: chỉ việc ngoài quy trình; false: chỉ lượt chạy của quy trình; bỏ trống: cả hai */
  adhoc: QueryBoolSchema.optional(),
  sort: z.enum(['-startedAt', 'startedAt', 'targetAt', '-targetAt']).default('-startedAt'),
});

export const RunEventViewSchema = z.object({
  id: IdSchema,
  seq: z.number().int(),
  type: z.string(),
  at: InstantSchema,
  actorType: z.enum(['user', 'system', 'ai']),
  actor: PersonRefSchema.nullable(),
  proposalId: IdSchema.nullable(),
  stepId: IdSchema.nullable(),
  stepTitle: z.string().nullable(),
  /** tham số của sự kiện và các thay đổi dẫn xuất; client dựng câu chữ từ packages/i18n */
  payload: z.record(z.string(), z.unknown()),
});
export type RunEventView = z.infer<typeof RunEventViewSchema>;

export const RunEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** phân trang theo seq: chỉ lấy sự kiện có seq lớn hơn */
  afterSeq: z.coerce.number().int().optional(),
});

export const RunCancelSchema = z.object({
  reason: z.string().min(1).max(500),
  /** phải trùng tên lượt chạy */
  confirmTitle: z.string(),
});
export const RunNoteSchema = z.object({ text: z.string().min(1).max(2000) });

export const StepListQuerySchema = PageQuerySchema.extend({
  /** 'me' hoặc id người nhận */
  assignee: z.union([z.literal('me'), IdSchema]).optional(),
  /** 'team' = việc của người dưới quyền (S8 Nhóm của tôi) */
  scope: z.enum(['team']).optional(),
  bucket: BucketSchema.optional(),
  state: StepStateSchema.optional(),
  late: QueryBoolSchema.optional(),
  unitId: IdSchema.optional(),
  runId: IdSchema.optional(),
  /** chỉ việc loại duyệt đang chờ */
  kind: z.enum(['task', 'approval']).optional(),
  open: QueryBoolSchema.optional(),
  q: z.string().optional(),
  sort: z.enum(['dueAt', '-dueAt', '-completedAt']).default('dueAt'),
});

/** Mọi POST lên việc trả trạng thái sau khi áp sự kiện. */
export const StepResultSchema = z.object({ step: StepViewSchema, run: RunSummarySchema });
export type StepResult = z.infer<typeof StepResultSchema>;

export const StepCompleteSchema = z.object({
  note: z.string().max(2000).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  fileIds: z.array(IdSchema).optional(),
  /** ghi phản hồi `done` cho lời nhắc */
  nudgeId: IdSchema.optional(),
});
/** Xuất tệp tổng hợp: `result` là các ô của biểu mẫu kết quả mà người làm đang gõ (chưa gửi), để tệp có cả phần họ vừa viết. */
export const StepCompileSchema = z.object({ result: z.record(z.string(), z.unknown()).optional() });
export const StepApproveSchema = z.object({
  comment: z.string().max(2000).optional(),
  /** biểu mẫu của nút duyệt hoặc đóng góp */
  result: z.record(z.string(), z.unknown()).optional(),
  fileIds: z.array(IdSchema).optional(),
});
export const StepRejectSchema = z.object({ reason: z.string().min(1).max(2000) });
export const StepExtensionRequestSchema = z.object({
  proposedDueAt: InstantSchema,
  reason: z.string().min(1).max(2000),
  nudgeId: IdSchema.optional(),
});
export const ExtensionDecideSchema = z.object({
  decision: z.enum(['approved', 'declined']),
  comment: z.string().max(2000).optional(),
});
export const StepBlockSchema = z.object({
  reasonCode: BlockReasonCodeSchema,
  note: z.string().max(2000).optional(),
  nudgeId: IdSchema.optional(),
});
export const StepReassignSchema = z.object({ toUserId: IdSchema, reason: z.string().min(1).max(2000) });
export const StepExtendSchema = z.object({ newDueAt: InstantSchema, reason: z.string().min(1).max(2000) });
export const StepSkipSchema = z.object({ reason: z.string().min(1).max(2000) });

export const StepBatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reassign'), stepIds: z.array(IdSchema).min(1).max(50), params: StepReassignSchema }),
  z.object({ action: z.literal('extend'), stepIds: z.array(IdSchema).min(1).max(50), params: StepExtendSchema }),
]);
/**
 * Những người một (hoặc nhiều) việc được giao lại cho: việc trong quy trình chỉ về người được bổ nhiệm và người được ủy quyền;
 * `anyone` = true khi ai còn hoạt động cũng được (việc ngoài quy trình, hoặc quy tắc không trỏ được tới ai). Nhiều việc: giao của các việc.
 */
export const StepAssigneesRequestSchema = z.object({ stepIds: z.array(IdSchema).min(1).max(50) });
export const StepAssigneesResponseSchema = z.object({
  anyone: z.boolean(),
  people: z.array(PersonRefSchema.extend({ unitName: z.string().nullable(), roleTitle: z.string().nullable() })),
});
export type StepAssigneesResponse = z.infer<typeof StepAssigneesResponseSchema>;

export const StepBatchResponseSchema = z.object({
  results: z.array(
    z.object({
      stepId: IdSchema,
      ok: z.boolean(),
      error: z.object({ code: z.string() }).optional(),
    }),
  ),
});

export const ExtensionRequestViewSchema = z.object({
  id: IdSchema,
  step: StepViewSchema,
  requestedBy: PersonRefSchema,
  proposedDueAt: InstantSchema,
  reason: z.string(),
  state: z.enum(['pending', 'approved', 'declined']),
  createdAt: InstantSchema,
});
export type ExtensionRequestView = z.infer<typeof ExtensionRequestViewSchema>;

// ───────────────────────── Tổng quan (cùng nguồn với tool get_overview, SPEC 5.5) ─────────────────────────

export const OverviewSchema = z.object({
  asOf: InstantSchema,
  running: z.number().int(),
  overdue: z.number().int(),
  dueToday: z.number().int(),
  dueTomorrow: z.number().int(),
  /** việc loại duyệt đang chờ, toàn tổ chức */
  pendingApproval: z.number().int(),
  /** việc đang chờ chính người gọi quyết */
  awaitingMyDecision: z.number().int(),
  /** "Cần giao người" */
  unassigned: z.number().int(),
  pendingExtensions: z.number().int(),
  /** đúng hạn tuần này theo hạn gốc, 0..1; null khi chưa có việc xong */
  onTimeRateThisWeek: z.number().nullable(),
  completedThisWeek: z.number().int(),
  /** "Cần Chủ tịch biết": mọi việc quá hạn từ 3 ngày làm việc (SPEC 4.6) */
  needsAttention: z.array(StepViewSchema),
  /** lượt chạy mới xong từ hôm qua */
  recentlyCompletedRuns: z.array(RunSummarySchema),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const ActivityItemSchema = RunEventViewSchema.extend({ runId: IdSchema, runTitle: z.string() });
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

// ───────────────────────── Đi thúc (SPEC 10.6) ─────────────────────────

export const NudgeToneSchema = z.enum(['down', 'peer', 'up']);

export const NudgeDraftRequestSchema = z.object({
  stepIds: z.array(IdSchema).min(1).max(50),
  /** bỏ trống: máy chủ chọn theo quan hệ giữa người gửi và người nhận */
  tone: NudgeToneSchema.optional(),
});

export const NudgeDraftSchema = z.object({
  stepId: IdSchema,
  stepTitle: z.string(),
  runTitle: z.string(),
  toUser: PersonRefSchema.nullable(),
  lateWorkingDays: z.number().int(),
  relation: NudgeToneSchema,
  message: z.string(),
  throttled: z.boolean(),
  /** lý do bị chặn làm phiền */
  throttleReason: z.enum(['already_nudged_today', 'quiet_hours', 'not_overdue', 'extension_pending', 'not_open']).nullable(),
  nextAllowedAt: InstantSchema.nullable(),
});
export type NudgeDraft = z.infer<typeof NudgeDraftSchema>;
export const NudgeDraftResponseSchema = z.object({ items: z.array(NudgeDraftSchema), senderName: z.string() });

export const NudgeSendSchema = z.object({
  items: z.array(z.object({ stepId: IdSchema, message: z.string().min(1).max(1000) })).min(1).max(50),
  /** người điều phối nêu đích danh việc chưa quá hạn (SPEC 4.7) */
  allowNotOverdue: z.boolean().optional(),
});
export const NudgeSendResponseSchema = z.object({
  results: z.array(
    z.object({
      stepId: IdSchema,
      ok: z.boolean(),
      nudgeId: IdSchema.optional(),
      error: z.object({ code: z.string(), nextAllowedAt: InstantSchema.optional() }).optional(),
    }),
  ),
});

// ───────────────────────── Bình luận theo việc (docs/DECISIONS.md, 07/10/2026 điểm a) ─────────────────────────

export const COMMENT_MAX = 4000;
/** Mỗi bình luận đính tối đa chừng này tệp (docs/DECISIONS.md, 12/10/2026). */
export const COMMENT_FILES_MAX = 5;
/** Tên trường đánh dấu tệp đính vào bình luận (khác tệp của biểu mẫu, tệp đính thêm và tệp tổng hợp). */
export const COMMENT_FILES_FIELD = '__comment';
/** Mỗi người tối đa chừng này bình luận mỗi phút. */
export const COMMENT_RATE_PER_MINUTE = 30;

export const StepCommentSchema = z.object({
  id: IdSchema,
  stepId: IdSchema,
  author: PersonRefSchema,
  body: z.string(),
  createdAt: InstantSchema,
  /** của chính người xem: chỉ tác giả xoá được */
  mine: z.boolean(),
  /** tệp đính kèm bình luận (có thể rỗng); tải xuống qua `files.download` */
  files: z.array(FileViewSchema),
});
export type StepComment = z.infer<typeof StepCommentSchema>;

/** Cũ nhất trước (đọc như một cuộc trao đổi); `cursor` là con trỏ do máy chủ cấp. */
export const StepCommentListSchema = z.object({
  items: z.array(StepCommentSchema),
  nextCursor: z.string().nullable(),
  /** người xem có được viết bình luận ở việc này không: ẩn ô nhập nếu false */
  canComment: z.boolean(),
});
export type StepCommentList = z.infer<typeof StepCommentListSchema>;
/** Chữ hoặc tệp, ít nhất một trong hai. Tệp phải do chính người viết tải lên (`files.upload`) và còn chờ gắn. */
export const StepCommentCreateSchema = z
  .object({
    body: z.string().trim().max(COMMENT_MAX).default(''),
    fileIds: z.array(IdSchema).max(COMMENT_FILES_MAX).default([]),
  })
  .refine((v) => v.body.length > 0 || v.fileIds.length > 0, { path: ['body'], message: 'required' });
export const StepCommentParamsSchema = z.object({ id: IdSchema, commentId: IdSchema });

// ───────────────────────── Chia sẻ lượt chạy kiểu Google Drive (điểm b) ─────────────────────────

export const RunShareRoleSchema = z.enum(RUN_SHARE_ROLES);
/** Mức của người đứng ngoài danh sách chia sẻ nhưng luôn có quyền: chủ sở hữu và người tham gia lượt (không gỡ được). */
export const RunFixedAccessRoleSchema = z.enum(['owner', 'participant']);

export const RunShareViewSchema = z.object({
  person: PersonRefSchema,
  role: RunShareRoleSchema,
  grantedBy: PersonRefSchema.nullable(),
  createdAt: InstantSchema,
});
export type RunShareView = z.infer<typeof RunShareViewSchema>;

export const RunSharesSchema = z.object({
  confidentiality: z.enum(CONFIDENTIALITIES),
  /** người được chia sẻ, thêm và gỡ được */
  shares: z.array(RunShareViewSchema),
  /** chủ sở hữu và người tham gia: luôn có quyền, không gỡ được */
  fixed: z.array(z.object({ person: PersonRefSchema, role: RunFixedAccessRoleSchema })),
  /** người xem có được thêm, đổi mức, gỡ người không (chủ sở hữu, hoặc có quyền `run.share`) */
  canManage: z.boolean(),
  /** người xem được viết bình luận ở lượt này không */
  canComment: z.boolean(),
});
export type RunShares = z.infer<typeof RunSharesSchema>;
export const RunShareSetSchema = z.object({ role: RunShareRoleSchema });
export const RunShareParamsSchema = z.object({ id: IdSchema, userId: IdSchema });
