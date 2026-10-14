import { BriefingSectionSchema, PG_NOTIFY_CHANNEL, ROLES, UserPrefsSchema, can, deterministicId, newId, type Briefing, type StepView, type StreamEvent } from '@mihato/domain';
import { addCalendarDays, atLocalTime, isWorkingDay, previousWorkingDay, toLocalDate } from '@mihato/domain/calendar';
import { formatLunar } from '@mihato/domain/lunar';
import { redact } from '@mihato/domain/vi-normalize';
import { toSpeakable } from '@mihato/domain/vi-speak';
import { fmt, fmtExecutive, formatDateFull, vi } from '@mihato/i18n';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { clock } from '../clock';
import type { OrgContext, UserRecord } from '../context';
import { schema, type Tx } from '../db/client';
import { env } from '../env';
import { dayBounds, runVisibility, stepRunVisibility, stepViewsByIds, viewVisibility, type Viewer } from '../views';
import { queueNotificationPush } from './notifications';
import { getOverview } from './overview';
import { personLabel, viewerForUser } from './proposals';

/**
 * Báo cáo tổng hợp đầu ngày (SPEC 6.7, 10.9; đổi tên và nội dung theo docs/DECISIONS.md 05/10/2026, trước đó gọi là "bản tin sáng"):
 * ba phần là việc chưa xong, việc đã xong từ hôm qua và việc dự kiến xong hôm nay, mỗi phần mở bằng câu số liệu rồi mới tới chi tiết.
 * Con số do SQL cho (`getOverview` cùng các truy vấn bổ sung trên cùng view), lời do MẪU VĂN BẢN cố định dựng.
 *
 * TODO(SPEC 6.7): khi có `LlmClient`, nhờ LLM viết lời từ đúng bộ số liệu này, rồi chạy chốt chặn số liệu
 * (trích mọi số trong câu trả lời, đối chiếu với tập số của kết quả; có số lạ thì sinh lại đúng một lần, vẫn sai thì
 * dùng chính mẫu văn bản ở đây). Tổ chức tắt AI (`ai.enabled = false` hoặc `llm = off`) thì luôn dùng mẫu văn bản (SPEC 11.7).
 */

/** Mẫu câu của báo cáo. [GIẢ ĐỊNH] câu chữ chờ Chủ tịch hoặc Chánh văn phòng duyệt (SPEC 7.5). */
export const BRIEFING_TEMPLATES = vi.server.briefing;

/** Số dòng chi tiết tối đa mỗi phần, để bản tin đọc không quá 90 giây [MỤC TIÊU, SPEC 6.7]. */
const MAX_DECISION_LINES = 3;
const MAX_OVERDUE_LINES = 3;
const MAX_DUE_LINES = 4;
const MAX_COMPLETED_LINES = 3;
const MAX_TEXT_CHARS = 1500;

/** Dựng trước giờ nhận 15 phút: mặc định dựng 07:15, nhận 07:30 (SPEC 10.9). */
export const BRIEFING_LEAD_MS = 15 * 60_000;
/** Worker lỡ giờ dựng (đang khởi động lại) thì vẫn dựng bù trong khoảng này; quá thì bỏ bản tin của ngày [GIẢ ĐỊNH]. */
export const BRIEFING_CATCH_UP_MS = 4 * 60 * 60_000;

const BriefingPayloadSchema = z.object({
  day: z.string(),
  builtAt: z.string(),
  text: z.string(),
  sections: z.array(BriefingSectionSchema),
  audioFileId: z.string().nullable(),
});
type BriefingSection = z.infer<typeof BriefingSectionSchema>;

/** Giao diện tối thiểu của TTS mà bản tin cần; `TtsProvider` ở packages/providers (SPEC 6.9) khớp cấu trúc này. */
export type BriefingTts = { synthesizeBatch(text: string, o: { voice: string; speed: number }): Promise<{ url: string; expiresAt: Date }> };
export type BriefingDeps = {
  tts?: BriefingTts;
  /** để dành cho bước viết lời bằng LLM (xem TODO ở đầu tệp); hiện chưa dùng */
  llm?: unknown;
};

