import { z } from 'zod';
import { IdSchema, InstantSchema } from '../enums';

/** SPEC 10.7.1: phiên Scribe. Token là JWT ký bất đối xứng, sống 120 giây, dùng một lần, scope 'scribe'. */
export const ScribeSessionCreateSchema = z.object({
  channel: z.enum(['voice', 'text']),
  transcriptConsent: z.boolean(),
});
export const ScribeSessionSchema = z.object({
  sessionId: IdSchema,
  conversationId: IdSchema,
  wsUrl: z.string(),
  token: z.string(),
  expiresAt: InstantSchema,
});
export type ScribeSession = z.infer<typeof ScribeSessionSchema>;

// ───────────────────────── Giao diện nội bộ /internal/v1/* (chỉ service token của ai_service) ─────────────────────────

export const InternalToolCallSchema = z.object({
  args: z.record(z.string(), z.unknown()),
  conversationId: IdSchema.optional(),
});
export const InternalToolResultSchema = z.object({
  ok: z.boolean(),
  /** kết quả tối thiểu theo SPEC 6.8 */
  result: z.unknown().optional(),
  /** lỗi trả về cho tool, không tạo proposals */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /** có khi tool propose_* tạo đề xuất */
  proposals: z.array(z.object({ proposalId: IdSchema, batchId: IdSchema.nullable(), risk: z.number().int(), summary: z.string() })).optional(),
  /**
   * Có khi `preview_process` nghe đủ và hợp lệ: câu đọc lại các bước do MÁY CHỦ dựng. Trợ lý dừng và đọc đúng các dòng này
   * (không diễn đạt lại), như với `proposals` (docs/DECISIONS.md, 04/10/2026).
   */
  processReadback: z.object({ name: z.string(), lines: z.array(z.string()), total: z.number().int() }).optional(),
});
export type InternalToolResult = z.infer<typeof InternalToolResultSchema>;

export const InternalClaimResponseSchema = z.object({
  userId: IdSchema,
  orgId: IdSchema,
  conversationId: IdSchema,
  channel: z.enum(['voice', 'text']),
  quotaLeft: z.number().int(),
  /** ngữ cảnh theo lượt và theo tổ chức để dựng prompt (SPEC 6.6) */
  user: z.object({ fullName: z.string(), givenName: z.string(), honorific: z.string().nullable(), roleTitle: z.string() }),
  ai: z.object({ enabled: z.boolean(), stt: z.string(), llm: z.string(), tts: z.string() }),
  voiceId: z.string().nullable(),
  speechRate: z.enum(['slow', 'normal', 'fast']),
  /** tên người, phòng ban, tên quy trình để gửi làm keyterm cho STT (SPEC 6.2) */
  keyterms: z.array(z.string()),
  orgPrompt: z.string(),
});
export type InternalClaimResponse = z.infer<typeof InternalClaimResponseSchema>;

export const InternalMessageSchema = z.object({
  conversationId: IdSchema,
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.unknown(),
  sttConfidence: z.number().optional(),
});

export const InternalUsageSchema = z.object({
  conversationId: IdSchema,
  llmCalls: z.number().int().default(0),
  llmInputTokens: z.number().int().default(0),
  llmOutputTokens: z.number().int().default(0),
  sttSeconds: z.number().int().default(0),
  ttsChars: z.number().int().default(0),
  errors: z.number().int().default(0),
});
export const InternalUsageResponseSchema = z.object({ quotaLeft: z.number().int() });

// ───────────────────────── Giao thức WebSocket (SPEC 10.7.2) ─────────────────────────

export const WsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), token: z.string(), appVersion: z.string() }),
  /** dictation: nghe, hiểu, trả lời. confirm: chỉ chép chữ, không gọi LLM (xác nhận bằng giọng ở M3). */
  z.object({ type: z.literal('start_turn'), mode: z.enum(['dictation', 'confirm']) }),
  z.object({ type: z.literal('end_turn') }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('interrupt') }),
]);
export type WsClientFrame = z.infer<typeof WsClientFrameSchema>;

export const WsServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sessionId: IdSchema, conversationId: IdSchema, quotaLeft: z.number().int() }),
  z.object({ type: z.literal('status'), phase: z.enum(['listening', 'thinking', 'speaking', 'idle']) }),
  z.object({ type: z.literal('transcript.partial'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('transcript.final'), turnId: z.string(), text: z.string(), confidence: z.number() }),
  z.object({ type: z.literal('assistant.delta'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('assistant.done'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('audio.start'), turnId: z.string(), format: z.literal('mp3') }),
  z.object({ type: z.literal('audio.end'), turnId: z.string() }),
  /** app mở M3 và lấy chi tiết bằng GET /v1/proposals/:id; câu xác nhận lấy từ summary do server dựng */
  z.object({ type: z.literal('proposal.created'), proposalId: IdSchema, batchId: IdSchema.nullable(), risk: z.number().int(), itemCount: z.number().int() }),
  /** tên mơ hồ: app hiện danh sách để chạm chọn (SPEC 6.6) */
  z.object({
    type: z.literal('choices'),
    turnId: z.string(),
    kind: z.enum(['person', 'template', 'run']),
    options: z.array(z.object({ id: IdSchema, label: z.string(), sub: z.string().nullable() })),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(['stt_unavailable', 'llm_unavailable', 'tts_unavailable', 'quota_exceeded', 'session_expired', 'ai_disabled']),
    retryable: z.boolean(),
  }),
]);
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>;

/** Mã đóng kết nối WebSocket. */
export const WS_CLOSE = { badToken: 4401, idle: 4408, quota: 4429, serverError: 1011 } as const;
