import { ApiError, PG_NOTIFY_CHANNEL, deterministicId, type NotificationKind, type NotificationView, type StreamEvent } from '@mihato/domain';
import { fmt, formatDateWeekday, formatTime, vi } from '@mihato/i18n';
import { PUSH_BATCH_SIZE, type PushMessage, type PushProvider } from '@mihato/providers/push';
import { and, desc, eq, inArray, isNotNull, isNull, lt, gt, sql } from 'drizzle-orm';
import { audit } from '../audit';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { insertEffect } from '../engine/runner';
import { env } from '../env';
import type { Viewer } from '../views';
import { quietUntil } from './nudges';

type NotificationRow = typeof schema.notifications.$inferSelect;

export type NotificationDraft = {
  /** id tất định theo effect: worker chạy lại không tạo trùng */
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  /** hiện trong app sau khi mở: có thể nêu người làm, hạn */
  body: string;
  /** đi qua Expo, Google, Apple: không có tên người, số tiền hay nội dung (SPEC 8.3, 11.5) */
  pushBody: string;
  payload: Record<string, unknown>;
  runId: string | null;
  stepId: string | null;
  /** inapp: chỉ hiện trong app, không đẩy */
  channel: 'push' | 'inapp';
  channelId: 'work' | 'nudge';
  priority: 'high' | 'normal';
  ttlSeconds?: number;
};

type Templates = Record<string, { title: string; body: string } | undefined>;
const templates = vi.notifications as unknown as Templates;

