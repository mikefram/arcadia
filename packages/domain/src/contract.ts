import { z } from 'zod';
import { IdSchema, LocalDateSchema, ProposalStateSchema, UserStatusSchema } from './enums';
import { TEMPLATE_DRAFT_ACTIONS, type Action } from './permissions';
import { RegisterCodeSchema, RegisterEntriesQuerySchema, RegisterEntriesSchema, RegisterUpsertSchema, RegisterViewSchema } from './api/documents';
import { FILE_UPLOAD_BODY_LIMIT, FileListSchema, FileUploadSchema, FileViewSchema, RunFilesAttachSchema, StepCompileResponseSchema } from './api/files';
import {
  AdminNotificationSchema,
  BriefingSchema,
  NotificationListQuerySchema,
  NotificationListSchema,
  NotificationReadSchema,
} from './api/notifications';
import {
  AiUsageQuerySchema,
  AiUsageResponseSchema,
  AuditEntrySchema,
  AuditQuerySchema,
  EffectQuerySchema,
  EffectViewSchema,
  ReportQuerySchema,
  ReportSchema,
} from './api/admin';
import {
  DeviceActivateResponseSchema,
  DeviceActivateSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MfaVerifySchema,
  PasswordSetSchema,
  PushTokenSchema,
  RefreshRequestSchema,
  StepUpChallengeSchema,
  StepUpRequestSchema,
  StepUpResponseSchema,
  TokenPairSchema,
  TotpEnableSchema,
  TotpSetupSchema,
} from './api/auth';
import { IdParamSchema, OkSchema, PageQuerySchema, PersonRefSchema, paged } from './api/common';
import {
  ActivationSchema,
  DelegationCreateSchema,
  DelegationViewSchema,
  DeviceViewSchema,
  HolidaySchema,
  HolidaySuggestionSchema,
  MeSchema,
  OrgSettingsPatchSchema,
  OrgSettingsSchema,
  EmailSettingsPutSchema,
  EmailSettingsViewSchema,
  EmailTestResultSchema,
  EmailTestSchema,
  InviteEmailSchema,
  PasswordLinkSchema,
  RoleGrantSchema,
  UnitCreateSchema,
  UnitUpdateSchema,
  UnitViewSchema,
  UserCreateSchema,
  UserImportResultSchema,
  UserPrefsPatchSchema,
  UserUpdateSchema,
  UserViewSchema,
} from './api/org';
import {
  PermissionMatrixSchema,
  PermissionRoleViewSchema,
  RoleParamSchema,
  RolePermissionsSetSchema,
  UserPermissionsSetSchema,
  UserPermissionsViewSchema,
} from './api/permissions';
import {
  ProposalBatchConfirmSchema,
  ProposalConfirmResponseSchema,
  ProposalConfirmSchema,
  ProposalCreateOfficeSchema,
  ProposalListQuerySchema,
  ProposalRejectSchema,
  ProposalViewSchema,
} from './api/proposals';
import {
  ActivityItemSchema,
  ExtensionDecideSchema,
  ExtensionRequestViewSchema,
  NudgeDraftRequestSchema,
  NudgeDraftResponseSchema,
  NudgeSendResponseSchema,
  NudgeSendSchema,
  OverviewSchema,
  RunCancelSchema,
  RunCreateSchema,
  RunDetailSchema,
  RunEventViewSchema,
  RunEventsQuerySchema,
  RunListQuerySchema,
  RunNoteSchema,
  RunShareParamsSchema,
  RunShareSetSchema,
  RunSharesSchema,
  RunSummarySchema,
  StepApproveSchema,
  StepAssigneesRequestSchema,
  StepAssigneesResponseSchema,
  StepBatchResponseSchema,
  StepBatchSchema,
  StepBlockSchema,
  StepCompileSchema,
  StepCommentCreateSchema,
  StepCommentListSchema,
  StepCommentParamsSchema,
  StepCommentSchema,
  StepCompleteSchema,
  StepDetailSchema,
  StepExtendSchema,
  StepExtensionRequestSchema,
  StepListQuerySchema,
  StepReassignSchema,
  StepRejectSchema,
  StepResultSchema,
  StepSkipSchema,
  StepViewSchema,
  TaskCreateSchema,
} from './api/runs';
import {
  InternalClaimResponseSchema,
  InternalMessageSchema,
  InternalToolCallSchema,
  InternalToolResultSchema,
  InternalUsageResponseSchema,
  InternalUsageSchema,
  ScribeSessionCreateSchema,
  ScribeSessionSchema,
} from './api/scribe';
import {
  DraftSaveResponseSchema,
  DraftSaveSchema,
  PublishResponseSchema,
  SimulateRequestSchema,
  SimulateResponseSchema,
  TemplateCreateSchema,
  TemplateDetailSchema,
  TemplateDiffSchema,
  TemplateCategorySchema,
  TemplatePresetSchema,
  TemplateSummarySchema,
  TemplateVersionSchema,
  ValidateResponseSchema,
} from './api/templates';