/** Tốc độ đọc theo ba nút Chậm, Vừa, Nhanh ở Cài đặt. Mặc định 0.9 (SPEC 6.4); hai mức còn lại là [GIẢ ĐỊNH] chờ nghe thử. */
const SPEECH_SPEED: Record<'slow' | 'normal' | 'fast', number> = { slow: 0.8, normal: 0.9, fast: 1 };

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clean = (s: string, max = 120) => {
  const t = s.replace(/[‘’“”"{}]/g, "'").replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const briefingId = (userId: string, day: string) => deterministicId(`briefing:${userId}:${day}`);

function addressOf(user: UserRecord): string {
  const role = ROLES.find((r) => user.roles.some((g) => g.role === r));
  const byRole = vi.executive.address.byRole as Record<string, string | undefined>;
  return (role && byRole[role]) || vi.executive.address.default;
}

const who = (s: StepView) => (s.assignee ? personLabel(s.assignee) : BRIEFING_TEMPLATES.noAssignee);

async function stepIds(tx: Tx, where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit: number): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`SELECT v.id FROM v_step_status v WHERE ${where} ORDER BY ${order} LIMIT ${limit}`);
  return res.rows.map((r) => r.id);
}

function withMore(lines: string[], total: number, shown: number): string[] {
  return total > shown ? [...lines, fmt(BRIEFING_TEMPLATES.more, { n: total - shown })] : lines;
}

/** Ba phần của báo cáo, dựng từ số liệu SQL bằng mẫu cố định. Mọi con số trong `lead` là số đếm từ CSDL. */
async function buildSections(tx: Tx, ctx: OrgContext, viewer: Viewer, user: UserRecord, now: Date): Promise<BriefingSection[]> {
  const T = BRIEFING_TEMPLATES;
  const address = addressOf(user);
  const titles = vi.executive.home.briefing.sections;
  const b = dayBounds(now, ctx);
  const today = toLocalDate(now, ctx.calendar);
  const o = await getOverview(tx, ctx, viewer);
  // Chỉ việc và lượt người nhận được thấy: lượt mật không lọt vào báo cáo đọc to cho người ngoài đường vào, kể cả Chủ tịch (DECISIONS 07/10/2026).
  const seen = viewVisibility(ctx, viewer);
  const open = sql`v.state IN ('unassigned','ready','in_progress') AND ${seen}`;

  // 1. Việc chưa xong: mọi việc đang mở (đã tới lượt mà chưa xong). Câu số liệu nêu tổng, rồi số việc cần quyết, quá hạn
  // và chưa có người nhận (đều là tập con của tổng, cùng điều kiện với tổng quan). Chi tiết: việc cần quyết, rồi việc quá hạn nặng nhất.
  const openCount = Number((await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM v_step_status v WHERE ${open}`)).rows[0]?.n ?? 0);
  const decisionIds = (
    await tx.execute<{ id: string }>(sql`
      SELECT v.id FROM step_approvals a JOIN v_step_status v ON v.id = a.step_run_id
      WHERE a.approver_id = ${user.id} AND a.decision IS NULL AND v.state IN ('ready','in_progress') AND ${seen}
      ORDER BY v.due_at ASC NULLS LAST, v.id LIMIT ${MAX_DECISION_LINES}`)
  ).rows.map((r) => r.id);
  const decisions = await stepViewsByIds(tx, ctx, viewer, decisionIds);
  // Việc vừa cần quyết vừa quá hạn chỉ nêu một lần (ở dòng "Cần quyết"): lấy dư vài việc quá hạn rồi bỏ các việc đã nêu.
  const namedDecision = new Set(decisions.map((s) => s.id));
  const overdueFetched = (await stepViewsByIds(tx, ctx, viewer, await stepIds(tx, sql`v.is_overdue AND ${seen}`, sql`v.due_at ASC, v.id`, MAX_OVERDUE_LINES + MAX_DECISION_LINES))).sort(
    (x, y) => y.lateWorkingDays - x.lateWorkingDays,
  );
  const overdue = overdueFetched.filter((s) => !namedDecision.has(s.id)).slice(0, MAX_OVERDUE_LINES);
  const overdueAlreadyNamed = overdueFetched.filter((s) => namedDecision.has(s.id)).length;

  // 2. Đã xong từ hôm qua: từ đầu ngày làm việc liền trước (sáng Thứ Hai thì tính từ Thứ Sáu).
  const prevDay = previousWorkingDay(today, ctx.calendar);
  const since = atLocalTime(prevDay, '00:00', ctx.calendar);
  const sinceLabel = prevDay === addCalendarDays(today, -1) ? T.completed.sinceYesterday : T.completed.sincePreviousWorkday;
  const doneCount = Number(
    (
      await tx.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM step_runs s WHERE s.kind IN ('task','approval') AND s.state = 'done' AND s.completed_at >= ${since} AND s.completed_at <= ${now} AND ${stepRunVisibility(ctx, viewer)}`,
      )
    ).rows[0]?.n ?? 0,
  );
  const doneIds = (
    await tx.execute<{ id: string }>(
      sql`SELECT s.id FROM step_runs s WHERE s.kind IN ('task','approval') AND s.state = 'done' AND s.completed_at >= ${since} AND s.completed_at <= ${now} AND ${stepRunVisibility(ctx, viewer)}
          ORDER BY s.completed_at DESC, s.id LIMIT ${MAX_COMPLETED_LINES}`,
    )
  ).rows.map((r) => r.id);
  const done = await stepViewsByIds(tx, ctx, viewer, doneIds);
  const doneRuns = await tx.execute<{ title: string }>(
    sql`SELECT r.title FROM process_runs r WHERE r.state = 'completed' AND NOT EXISTS (SELECT 1 FROM process_templates pt WHERE pt.id = r.template_id AND pt.kind = 'adhoc') AND r.completed_at >= ${since} AND r.completed_at <= ${now} AND ${runVisibility(ctx, viewer)} ORDER BY r.completed_at DESC LIMIT 2`,
  );

  // 3. Dự kiến xong hôm nay: việc đang mở có hạn trong ngày hôm nay, cùng điều kiện với `dueToday` của tổng quan.
  const dueToday = await stepViewsByIds(tx, ctx, viewer, await stepIds(tx, sql`${open} AND v.due_at >= ${now} AND v.due_at < ${b.tomorrow}`, sql`v.due_at ASC, v.id`, MAX_DUE_LINES));

  const stepVars = (s: StepView) => ({ việc: clean(s.title), lượt: clean(s.runTitle), người: who(s), Người: capitalize(who(s)), k: s.lateWorkingDays });
  const openLead = [
    fmt(openCount > 0 ? T.open.some : T.open.none, { n: openCount }),
    ...(o.awaitingMyDecision > 0 ? [fmtExecutive(T.open.decisions, { n: o.awaitingMyDecision }, address)] : []),
    ...(o.overdue > 0 ? [fmt(T.open.overdue, { n: o.overdue })] : []),
    ...(o.unassigned > 0 ? [fmt(T.open.unassigned, { n: o.unassigned })] : []),
  ].join(' ');
  return [
    {
      key: 'open',
      title: fmtExecutive(titles.open, {}, address),
      lead: openLead,
      lines: [
        ...withMore(decisions.map((s) => fmt(T.open.decisionLine, stepVars(s))), o.awaitingMyDecision, decisions.length),
        ...withMore(
          overdue.map((s) => fmt(!s.assignee ? T.open.overdueLineNoOne : s.lateWorkingDays > 0 ? T.open.overdueLine : T.open.overdueLineToday, stepVars(s))),
          o.overdue,
          overdue.length + overdueAlreadyNamed,
        ),
      ],
    },
    {
      key: 'completed',
      title: fmtExecutive(titles.completed, {}, address),
      lead: fmt(doneCount > 0 ? T.completed.some : T.completed.none, { n: doneCount, 'Từ lúc': capitalize(sinceLabel) }),
      lines: [...doneRuns.rows.map((r) => fmt(T.completed.run, { lượt: clean(r.title) })), ...withMore(done.map((s) => fmt(T.completed.line, stepVars(s))), doneCount, done.length)],
    },
    {
      key: 'due',
      title: fmtExecutive(titles.due, {}, address),
      lead: fmt(o.dueToday > 0 ? T.due.some : T.due.none, { n: o.dueToday }),
      lines: withMore(dueToday.map((s) => fmt(T.due.line, stepVars(s))), o.dueToday, dueToday.length),
    },
  ];
}

