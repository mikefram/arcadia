/**
 * Schema Drizzle (SPEC 5.2, 5.3, 10.10). Tệp này là nguồn để `drizzle-kit generate` sinh migration
 * bảng và chỉ mục. RLS, quyền của ba vai trò CSDL, trigger chặn sửa xoá và các view nằm ở migration
 * SQL viết tay trong db/migrations (drizzle-kit không sinh được).
 *
 * Không import gói nội bộ ở đây: drizzle-kit nạp tệp này độc lập.
 * Mọi bảng nghiệp vụ có org_id (CLAUDE.md luật 1). Cột id do ứng dụng sinh (UUID v7).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id);

// ───────────────────────── Tổ chức và người ─────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  /** 'mihato', 'vrg' */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  /** OrgSettings: workdays, workStart, workEnd, quietHours, nudgeTemplates, ai, … */
  settings: jsonb('settings').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const units = pgTable('units', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => units.id),
  headUserId: uuid('head_user_id').references((): AnyPgColumn => users.id),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    fullName: text('full_name').notNull(),
    givenName: text('given_name').notNull(),
    honorific: text('honorific'),
    email: text('email'),
    phone: text('phone'),
    unitId: uuid('unit_id').references((): AnyPgColumn => units.id),
    managerId: uuid('manager_id').references((): AnyPgColumn => users.id),
    uiProfile: text('ui_profile').notNull().default('standard'),
    /** thứ tự hiển thị do Văn phòng nhập (SPEC 7.5) */
    displayOrder: integer('display_order').notNull().default(0),
    /** cỡ chữ, tốc độ đọc, giờ nhận bản tin, giờ yên tĩnh (SPEC 10.2) */
    prefs: jsonb('prefs').notNull().default({}),
    status: text('status').notNull().default('invited'),
    /** Argon2id; null khi chưa đặt mật khẩu web */
    passwordHash: text('password_hash'),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('users_org_email').on(t.orgId, t.email),
    check('users_honorific_check', sql`${t.honorific} IS NULL OR ${t.honorific} IN ('anh','chi','ong','ba','co','chu','bac')`),
    check('users_ui_profile_check', sql`${t.uiProfile} IN ('senior','standard')`),
    check('users_status_check', sql`${t.status} IN ('invited','active','disabled')`),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    /** NULL = toàn tổ chức */
    unitId: uuid('unit_id').references(() => units.id),
  },
  (t) => [
    unique('user_roles_unique').on(t.userId, t.role, t.unitId).nullsNotDistinct(),
    check('user_roles_role_check', sql`${t.role} IN ('chairman','director','deputy','office_admin','process_designer','it_admin','employee')`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    platform: text('platform').notNull(),
    name: text('name'),
    pushToken: text('push_token'),
    /** khoá công khai ES256 (JWK) để kiểm assertion nâng quyền [GIẢ ĐỊNH, Q16] */
    stepUpPublicKey: jsonb('step_up_public_key'),
    enrolledAt: ts('enrolled_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [check('devices_platform_check', sql`${t.platform} IN ('ios','android','web')`), index('devices_user').on(t.orgId, t.userId)],
);

export const delegations = pgTable(
  'delegations',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id),
    validFrom: ts('valid_from').notNull(),
    validTo: ts('valid_to').notNull(),
    scope: text('scope').notNull(),
    /** id mẫu hoặc tên vai trò khi scope khác 'all' */
    scopeRef: text('scope_ref'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (t) => [check('delegations_scope_check', sql`${t.scope} IN ('all','process','role')`), check('delegations_range_check', sql`${t.validTo} > ${t.validFrom}`)],
);

// ───────────────────────── Quy trình ─────────────────────────

export const processTemplates = pgTable(
  'process_templates',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    name: text('name').notNull(),
    description: text('description'),
    /** 'process' = quy trình do người thiết kế vẽ; 'adhoc' = mẫu một việc, ẩn, do máy chủ dựng cho mỗi việc ngoài quy trình */
    kind: text('kind').notNull().default('process'),
    /** nhóm quy trình để lọc và gom: directive (chỉ thị), incoming (văn bản đến), outgoing (văn bản đi), general và các nhóm nghiệp vụ; không ràng buộc ở CSDL, Zod kiểm */
    category: text('category').notNull().default('general'),
    archivedAt: ts('archived_at'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('process_templates_kind_check', sql`${t.kind} IN ('process','adhoc')`)],
);

export const processTemplateVersions = pgTable(
  'process_template_versions',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => processTemplates.id),
    version: integer('version').notNull(),
    /** ProcessDefinition (SPEC 4.2); nháp có thể còn dở */
    definition: jsonb('definition').notNull(),
    status: text('status').notNull(),
    /** tăng mỗi lần lưu nháp; dùng cho If-Match */
    draftRev: integer('draft_rev').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by').references(() => users.id),
  },
  (t) => [unique('template_versions_unique').on(t.templateId, t.version), check('template_versions_status_check', sql`${t.status} IN ('draft','published')`)],
);