/**
 * Hợp đồng API v1 (SPEC 10). Một bảng duy nhất: `apps/api` đăng ký route từ bảng này
 * (kiểm Zod, quyền, Idempotency-Key, sinh OpenAPI) và `packages/api-client` suy ra kiểu gọi từ nó,
 * nên web và hai app không thể lệch tên trường với máy chủ.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteDef = {
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  /**
   * none: không cần đăng nhập. user: cookie phiên (web) hoặc bearer (app).
   * service: service token của ai_service, chỉ ở /internal/v1/*, không đưa ra Internet.
   */
  auth: 'none' | 'user' | 'service';
  /** quyền theo vai trò (SPEC 9.1). Thiếu = mọi người dùng đã đăng nhập. */
  permission?: Action;
  /** một trong các quyền này là đủ */
  anyPermission?: readonly Action[];
  /** bắt buộc X-Step-Up-Token trong mọi trường hợp (riêng duyệt việc có tiền thì kiểm theo dữ liệu) */
  stepUp?: boolean;
  /** cần header If-Match */
  ifMatch?: boolean;
  /** giới hạn cỡ thân yêu cầu (byte) cao hơn mặc định của máy chủ, ví dụ tải tệp lên */
  bodyLimit?: number;
  /** mặc định: mọi yêu cầu ghi của `user` ngoài /v1/auth/* bắt buộc Idempotency-Key (SPEC 10.1) */
  idempotency?: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  status?: 200 | 201;
};

const r = <const R extends RouteDef>(def: R): R => def;

const DayParam = z.object({ day: LocalDateSchema });
const VersionParam = z.object({ id: IdSchema, n: z.coerce.number().int().min(1) });