function composeText(opening: string, sections: BriefingSection[]): string {
  return [opening, ...sections.map((s) => [s.lead, ...s.lines].join(' '))].join('\n');
}

/**
 * Dựng báo cáo đầu ngày của một người điều hành và lưu thành MỘT dòng `notifications` kiểu `briefing` mỗi ngày
 * (id tất định theo người và ngày; dựng lại trong ngày thì ghi đè nội dung). `payload` gồm `text`, `sections`, `audioFileId`.
 * Không có TTS, hoặc tổng hợp tiếng lỗi, thì `audioFileId = null` và app đọc `text` bằng giọng hệ điều hành (SPEC 6.11).
 */
export async function buildBriefing(tx: Tx, ctx: OrgContext, userId: string, deps: BriefingDeps = {}): Promise<Briefing | null> {
  const user = ctx.users.get(userId);
  const viewer = viewerForUser(ctx, userId);
  if (!user || !viewer || !can(viewer, 'briefing.view')) return null;
  const now = clock.now();
  const day = toLocalDate(now, ctx.calendar);
  const address = addressOf(user);

  const sections = await buildSections(tx, ctx, viewer, user, now);
  const opening = fmtExecutive(BRIEFING_TEMPLATES.opening, { ngày: formatDateFull(now), 'ngày âm': formatLunar(now) }, address);
  let text = composeText(opening, sections);
  // Giữ độ dài đọc trong khoảng 90 giây: bớt dần dòng chi tiết của phần dài nhất, không bao giờ bỏ câu số liệu.
  while (text.length > MAX_TEXT_CHARS) {
    const longest = [...sections].sort((a, b) => b.lines.length - a.lines.length)[0];
    if (!longest || longest.lines.length === 0) break;
    longest.lines = longest.lines.slice(0, -1);
    text = composeText(opening, sections);
  }

  const id = briefingId(userId, day);
  const prefs = UserPrefsSchema.safeParse(user.prefs ?? {});
  let audioFileId: string | null = null;
  const ai = ctx.settings.ai;
  if (deps.tts && ai.enabled && ai.tts === 'vbee') {
    try {
      const voice = (prefs.success ? prefs.data.voiceId : null) ?? env.vbeeVoice;
      const speed = SPEECH_SPEED[prefs.success ? prefs.data.speechRate : 'normal'];
      // Văn bản gửi TTS không chứa số điện thoại hay thư điện tử (SPEC 6.4, 6.8), và số, ngày đã đổi thành chữ đọc được.
      const audio = await deps.tts.synthesizeBatch(toSpeakable(redact(text)), { voice, speed });
      // TODO(SPEC 6.4.1 điều 2, SPEC 12): tải tệp về kho tệp của hệ thống rồi phát đường dẫn có chữ ký sống 10 phút.
      // [GIẢ ĐỊNH] hiện chưa có kho tệp nên `storage_key` giữ thẳng liên kết của nhà cung cấp và hết hạn theo nhà cung cấp.
      // Liên kết của Vbee chỉ sống 3 phút (SPEC 6.4): tới giờ nhận thì `audioUrl` đã là null và app đọc `text` bằng giọng của máy.
      audioFileId = newId(now.getTime());
      await tx.insert(schema.files).values({
        id: audioFileId,
        orgId: ctx.orgId,
        ownerUserId: userId,
        kind: 'briefing_audio',
        storageKey: audio.url,
        mime: 'audio/mpeg',
        sizeBytes: 0,
        expiresAt: audio.expiresAt,
        createdAt: now,
      });
    } catch {
      // Tổng hợp tiếng lỗi: vẫn có bản tin bằng chữ (SPEC 6.11). Không ghi nội dung lỗi vì có thể chứa câu chữ của bản tin.
      audioFileId = null;
    }
  }

  const t = vi.notifications.briefing;
  const payload = { type: 'briefing', day, builtAt: now.toISOString(), text, sections, audioFileId, link: `${env.appScheme}://home` };
  await tx
    .insert(schema.notifications)
    .values({ id, orgId: ctx.orgId, userId, kind: 'briefing', title: t.title, body: t.body, payload, state: 'queued', createdAt: now })
    .onConflictDoUpdate({ target: schema.notifications.id, set: { payload, title: t.title, body: t.body } });
  return { id, builtAt: now.toISOString(), text, sections, audioUrl: await audioUrlOf(tx, audioFileId, now) };
}