/**
 * Chỉnh quyền (docs/DECISIONS.md, 05/10/2026), lưu THƯA: chỉ phần khác bảng mặc định ở packages/domain/src/permissions.ts.
 * `subject_type = 'role'`: `subject` là tên vai trò, chỉnh áp cho mọi người giữ vai trò đó.
 * `subject_type = 'user'`: `subject` là id người dùng, chỉnh riêng một người; đổi vai trò của họ không làm mất dòng này.
 * `effect`: 'grant' = thêm quyền, 'revoke' = bớt quyền. Mỗi (tổ chức, đối tượng, quyền) chỉ một dòng.
 */
export const permissionRules = pgTable(
  'permission_rules',
  {
    orgId: orgId(),
    subjectType: text('subject_type').notNull(),
    subject: text('subject').notNull(),
    action: text('action').notNull(),
    effect: text('effect').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.subjectType, t.subject, t.action] }),
    check('permission_rules_subject_type_check', sql`${t.subjectType} IN ('role','user')`),
    check('permission_rules_effect_check', sql`${t.effect} IN ('grant','revoke')`),
  ],
);

export const holidays = pgTable(
  'holidays',
  {
    orgId: orgId(),
    day: date('day', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] }), check('holidays_kind_check', sql`${t.kind} IN ('public','company','makeup_workday')`)],
);

// ───────────────────────── Chạy việc ─────────────────────────

export const processRuns = pgTable(
  'process_runs',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => processTemplates.id),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => processTemplateVersions.id),
    title: text('title').notNull(),
    initiatorId: uuid('initiator_id')
      .notNull()
      .references(() => users.id),
    state: text('state').notNull(),
    outcome: text('outcome'),
    inputs: jsonb('inputs').notNull().default({}),
    /** mốc đích (ngày đoàn đến) */
    targetAt: ts('target_at'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    /** tăng mỗi lần advance() */
    version: integer('version').notNull().default(0),
    /**
     * Mức mật, tính MỘT LẦN lúc khởi chạy từ ô `mucMat` của biểu mẫu (packages/domain/src/confidentiality.ts), không đổi sau đó.
     * 'restricted': chỉ chủ sở hữu, người tham gia và người được chia sẻ (run_shares) thấy; `run.view_all` không đủ.
     */
    confidentiality: text('confidentiality').notNull().default('normal'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('process_runs_confidentiality_check', sql`${t.confidentiality} IN ('normal','restricted')`),
    check('process_runs_state_check', sql`${t.state} IN ('draft','running','completed','cancelled','failed')`),
    check('process_runs_outcome_check', sql`${t.outcome} IS NULL OR ${t.outcome} IN ('success','rejected')`),
    index('process_runs_org_state').on(t.orgId, t.state),
  ],
);

