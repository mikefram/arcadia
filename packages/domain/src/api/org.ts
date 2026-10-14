import { z } from 'zod';
import {
  DelegationScopeSchema,
  HolidayKindSchema,
  HonorificSchema,
  IdSchema,
  InstantSchema,
  LocalDateSchema,
  PlatformSchema,
  RoleSchema,
  TimeOfDaySchema,
  UiProfileSchema,
  UserStatusSchema,
} from '../enums';
import { ActionSchema } from '../permission-rules';
import { ReminderStepSchema } from '../process';
import { PersonRefSchema } from './common';

// ───────────────────────── Cấu hình tổ chức (organizations.settings) ─────────────────────────

export const AiSettingsSchema = z.object({
  /** Công tắc AI theo tổ chức (SPEC 11.7) */
  enabled: z.boolean().default(true),
  stt: z.enum(['deepgram', 'vbee', 'off']).default('deepgram'),
  llm: z.enum(['anthropic', 'off']).default('anthropic'),
  tts: z.enum(['vbee', 'device', 'off']).default('vbee'),
  /** hạn mức lượt gọi LLM mỗi người mỗi ngày (SPEC 6.11) */
  dailyCallLimit: z.number().int().min(0).default(200),
  /** chỉ cảnh báo ở 80% và 100%, không tự cắt (SPEC 12.6) */
  monthlyBudgetUsd: z.number().min(0).nullable().default(null),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** Ma trận xưng hô của lời đi thúc (SPEC 4.7): dữ liệu cấu hình theo tổ chức, không viết cứng trong prompt. */
export const NudgeTemplatesSchema = z.object({
  /** gửi cấp dưới */
  down: z.string(),
  /** gửi ngang cấp */
  peer: z.string(),
  /** gửi cấp trên */
  up: z.string(),
  /** danh tính người gửi hiện trên lời nhắc */
  senderName: z.string(),
  /** dòng nhỏ kèm theo khi lời nhắc do AI soạn */
  aiDisclosure: z.string(),
});
export type NudgeTemplates = z.infer<typeof NudgeTemplatesSchema>;

export const DEFAULT_NUDGE_TEMPLATES: NudgeTemplates = {
  down: 'Văn phòng Chủ tịch nhắc {honorific} {tên}: việc ‘{việc}’ đã quá hạn {n} ngày. {Honorific} cho biết khi nào hoàn thành.',
  peer: 'Nhắc nhẹ {honorific} {tên}: việc ‘{việc}’ đã quá hạn {n} ngày. Cần hỗ trợ gì {honorific} cứ báo.',
  up: 'Kính nhắc {honorific} {tên}: việc ‘{việc}’ đang chờ {honorific} xử lý, đã quá hạn {n} ngày.',
  senderName: 'Văn phòng Chủ tịch',
  aiDisclosure: 'do Trợ lý AI soạn, theo chỉ đạo của Chủ tịch',
};

export const RetentionSchema = z.object({
  transcriptDays: z.number().int().default(90),
  briefingAudioDays: z.number().int().default(3),
  auditLogMonths: z.number().int().default(24),
  notificationDays: z.number().int().default(180),
  aiUsageMonths: z.number().int().default(13),
});

export const OrgSettingsSchema = z.object({
  /** ISO: 1 = Thứ Hai … 7 = Chủ Nhật */
  workdays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
  workStart: TimeOfDaySchema.default('08:00'),
  workEnd: TimeOfDaySchema.default('17:00'),
  /**
   * Giờ yên tĩnh của cả tổ chức. MẶC ĐỊNH KHÔNG CÓ (null): với công việc, giao việc hay đi thúc lúc 2 giờ sáng là bình thường
   * (Mike, 04/10/2026; docs/DECISIONS.md). Có giá trị thì không đẩy thông báo và không cho đi thúc trong khoảng đó.
   */
  quietHours: z.object({ start: TimeOfDaySchema, end: TimeOfDaySchema }).nullable().default(null),
  nudgeTemplates: NudgeTemplatesSchema.default(DEFAULT_NUDGE_TEMPLATES),
  reminderPreset: z.enum(['standard', 'strict', 'none']).default('standard'),
  /** ghi đè bộ nhắc `standard` của tổ chức; trống thì dùng mặc định SPEC 4.6 */
  reminderSteps: z.array(ReminderStepSchema).nullable().default(null),
  /** số Văn phòng cho nút "Nhờ Văn phòng" (SPEC 7.7); chưa có thì nút chưa bật */
  officePhone: z.string().nullable().default(null),
  /** lời chúc dịp Tết, lễ do Văn phòng soạn; AI không tự viết (SPEC 7.5) */
  greeting: z.string().nullable().default(null),
  ai: AiSettingsSchema.default(AiSettingsSchema.parse({})),
  minAppVersion: z.string().nullable().default(null),
  retention: RetentionSchema.default(RetentionSchema.parse({})),
  features: z.record(z.string(), z.boolean()).default({}),
  /** đầu mối bảo vệ dữ liệu của tổ chức (SPEC 11.8) */
  dataContact: z.string().nullable().default(null),
});
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;
/** PATCH gộp sâu một cấp: các nhóm con gửi thiếu khoá được (máy chủ chỉ áp khoá người gọi thật sự gửi). */
/** Nhà cung cấp thư điện tử đang hỗ trợ. */
export const EMAIL_PROVIDERS = ['resend'] as const;
export const EmailProviderSchema = z.enum(EMAIL_PROVIDERS);

/**
 * Cấu hình gửi thư của tổ chức (đặt ở web quản trị). Khoá API CHỈ GHI: phản hồi không bao giờ chứa khoá,
 * chỉ cho biết đã có khoá chưa (`hasApiKey`) và 4 ký tự cuối (`apiKeyHint`).
 * `active` là nguồn thật sự dùng khi gửi: `org` = cấu hình ở đây; `env` = biến môi trường của máy chủ (dự phòng);
 * `fake` = bản giả (phát triển, staging; thư không ra ngoài); `none` = chưa cấu hình, thư kích hoạt không gửi được.
 */
export const EmailSettingsViewSchema = z.object({
  provider: EmailProviderSchema,
  fromAddress: z.string(),
  hasApiKey: z.boolean(),
  apiKeyHint: z.string().nullable(),
  updatedAt: InstantSchema.nullable(),
  active: z.enum(['org', 'env', 'fake', 'none']),
});
export type EmailSettingsView = z.infer<typeof EmailSettingsViewSchema>;

/** `apiKey` bỏ trống = giữ khoá cũ; có giá trị = thay khoá. Lần đầu bắt buộc có khoá. */
export const EmailSettingsPutSchema = z.object({
  provider: EmailProviderSchema.default('resend'),
  fromAddress: z.string().trim().min(3).max(200),
  apiKey: z.string().trim().min(8).max(300).optional(),
});
export type EmailSettingsPut = z.input<typeof EmailSettingsPutSchema>;

export const EmailTestSchema = z.object({ to: z.email() });
/** `ok` false kèm lý do: `not_configured` (chưa có cấu hình dùng được), `transient` (lỗi tạm, thử lại), `permanent` (khoá sai, địa chỉ gửi chưa xác minh, địa chỉ nhận sai). */
export const EmailTestResultSchema = z.object({ ok: z.boolean(), error: z.enum(['not_configured', 'transient', 'permanent']).nullable() });

export const OrgSettingsPatchSchema = OrgSettingsSchema.partial().extend({
  quietHours: z.object({ start: TimeOfDaySchema, end: TimeOfDaySchema }).partial().nullable().optional(),
  nudgeTemplates: NudgeTemplatesSchema.partial().optional(),
  ai: AiSettingsSchema.partial().optional(),
  retention: RetentionSchema.partial().optional(),
});
export type OrgSettingsPatch = z.input<typeof OrgSettingsPatchSchema>;

// ───────────────────────── Người dùng ─────────────────────────

export const RoleGrantSchema = z.object({ role: RoleSchema, unitId: IdSchema.nullable().default(null) });

export const QuietHoursSchema = z.object({ start: TimeOfDaySchema, end: TimeOfDaySchema });

/** users.prefs (SPEC 10.2) */
export const UserPrefsSchema = z.object({
  fontScale: z.enum(['large', 'xlarge', 'xxlarge']).default('large'),
  speechRate: z.enum(['slow', 'normal', 'fast']).default('normal'),
  voiceId: z.string().nullable().default(null),
  briefingTime: TimeOfDaySchema.default('07:30'),
  quietHours: QuietHoursSchema.nullable().default(null),
  /** âm "tinh" khi gửi xong (SPEC 7.6) */
  sendSound: z.boolean().default(true),
});
export type UserPrefs = z.infer<typeof UserPrefsSchema>;
export const UserPrefsPatchSchema = UserPrefsSchema.partial();

export const DelegationViewSchema = z.object({
  id: IdSchema,
  fromUser: PersonRefSchema,
  toUser: PersonRefSchema,
  validFrom: InstantSchema,
  validTo: InstantSchema,
  scope: DelegationScopeSchema,
  scopeRef: z.string().nullable(),
  active: z.boolean(),
});
export type DelegationView = z.infer<typeof DelegationViewSchema>;

export const DelegationCreateSchema = z.object({
  fromUserId: IdSchema,
  toUserId: IdSchema,
  validFrom: InstantSchema,
  validTo: InstantSchema,
  scope: DelegationScopeSchema.default('all'),
  scopeRef: z.string().nullable().default(null),
});

export const MeSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  orgCode: z.string(),
  orgName: z.string(),
  fullName: z.string(),
  givenName: z.string(),
  honorific: HonorificSchema.nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  unitId: IdSchema.nullable(),
  unitName: z.string().nullable(),
  /** trưởng của ít nhất một đơn vị: hiện màn "Nhóm của tôi" */
  isUnitHead: z.boolean(),
  roles: z.array(RoleGrantSchema),
  /** quyền hiệu lực: bảng quyền của vai trò, chỉnh của tổ chức và chỉnh riêng đã tính xong. Giao diện ẩn hiện nút theo đây, không theo vai trò. */
  permissions: z.array(ActionSchema),
  uiProfile: UiProfileSchema,
  prefs: UserPrefsSchema,
  /** ủy quyền đang có hiệu lực, cả chiều đi và chiều nhận */
  activeDelegations: z.array(DelegationViewSchema),
  officePhone: z.string().nullable(),
  greeting: z.string().nullable(),
  /** lịch làm việc của tổ chức, để app làm mờ ngày nghỉ khi chọn hạn (ngày lễ lấy ở /v1/holidays) */
  calendar: z.object({ workdays: z.array(z.number().int()), workStart: TimeOfDaySchema, workEnd: TimeOfDaySchema }),
  ai: AiSettingsSchema.pick({ enabled: true, stt: true, llm: true, tts: true }),
  mfaEnabled: z.boolean(),
  /** vai trò bắt buộc TOTP mà chưa bật (SPEC 11.2) */
  mfaRequired: z.boolean(),
  /** máy chủ đang chặn mọi thao tác khác của phiên web cho tới khi bật TOTP (cờ ENFORCE_MFA; mặc định bật ở production) */
  mfaEnforced: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

export const UserViewSchema = z.object({
  id: IdSchema,
  fullName: z.string(),
  givenName: z.string(),
  honorific: HonorificSchema.nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  unitId: IdSchema.nullable(),
  unitName: z.string().nullable(),
  managerId: IdSchema.nullable(),
  managerName: z.string().nullable(),
  uiProfile: UiProfileSchema,
  displayOrder: z.number().int(),
  status: UserStatusSchema,
  roles: z.array(RoleGrantSchema),
  hasPassword: z.boolean(),
  mfaEnabled: z.boolean(),
  deviceCount: z.number().int(),
  createdAt: InstantSchema,
});
export type UserView = z.infer<typeof UserViewSchema>;

export const UserCreateSchema = z.object({
  fullName: z.string().min(1).max(120),
  givenName: z.string().min(1).max(40),
  honorific: HonorificSchema.nullable().default(null),
  email: z.email().nullable().default(null),
  phone: z.string().max(20).nullable().default(null),
  unitId: IdSchema.nullable().default(null),
  managerId: IdSchema.nullable().default(null),
  uiProfile: UiProfileSchema.default('standard'),
  displayOrder: z.number().int().default(0),
  roles: z.array(RoleGrantSchema).min(1),
});
export type UserCreate = z.input<typeof UserCreateSchema>;
export const UserUpdateSchema = UserCreateSchema.omit({ roles: true }).partial();
export type UserUpdate = z.input<typeof UserUpdateSchema>;

export const UserImportResultSchema = z.object({
  dryRun: z.boolean(),
  total: z.number().int(),
  created: z.number().int(),
  rows: z.array(z.object({ line: z.number().int(), ok: z.boolean(), errors: z.array(z.string()) })),
});

export const ActivationSchema = z.object({
  /** đường dẫn kích hoạt; mã gốc chỉ hiện một lần */
  url: z.string(),
  qrPayload: z.string(),
  expiresAt: InstantSchema,
});

export const PasswordLinkSchema = z.object({ url: z.string(), expiresAt: InstantSchema });
/** Kết quả xếp hàng gửi thư kích hoạt: `queued` false khi vừa có một thư cho người này trong cùng phút (chống bấm nhiều lần). */
export const InviteEmailSchema = z.object({ queued: z.boolean() });

export const DeviceViewSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  userName: z.string(),
  platform: PlatformSchema,
  name: z.string().nullable(),
  hasPushToken: z.boolean(),
  enrolledAt: InstantSchema,
  lastSeenAt: InstantSchema.nullable(),
  revokedAt: InstantSchema.nullable(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

// ───────────────────────── Đơn vị, ngày nghỉ ─────────────────────────

export const UnitViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  parentId: IdSchema.nullable(),
  headUserId: IdSchema.nullable(),
  headName: z.string().nullable(),
  memberCount: z.number().int(),
});
export type UnitView = z.infer<typeof UnitViewSchema>;
export const UnitCreateSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: IdSchema.nullable().default(null),
  headUserId: IdSchema.nullable().default(null),
});
export const UnitUpdateSchema = UnitCreateSchema.partial();

export const HolidaySchema = z.object({ day: LocalDateSchema, name: z.string().min(1), kind: HolidayKindSchema });
export type Holiday = z.infer<typeof HolidaySchema>;
export const HolidaySuggestionSchema = HolidaySchema.extend({
  /** ngày âm viết đủ, khi ngày lễ tính theo âm lịch */
  lunarLabel: z.string().nullable(),
  alreadyAdded: z.boolean(),
});