async function audioUrlOf(tx: Tx, fileId: string | null, now: Date): Promise<string | null> {
  if (!fileId) return null;
  const [file] = await tx.select().from(schema.files).where(and(eq(schema.files.id, fileId), eq(schema.files.kind, 'briefing_audio')));
  if (!file || (file.expiresAt && file.expiresAt <= now)) return null;
  return /^https:\/\//.test(file.storageKey) ? file.storageKey : null;
}

/** Bản dựng mới nhất của chính người gọi, của bất kỳ ngày nào, hoặc null khi chưa có. */
export async function latestBriefing(tx: Tx, viewer: Viewer): Promise<Briefing | null> {
  const n = schema.notifications;
  const [row] = await tx
    .select()
    .from(n)
    .where(and(eq(n.userId, viewer.id), eq(n.kind, 'briefing')))
    .orderBy(desc(n.createdAt), desc(n.id))
    .limit(1);
  if (!row) return null;
  const payload = BriefingPayloadSchema.safeParse(row.payload);
  if (!payload.success) return null;
  return {
    id: row.id,
    builtAt: payload.data.builtAt,
    text: payload.data.text,
    sections: payload.data.sections,
    audioUrl: await audioUrlOf(tx, payload.data.audioFileId, clock.now()),
  };
}

