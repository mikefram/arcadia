import { z } from 'zod';
import { IdSchema, InstantSchema, LocalDateSchema } from '../enums';
import { PageQuerySchema, PersonRefSchema } from './common';

/** Nhật ký bảo mật và quản trị (SPEC 11.3). Không thay thế run_events. */
export const AUDIT_ACTIONS = [
  'login',
  'login_failed',
  'logout',
  'mfa_enabled',
  'password_set',
  'device_activated',
  'device_revoked',
  'refresh_reuse',
  'role_changed',
  'user_created',
  'user_updated',
  'user_disabled',
  'user_enabled',
  'activation_created',
  'delegation_created',
  'delegation_deleted',
  'org_settings_changed',
  'holiday_changed',
  'template_published',
  'template_archived',
  'proposal_created',
  'proposal_confirmed',
  'proposal_rejected',
  'proposal_undone',
  'proposal_applied',
  'proposal_failed',
  'step_up_issued',
  'data_exported',
  'conversations_deleted',
  'effect_retried',
  'push_token_removed',
  'unit_created',
  'unit_updated',
  'password_link_created',
  'invite_email_queued',
  'invite_email_sent',
  'email_settings_changed',
  'email_settings_cleared',
  'email_test_sent',
  'run_files_attached',
  'permission_role_changed',
  'permission_role_reset',
  'permission_user_changed',
  'register_created',
  'register_updated',
  'document_compiled',
  'run_share_added',
  'run_share_changed',
  'run_share_removed',
  'step_comment_added',
  'step_comment_deleted',
  'mfa_reset',
  'step_up_failed',
  'totp_enable_failed',
  'org_bootstrapped',
] as const;

export const AuditEntrySchema = z.object({
  id: IdSchema,
  at: InstantSchema,
  actorType: z.enum(['user', 'system', 'ai_service']),
  actor: PersonRefSchema.nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: IdSchema.nullable(),
  ip: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = PageQuerySchema.extend({
  action: z.string().optional(),
  actorId: IdSchema.optional(),
  from: InstantSchema.optional(),
  to: InstantSchema.optional(),
});

/** Hàng effect lỗi (`dead`) có nút thử lại (SPEC 9.2). */
export const EffectViewSchema = z.object({
  id: IdSchema,
  kind: z.string(),
  state: z.enum(['pending', 'processing', 'done', 'dead']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  runId: IdSchema.nullable(),
  createdAt: InstantSchema,
  nextAttemptAt: InstantSchema,
});
export type EffectView = z.infer<typeof EffectViewSchema>;
export const EffectQuerySchema = PageQuerySchema.extend({ state: z.enum(['pending', 'processing', 'done', 'dead']).default('dead') });

/** Số liệu dùng AI theo người và ngày: KHÔNG có nội dung hội thoại [QUYẾT ĐỊNH, SPEC 9.1]. */
export const AiUsageRowSchema = z.object({
  user: PersonRefSchema,
  day: LocalDateSchema,
  llmCalls: z.number().int(),
  llmInputTokens: z.number().int(),
  llmOutputTokens: z.number().int(),
  sttSeconds: z.number().int(),
  ttsChars: z.number().int(),
  errors: z.number().int(),
});
export const AiUsageQuerySchema = z.object({ from: LocalDateSchema.optional(), to: LocalDateSchema.optional() });
export const AiUsageResponseSchema = z.object({
  rows: z.array(AiUsageRowSchema),
  totals: z.object({
    llmCalls: z.number().int(),
    llmInputTokens: z.number().int(),
    llmOutputTokens: z.number().int(),
    sttSeconds: z.number().int(),
    ttsChars: z.number().int(),
    errors: z.number().int(),
    /** ước tính theo giá ở SPEC 6.3; cảnh báo ở 80% và 100% ngân sách tháng */
    estimatedUsd: z.number(),
  }),
});

// ───────────────────────── Báo cáo (SPEC 9.6) ─────────────────────────

export const ReportQuerySchema = z.object({
  from: LocalDateSchema,
  to: LocalDateSchema,
  unitId: IdSchema.optional(),
  userId: IdSchema.optional(),
  templateId: IdSchema.optional(),
});

const rate = z.number().min(0).max(1).nullable();

export const ReportSchema = z.object({
  from: LocalDateSchema,
  to: LocalDateSchema,
  asOf: InstantSchema,
  /** việc xong có completed_at không muộn hơn due_original_at, chia số việc xong trong kỳ */
  onTimeRate: rate,
  /** như trên nhưng theo due_at hiện tại */
  onTimeRateAfterExtension: rate,
  completedCount: z.number().int(),
  /** số dòng is_overdue trong v_step_status lúc này */
  overdueNow: z.number().int(),
  /** trung bình completed_at trừ activated_at, tính bằng ngày làm việc */
  avgHandlingWorkingDays: z.number().nullable(),
  byUser: z.array(
    z.object({
      user: PersonRefSchema,
      unitName: z.string().nullable(),
      open: z.number().int(),
      overdue: z.number().int(),
      completed: z.number().int(),
      onTimeRate: rate,
    }),
  ),
  byUnit: z.array(
    z.object({
      unitId: IdSchema.nullable(),
      unitName: z.string(),
      open: z.number().int(),
      overdue: z.number().int(),
      completed: z.number().int(),
      onTimeRate: rate,
    }),
  ),
  /** theo mẫu và theo bước: nguồn của "nút thắt" */
  byTemplateStep: z.array(
    z.object({
      templateId: IdSchema,
      templateName: z.string(),
      nodeId: z.string(),
      title: z.string(),
      count: z.number().int(),
      avgWorkingDays: z.number().nullable(),
      overdueRate: rate,
    }),
  ),
  nudges: z.array(
    z.object({
      user: PersonRefSchema,
      received: z.number().int(),
      repliedWithinOneWorkingDay: z.number().int(),
      replyRate: rate,
    }),
  ),
});
export type Report = z.infer<typeof ReportSchema>;