export const stepRuns = pgTable(
  'step_runs',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processRuns.id),
    nodeId: text('node_id').notNull(),
    attempt: integer('attempt').notNull().default(1),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    state: text('state').notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id),
    onBehalfOfId: uuid('on_behalf_of_id').references(() => users.id),
    assignedBy: uuid('assigned_by').references(() => users.id),
    dueAt: ts('due_at'),
    dueOriginalAt: ts('due_original_at'),
    activatedAt: ts('activated_at'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    result: jsonb('result'),
    reason: text('reason'),
    /** cờ "Đang vướng" (SPEC 8.2), xoá khi xong hoặc đổi người */
    blockedReason: text('blocked_reason'),
    /** chống làm phiền (SPEC 4.6) */
    lastReminderOn: date('last_reminder_on', { mode: 'string' }),
    lastNudgedAt: ts('last_nudged_at'),
  },
  (t) => [
    unique('step_runs_unique').on(t.runId, t.nodeId, t.attempt),
    check('step_runs_kind_check', sql`${t.kind} IN ('start','end','task','approval','condition','timer','notify','webhook')`),
    check('step_runs_state_check', sql`${t.state} IN ('pending','unassigned','ready','in_progress','done','rejected','skipped','cancelled')`),
    index('step_runs_assignee').on(t.orgId, t.assigneeId, t.state),
    index('step_runs_open_due')
      .on(t.orgId, t.dueAt)
      .where(sql`state IN ('unassigned','ready','in_progress')`),
    index('step_runs_run').on(t.runId),
  ],
);

/** Chia sẻ lượt chạy kiểu Google Drive (docs/DECISIONS.md, 07/10/2026 điểm b): mỗi người một mức, xem hoặc bình luận. */
export const runShares = pgTable(
  'run_shares',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processRuns.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('run_shares_run_user').on(t.runId, t.userId),
    check('run_shares_role_check', sql`${t.role} IN ('viewer','commenter')`),
    index('run_shares_user').on(t.orgId, t.userId),
  ],
);

/** Bình luận theo việc (điểm a). Không phải sự kiện engine: không đổi trạng thái việc. Xoá mềm bằng `deleted_at`. */
export const stepComments = pgTable(
  'step_comments',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => processRuns.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    // Thân rỗng chỉ hợp lệ khi bình luận có tệp đính kèm (máy chủ kiểm); 0 ở đây để bình luận chỉ có tệp lưu được.
    check('step_comments_body_check', sql`char_length(${t.body}) BETWEEN 0 AND 4000`),
    index('step_comments_step').on(t.orgId, t.stepRunId, t.createdAt),
    index('step_comments_author').on(t.orgId, t.authorId, t.createdAt),
  ],
);

export const stepApprovals = pgTable(
  'step_approvals',
  {
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id),
    orgId: orgId(),
    approverId: uuid('approver_id')
      .notNull()
      .references(() => users.id),
    onBehalfOfId: uuid('on_behalf_of_id').references(() => users.id),
    decision: text('decision'),
    reason: text('reason'),
    decidedAt: ts('decided_at'),
    /** phần người này gửi khi nút duyệt hoặc đóng góp có biểu mẫu */
    result: jsonb('result'),
    fileIds: uuid('file_ids').array().notNull().default(sql`'{}'::uuid[]`),
  },
  (t) => [
    primaryKey({ columns: [t.stepRunId, t.approverId] }),
    check('step_approvals_decision_check', sql`${t.decision} IS NULL OR ${t.decision} IN ('approved','rejected')`),
    index('step_approvals_approver').on(t.orgId, t.approverId),
  ],
);

export const extensionRequests = pgTable(
  'extension_requests',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    proposedDueAt: ts('proposed_due_at').notNull(),
    reason: text('reason').notNull(),
    state: text('state').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('extension_requests_state_check', sql`${t.state} IN ('pending','approved','declined')`), index('extension_requests_step').on(t.stepRunId)],
);

/** Chỉ thêm, không sửa, không xoá. id chính là eventId, chống lặp. */
export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processRuns.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    /** có khi sự kiện xuất phát từ một đề xuất AI */
    proposalId: uuid('proposal_id'),
    payload: jsonb('payload').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [
    unique('run_events_run_seq').on(t.runId, t.seq),
    check('run_events_actor_type_check', sql`${t.actorType} IN ('user','system','ai')`),
    index('run_events_run').on(t.runId, t.seq),
  ],
);

// ───────────────────────── Hạ tầng engine ─────────────────────────

export const effects = pgTable(
  'effects',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    runId: uuid('run_id').references(() => processRuns.id),
    /** notify.assigned, notify.reminder, webhook, proposal.apply, … */
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lockedAt: ts('locked_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('effects_state_check', sql`${t.state} IN ('pending','processing','done','dead')`),
    index('effects_pending')
      .on(t.nextAttemptAt)
      .where(sql`state = 'pending'`),
  ],
);

