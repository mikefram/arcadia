import { z } from 'zod';
import { IdSchema, InstantSchema, NotificationStateSchema } from '../enums';
import { PageQuerySchema, PersonRefSchema } from './common';

/** SPEC 10.9. Nội dung thông báo không chứa dữ liệu nhạy cảm: chỉ chữ ngắn và mã việc. */
export const NOTIFICATION_KINDS = [
  'assigned',
  'unassigned',
  'approval_needed',
  'reassigned',
  'accepted',
  'completed',
  'rejected',
  'extension_requested',
  'extension_approved',
  'extension_declined',
  'due_changed',
  'run_cancelled',
  'run_completed',
  'reminder_due_tomorrow',
  'reminder_due_today',
  'reminder',
  'overdue',
  'escalation',
  'nudge',
  'nudge_reply',
  'blocked',
  'comment_new',
  'briefing',
  'approval',
  'proposal.office',
  'proposal.failed',
  'system',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationViewSchema = z.object({
  id: IdSchema,
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  /** liên kết sâu dạng mihato://step/{id}, và dữ liệu đi kèm */
  payload: z.record(z.string(), z.unknown()),
  runId: IdSchema.nullable(),
  stepId: IdSchema.nullable(),
  state: NotificationStateSchema,
  createdAt: InstantSchema,
  readAt: InstantSchema.nullable(),
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

export const NotificationListQuerySchema = PageQuerySchema.extend({ unread: z.enum(['true', 'false']).optional() });
export const NotificationListSchema = z.object({
  items: z.array(NotificationViewSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int(),
});

export const NotificationReadSchema = z.union([z.object({ ids: z.array(IdSchema).min(1) }), z.object({ all: z.literal(true) })]);

export const BriefingSectionSchema = z.object({
  key: z.enum(['open', 'completed', 'due']),
  title: z.string(),
  /** câu số liệu mở đầu rồi mới tới chi tiết (SPEC 6.7) */
  lead: z.string(),
  lines: z.array(z.string()),
});

export const BriefingSchema = z.object({
  id: IdSchema,
  builtAt: InstantSchema,
  text: z.string(),
  sections: z.array(BriefingSectionSchema),
  /** đường dẫn có chữ ký sống 10 phút, hoặc null: app đọc `text` bằng giọng hệ điều hành */
  audioUrl: z.string().nullable(),
});
export type Briefing = z.infer<typeof BriefingSchema>;

/** Quản trị: trạng thái gửi và đọc (SPEC 9.2 "Thông báo và nhật ký") */
export const AdminNotificationSchema = z.object({
  id: IdSchema,
  user: PersonRefSchema,
  kind: z.string(),
  title: z.string(),
  state: NotificationStateSchema,
  createdAt: InstantSchema,
  sentAt: InstantSchema.nullable(),
  deliveredAt: InstantSchema.nullable(),
  openedAt: InstantSchema.nullable(),
});

/** Sự kiện SSE cho web (SPEC 10.8): chỉ mang id, không mang dữ liệu. */
export const StreamEventSchema = z.object({
  kind: z.enum(['run.updated', 'step.updated', 'proposal.updated', 'notification.created', 'template.updated', 'ping']),
  orgId: IdSchema.optional(),
  runId: IdSchema.optional(),
  stepId: IdSchema.optional(),
  proposalId: IdSchema.optional(),
  templateId: IdSchema.optional(),
  userId: IdSchema.optional(),
  version: z.number().int().optional(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export const PG_NOTIFY_CHANNEL = 'mihato_events';