export const routes = {
  // ───── 10.2 Xác thực, thiết bị, hồ sơ ─────
  'auth.login': r({ method: 'POST', path: '/v1/auth/login', tag: 'auth', summary: 'Đăng nhập web bằng email và mật khẩu', auth: 'none', body: LoginRequestSchema, response: LoginResponseSchema }),
  'auth.mfaVerify': r({ method: 'POST', path: '/v1/auth/mfa/verify', tag: 'auth', summary: 'Xác minh TOTP, tạo phiên 8 giờ', auth: 'none', body: MfaVerifySchema, response: LoginResponseSchema }),
  'auth.logout': r({ method: 'POST', path: '/v1/auth/logout', tag: 'auth', summary: 'Thu hồi phiên hoặc thiết bị hiện tại', auth: 'user', response: OkSchema }),
  'auth.refresh': r({ method: 'POST', path: '/v1/auth/refresh', tag: 'auth', summary: 'Đổi refresh token lấy cặp mới (xoay vòng)', auth: 'none', body: RefreshRequestSchema, response: TokenPairSchema }),
  'auth.stepUpChallenge': r({ method: 'POST', path: '/v1/auth/step-up/challenge', tag: 'auth', summary: 'Lấy thử thách để thiết bị ký', auth: 'user', response: StepUpChallengeSchema }),
  'auth.stepUp': r({ method: 'POST', path: '/v1/auth/step-up', tag: 'auth', summary: 'Đổi assertion lấy stepUpToken sống 60 giây', auth: 'user', body: StepUpRequestSchema, response: StepUpResponseSchema }),
  'auth.totpSetup': r({ method: 'POST', path: '/v1/auth/totp/setup', tag: 'auth', summary: 'Tạo khoá TOTP để quét', auth: 'user', response: TotpSetupSchema }),
  'auth.totpEnable': r({ method: 'POST', path: '/v1/auth/totp/enable', tag: 'auth', summary: 'Bật TOTP sau khi nhập đúng mã', auth: 'user', body: TotpEnableSchema, response: OkSchema }),
  'auth.passwordSet': r({ method: 'POST', path: '/v1/auth/password/set', tag: 'auth', summary: 'Đặt mật khẩu bằng đường dẫn một lần', auth: 'none', body: PasswordSetSchema, response: OkSchema }),
  'devices.activate': r({ method: 'POST', path: '/v1/devices/activate', tag: 'auth', summary: 'Kích hoạt thiết bị bằng mã một lần', auth: 'none', body: DeviceActivateSchema, response: DeviceActivateResponseSchema }),
  'me.get': r({ method: 'GET', path: '/v1/me', tag: 'me', summary: 'Hồ sơ của tôi', auth: 'user', response: MeSchema }),
  'me.prefs': r({ method: 'PATCH', path: '/v1/me/prefs', tag: 'me', summary: 'Cỡ chữ, tốc độ đọc, giọng, giờ bản tin, giờ yên tĩnh', auth: 'user', body: UserPrefsPatchSchema, response: MeSchema }),
  'me.pushTokenPut': r({ method: 'PUT', path: '/v1/me/push-token', tag: 'me', summary: 'Ghi push token của thiết bị', auth: 'user', body: PushTokenSchema, response: OkSchema }),
  'me.pushTokenDelete': r({ method: 'DELETE', path: '/v1/me/push-token', tag: 'me', summary: 'Xoá push token của thiết bị', auth: 'user', response: OkSchema }),
  'users.activation': r({ method: 'POST', path: '/v1/users/:id/activation', tag: 'users', summary: 'Tạo mã kích hoạt thiết bị (QR, đường dẫn); `app` chọn app nhân viên hay app Chủ tịch, mặc định theo vai trò', auth: 'user', permission: 'device.manage', params: IdParamSchema, query: z.object({ app: z.enum(['staff', 'executive']).optional() }), response: ActivationSchema }),
  'users.passwordLink': r({ method: 'POST', path: '/v1/users/:id/password-link', tag: 'users', summary: 'Tạo đường dẫn đặt mật khẩu web', auth: 'user', permission: 'user.manage', params: IdParamSchema, response: PasswordLinkSchema }),
  'users.inviteEmail': r({ method: 'POST', path: '/v1/users/:id/invite-email', tag: 'users', summary: 'Gửi lại thư kích hoạt tài khoản (đường dẫn đặt mật khẩu web) tới email trong hồ sơ; worker gửi qua nhà cung cấp thư', auth: 'user', permission: 'user.manage', params: IdParamSchema, response: InviteEmailSchema }),
  'users.totpReset': r({ method: 'POST', path: '/v1/users/:id/totp/reset', tag: 'users', summary: 'Đặt lại TOTP của một người mất máy xác thực: tắt TOTP, xoá khoá, thu hồi phiên web; cần X-Step-Up-Token, không tự đặt cho mình', auth: 'user', permission: 'user.manage', params: IdParamSchema, response: OkSchema }),
  'devices.list': r({ method: 'GET', path: '/v1/devices', tag: 'users', summary: 'Xem thiết bị', auth: 'user', permission: 'device.manage', query: z.object({ userId: IdSchema.optional() }), response: z.object({ items: z.array(DeviceViewSchema) }) }),
  'devices.revoke': r({ method: 'POST', path: '/v1/devices/:id/revoke', tag: 'users', summary: 'Thu hồi thiết bị', auth: 'user', permission: 'device.manage', params: IdParamSchema, response: OkSchema }),

  // ───── 10.3 Người dùng và tổ chức ─────
  'people.search': r({ method: 'GET', path: '/v1/people', tag: 'org', summary: 'Tìm người theo tên, không phân biệt dấu', auth: 'user', query: z.object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(100).default(20) }), response: z.object({ items: z.array(PersonRefSchema.extend({ unitName: z.string().nullable(), roleTitle: z.string().nullable() })) }) }),
  'users.list': r({ method: 'GET', path: '/v1/users', tag: 'users', summary: 'Danh sách người dùng', auth: 'user', permission: 'user.manage', query: PageQuerySchema.extend({ q: z.string().optional(), unitId: IdSchema.optional(), status: UserStatusSchema.optional() }), response: paged(UserViewSchema) }),
  'users.create': r({ method: 'POST', path: '/v1/users', tag: 'users', summary: 'Thêm người dùng', auth: 'user', permission: 'user.manage', body: UserCreateSchema, response: UserViewSchema, status: 201 }),
  'users.get': r({ method: 'GET', path: '/v1/users/:id', tag: 'users', summary: 'Một người dùng', auth: 'user', permission: 'user.manage', params: IdParamSchema, response: UserViewSchema }),
  'users.update': r({ method: 'PATCH', path: '/v1/users/:id', tag: 'users', summary: 'Sửa hồ sơ', auth: 'user', permission: 'user.manage', params: IdParamSchema, body: UserUpdateSchema, response: UserViewSchema }),
  'users.import': r({ method: 'POST', path: '/v1/users/import', tag: 'users', summary: 'Nhập CSV theo mẫu; dryRun chỉ báo lỗi từng dòng', auth: 'user', permission: 'user.manage', query: z.object({ dryRun: z.enum(['true', 'false']).default('false') }), body: z.object({ csv: z.string().min(1) }), response: UserImportResultSchema }),
  'users.disable': r({ method: 'POST', path: '/v1/users/:id/disable', tag: 'users', summary: 'Vô hiệu hoá: thu hồi thiết bị, việc đang giữ sang "Cần giao người"', auth: 'user', permission: 'user.manage', params: IdParamSchema, response: UserViewSchema }),
  'users.enable': r({ method: 'POST', path: '/v1/users/:id/enable', tag: 'users', summary: 'Bật lại người dùng', auth: 'user', permission: 'user.manage', params: IdParamSchema, response: UserViewSchema }),
  'permissions.get': r({ method: 'GET', path: '/v1/permissions', tag: 'permissions', summary: 'Bảng quyền của từng vai trò: mặc định, quyền thật sau chỉnh của tổ chức, số người giữ', auth: 'user', permission: 'permission.manage', response: PermissionMatrixSchema }),
  'permissions.setRole': r({ method: 'PUT', path: '/v1/permissions/roles/:role', tag: 'permissions', summary: 'Đặt bộ quyền của một vai trò (chỉ lưu phần khác bảng mặc định)', auth: 'user', permission: 'permission.manage', params: RoleParamSchema, body: RolePermissionsSetSchema, response: PermissionRoleViewSchema }),
  'permissions.resetRole': r({ method: 'POST', path: '/v1/permissions/roles/:role/reset', tag: 'permissions', summary: 'Khôi phục quyền mặc định của một vai trò', auth: 'user', permission: 'permission.manage', params: RoleParamSchema, response: PermissionRoleViewSchema }),
  'users.permissions': r({ method: 'GET', path: '/v1/users/:id/permissions', tag: 'permissions', summary: 'Quyền của một người: từ vai trò, chỉnh riêng, quyền thật', auth: 'user', permission: 'permission.manage', params: IdParamSchema, response: UserPermissionsViewSchema }),
  'users.setPermissions': r({ method: 'PUT', path: '/v1/users/:id/permissions', tag: 'permissions', summary: 'Đặt chỉnh riêng của một người (thêm/bớt quyền so với vai trò, không đổi vai trò)', auth: 'user', permission: 'permission.manage', params: IdParamSchema, body: UserPermissionsSetSchema, response: UserPermissionsViewSchema }),
  'users.setRoles': r({ method: 'PUT', path: '/v1/users/:id/roles', tag: 'users', summary: 'Đặt vai trò và phạm vi đơn vị', auth: 'user', permission: 'user.manage', params: IdParamSchema, body: z.object({ roles: z.array(RoleGrantSchema).min(1) }), response: UserViewSchema }),
  'units.list': r({ method: 'GET', path: '/v1/units', tag: 'org', summary: 'Cây đơn vị', auth: 'user', response: z.object({ items: z.array(UnitViewSchema) }) }),
  'units.create': r({ method: 'POST', path: '/v1/units', tag: 'org', summary: 'Tạo đơn vị', auth: 'user', permission: 'unit.manage', body: UnitCreateSchema, response: UnitViewSchema, status: 201 }),
  'units.update': r({ method: 'PATCH', path: '/v1/units/:id', tag: 'org', summary: 'Sửa đơn vị', auth: 'user', permission: 'unit.manage', params: IdParamSchema, body: UnitUpdateSchema, response: UnitViewSchema }),
  'delegations.list': r({ method: 'GET', path: '/v1/delegations', tag: 'org', summary: 'Ủy quyền (quản trị: tất cả; người dùng: của mình)', auth: 'user', anyPermission: ['delegation.manage', 'delegation.self'], response: z.object({ items: z.array(DelegationViewSchema) }) }),
  'delegations.create': r({ method: 'POST', path: '/v1/delegations', tag: 'org', summary: 'Tạo ủy quyền; điều hành tự tạo phải kèm X-Step-Up-Token', auth: 'user', anyPermission: ['delegation.manage', 'delegation.self'], body: DelegationCreateSchema, response: DelegationViewSchema, status: 201 }),
  'delegations.delete': r({ method: 'DELETE', path: '/v1/delegations/:id', tag: 'org', summary: 'Xoá ủy quyền', auth: 'user', anyPermission: ['delegation.manage', 'delegation.self'], params: IdParamSchema, response: OkSchema }),
  'holidays.list': r({ method: 'GET', path: '/v1/holidays', tag: 'org', summary: 'Ngày nghỉ theo năm', auth: 'user', query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), response: z.object({ items: z.array(HolidaySchema) }) }),
  'holidays.suggestions': r({ method: 'GET', path: '/v1/holidays/suggestions', tag: 'org', summary: 'Gợi ý ngày lễ cố định', auth: 'user', permission: 'holiday.manage', query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), response: z.object({ items: z.array(HolidaySuggestionSchema) }) }),
  'holidays.put': r({ method: 'PUT', path: '/v1/holidays/:day', tag: 'org', summary: 'Ghi một ngày nghỉ', auth: 'user', permission: 'holiday.manage', params: DayParam, body: HolidaySchema.omit({ day: true }), response: HolidaySchema }),
  'holidays.delete': r({ method: 'DELETE', path: '/v1/holidays/:day', tag: 'org', summary: 'Xoá một ngày nghỉ', auth: 'user', permission: 'holiday.manage', params: DayParam, response: OkSchema }),
  'org.settingsGet': r({ method: 'GET', path: '/v1/org/settings', tag: 'org', summary: 'Cấu hình tổ chức', auth: 'user', anyPermission: ['org.settings', 'holiday.manage'], response: OrgSettingsSchema }),
  'org.emailGet': r({ method: 'GET', path: '/v1/org/email-settings', tag: 'org', summary: 'Cấu hình gửi thư của tổ chức (không trả khoá API)', auth: 'user', permission: 'org.settings', response: EmailSettingsViewSchema }),
  'org.emailPut': r({ method: 'PUT', path: '/v1/org/email-settings', tag: 'org', summary: 'Đặt nhà cung cấp thư, địa chỉ gửi và khoá API (chỉ ghi, được mã hoá); bỏ trống khoá thì giữ khoá cũ', auth: 'user', permission: 'org.settings', body: EmailSettingsPutSchema, response: EmailSettingsViewSchema }),
  'org.emailDelete': r({ method: 'DELETE', path: '/v1/org/email-settings', tag: 'org', summary: 'Xoá cấu hình gửi thư của tổ chức (quay về cấu hình của máy chủ nếu có)', auth: 'user', permission: 'org.settings', response: EmailSettingsViewSchema }),
  'org.emailTest': r({ method: 'POST', path: '/v1/org/email-settings/test', tag: 'org', summary: 'Gửi một thư thử tới địa chỉ chỉ định bằng cấu hình đang dùng', auth: 'user', permission: 'org.settings', body: EmailTestSchema, response: EmailTestResultSchema }),
  'org.settingsPatch': r({ method: 'PATCH', path: '/v1/org/settings', tag: 'org', summary: 'Sửa cấu hình tổ chức', auth: 'user', permission: 'org.settings', body: OrgSettingsPatchSchema, response: OrgSettingsSchema }),
  'admin.aiUsage': r({ method: 'GET', path: '/v1/admin/ai-usage', tag: 'admin', summary: 'Số liệu dùng AI, không có nội dung hội thoại', auth: 'user', permission: 'ai_usage.view', query: AiUsageQuerySchema, response: AiUsageResponseSchema }),
  'admin.audit': r({ method: 'GET', path: '/v1/admin/audit-log', tag: 'admin', summary: 'Nhật ký hoạt động', auth: 'user', permission: 'audit.view', query: AuditQuerySchema, response: paged(AuditEntrySchema) }),
  'admin.notifications': r({ method: 'GET', path: '/v1/admin/notifications', tag: 'admin', summary: 'Trạng thái gửi và đọc của thông báo', auth: 'user', permission: 'notification.audit', query: PageQuerySchema.extend({ state: z.string().optional(), userId: IdSchema.optional() }), response: paged(AdminNotificationSchema) }),
  'admin.effects': r({ method: 'GET', path: '/v1/admin/effects', tag: 'admin', summary: 'Hàng effect (mặc định: lỗi `dead`)', auth: 'user', permission: 'effect.retry', query: EffectQuerySchema, response: paged(EffectViewSchema) }),
  'admin.effectRetry': r({ method: 'POST', path: '/v1/admin/effects/:id/retry', tag: 'admin', summary: 'Thử lại một effect lỗi', auth: 'user', permission: 'effect.retry', params: IdParamSchema, response: EffectViewSchema }),

  // ───── 10.4 Mẫu quy trình ─────
  'templates.list': r({ method: 'GET', path: '/v1/templates', tag: 'templates', summary: 'Danh sách mẫu (người không có quyền xem mẫu chỉ thấy mẫu mình khởi chạy được)', auth: 'user', query: z.object({ q: z.string().optional(), archived: z.enum(['true', 'false']).optional(), category: TemplateCategorySchema.optional() }), response: z.object({ items: z.array(TemplateSummarySchema) }) }),
  'templates.presets': r({ method: 'GET', path: '/v1/template-presets', tag: 'templates', summary: 'Thư viện quy trình mẫu có sẵn (Chỉ thị, Văn bản đến, Văn bản đi)', auth: 'user', permission: 'template.edit', response: z.object({ items: z.array(TemplatePresetSchema) }) }),
  'templates.get': r({ method: 'GET', path: '/v1/templates/:id', tag: 'templates', summary: 'Một mẫu, kèm nháp nếu là người vẽ', auth: 'user', params: IdParamSchema, response: TemplateDetailSchema }),
  'templates.version': r({ method: 'GET', path: '/v1/templates/:id/versions/:n', tag: 'templates', summary: 'Một phiên bản kèm definition', auth: 'user', params: VersionParam, response: TemplateVersionSchema }),
  'templates.create': r({ method: 'POST', path: '/v1/templates', tag: 'templates', summary: 'Tạo mẫu và bản nháp đầu', auth: 'user', permission: 'template.edit', body: TemplateCreateSchema, response: TemplateDetailSchema, status: 201 }),
  'templates.saveDraft': r({ method: 'PUT', path: '/v1/templates/:id/draft', tag: 'templates', summary: 'Lưu nháp (If-Match = rev). Nháp còn lỗi vẫn lưu được', auth: 'user', permission: 'template.edit', ifMatch: true, params: IdParamSchema, body: DraftSaveSchema, response: DraftSaveResponseSchema }),
  'templates.validate': r({ method: 'POST', path: '/v1/templates/:id/validate', tag: 'templates', summary: 'Chạy validate() trên nháp', auth: 'user', anyPermission: TEMPLATE_DRAFT_ACTIONS, idempotency: false, params: IdParamSchema, response: ValidateResponseSchema }),
  'templates.simulate': r({ method: 'POST', path: '/v1/templates/:id/simulate', tag: 'templates', summary: 'Chạy thử: ai làm gì, hạn nào. Hàm thuần, không ghi CSDL', auth: 'user', permission: 'template.simulate', idempotency: false, params: IdParamSchema, body: SimulateRequestSchema, response: SimulateResponseSchema }),
  'templates.publish': r({ method: 'POST', path: '/v1/templates/:id/publish', tag: 'templates', summary: 'Xuất bản phiên bản bất biến', auth: 'user', permission: 'template.publish', params: IdParamSchema, response: PublishResponseSchema }),
  'templates.archive': r({ method: 'POST', path: '/v1/templates/:id/archive', tag: 'templates', summary: 'Lưu trữ: không cho khởi chạy mới', auth: 'user', permission: 'template.archive', params: IdParamSchema, body: z.object({ archived: z.boolean().default(true) }), response: TemplateSummarySchema }),
  'templates.diff': r({ method: 'GET', path: '/v1/templates/:id/diff', tag: 'templates', summary: 'So sánh hai phiên bản', auth: 'user', anyPermission: TEMPLATE_DRAFT_ACTIONS, params: IdParamSchema, query: z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), response: TemplateDiffSchema }),

  // ───── 10.5 Lượt chạy và việc ─────
  'overview.get': r({ method: 'GET', path: '/v1/overview', tag: 'runs', summary: 'Thẻ số tổng quan (cùng nguồn với get_overview)', auth: 'user', permission: 'overview.view', query: z.object({ unitId: IdSchema.optional() }), response: OverviewSchema }),
  'activity.list': r({ method: 'GET', path: '/v1/activity', tag: 'runs', summary: 'Hoạt động gần đây', auth: 'user', permission: 'overview.view', query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }), response: z.object({ items: z.array(ActivityItemSchema) }) }),
  'runs.create': r({ method: 'POST', path: '/v1/runs', tag: 'runs', summary: 'Khởi chạy lượt chạy mới (StartRun)', auth: 'user', body: RunCreateSchema, response: RunDetailSchema, status: 201 }),
  'tasks.create': r({ method: 'POST', path: '/v1/tasks', tag: 'steps', summary: 'Giao một việc ngoài quy trình cho bất kỳ ai', auth: 'user', permission: 'task.assign', body: TaskCreateSchema, response: StepResultSchema, status: 201 }),
  'runs.list': r({ method: 'GET', path: '/v1/runs', tag: 'runs', summary: 'Danh sách lượt chạy theo tầm nhìn', auth: 'user', query: RunListQuerySchema, response: paged(RunSummarySchema) }),
  'runs.get': r({ method: 'GET', path: '/v1/runs/:id', tag: 'runs', summary: 'Chi tiết lượt chạy', auth: 'user', params: IdParamSchema, response: RunDetailSchema }),
  'runs.events': r({ method: 'GET', path: '/v1/runs/:id/events', tag: 'runs', summary: 'Dòng thời gian từ run_events (ai thấy được lượt chạy thì đọc được; phần nội dung của người đóng góp khác được che)', auth: 'user', params: IdParamSchema, query: RunEventsQuerySchema, response: z.object({ items: z.array(RunEventViewSchema), nextSeq: z.number().int().nullable() }) }),
  'runs.cancel': r({ method: 'POST', path: '/v1/runs/:id/cancel', tag: 'runs', summary: 'Huỷ lượt chạy; confirmTitle phải trùng tên', auth: 'user', permission: 'run.cancel', params: IdParamSchema, body: RunCancelSchema, response: RunDetailSchema }),
  'runs.note': r({ method: 'POST', path: '/v1/runs/:id/notes', tag: 'runs', summary: 'Ghi chú vào lượt chạy', auth: 'user', params: IdParamSchema, body: RunNoteSchema, response: OkSchema }),
  'steps.list': r({ method: 'GET', path: '/v1/steps', tag: 'steps', summary: 'Việc theo tầm nhìn', auth: 'user', query: StepListQuerySchema, response: paged(StepViewSchema) }),
  'steps.get': r({ method: 'GET', path: '/v1/steps/:id', tag: 'steps', summary: 'Chi tiết việc kèm lịch sử', auth: 'user', params: IdParamSchema, response: StepDetailSchema }),
  'steps.comments.list': r({ method: 'GET', path: '/v1/steps/:id/comments', tag: 'steps', summary: 'Bình luận của việc, cũ nhất trước; ai thấy việc thì đọc được', auth: 'user', params: IdParamSchema, query: PageQuerySchema, response: StepCommentListSchema }),
  'steps.comments.add': r({ method: 'POST', path: '/v1/steps/:id/comments', tag: 'steps', summary: 'Viết bình luận (không đổi trạng thái việc); người giữ hoặc duyệt việc, người khởi chạy, người xem mọi lượt (lượt thường), người được chia sẻ mức bình luận', auth: 'user', params: IdParamSchema, body: StepCommentCreateSchema, response: StepCommentSchema, status: 201 }),
  'steps.comments.delete': r({ method: 'DELETE', path: '/v1/steps/:id/comments/:commentId', tag: 'steps', summary: 'Xoá bình luận của chính mình (xoá mềm)', auth: 'user', params: StepCommentParamsSchema, response: OkSchema }),
  'runs.shares.list': r({ method: 'GET', path: '/v1/runs/:id/shares', tag: 'runs', summary: 'Chia sẻ của lượt chạy: người được chia sẻ, chủ sở hữu và người tham gia, cùng quyền của người xem', auth: 'user', params: IdParamSchema, response: RunSharesSchema }),
  'runs.shares.set': r({ method: 'PUT', path: '/v1/runs/:id/shares/:userId', tag: 'runs', summary: 'Thêm hoặc đổi mức chia sẻ (viewer, commenter); chủ sở hữu hoặc người có run.share', auth: 'user', params: RunShareParamsSchema, body: RunShareSetSchema, response: RunSharesSchema }),
  'runs.shares.remove': r({ method: 'DELETE', path: '/v1/runs/:id/shares/:userId', tag: 'runs', summary: 'Gỡ người khỏi danh sách chia sẻ; không gỡ được chủ sở hữu và người tham gia', auth: 'user', params: RunShareParamsSchema, response: RunSharesSchema }),
  'steps.accept': r({ method: 'POST', path: '/v1/steps/:id/accept', tag: 'steps', summary: 'Đã nhận (AcceptStep)', auth: 'user', params: IdParamSchema, response: StepResultSchema }),
  'steps.complete': r({ method: 'POST', path: '/v1/steps/:id/complete', tag: 'steps', summary: 'Báo hoàn thành (CompleteStep)', auth: 'user', params: IdParamSchema, body: StepCompleteSchema, response: StepResultSchema }),
  'steps.approve': r({ method: 'POST', path: '/v1/steps/:id/approve', tag: 'steps', summary: 'Đồng ý (ApproveStep); có tiền thì cần X-Step-Up-Token', auth: 'user', params: IdParamSchema, body: StepApproveSchema, response: StepResultSchema }),
  'steps.reject': r({ method: 'POST', path: '/v1/steps/:id/reject', tag: 'steps', summary: 'Chưa đồng ý (RejectStep), bắt buộc lý do', auth: 'user', params: IdParamSchema, body: StepRejectSchema, response: StepResultSchema }),
  'steps.requestExtension': r({ method: 'POST', path: '/v1/steps/:id/extension-requests', tag: 'steps', summary: 'Xin thêm thời gian (RequestExtension)', auth: 'user', params: IdParamSchema, body: StepExtensionRequestSchema, response: StepResultSchema }),
  'steps.block': r({ method: 'POST', path: '/v1/steps/:id/block', tag: 'steps', summary: 'Báo vướng (ReportBlocked)', auth: 'user', params: IdParamSchema, body: StepBlockSchema, response: StepResultSchema }),
  'steps.reassign': r({ method: 'POST', path: '/v1/steps/:id/reassign', tag: 'steps', summary: 'Giao lại (Reassign), bắt buộc lý do', auth: 'user', params: IdParamSchema, body: StepReassignSchema, response: StepResultSchema }),
  'steps.extend': r({ method: 'POST', path: '/v1/steps/:id/extend', tag: 'steps', summary: 'Gia hạn (ExtendDue)', auth: 'user', permission: 'step.extend', params: IdParamSchema, body: StepExtendSchema, response: StepResultSchema }),
  'steps.skip': r({ method: 'POST', path: '/v1/steps/:id/skip', tag: 'steps', summary: 'Bỏ qua bước (SkipStep), bắt buộc lý do', auth: 'user', permission: 'step.skip', params: IdParamSchema, body: StepSkipSchema, response: StepResultSchema }),
  'steps.assignees': r({ method: 'POST', path: '/v1/steps/assignees', tag: 'steps', summary: 'Những người nhận được việc khi giao lại (người được bổ nhiệm, người được ủy quyền)', auth: 'user', idempotency: false, body: StepAssigneesRequestSchema, response: StepAssigneesResponseSchema }),
  'steps.batch': r({ method: 'POST', path: '/v1/steps/batch', tag: 'steps', summary: 'Giao lại hoặc gia hạn hàng loạt, tối đa 50', auth: 'user', permission: 'step.batch', body: StepBatchSchema, response: StepBatchResponseSchema }),
  'extensionRequests.list': r({ method: 'GET', path: '/v1/extension-requests', tag: 'steps', summary: 'Yêu cầu gia hạn chờ duyệt', auth: 'user', query: z.object({ state: z.enum(['pending', 'approved', 'declined']).default('pending') }), response: z.object({ items: z.array(ExtensionRequestViewSchema) }) }),
  'extensionRequests.decide': r({ method: 'POST', path: '/v1/extension-requests/:id/decide', tag: 'steps', summary: 'Duyệt hoặc chưa duyệt yêu cầu gia hạn', auth: 'user', params: IdParamSchema, body: ExtensionDecideSchema, response: StepResultSchema }),
  'files.upload': r({ method: 'POST', path: '/v1/files', tag: 'files', summary: 'Tải tệp lên (nhận base64, tối đa 20 MB); tệp chờ gắn vào việc, tự dọn sau 24 giờ nếu không gắn', auth: 'user', bodyLimit: FILE_UPLOAD_BODY_LIMIT, body: FileUploadSchema, response: FileViewSchema, status: 201 }),
  'files.download': r({ method: 'GET', path: '/v1/files/:id/content', tag: 'files', summary: 'Tải tệp xuống (nhị phân, không phải JSON: phản hồi là nội dung tệp)', auth: 'user', params: IdParamSchema, response: z.null() }),
  'files.remove': r({ method: 'DELETE', path: '/v1/files/:id', tag: 'files', summary: 'Xoá tệp mới tải lên mà chưa gắn vào việc nào', auth: 'user', params: IdParamSchema, response: OkSchema }),
  'runs.attachFiles': r({ method: 'POST', path: '/v1/runs/:id/files', tag: 'runs', summary: 'Đính thêm tài liệu vào lượt chạy đang chạy (tệp đã tải lên, còn chờ gắn); người khởi chạy, người từng giữ việc trong lượt, hoặc người có run.note', auth: 'user', params: IdParamSchema, body: RunFilesAttachSchema, response: FileListSchema }),
  'runs.files': r({ method: 'GET', path: '/v1/runs/:id/files', tag: 'runs', summary: 'Mọi tệp đính kèm của lượt chạy', auth: 'user', params: IdParamSchema, response: FileListSchema }),
  'steps.compile': r({ method: 'POST', path: '/v1/steps/:id/compile', tag: 'steps', summary: 'Xuất tệp tổng hợp (Word kèm bản PDF) từ dữ liệu của lượt chạy và phần người làm đang gõ (việc tổng hợp có cấu hình compile)', auth: 'user', params: IdParamSchema, body: StepCompileSchema, response: StepCompileResponseSchema, status: 201 }),

  // ───── Sổ văn bản (docs/DECISIONS.md, 06/10/2026) ─────
  'registers.list': r({ method: 'GET', path: '/v1/registers', tag: 'documents', summary: 'Các sổ văn bản (người vẽ quy trình cũng đọc được để chọn sổ cho ô cấp số)', auth: 'user', anyPermission: ['document.view', 'org.settings', 'template.edit'], response: z.object({ items: z.array(RegisterViewSchema) }) }),
  'registers.upsert': r({ method: 'PUT', path: '/v1/registers/:code', tag: 'documents', summary: 'Tạo hoặc sửa một sổ văn bản (tên, mẫu số, cột hiển thị)', auth: 'user', permission: 'org.settings', params: z.object({ code: RegisterCodeSchema }), body: RegisterUpsertSchema, response: RegisterViewSchema }),
  'registers.entries': r({ method: 'GET', path: '/v1/registers/:code/entries', tag: 'documents', summary: 'Các dòng của sổ văn bản, mới nhất trước', auth: 'user', permission: 'document.view', params: z.object({ code: RegisterCodeSchema }), query: RegisterEntriesQuerySchema, response: RegisterEntriesSchema }),

  // ───── 10.6 Đi thúc và đề xuất ─────
  'nudges.drafts': r({ method: 'POST', path: '/v1/nudges/drafts', tag: 'nudges', summary: 'Soạn nháp lời nhắc theo ma trận xưng hô', auth: 'user', permission: 'nudge.send', idempotency: false, body: NudgeDraftRequestSchema, response: NudgeDraftResponseSchema }),
  'nudges.send': r({ method: 'POST', path: '/v1/nudges', tag: 'nudges', summary: 'Gửi lời nhắc đã đọc và sửa', auth: 'user', permission: 'nudge.send', body: NudgeSendSchema, response: NudgeSendResponseSchema }),
  'proposals.list': r({ method: 'GET', path: '/v1/proposals', tag: 'proposals', summary: 'Đề xuất đang chờ chính mình', auth: 'user', query: ProposalListQuerySchema, response: z.object({ items: z.array(ProposalViewSchema) }) }),
  'proposals.get': r({ method: 'GET', path: '/v1/proposals/:id', tag: 'proposals', summary: 'Một đề xuất; câu chữ do máy chủ dựng', auth: 'user', params: IdParamSchema, response: ProposalViewSchema }),
  'proposals.confirm': r({ method: 'POST', path: '/v1/proposals/:id/confirm', tag: 'proposals', summary: 'Xác nhận; mức 2 cần X-Step-Up-Token', auth: 'user', params: IdParamSchema, body: ProposalConfirmSchema, response: ProposalConfirmResponseSchema }),
  'proposalBatches.confirm': r({ method: 'POST', path: '/v1/proposal-batches/:id/confirm', tag: 'proposals', summary: 'Xác nhận cả lô mức 1 một lần', auth: 'user', params: IdParamSchema, body: ProposalBatchConfirmSchema, response: ProposalConfirmResponseSchema }),
  'proposals.reject': r({ method: 'POST', path: '/v1/proposals/:id/reject', tag: 'proposals', summary: 'Không gửi', auth: 'user', params: IdParamSchema, body: ProposalRejectSchema, response: ProposalViewSchema }),
  'proposals.undo': r({ method: 'POST', path: '/v1/proposals/:id/undo', tag: 'proposals', summary: 'Hoàn tác trong 30 giây', auth: 'user', params: IdParamSchema, response: ProposalViewSchema }),
  'proposals.sendNow': r({ method: 'POST', path: '/v1/proposals/:id/send-now', tag: 'proposals', summary: 'Gửi ngay, bỏ phần còn lại của 30 giây (không áp cho mức 2)', auth: 'user', params: IdParamSchema, response: ProposalViewSchema }),
  'proposals.create': r({ method: 'POST', path: '/v1/proposals', tag: 'proposals', summary: 'Trình từ Văn phòng (giai đoạn 3)', auth: 'user', permission: 'proposal.create_office', body: ProposalCreateOfficeSchema, response: z.object({ items: z.array(ProposalViewSchema) }), status: 201 }),
  'conversations.delete': r({ method: 'DELETE', path: '/v1/conversations', tag: 'proposals', summary: 'Xoá lịch sử hội thoại của chính mình', auth: 'user', response: OkSchema }),

  // ───── 10.7 AI Scribe ─────
  'scribe.createSession': r({ method: 'POST', path: '/v1/scribe/sessions', tag: 'scribe', summary: 'Tạo phiên Scribe, trả token dùng một lần', auth: 'user', permission: 'assistant.use', idempotency: false, body: ScribeSessionCreateSchema, response: ScribeSessionSchema, status: 201 }),
  'internal.tool': r({ method: 'POST', path: '/internal/v1/tools/:name', tag: 'internal', summary: 'Chạy một tool thay người dùng ở X-On-Behalf-Of', auth: 'service', params: z.object({ name: z.string() }), body: InternalToolCallSchema, response: InternalToolResultSchema }),
  'internal.claim': r({ method: 'POST', path: '/internal/v1/scribe/sessions/:id/claim', tag: 'internal', summary: 'Đánh dấu token phiên đã dùng', auth: 'service', params: IdParamSchema, body: z.object({ jti: z.string() }), response: InternalClaimResponseSchema }),
  'internal.message': r({ method: 'POST', path: '/internal/v1/messages', tag: 'internal', summary: 'Ghi messages của hội thoại (không ghi âm thanh)', auth: 'service', body: InternalMessageSchema, response: OkSchema }),
  'internal.usage': r({ method: 'POST', path: '/internal/v1/scribe/usage', tag: 'internal', summary: 'Cộng số liệu dùng AI, trả quotaLeft', auth: 'service', body: InternalUsageSchema, response: InternalUsageResponseSchema }),

  // ───── 10.9 Thông báo ─────
  'notifications.list': r({ method: 'GET', path: '/v1/notifications', tag: 'notifications', summary: 'Tin của chính mình', auth: 'user', query: NotificationListQuerySchema, response: NotificationListSchema }),
  'notifications.read': r({ method: 'POST', path: '/v1/notifications/read', tag: 'notifications', summary: 'Đánh dấu đã đọc', auth: 'user', idempotency: false, body: NotificationReadSchema, response: OkSchema }),
  'notifications.opened': r({ method: 'POST', path: '/v1/notifications/:id/opened', tag: 'notifications', summary: 'Ghi opened_at khi mở từ thông báo đẩy', auth: 'user', idempotency: false, params: IdParamSchema, response: OkSchema }),
  'briefings.latest': r({ method: 'GET', path: '/v1/briefings/latest', tag: 'notifications', summary: 'Báo cáo tổng hợp đầu ngày của hôm nay (chưa có thì dựng ngay)', auth: 'user', permission: 'briefing.view', response: BriefingSchema.nullable() }),

  // ───── 9.6 Báo cáo ─────
  'reports.summary': r({ method: 'GET', path: '/v1/reports/summary', tag: 'reports', summary: 'Các chỉ số báo cáo', auth: 'user', permission: 'report.view', query: ReportQuerySchema, response: ReportSchema }),
} as const satisfies Record<string, RouteDef>;