export const timers = pgTable(
  'timers',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processRuns.id),
    stepRunId: uuid('step_run_id').references(() => stepRuns.id),
    /** reminder, overdue, escalation, wait */
    kind: text('kind').notNull(),
    fireAt: ts('fire_at').notNull(),
    state: text('state').notNull().default('pending'),
    lockedAt: ts('locked_at'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** TimerData của engine */
    data: jsonb('data').notNull().default({}),
  },
  (t) => [
    check('timers_state_check', sql`${t.state} IN ('pending','firing','done','cancelled')`),
    index('timers_pending')
      .on(t.fireAt)
      .where(sql`state = 'pending'`),
    index('timers_run').on(t.runId),
  ],
);

// ───────────────────────── Thông báo ─────────────────────────

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** dữ liệu đi kèm: liên kết sâu, bản tin sáng (SPEC 10.9) */
    payload: jsonb('payload').notNull().default({}),
    runId: uuid('run_id').references(() => processRuns.id),
    stepRunId: uuid('step_run_id').references(() => stepRuns.id),
    state: text('state').notNull().default('queued'),
    /** vé Expo chờ lấy biên nhận: [{ ticketId, token }] */
    pushTickets: jsonb('push_tickets'),
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    openedAt: ts('opened_at'),
    /** người dùng đánh dấu đã đọc trong app (khác opened: mở từ thông báo đẩy) */
    readAt: ts('read_at'),
  },
  (t) => [
    check('notifications_state_check', sql`${t.state} IN ('queued','sent','delivered','opened','failed')`),
    index('notifications_user').on(t.orgId, t.userId, t.createdAt.desc()),
  ],
);

export const nudges = pgTable(
  'nudges',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id),
    proposalId: uuid('proposal_id').references(() => proposals.id),
    message: text('message').notNull(),
    aiDrafted: boolean('ai_drafted').notNull().default(false),
    sentAt: ts('sent_at').notNull(),
    reply: text('reply'),
    repliedAt: ts('replied_at'),
  },
  (t) => [check('nudges_reply_check', sql`${t.reply} IS NULL OR ${t.reply} IN ('done','need_time','blocked')`), index('nudges_step').on(t.stepRunId, t.sentAt)],
);

// ───────────────────────── AI ─────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channel: text('channel').notNull(),
    transcriptConsent: boolean('transcript_consent').notNull().default(false),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [check('conversations_channel_check', sql`${t.channel} IN ('voice','text')`)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    sttConfidence: real('stt_confidence'),
    /** luôn NULL trừ khi tổ chức bật lưu âm thanh */
    audioRef: text('audio_ref'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('messages_role_check', sql`${t.role} IN ('user','assistant','tool')`), index('messages_conversation').on(t.conversationId, t.createdAt)],
);

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /** người phải xác nhận */
    forUserId: uuid('for_user_id')
      .notNull()
      .references(() => users.id),
    /** nhóm đề xuất xác nhận một lần (mức 1) */
    batchId: uuid('batch_id'),
    /** propose_nudge, propose_start_run, … */
    tool: text('tool').notNull(),
    /** tham số đã kiểm bằng Zod */
    payload: jsonb('payload').notNull(),
    /** câu hiển thị cho người xác nhận, do máy chủ dựng */
    summary: text('summary').notNull(),
    /** 0 = ghi chép, máy chủ tự xác nhận */
    risk: smallint('risk').notNull(),
    source: text('source').notNull().default('ai'),
    /** người soạn khi source = 'office' */
    createdBy: uuid('created_by').references(() => users.id),
    state: text('state').notNull().default('pending'),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: ts('confirmed_at'),
    confirmedVia: text('confirmed_via'),
    /** mốc hiệu lực chạy (xác nhận + 30 giây) */
    effectiveAt: ts('effective_at'),
    /** bằng chứng khi xác nhận bằng giọng hoặc sửa lời nhắc (SPEC 10.6) */
    transcript: text('transcript'),
    sttConfidence: real('stt_confidence'),
    editedMessages: jsonb('edited_messages'),
    result: jsonb('result'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('proposals_risk_check', sql`${t.risk} IN (0,1,2)`),
    check('proposals_source_check', sql`${t.source} IN ('ai','office')`),
    check('proposals_state_check', sql`${t.state} IN ('pending','confirmed','rejected','expired','failed','undone')`),
    check('proposals_confirmed_via_check', sql`${t.confirmedVia} IS NULL OR ${t.confirmedVia} IN ('touch','voice','auto')`),
    index('proposals_pending')
      .on(t.orgId, t.forUserId)
      .where(sql`state = 'pending'`),
  ],
);

