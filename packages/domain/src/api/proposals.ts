import { z } from 'zod';
import { IdSchema, InstantSchema, ProposalStateSchema } from '../enums';
import { ProcessDraftPayloadSchema } from '../process-draft';
import { PersonRefSchema } from './common';
import { SimulationRowViewSchema } from './templates';

/**
 * Đề xuất và cổng xác nhận (SPEC 6.5, 10.6). Cổng nằm ở máy chủ, không nằm trong prompt.
 * `summary` và `items[].text` do máy chủ dựng từ `payload` bằng mẫu cố định, không lấy chữ của LLM.
 */

export const PROPOSAL_TOOLS = [
  'save_note',
  'propose_nudge',
  'propose_start_run',
  'propose_reassign',
  'propose_extend_due',
  'propose_cancel_run',
  'propose_create_process',
  'propose_publish_process',
  'propose_assign_task',
] as const;
export const ProposalToolSchema = z.enum(PROPOSAL_TOOLS);
export type ProposalTool = z.infer<typeof ProposalToolSchema>;

/** Mức rủi ro theo tool (SPEC 6.5). Mức 3 không có tool. */
export const PROPOSAL_RISK: Record<ProposalTool, 0 | 1 | 2> = {
  save_note: 0,
  propose_nudge: 1,
  propose_start_run: 1,
  propose_reassign: 1,
  propose_extend_due: 1,
  propose_cancel_run: 2,
  /** tạo BẢN NHÁP quy trình: chưa giao việc cho ai, chưa xuất bản (docs/DECISIONS.md, 04/10/2026) */
  propose_create_process: 1,
  /** xuất bản bản nháp, tuỳ chọn giao việc ngay; cùng mức với propose_start_run */
  propose_publish_process: 1,
  /** giao một việc ngoài quy trình: cùng mức với propose_start_run */
  propose_assign_task: 1,
};

/** Cửa hoàn tác 30 giây và hạn 10 phút của đề xuất [QUYẾT ĐỊNH / MỤC TIÊU]. */
export const PROPOSAL_UNDO_WINDOW_MS = 30_000;
export const PROPOSAL_TTL_MS = 10 * 60_000;
export const STEP_UP_TTL_MS = 60_000;

/** Tham số đã kiểm của từng tool đề xuất (lưu ở proposals.payload). */
export const ProposalPayloadSchemas = {
  save_note: z.object({ text: z.string().min(1).max(2000), runId: IdSchema.optional() }),
  /** mỗi lời nhắc là một proposal; `message` do máy chủ soạn theo ma trận xưng hô */
  propose_nudge: z.object({ stepRunId: IdSchema, toUserId: IdSchema, message: z.string().min(1).max(1000), tone: z.enum(['down', 'peer', 'up']) }),
  propose_start_run: z.object({
    templateId: IdSchema,
    title: z.string().min(1).max(200),
    inputs: z.record(z.string(), z.unknown()),
  }),
  propose_reassign: z.object({ stepRunId: IdSchema, toUserId: IdSchema, reason: z.string().min(1).max(2000) }),
  propose_extend_due: z.object({ stepRunId: IdSchema, newDue: InstantSchema, reason: z.string().min(1).max(2000) }),
  propose_cancel_run: z.object({ runId: IdSchema, reason: z.string().min(1).max(500) }),
  /** các bước đã tra người và kiểm đủ; máy chủ dựng lại bản nháp từ đây lúc áp */
  propose_create_process: ProcessDraftPayloadSchema,
  propose_assign_task: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    assigneeId: IdSchema,
    /** ngày lịch YYYY-MM-DD */
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  propose_publish_process: z.object({
    templateId: IdSchema,
    /** có thì sau khi xuất bản giao việc ngay theo mẫu vừa xuất bản, trong cùng một lần áp */
    startRun: z.object({ title: z.string().min(1).max(200), inputs: z.record(z.string(), z.unknown()) }).optional(),
  }),
} as const;

export const ProposalItemSchema = z.object({
  /** câu do máy chủ dựng */
  text: z.string(),
  stepId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  toUser: PersonRefSchema.nullable(),
  /** lời sẽ gửi (đi thúc); người xác nhận sửa được trước khi đồng ý */
  message: z.string().nullable(),
  editable: z.boolean(),
  lateWorkingDays: z.number().int().nullable(),
});

export const ProposalViewSchema = z.object({
  id: IdSchema,
  batchId: IdSchema.nullable(),
  tool: ProposalToolSchema,
  risk: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  summary: z.string(),
  items: z.array(ProposalItemSchema),
  /** bản xem trước của propose_start_run: sáu việc, người nhận, hạn (SPEC 6.5) */
  preview: z.array(SimulationRowViewSchema).nullable(),
  source: z.enum(['ai', 'office']),
  createdBy: PersonRefSchema.nullable(),
  state: ProposalStateSchema,
  requiresStepUp: z.boolean(),
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
  /** có sau khi xác nhận: mốc hiệu lực chạy và hạn hoàn tác */
  effectiveAt: InstantSchema.nullable(),
  undoUntil: InstantSchema.nullable(),
  /** confirmed cùng result khác null nghĩa là đã thực hiện; failed thì result.reason là lý do */
  result: z.record(z.string(), z.unknown()).nullable(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

export const ProposalListQuerySchema = z.object({
  state: ProposalStateSchema.optional(),
  batchId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ProposalConfirmSchema = z.object({
  via: z.enum(['touch', 'voice']),
  /** bằng chứng khi xác nhận bằng giọng (chỉ mức 1, tập câu đóng) */
  transcript: z.string().optional(),
  sttConfidence: z.number().min(0).max(1).optional(),
  /** lời nhắc đã sửa: proposalId → lời mới */
  editedMessages: z.record(z.string(), z.string().min(1).max(1000)).optional(),
});

export const ProposalBatchConfirmSchema = ProposalConfirmSchema.extend({
  dropProposalIds: z.array(IdSchema).optional(),
});

export const ProposalConfirmResponseSchema = z.object({
  state: z.enum(['confirmed', 'rejected']),
  effectiveAt: InstantSchema.nullable(),
  undoUntil: InstantSchema.nullable(),
  proposalIds: z.array(IdSchema),
});

export const ProposalRejectSchema = z.object({ reason: z.string().max(500).optional() });

/** "Trình" từ Văn phòng (giai đoạn 3, SPEC 7.7): cùng kiểm tra và cùng cổng xác nhận. */
export const ProposalCreateOfficeSchema = z.object({
  forUserId: IdSchema,
  tool: z.enum(['propose_nudge', 'propose_start_run', 'propose_reassign', 'propose_extend_due']),
  /** tham số của tool như AI gọi (propose_nudge nhận stepRunIds[]) */
  payload: z.record(z.string(), z.unknown()),
});

/** Tập câu đóng để xác nhận bằng giọng (SPEC 10.6). So sau khi chuẩn hoá: chữ thường, bỏ dấu câu, bỏ "dạ" và "ạ". */
export const VOICE_CONFIRM_PHRASES = ['đồng ý', 'gửi đi'] as const;
export const VOICE_REJECT_PHRASES = ['không', 'thôi'] as const;