function text(kind: NotificationKind, vars: Record<string, string | number>): { title: string; body: string } {
  const t = templates[kind] ?? templates.system ?? { title: '{việc}', body: '' };
  return { title: fmt(t.title, vars).trim(), body: fmt(t.body, vars).trim() };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

/** Loại thông báo mà phần thân của tin đẩy chỉ nêu hạn (không tên người, không nội dung). */
const PUSH_BODY_WITH_DUE = new Set<NotificationKind>(['assigned', 'approval_needed', 'reminder_due_tomorrow', 'reminder_due_today', 'reminder', 'overdue', 'due_changed', 'extension_approved']);

/** Nhắc việc có hạn sống 4 giờ để tin "hôm nay đến hạn" không đến sau khi hết ngày [MỤC TIÊU, SPEC 10.9]. */
const REMINDER_TTL_S = 4 * 60 * 60;

/**
 * Dựng thông báo từ một effect `notify.*` của engine. Chữ lấy từ packages/i18n; tiêu đề chỉ có tên việc và mã,
 * không có số tiền hay nội dung (SPEC 8.3, 11.1) vì tiêu đề đi qua Expo, Google và Apple.
 */
export async function draftFromEffect(
  tx: Tx,
  ctx: OrgContext,
  effectId: string,
  payload: { kind: string; toUserId: string; runId?: string | null; stepId?: string | null; data?: Record<string, unknown> },
): Promise<NotificationDraft | null> {
  const user = ctx.users.get(payload.toUserId);
  if (!user || user.status === 'disabled') return null;
  const data = payload.data ?? {};
  let stepTitle = str(data.stepTitle);
  let runTitle = str(data.runTitle);
  let runId = payload.runId ?? null;
  if (payload.stepId && (!stepTitle || !runTitle || !runId)) {
    const [row] = await tx
      .select({ title: schema.stepRuns.title, runId: schema.stepRuns.runId, runTitle: schema.processRuns.title })
      .from(schema.stepRuns)
      .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
      .where(eq(schema.stepRuns.id, payload.stepId));
    stepTitle ||= row?.title ?? '';
    runTitle ||= row?.runTitle ?? '';
    runId ??= row?.runId ?? null;
  } else if (runId && !runTitle) {
    const [row] = await tx.select({ title: schema.processRuns.title }).from(schema.processRuns).where(eq(schema.processRuns.id, runId));
    runTitle = row?.title ?? '';
  }
  const sender = ctx.settings.nudgeTemplates.senderName;
  const dueAt = str(data.proposedDueAt) || str(data.newDueAt) || str(data.dueAt);
  const dueText = dueAt ? `${formatDateWeekday(dueAt)} ${formatTime(dueAt)}` : vi.common.due.none;
  const nameOf = (id: unknown) => (typeof id === 'string' ? (ctx.person(id)?.fullName ?? '') : '');
  let assigneeId = str(data.assigneeId);
  if (!assigneeId && payload.stepId) {
    const [row] = await tx.select({ assigneeId: schema.stepRuns.assigneeId }).from(schema.stepRuns).where(eq(schema.stepRuns.id, payload.stepId));
    assigneeId = row?.assigneeId ?? '';
  }
  const vars: Record<string, string | number> = {
    việc: stepTitle,
    lượt: runTitle,
    n: Math.max(1, num(data.lateWorkingDays, 1)),
    người: nameOf(data.actorId) || nameOf(data.approverId) || nameOf(assigneeId),
    // "Người giao" của tin "Việc mới"; với lời đi thúc là danh tính người gửi của tổ chức.
    'người gửi': payload.kind === 'notify.assigned' ? nameOf(data.assignedBy) || sender : sender,
    hạn: dueText,
  };

  let kind: NotificationKind;
  let channel: NotificationDraft['channel'] = 'push';
  let channelId: NotificationDraft['channelId'] = 'work';
  let priority: NotificationDraft['priority'] = 'normal';
  let ttlSeconds: number | undefined;
  let body: string | null = null;
  const link = payload.stepId ? `${env.appScheme}://step/${payload.stepId}` : runId ? `${env.appScheme}://run/${runId}` : null;
  const extra: Record<string, unknown> = {};

  switch (payload.kind) {
    case 'notify.assigned':
      if (data.stepKind === 'approval') {
        // Chủ tịch: "Có 1 việc cần Chủ tịch quyết", mở tới M6 (SPEC 10.9). Người khác: "Cần duyệt: …" (SPEC 8.3).
        kind = user.roles.some((r) => r.role === 'chairman') ? 'approval' : 'approval_needed';
        priority = 'high';
        vars.n = 1;
      } else if (data.needsAssignee) {
        // Việc tới lượt nhưng chưa xác định được người nhận: Văn phòng thấy "Cần giao người" trong app.
        kind = 'unassigned';
        channel = 'inapp';
      } else kind = 'assigned';
      break;
    case 'notify.reassigned':
      kind = 'reassigned';
      break;
    case 'notify.accepted':
      kind = 'accepted';
      channel = 'inapp';
      break;
    case 'notify.completed':
      kind = 'completed';
      channel = 'inapp';
      break;
    case 'notify.rejected':
      kind = 'rejected';
      break;
    case 'notify.extension_requested':
      kind = 'extension_requested';
      break;
    case 'notify.extension_declined':
      kind = 'extension_declined';
      break;
    case 'notify.due_changed':
      kind = data.extensionRequestId ? 'extension_approved' : 'due_changed';
      break;
    case 'notify.run_cancelled':
      kind = 'run_cancelled';
      break;
    case 'notify.run_completed':
      kind = 'run_completed';
      channel = 'inapp';
      break;
    case 'notify.reminder':
      kind = data.variant === 'due_tomorrow' ? 'reminder_due_tomorrow' : data.variant === 'due_today' ? 'reminder_due_today' : 'reminder';
      ttlSeconds = REMINDER_TTL_S;
      break;
    case 'notify.overdue':
      kind = 'overdue';
      ttlSeconds = REMINDER_TTL_S;
      break;
    case 'notify.escalation':
      kind = 'escalation';
      // Quá hạn 3 ngày làm việc: Văn phòng nhận trong app, không đẩy (bảng SPEC 4.6).
      if (data.audience === 'office_admin' || (user.roles.some((r) => r.role === 'office_admin') && num(data.lateWorkingDays) >= 3)) channel = 'inapp';
      break;
    case 'notify.nudge': {
      kind = 'nudge';
      channelId = 'nudge';
      priority = 'high';
      const disclosure = data.aiDrafted ? ctx.settings.nudgeTemplates.aiDisclosure : null;
      body = [str(data.message), disclosure ? `(${disclosure})` : null].filter(Boolean).join('\n');
      extra.nudgeId = data.nudgeId;
      extra.aiDrafted = !!data.aiDrafted;
      break;
    }
    case 'notify.nudge_reply':
      kind = 'nudge_reply';
      extra.reply = data.reply;
      body = vi.common.nudgeReply[str(data.reply) as keyof typeof vi.common.nudgeReply] ?? null;
      break;
    case 'notify.blocked':
      kind = 'blocked';
      break;
    default:
      kind = 'system';
      body = str(data.text) || str(data.template) || null;
  }

  // SPEC 4.6 và 10.9 [QUYẾT ĐỊNH]: Chủ tịch không nhận tin đẩy riêng về việc quá hạn; tin vẫn lưu để hiện trong app và nằm trong
  // báo cáo đầu ngày. Nhắc trước hạn (ngày mai, hôm nay) và việc cần quyết vẫn đẩy bình thường (audit worker-2).
  if ((kind === 'overdue' || kind === 'escalation') && user.roles.some((r) => r.role === 'chairman')) channel = 'inapp';

  const rendered = text(kind, vars);
  return {
    id: deterministicId(`notification:${effectId}`),
    userId: user.id,
    kind,
    title: rendered.title,
    body: body ?? rendered.body,
    pushBody: PUSH_BODY_WITH_DUE.has(kind) && dueAt ? fmt(vi.common.due.label + ': {hạn}', { hạn: dueText }) : kind === 'nudge' ? rendered.body : '',
    payload: { type: kind, link, ...extra },
    runId,
    stepId: payload.stepId ?? null,
    channel,
    channelId,
    priority,
    ttlSeconds,
  };
}

/**
 * Trường của `notifications.payload` được phép đi qua Expo, APNs và FCM (SPEC 11.5, CLAUDE.md luật 6; audit worker-1).
 * Danh sách TRẮNG theo từng loại: chỉ mã, id và cờ. Không bao giờ chép nguyên payload, vì payload của báo cáo đầu ngày
 * mang chữ (tên người, tên việc) và vượt giới hạn 4 KiB của Expo. Loại không có trong bảng chỉ mang `type` và `link`.
 */
const PUSH_DATA_BASE = ['type', 'link'] as const;
const PUSH_DATA_BY_KIND: Record<string, readonly string[]> = {
  briefing: [],
  nudge: ['nudgeId', 'aiDrafted'],
  nudge_reply: ['reply'],
  'proposal.office': ['proposalId', 'batchId', 'count'],
  'proposal.failed': ['proposalId', 'reason'],
  comment_new: ['runId', 'stepId'],
};
const PUSH_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `data` của một tin đẩy: chỉ các trường được phép, giá trị là mã ngắn, số, cờ hoặc id. */
export function pushDataOf(kind: string, payload: Record<string, unknown>, notificationId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...PUSH_DATA_BASE, ...(PUSH_DATA_BY_KIND[kind] ?? [])]) {
    const v = payload[key];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    // `link` là đường dẫn sâu mihato://…; các trường còn lại là mã hoặc id.
    else if (typeof v === 'string' && (key === 'link' ? /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9/_.-]{0,200}$/i.test(v) : PUSH_CODE.test(v))) out[key] = v;
  }
  out.notificationId = notificationId;
  return out;
}

