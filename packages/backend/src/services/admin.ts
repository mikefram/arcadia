import {
  ApiError,
  NOTIFICATION_STATES,
  type AdminNotificationSchema,
  type AiUsageResponseSchema,
  type AuditEntry,
  type EffectView,
  type NotificationState,
  type Paged,
  type PersonRef,
} from '@mihato/domain';
import { addCalendarDays, toLocalDate } from '@mihato/domain/calendar';
import { deterministicId } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../audit';
import type { RequestMeta } from '../auth/service';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { createSystemNotification } from './notifications';
import type { Viewer } from '../views';

/**
 * Màn "Thông báo và nhật ký" và số liệu dùng AI của quản trị (SPEC 9.2, 10.3). Chỉ đọc, trừ nút thử lại effect.
 * Không hàm nào ở đây đọc bảng `messages`: it_admin chỉ thấy số liệu dùng, không thấy nội dung hội thoại
 * [QUYẾT ĐỊNH, SPEC 9.1].
 */

export type AdminNotification = z.infer<typeof AdminNotificationSchema>;
export type AiUsageResponse = z.infer<typeof AiUsageResponseSchema>;
export type AuditQuery = { limit: number; cursor?: string; action?: string; actorId?: string; from?: string; to?: string };
export type AdminNotificationQuery = { limit: number; cursor?: string; state?: string; userId?: string };
export type EffectQuery = { limit: number; cursor?: string; state: EffectView['state'] };

const unknownPerson = (id: string): PersonRef => ({ id, fullName: '', givenName: '', honorific: null });

/**
 * Con trỏ phân trang theo (thời điểm, id), mới nhất trước. Thời điểm lấy nguyên văn từ PostgreSQL (đủ micro giây):
 * cắt xuống mili giây của JavaScript sẽ làm sót hoặc lặp dòng ở ranh giới trang.
 */
