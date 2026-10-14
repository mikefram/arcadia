import { z } from 'zod';

/** Vai trò theo tổ chức và đơn vị (SPEC 2.1, 5.2). */
export const ROLES = ['chairman', 'director', 'deputy', 'office_admin', 'process_designer', 'it_admin', 'employee'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Vai trò điều hành: dùng app Chủ tịch, là "người điều phối" trong bảng 4.3. */
export const EXECUTIVE_ROLES = ['chairman', 'director', 'deputy'] as const satisfies readonly Role[];
/** Người điều phối: điều hành và Văn phòng. */
export const COORDINATOR_ROLES = ['chairman', 'director', 'deputy', 'office_admin'] as const satisfies readonly Role[];

export const HONORIFICS = ['anh', 'chi', 'ong', 'ba', 'co', 'chu', 'bac'] as const;
export const HonorificSchema = z.enum(HONORIFICS);
export type Honorific = z.infer<typeof HonorificSchema>;

/** Chữ hiển thị của xưng hô (CSDL lưu không dấu). */
export const HONORIFIC_LABEL: Record<Honorific, string> = {
  anh: 'anh',
  chi: 'chị',
  ong: 'ông',
  ba: 'bà',
  co: 'cô',
  chu: 'chú',
  bac: 'bác',
};

export const UI_PROFILES = ['senior', 'standard'] as const;
export const UiProfileSchema = z.enum(UI_PROFILES);
export type UiProfile = z.infer<typeof UiProfileSchema>;

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const RUN_STATES = ['draft', 'running', 'completed', 'cancelled', 'failed'] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunStateName = z.infer<typeof RunStateSchema>;

export const RUN_OUTCOMES = ['success', 'rejected'] as const;
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Tám trạng thái của việc (SPEC 4.3). Quá hạn không phải trạng thái lưu. */
export const STEP_STATES = ['pending', 'unassigned', 'ready', 'in_progress', 'done', 'rejected', 'skipped', 'cancelled'] as const;
export const StepStateSchema = z.enum(STEP_STATES);
export type StepStateName = z.infer<typeof StepStateSchema>;

/** Trạng thái chưa xong mà đã tới lượt: dùng để tính cờ quá hạn. */
export const OPEN_STEP_STATES = ['unassigned', 'ready', 'in_progress'] as const satisfies readonly StepStateName[];
export const TERMINAL_STEP_STATES = ['done', 'rejected', 'skipped', 'cancelled'] as const satisfies readonly StepStateName[];

export const NODE_KINDS = ['start', 'end', 'task', 'approval', 'condition', 'timer', 'notify', 'webhook'] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const HOLIDAY_KINDS = ['public', 'company', 'makeup_workday'] as const;
export const HolidayKindSchema = z.enum(HOLIDAY_KINDS);
export type HolidayKind = z.infer<typeof HolidayKindSchema>;

export const DELEGATION_SCOPES = ['all', 'process', 'role'] as const;
export const DelegationScopeSchema = z.enum(DELEGATION_SCOPES);
export type DelegationScope = z.infer<typeof DelegationScopeSchema>;

export const PLATFORMS = ['ios', 'android', 'web'] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

export const PROPOSAL_STATES = ['pending', 'confirmed', 'rejected', 'expired', 'failed', 'undone'] as const;
export const ProposalStateSchema = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

export const NOTIFICATION_STATES = ['queued', 'sent', 'delivered', 'opened', 'failed'] as const;
export const NotificationStateSchema = z.enum(NOTIFICATION_STATES);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

export const NUDGE_REPLIES = ['done', 'need_time', 'blocked'] as const;
export const NudgeReplySchema = z.enum(NUDGE_REPLIES);
export type NudgeReply = z.infer<typeof NudgeReplySchema>;

export const BLOCK_REASON_CODES = ['missing_info', 'waiting_on_other', 'need_decision', 'other'] as const;
export const BlockReasonCodeSchema = z.enum(BLOCK_REASON_CODES);
export type BlockReasonCode = z.infer<typeof BlockReasonCodeSchema>;

/** Múi giờ hiển thị cố định (SPEC 3.5). Việt Nam không đổi giờ mùa nên lệch UTC luôn là +7. */
export const DISPLAY_TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const VN_UTC_OFFSET_MINUTES = 7 * 60;

/** Ngày lịch `YYYY-MM-DD` theo giờ Việt Nam; giờ trong ngày `HH:mm`. */
export const LocalDateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Thời điểm ISO 8601 UTC. */
export const InstantSchema = z.iso.datetime({ offset: true });
export const IdSchema = z.uuid();