export type DeliverOutcome = { state: 'done' } | { state: 'defer'; until: Date } | { state: 'retry'; reason: string };

/** Giờ yên tĩnh của người nhận: cấu hình riêng ở prefs, nếu không thì theo tổ chức. */
function quietFor(ctx: OrgContext, userId: string, now: Date): Date | null {
  const prefs = ctx.users.get(userId)?.prefs as { quietHours?: { start: string; end: string } | null } | undefined;
  return quietUntil(ctx, now, prefs?.quietHours ?? ctx.settings.quietHours);
}

/**
 * Chuỗi xử lý thông báo (SPEC 10.9 [QUYẾT ĐỊNH]): tạo dòng notifications ở `queued` (một lần, id tất định);
 * trong giờ yên tĩnh thì hoãn tới 07:00, không gửi; ngoài giờ thì gửi tới mọi thiết bị chưa thu hồi của người nhận.
 */
export async function deliverNotification(tx: Tx, ctx: OrgContext, draft: NotificationDraft, push: PushProvider): Promise<DeliverOutcome> {
  const now = clock.now();
  const inserted = await tx
    .insert(schema.notifications)
    .values({
      id: draft.id,
      orgId: ctx.orgId,
      userId: draft.userId,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      payload: draft.payload,
      runId: draft.runId,
      stepRunId: draft.stepId,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.notifications.id });
  if (inserted.length) {
    const event: StreamEvent = { kind: 'notification.created', orgId: ctx.orgId, userId: draft.userId };
    await tx.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
  }
  const [row] = await tx.select().from(schema.notifications).where(eq(schema.notifications.id, draft.id));
  if (!row || row.state !== 'queued') return { state: 'done' };

  if (draft.channel === 'inapp') {
    await tx.update(schema.notifications).set({ state: 'sent', sentAt: now }).where(eq(schema.notifications.id, draft.id));
    return { state: 'done' };
  }
  const quiet = quietFor(ctx, draft.userId, now);
  if (quiet) return { state: 'defer', until: quiet };

  const devices = await tx
    .select({ id: schema.devices.id, pushToken: schema.devices.pushToken })
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, draft.userId), isNull(schema.devices.revokedAt), isNotNull(schema.devices.pushToken)));
  if (devices.length === 0) {
    // Chưa có thiết bị nhận đẩy: người nhận vẫn thấy việc khi mở app (SPEC 10.9).
    await tx.update(schema.notifications).set({ state: 'sent', sentAt: now }).where(eq(schema.notifications.id, draft.id));
    return { state: 'done' };
  }
  const messages: PushMessage[] = devices.slice(0, PUSH_BATCH_SIZE).map((d) => ({
    to: d.pushToken!,
    title: draft.title,
    body: draft.pushBody,
    data: pushDataOf(draft.kind, draft.payload, draft.id),
    channelId: draft.channelId,
    priority: draft.priority,
    ttlSeconds: draft.ttlSeconds,
  }));
  const tickets = await push.sendBatch(messages);
  const okTickets: { ticketId: string; token: string }[] = [];
  let transient = false;
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i]!;
    const device = devices[i]!;
    if (t.ok) okTickets.push({ ticketId: t.ticketId, token: device.pushToken! });
    else if (t.error === 'DeviceNotRegistered') await removePushToken(tx, ctx.orgId, device.id);
    else if (t.error === 'transient') transient = true;
  }
  if (okTickets.length > 0) {
    await tx.update(schema.notifications).set({ state: 'sent', sentAt: now, pushTickets: okTickets }).where(eq(schema.notifications.id, draft.id));
    return { state: 'done' };
  }
  if (transient) return { state: 'retry', reason: 'push_transient' };
  await tx.update(schema.notifications).set({ state: 'failed' }).where(eq(schema.notifications.id, draft.id));
  return { state: 'done' };
}