export const scribeSessions = pgTable('scribe_sessions', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  deviceId: uuid('device_id').references(() => devices.id),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  /** token dùng một lần: claimed_at khác NULL là đã dùng */
  claimedAt: ts('claimed_at'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const aiUsage = pgTable(
  'ai_usage',
  {
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    day: date('day', { mode: 'string' }).notNull(),
    llmCalls: integer('llm_calls').notNull().default(0),
    llmInputTokens: bigint('llm_input_tokens', { mode: 'number' }).notNull().default(0),
    llmOutputTokens: bigint('llm_output_tokens', { mode: 'number' }).notNull().default(0),
    sttSeconds: integer('stt_seconds').notNull().default(0),
    ttsChars: integer('tts_chars').notNull().default(0),
    errors: integer('errors').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.day] })],
);

// ───────────────────────── Xác thực (lớp tạm, chờ Q12) ─────────────────────────

/** Phiên web: cookie httpOnly mang `<orgId>.<mã ngẫu nhiên>`; CSDL chỉ lưu SHA-256. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user').on(t.orgId, t.userId)],
);

/** Refresh token của thiết bị, xoay vòng. Dùng lại token đã dùng → thu hồi cả thiết bị (SPEC 10.2). */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    usedAt: ts('used_at'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_device').on(t.deviceId)],
);

export const activationTokens = pgTable('activation_tokens', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  /** SHA-256; mã gốc chỉ hiện một lần */
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const passwordTokens = pgTable('password_tokens', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ───────────────────────── Khác ─────────────────────────

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    key: uuid('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    /** SHA-256 của thân yêu cầu */
    requestHash: bytea('request_hash').notNull(),
    state: text('state').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.key] }), check('idempotency_keys_state_check', sql`${t.state} IN ('in_progress','done')`)],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    runId: uuid('run_id').references(() => processRuns.id),
    stepRunId: uuid('step_run_id').references(() => stepRuns.id),
    kind: text('kind').notNull(),
    name: text('name'),
    /** khoá trong kho đối tượng tương thích S3 (SPEC 12) */
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: bytea('sha256'),
    /** âm thanh bản tin tự xoá sau 3 ngày [MỤC TIÊU] */
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** 'pending' = vừa tải lên, chưa gắn vào lượt chạy nào (tự dọn sau 24 giờ); 'attached' = đã gắn */
    status: text('status').notNull().default('attached'),
    /** ô biểu mẫu mà tệp được đính kèm qua; '__compiled' là tệp tổng hợp do máy chủ dựng */
    fieldKey: text('field_key'),
    /** quét vi-rút (SPEC 11): chưa có dịch vụ quét nên ghi 'skipped' [GIẢ ĐỊNH] */
    scanStatus: text('scan_status').notNull().default('skipped'),
    /** bản PDF của một tệp Word tổng hợp: trỏ tới tệp Word đã dựng cùng lúc (docs/DECISIONS.md, 06/10/2026) */
    sourceFileId: uuid('source_file_id').references((): AnyPgColumn => files.id),
    /** bình luận mà tệp đính kèm vào (docs/DECISIONS.md, 12/10/2026); tệp loại này mang fieldKey '__comment' và không hiện ở hồ sơ lượt chạy */
    commentId: uuid('comment_id').references((): AnyPgColumn => stepComments.id),
  },
  (t) => [
    check('files_kind_check', sql`${t.kind} IN ('attachment','briefing_audio')`),
    check('files_status_check', sql`${t.status} IN ('pending','attached')`),
    index('files_run').on(t.orgId, t.runId),
    index('files_comment').on(t.orgId, t.commentId),
    index('files_pending').on(t.status, t.createdAt),
  ],
);