export type Routes = typeof routes;
export type RouteKey = keyof Routes;

type In<T> = T extends z.ZodType ? z.input<T> : never;
type Out<T> = T extends z.ZodType ? z.output<T> : never;

/** Tham số phía client của một route. */
export type RouteArgs<K extends RouteKey> = (Routes[K] extends { params: infer P } ? { params: In<P> } : { params?: undefined }) &
  (Routes[K] extends { query: infer Q } ? { query?: In<Q> } : { query?: undefined }) &
  (Routes[K] extends { body: infer B } ? { body: In<B> } : { body?: undefined });

/** Dữ liệu đã kiểm phía máy chủ của một route. */
export type RouteInput<K extends RouteKey> = {
  params: Routes[K] extends { params: infer P } ? Out<P> : undefined;
  query: Routes[K] extends { query: infer Q } ? Out<Q> : undefined;
  body: Routes[K] extends { body: infer B } ? Out<B> : undefined;
};

export type RouteResponse<K extends RouteKey> = Out<Routes[K]['response']>;

/** Yêu cầu ghi của người dùng ngoài /v1/auth/* bắt buộc Idempotency-Key, trừ route khai báo `idempotency: false`. */
export function requiresIdempotencyKey(def: RouteDef): boolean {
  if (def.idempotency !== undefined) return def.idempotency;
  if (def.method === 'GET') return false;
  if (def.auth !== 'user') return false;
  return !def.path.startsWith('/v1/auth/');
}

/** Trạng thái đề xuất hợp lệ ở query. */
export { ProposalStateSchema };