/** DeviceNotRegistered: ngừng gửi tới token đó, ghi audit_log, hiện ở màn Thông báo và nhật ký (SPEC 10.9 bước 5). */
async function removePushToken(tx: Tx, orgId: string, deviceId: string): Promise<void> {
  await tx.update(schema.devices).set({ pushToken: null }).where(eq(schema.devices.id, deviceId));
  await audit(tx, { orgId, action: 'push_token_removed', actorType: 'system', targetType: 'device', targetId: deviceId, detail: { reason: 'DeviceNotRegistered' } });
}

/** Tác vụ push-receipts: sau 15 phút và trước 24 giờ, hỏi biên nhận; `ok` nghĩa là Expo đã giao cho FCM hoặc APNs. */
export async function checkPushReceipts(tx: Tx, ctx: OrgContext, push: PushProvider): Promise<number> {
  const now = clock.now();
  const rows = await tx
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.state, 'sent'),
        isNotNull(schema.notifications.pushTickets),
        lt(schema.notifications.sentAt, new Date(now.getTime() - 15 * 60_000)),
        gt(schema.notifications.sentAt, new Date(now.getTime() - 24 * 60 * 60_000)),
      ),
    )
    .limit(300);
  let updated = 0;
  for (const n of rows) {
    const tickets = (n.pushTickets as { ticketId: string; token: string }[] | null) ?? [];
    if (tickets.length === 0) continue;
    // Expo lỗi (429, 5xx, hết giờ) thì bỏ qua lần này, thử lại ở phút sau; không làm hỏng các việc định kỳ khác (audit worker-3).
    let receipts: Awaited<ReturnType<PushProvider['getReceipts']>>;
    try {
      receipts = await push.getReceipts(tickets.map((t) => t.ticketId));
    } catch {
      continue;
    }
    let delivered = false;
    let pending = false;
    for (const t of tickets) {
      const r = receipts[t.ticketId];
      if (!r) pending = true;
      else if (r.ok) delivered = true;
      else if (r.error === 'DeviceNotRegistered') {
        const [d] = await tx.select({ id: schema.devices.id }).from(schema.devices).where(eq(schema.devices.pushToken, t.token));
        if (d) await removePushToken(tx, ctx.orgId, d.id);
      }
    }
    if (pending && !delivered) continue;
    await tx
      .update(schema.notifications)
      .set(delivered ? { state: 'delivered', deliveredAt: now, pushTickets: null } : { state: 'failed', pushTickets: null })
      .where(eq(schema.notifications.id, n.id));
    updated++;
  }
  return updated;
}