type Keyset = { at: string; id: string };
const TS_TEXT = (col: SQL): SQL<string> => sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const encodeCursor = (k: Keyset): string => Buffer.from(`${k.at}|${k.id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string | undefined): Keyset | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError('input_invalid', { errors: [{ path: 'query.cursor', code: 'invalid' }] });
  return { at, id };
}
const before = (atCol: SQL, idCol: SQL, k: Keyset): SQL => sql`(${atCol}, ${idCol}) < (${k.at}::timestamptz, ${k.id}::uuid)`;

function pageOf<R extends { atText: string; id: string }>(rows: R[], limit: number): { page: R[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { page, nextCursor: rows.length > limit && last ? encodeCursor({ at: last.atText, id: last.id }) : null };
}

// ───────────────────────── Nhật ký hoạt động ─────────────────────────

/** Nhật ký bảo mật và quản trị (SPEC 11.3), mới nhất trước. Lọc theo hành động, người thực hiện và khoảng thời gian. */
export async function listAuditLog(tx: Tx, ctx: OrgContext, q: AuditQuery): Promise<Paged<AuditEntry>> {
  const a = schema.auditLog;
  const conds: SQL[] = [];
  if (q.action) conds.push(eq(a.action, q.action));
  if (q.actorId) conds.push(eq(a.actorUserId, q.actorId));
  if (q.from) conds.push(gte(a.at, new Date(q.from)));
  if (q.to) conds.push(lte(a.at, new Date(q.to)));
  const cursor = decodeCursor(q.cursor);
  if (cursor) conds.push(before(sql`${a.at}`, sql`${a.id}`, cursor));
  const rows = await tx
    .select({
      id: a.id,
      at: a.at,
      atText: TS_TEXT(sql`${a.at}`),
      actorType: a.actorType,
      actorUserId: a.actorUserId,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      ip: a.ip,
      detail: a.detail,
    })
    .from(a)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(a.at), desc(a.id))
    .limit(q.limit + 1);
  const { page, nextCursor } = pageOf(rows, q.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorType: r.actorType as AuditEntry['actorType'],
      actor: r.actorUserId ? (ctx.person(r.actorUserId) ?? unknownPerson(r.actorUserId)) : null,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      ip: r.ip,
      detail: (r.detail as Record<string, unknown> | null) ?? {},
    })),
    nextCursor,
  };
}

// ───────────────────────── Trạng thái gửi và đọc của thông báo ─────────────────────────

/** Mỗi thông báo một dòng: gửi lúc nào, tới máy lúc nào, mở lúc nào. Bản tin sáng cũng nằm ở đây (kind = briefing). */
export async function listAdminNotifications(tx: Tx, ctx: OrgContext, q: AdminNotificationQuery): Promise<Paged<AdminNotification>> {
  const n = schema.notifications;
  const conds: SQL[] = [];
  if (q.state !== undefined) {
    if (!(NOTIFICATION_STATES as readonly string[]).includes(q.state)) throw new ApiError('input_invalid', { errors: [{ path: 'query.state', code: 'invalid' }] });
    conds.push(eq(n.state, q.state));
  }
  if (q.userId) conds.push(eq(n.userId, q.userId));
  const cursor = decodeCursor(q.cursor);
  if (cursor) conds.push(before(sql`${n.createdAt}`, sql`${n.id}`, cursor));
  const rows = await tx
    .select({
      id: n.id,
      atText: TS_TEXT(sql`${n.createdAt}`),
      userId: n.userId,
      kind: n.kind,
      title: n.title,
      state: n.state,
      createdAt: n.createdAt,
      sentAt: n.sentAt,
      deliveredAt: n.deliveredAt,
      openedAt: n.openedAt,
    })
    .from(n)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(n.createdAt), desc(n.id))
    .limit(q.limit + 1);
  const { page, nextCursor } = pageOf(rows, q.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      user: ctx.person(r.userId) ?? unknownPerson(r.userId),
      kind: r.kind,
      title: r.title,
      state: r.state as NotificationState,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      openedAt: r.openedAt?.toISOString() ?? null,
    })),
    nextCursor,
  };
}

// ───────────────────────── Hàng effect ─────────────────────────

type EffectRow = typeof schema.effects.$inferSelect;

const effectView = (e: Pick<EffectRow, 'id' | 'kind' | 'state' | 'attempts' | 'lastError' | 'runId' | 'createdAt' | 'nextAttemptAt'>): EffectView => ({
  id: e.id,
  kind: e.kind,
  state: e.state as EffectView['state'],
  attempts: e.attempts,
  lastError: e.lastError,
  runId: e.runId,
  createdAt: e.createdAt.toISOString(),
  nextAttemptAt: e.nextAttemptAt.toISOString(),
});

/** Hàng effect theo trạng thái; mặc định là `dead` (đã thử đủ 8 lần mà chưa được), để it_admin xem và thử lại. */
export async function listEffects(tx: Tx, q: EffectQuery): Promise<Paged<EffectView>> {
  const e = schema.effects;
  const conds: SQL[] = [eq(e.state, q.state)];
  const cursor = decodeCursor(q.cursor);
  if (cursor) conds.push(before(sql`${e.createdAt}`, sql`${e.id}`, cursor));
  const rows = await tx
    .select({
      id: e.id,
      atText: TS_TEXT(sql`${e.createdAt}`),
      kind: e.kind,
      state: e.state,
      attempts: e.attempts,
      lastError: e.lastError,
      runId: e.runId,
      createdAt: e.createdAt,
      nextAttemptAt: e.nextAttemptAt,
    })
    .from(e)
    .where(and(...conds))
    .orderBy(desc(e.createdAt), desc(e.id))
    .limit(q.limit + 1);
  const { page, nextCursor } = pageOf(rows, q.limit);
  return { items: page.map(effectView), nextCursor };
}

/**
 * Thử lại một effect `dead`: trả về hàng đợi với số lần thử về 0, worker lấy ở vòng quét kế tiếp.
 * `dedupe_key` giữ nguyên nên thử lại không gửi trùng. Effect không ở `dead` thì 409.
 */
export async function retryEffect(tx: Tx, viewer: Viewer, effectId: string, meta: RequestMeta = {}): Promise<EffectView> {
  const e = schema.effects;
  const [row] = await tx.select().from(e).where(eq(e.id, effectId)).for('update');
  if (!row) throw new ApiError('not_found');
  if (row.state !== 'dead') throw new ApiError('state_conflict', { currentState: row.state });
  const [updated] = await tx.update(e).set({ state: 'pending', attempts: 0, nextAttemptAt: clock.now(), lockedAt: null }).where(eq(e.id, effectId)).returning();
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'effect_retried',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'effect',
    targetId: effectId,
    ip: meta.ip,
    detail: { kind: row.kind, attempts: row.attempts },
  });
  return effectView(updated!);
}

// ───────────────────────── Số liệu dùng AI ─────────────────────────

/** [GIẢ ĐỊNH] Giá Claude Sonnet 5.5 ở SPEC 6.3: 2 USD mỗi triệu token vào, 10 USD mỗi triệu token ra; chưa tính bộ nhớ đệm, STT, TTS. */
const USD_PER_MILLION_INPUT_TOKENS = 2;
const USD_PER_MILLION_OUTPUT_TOKENS = 10;
const DEFAULT_USAGE_DAYS = 30;

/**
 * Số liệu dùng AI theo người và ngày, đọc từ bảng `ai_usage` (số lượt, token, giây, lỗi). Bỏ trống kỳ thì lấy 30 ngày gần nhất.
 * Tuyệt đối không đọc `messages`.
 */
export async function getAiUsage(tx: Tx, ctx: OrgContext, q: { from?: string; to?: string } = {}): Promise<AiUsageResponse> {
  const to = q.to ?? toLocalDate(clock.now(), ctx.calendar);
  const from = q.from ?? addCalendarDays(to, -(DEFAULT_USAGE_DAYS - 1));
  if (from > to) throw new ApiError('input_invalid', { errors: [{ path: 'query.from', code: 'after_to' }] });
  const u = schema.aiUsage;
  const rows = await tx
    .select()
    .from(u)
    .where(and(gte(u.day, from), lte(u.day, to)))
    .orderBy(desc(u.day), u.userId);
  const totals = { llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, sttSeconds: 0, ttsChars: 0, errors: 0 };
  const items = rows.map((r) => {
    totals.llmCalls += r.llmCalls;
    totals.llmInputTokens += r.llmInputTokens;
    totals.llmOutputTokens += r.llmOutputTokens;
    totals.sttSeconds += r.sttSeconds;
    totals.ttsChars += r.ttsChars;
    totals.errors += r.errors;
    return {
      user: ctx.person(r.userId) ?? unknownPerson(r.userId),
      day: r.day,
      llmCalls: r.llmCalls,
      llmInputTokens: r.llmInputTokens,
      llmOutputTokens: r.llmOutputTokens,
      sttSeconds: r.sttSeconds,
      ttsChars: r.ttsChars,
      errors: r.errors,
    };
  });
  const usd = (totals.llmInputTokens * USD_PER_MILLION_INPUT_TOKENS + totals.llmOutputTokens * USD_PER_MILLION_OUTPUT_TOKENS) / 1_000_000;
  return { rows: items, totals: { ...totals, estimatedUsd: Math.round(usd * 10_000) / 10_000 } };
}

// ───────────────────────── Cảnh báo ngân sách AI ─────────────────────────

/** Ước tính chi phí LLM (USD) từ token; cùng công thức với màn "Dùng AI" của web. */
export function estimateAiUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * USD_PER_MILLION_INPUT_TOKENS + outputTokens * USD_PER_MILLION_OUTPUT_TOKENS) / 1_000_000;
}

const BUDGET_LEVELS = [80, 100] as const;
const usdText = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

/**
 * Việc định kỳ mỗi phút (SPEC 12.4, 12.6): chi phí AI trong tháng (giờ Việt Nam) chạm 80% và 100% ngân sách tháng
 * `settings.ai.monthlyBudgetUsd` thì báo `it_admin` một lần cho mỗi mốc mỗi tháng. CHỈ cảnh báo, không tự cắt trợ lý,
 * vì cắt giữa tháng sẽ làm Chủ tịch mất trợ lý đúng lúc cần; `it_admin` quyết định (hạn mức mỗi người mỗi ngày vẫn còn).
 * Mã thông báo tất định theo (tổ chức, tháng, mốc, người nhận) nên chạy lại không gửi trùng.
 */
export async function aiBudgetJob(tx: Tx, ctx: OrgContext): Promise<{ notified: number; level: 0 | 80 | 100; usd: number }> {
  const budget = ctx.settings.ai.monthlyBudgetUsd;
  if (!budget || budget <= 0 || !ctx.settings.ai.enabled) return { notified: 0, level: 0, usd: 0 };
  const today = toLocalDate(clock.now(), ctx.calendar);
  const month = today.slice(0, 7);
  const u = schema.aiUsage;
  const [row] = await tx
    .select({ input: sql<number>`coalesce(sum(${u.llmInputTokens}), 0)::float8`, output: sql<number>`coalesce(sum(${u.llmOutputTokens}), 0)::float8` })
    .from(u)
    .where(and(gte(u.day, `${month}-01`), lte(u.day, today)));
  const usd = estimateAiUsd(row?.input ?? 0, row?.output ?? 0);
  const percent = (usd / budget) * 100;
  const reached = BUDGET_LEVELS.filter((l) => percent >= l);
  if (reached.length === 0) return { notified: 0, level: 0, usd };
  const admins = [...ctx.users.values()].filter((x) => x.status === 'active' && x.roles.some((r) => r.role === 'it_admin'));
  let notified = 0;
  for (const level of reached) {
    for (const admin of admins) {
      const id = deterministicId(`ai-budget:${ctx.orgId}:${month}:${level}:${admin.id}`);
      const before = await tx.select({ id: schema.notifications.id }).from(schema.notifications).where(eq(schema.notifications.id, id));
      if (before.length > 0) continue;
      const t = vi.server.aiBudget;
      await createSystemNotification(tx, ctx, {
        id,
        userId: admin.id,
        kind: 'system',
        body: fmt(level === 100 ? t.warn100 : t.warn80, { n: level, 'chi phí': usdText(usd), 'ngân sách': usdText(budget) }),
        payload: { type: 'ai_budget', level, month, link: null },
        push: true,
      });
      notified++;
    }
  }
  return { notified, level: reached[reached.length - 1] as 80 | 100, usd };
}