/**
 * Sổ văn bản (docs/DECISIONS.md, 06/10/2026): mỗi sổ có mẫu số và cách đánh lại từ đầu; ô `autonumber` của biểu mẫu trỏ tới
 * một sổ qua `code`. `columns` là các ô của biểu mẫu hiện thành cột ở màn Sổ văn bản.
 */
export const documentRegisters = pgTable(
  'document_registers',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** incoming = văn bản đến, outgoing = văn bản đi, internal = nội bộ (chỉ thị, quyết định) */
    direction: text('direction').notNull(),
    /** mẫu số: {seq}, {seq:4} (đệm số 0), {yyyy}, {yy} */
    pattern: text('pattern').notNull().default('{seq}'),
    resetPolicy: text('reset_policy').notNull().default('yearly'),
    columns: jsonb('columns').notNull().default(sql`'[]'::jsonb`),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_registers_code').on(t.orgId, t.code),
    check('document_registers_direction_check', sql`${t.direction} IN ('incoming','outgoing','internal')`),
    check('document_registers_reset_check', sql`${t.resetPolicy} IN ('yearly','never')`),
  ],
);

/** Bộ đếm theo sổ và năm (năm 0 cho sổ không đánh lại). Cấp số bằng một câu UPSERT khoá hàng nên không trùng, không hụt khi chạy song song. */
export const documentCounters = pgTable(
  'document_counters',
  {
    orgId: orgId(),
    registerId: uuid('register_id')
      .notNull()
      .references(() => documentRegisters.id),
    year: integer('year').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.registerId, t.year] })],
);

/** Một dòng của sổ văn bản: số đã cấp cho một lượt chạy. `values` là ảnh chụp các ô lên cột lúc cấp số. */
export const documentEntries = pgTable(
  'document_entries',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    registerId: uuid('register_id')
      .notNull()
      .references(() => documentRegisters.id),
    year: integer('year').notNull(),
    seq: integer('seq').notNull(),
    /** số đã dựng theo mẫu, ví dụ 12/VRG-VP */
    number: text('number').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processRuns.id),
    fieldKey: text('field_key').notNull(),
    subject: text('subject').notNull(),
    values: jsonb('values').notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_entries_seq').on(t.registerId, t.year, t.seq),
    index('document_entries_run').on(t.orgId, t.runId),
    index('document_entries_register').on(t.orgId, t.registerId, t.createdAt),
  ],
);

/** Chỉ thêm; trigger cấm UPDATE và DELETE như run_events. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    orgId: orgId(),
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorDeviceId: uuid('actor_device_id').references(() => devices.id),
    /** login, login_failed, device_activated, device_revoked, role_changed, refresh_reuse, proposal_confirmed, … */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    detail: jsonb('detail').notNull().default({}),
  },
  (t) => [check('audit_log_actor_type_check', sql`${t.actorType} IN ('user','system','ai_service')`), index('audit_log_org_at').on(t.orgId, t.at.desc())],
);

/** Nhịp tim của worker cho /readyz (SPEC 12.4). Không phải bảng nghiệp vụ: không có org_id. */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  name: text('name').primaryKey(),
  beatAt: ts('beat_at').notNull().defaultNow(),
});

/**
 * Cấu hình gửi thư của tổ chức (đặt ở web quản trị, thay cho biến môi trường). Mỗi tổ chức một dòng.
 * Khoá API của nhà cung cấp lưu MÃ HOÁ (AES-256-GCM, xem services/email-settings.ts), chỉ ghi, không bao giờ trả ra API.
 */
export const orgEmailSettings = pgTable(
  'org_email_settings',
  {
    orgId: orgId().primaryKey(),
    provider: text('provider').notNull().default('resend'),
    /** địa chỉ gửi, dạng `Tên <thu@ten-mien>` */
    fromAddress: text('from_address').notNull(),
    /** nonce(12) + thẻ xác thực(16) + bản mã; trống khi chưa nhập khoá */
    apiKeyEnc: bytea('api_key_enc'),
    /** 4 ký tự cuối của khoá để quản trị nhận ra khoá nào đang dùng */
    apiKeyHint: text('api_key_hint'),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('org_email_settings_provider_check', sql`${t.provider} IN ('resend')`)],
);