// ───────────────────────── API của người dùng ─────────────────────────

export function notificationView(n: NotificationRow): NotificationView {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    payload: (n.payload as Record<string, unknown>) ?? {},
    runId: n.runId,
    stepId: n.stepRunId,
    state: n.state as NotificationView['state'],
    createdAt: n.createdAt.toISOString(),
    readAt: (n.readAt ?? n.openedAt)?.toISOString() ?? null,
  };
}

export async function listNotifications(tx: Tx, viewer: Viewer, q: { limit: number; cursor?: string; unread?: 'true' | 'false' }) {
  const conds = [eq(schema.notifications.userId, viewer.id), sql`${schema.notifications.kind} <> 'briefing'`];
  if (q.unread === 'true') conds.push(isNull(schema.notifications.readAt), isNull(schema.notifications.openedAt));
  if (q.cursor) {
    const at = new Date(q.cursor);
    // Con trỏ do máy chủ cấp là một thời điểm ISO; chuỗi khác là 422, không để PostgreSQL ném 500 (audit worker-9).
    if (Number.isNaN(at.getTime())) throw new ApiError('input_invalid', { errors: [{ path: 'query.cursor', code: 'invalid' }] });
    conds.push(lt(schema.notifications.createdAt, at));
  }
  const rows = await tx
    .select()
    .from(schema.notifications)
    .where(and(...conds))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(q.limit + 1);
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, viewer.id), isNull(schema.notifications.readAt), isNull(schema.notifications.openedAt), sql`${schema.notifications.kind} <> 'briefing'`));
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(notificationView),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    unreadCount: count,
  };
}