/**
 * `GET /v1/briefings/latest`: báo cáo của HÔM NAY cho chính người gọi (docs/DECISIONS.md, 05/10/2026). Worker dựng sẵn lúc 07:15 ngày làm việc;
 * chưa có bản của hôm nay (mở trước giờ dựng, cuối tuần, ngày nghỉ, worker lỡ giờ quá 4 giờ, máy chủ mới bật) thì dựng ngay bằng số liệu lúc này.
 * Không bao giờ trả bản của ngày cũ: sáng nay đọc "dự kiến xong hôm nay" của hôm qua là sai. Dựng ngay thì không có tệp âm thanh
 * (`audioUrl = null`), app đọc bằng giọng hệ điều hành (SPEC 6.11). Trả null khi người gọi không có quyền xem.
 */
export async function currentBriefing(tx: Tx, ctx: OrgContext, viewer: Viewer): Promise<Briefing | null> {
  const latest = await latestBriefing(tx, viewer);
  if (latest && toLocalDate(new Date(latest.builtAt), ctx.calendar) === toLocalDate(clock.now(), ctx.calendar)) return latest;
  return buildBriefing(tx, ctx, viewer.id);
}

/**
 * Việc định kỳ mỗi phút: với từng người điều hành đang hoạt động, tới giờ dựng (giờ nhận ở `prefs.briefingTime`
 * trừ 15 phút, theo giờ Việt Nam, chỉ ngày làm việc) thì dựng bản tin một lần cho ngày đó; tới giờ nhận thì đánh dấu
 * đã phát để app hiện dải "Nghe báo cáo tổng hợp đầu ngày".
 *
 * Tới giờ nhận, tin `briefing` được hẹn đẩy qua effect `notify.deliver` (xem services/notifications.ts).
 */
export async function briefingJob(tx: Tx, ctx: OrgContext, deps: BriefingDeps = {}): Promise<{ built: number; delivered: number }> {
  const now = clock.now();
  const today = toLocalDate(now, ctx.calendar);
  const out = { built: 0, delivered: 0 };
  if (!isWorkingDay(today, ctx.calendar)) return out;
  const n = schema.notifications;
  for (const user of ctx.users.values()) {
    if (user.status !== 'active' || !can(user, 'briefing.view')) continue;
    const prefs = UserPrefsSchema.safeParse(user.prefs ?? {});
    const deliverAt = atLocalTime(today, prefs.success ? prefs.data.briefingTime : '07:30', ctx.calendar);
    const buildAt = new Date(deliverAt.getTime() - BRIEFING_LEAD_MS);
    if (now < buildAt || now.getTime() - buildAt.getTime() > BRIEFING_CATCH_UP_MS) continue;
    try {
      // Savepoint riêng cho từng người: một người lỗi không kéo đổ giao dịch của cả việc định kỳ.
      await tx.transaction(async (sp) => {
        const id = briefingId(user.id, today);
        const [existing] = await sp.select({ state: n.state }).from(n).where(eq(n.id, id));
        if (!existing) {
          await buildBriefing(sp, ctx, user.id, deps);
          out.built++;
        }
        if (now >= deliverAt && (existing?.state ?? 'queued') === 'queued') {
          // Tới giờ nhận: hẹn đẩy "Báo cáo đầu ngày đã sẵn sàng" qua cùng chuỗi xử lý thông báo (SPEC 10.9).
          if (await queueNotificationPush(sp, ctx.orgId, id)) {
            const event: StreamEvent = { kind: 'notification.created', orgId: ctx.orgId, userId: user.id };
            await sp.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
            out.delivered++;
          }
        }
      });
    } catch {
      // Bỏ qua người này ở vòng này; vòng sau (một phút nữa) thử lại.
    }
  }
  return out;
}