export async function markNotificationsRead(tx: Tx, viewer: Viewer, body: { ids: string[] } | { all: true }): Promise<void> {
  const base = and(eq(schema.notifications.userId, viewer.id), isNull(schema.notifications.readAt));
  await tx
    .update(schema.notifications)
    .set({ readAt: clock.now() })
    .where('all' in body ? base : and(base, inArray(schema.notifications.id, body.ids)));
}

/** App mở từ thông báo đẩy: trạng thái thành `opened` (SPEC 10.9 bước 6). */
export async function markNotificationOpened(tx: Tx, viewer: Viewer, id: string): Promise<void> {
  const now = clock.now();
  await tx
    .update(schema.notifications)
    .set({ state: 'opened', openedAt: now, readAt: now })
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, viewer.id)));
}

/** Loại thông báo của app Chủ tịch (SPEC 10.9): chữ lớn, ngắn, không có nút hành động. */
const HIGH_PRIORITY_KINDS = new Set(['approval', 'proposal.office', 'proposal.failed', 'approval_needed', 'nudge']);

/** Hẹn đẩy một thông báo đã có dòng trong CSDL: worker gửi qua cùng chuỗi xử lý (giờ yên tĩnh, backoff, biên nhận). */
export async function queueNotificationPush(tx: Tx, orgId: string, notificationId: string): Promise<boolean> {
  return insertEffect(tx, orgId, { kind: 'notify.deliver', dedupeKey: `deliver:${notificationId}`, payload: { notificationId } });
}

/** Dựng lại bản nháp từ một dòng notifications đang `queued` để worker đẩy (effect `notify.deliver`). */
export async function draftFromNotification(tx: Tx, notificationId: string): Promise<NotificationDraft | null> {
  const [n] = await tx.select().from(schema.notifications).where(eq(schema.notifications.id, notificationId));
  if (!n) return null;
  const high = HIGH_PRIORITY_KINDS.has(n.kind);
  return {
    id: n.id,
    userId: n.userId,
    kind: n.kind as NotificationKind,
    title: n.title,
    body: n.body,
    // Các loại này có thân chung chung ("Chạm để xem."), không chứa tên người hay nội dung.
    pushBody: n.kind === 'briefing' || n.kind.startsWith('proposal.') || n.kind === 'approval' ? n.body : '',
    payload: (n.payload as Record<string, unknown>) ?? {},
    runId: n.runId,
    stepId: n.stepRunId,
    channel: 'push',
    channelId: 'work',
    priority: high ? 'high' : 'normal',
  };
}

/**
 * Thông báo do hệ thống tạo trực tiếp (không qua effect của engine), ví dụ báo effect `dead` cho it_admin,
 * "Có 1 việc trợ lý chưa làm được", "Văn phòng có 1 đề xuất". `push: true` thì hẹn đẩy tới thiết bị.
 */
export async function createSystemNotification(
  tx: Tx,
  ctx: OrgContext,
  input: {
    id: string;
    userId: string;
    kind: NotificationKind;
    vars?: Record<string, string | number>;
    payload?: Record<string, unknown>;
    body?: string;
    push?: boolean;
    runId?: string | null;
    stepId?: string | null;
  },
): Promise<void> {
  const rendered = text(input.kind, input.vars ?? {});
  const now = clock.now();
  const inserted = await tx
    .insert(schema.notifications)
    .values({
      id: input.id,
      orgId: ctx.orgId,
      userId: input.userId,
      kind: input.kind,
      title: rendered.title,
      body: input.body ?? rendered.body,
      payload: input.payload ?? {},
      runId: input.runId ?? null,
      stepRunId: input.stepId ?? null,
      state: input.push ? 'queued' : 'sent',
      sentAt: input.push ? null : now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.notifications.id });
  if (inserted.length) {
    if (input.push) await queueNotificationPush(tx, ctx.orgId, input.id);
    const event: StreamEvent = { kind: 'notification.created', orgId: ctx.orgId, userId: input.userId };
    await tx.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
  }
}
