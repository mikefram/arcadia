import { ApiError, deterministicId, type EngineEvent, type TimerData } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import type { EmailProvider } from '@mihato/providers/email';
import type { PushProvider } from '@mihato/providers/push';
import { and, eq, lt, sql } from 'drizzle-orm';
import { clock } from './clock';
import { loadOrgContext, type OrgContext } from './context';
import { getDb, getScanDb, listOrgIds, schema, withOrg, type Db, type Tx } from './db/client';
import { applyRunEvent } from './engine/runner';
import { resolveEmailProvider } from './services/email-settings';
import { INVITE_EMAIL_EFFECT, sendInviteEmail } from './services/invites';
import { checkPushReceipts, createSystemNotification, deliverNotification, draftFromEffect, draftFromNotification } from './services/notifications';

/**
 * Lõi của worker (SPEC 4.4, 10.9): lấy effect và timer bằng `FOR UPDATE SKIP LOCKED` qua vai trò app_scan
 * (quét chéo tổ chức), rồi xử lý từng dòng trong giao dịch app_user có SET LOCAL app.org_id.
 * Hàm ở đây nhận `clock.now()` nên test điều khiển được bằng đồng hồ giả, không cần sleep.
 */

export const MAX_EFFECT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 30_000;
const STALE_LOCK_MS = 10 * 60_000;

type EffectRow = { id: string; org_id: string; run_id: string | null; kind: string; payload: unknown; attempts: number };
type TimerRow = { id: string; org_id: string; run_id: string; step_run_id: string | null; kind: string; fire_at: string; dedupe_key: string; data: unknown };

/** `email` là nhà cung cấp DỰ PHÒNG khi tổ chức chưa đặt cấu hình thư ở web quản trị; bỏ trống thì lấy theo biến môi trường. */
export type WorkerDeps = { push: PushProvider; email?: EmailProvider };

export type EffectOutcome = { state: 'done' } | { state: 'defer'; until: Date } | { state: 'retry'; reason: string };
export type EffectHandler = (tx: Tx, ctx: OrgContext, effect: { id: string; kind: string; payload: Record<string, unknown>; runId: string | null }, deps: WorkerDeps) => Promise<EffectOutcome>;

const handlers = new Map<string, EffectHandler>();

/** Đăng ký cách xử lý một loại effect ngoài `notify.*` (ví dụ `proposal.apply`). */
export function registerEffectHandler(kind: string, handler: EffectHandler): void {
  handlers.set(kind, handler);
}

async function claimEffects(limit: number, orgId?: string): Promise<EffectRow[]> {
  const now = clock.now();
  const scope = orgId ? sql`AND org_id = ${orgId}` : sql``;
  const res = await getScanDb().execute<EffectRow>(sql`
    WITH due AS (
      SELECT id FROM effects
      WHERE state = 'pending' AND next_attempt_at <= ${now} ${scope}
      ORDER BY next_attempt_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    UPDATE effects e SET state = 'processing', locked_at = ${now}
    FROM due WHERE e.id = due.id
    RETURNING e.id, e.org_id, e.run_id, e.kind, e.payload, e.attempts`);
  return res.rows;
}

async function claimTimers(limit: number, orgId?: string): Promise<TimerRow[]> {
  const now = clock.now();
  const scope = orgId ? sql`AND org_id = ${orgId}` : sql``;
  const res = await getScanDb().execute<TimerRow>(sql`
    WITH due AS (
      SELECT id FROM timers
      WHERE state = 'pending' AND fire_at <= ${now} ${scope}
      ORDER BY fire_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    UPDATE timers t SET state = 'firing', locked_at = ${now}
    FROM due WHERE t.id = due.id
    RETURNING t.id, t.org_id, t.run_id, t.step_run_id, t.kind, t.fire_at, t.dedupe_key, t.data`);
  return res.rows.sort((a, b) => new Date(a.fire_at).getTime() - new Date(b.fire_at).getTime());
}

/** `locked_at` quá 10 phút thì nhả lại (worker chết giữa chừng). Vì effect có dedupe_key, chạy lại không gửi trùng. */
export async function releaseStaleLocks(): Promise<void> {
  const cutoff = new Date(clock.now().getTime() - STALE_LOCK_MS);
  const db = getScanDb();
  await db.execute(sql`UPDATE effects SET state = 'pending', locked_at = NULL WHERE state = 'processing' AND locked_at < ${cutoff}`);
  await db.execute(sql`UPDATE timers SET state = 'pending', locked_at = NULL WHERE state = 'firing' AND locked_at < ${cutoff}`);
}

async function handleEffect(tx: Tx, ctx: OrgContext, row: EffectRow, deps: WorkerDeps): Promise<EffectOutcome> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const custom = handlers.get(row.kind);
  if (custom) return custom(tx, ctx, { id: row.id, kind: row.kind, payload, runId: row.run_id }, deps);
  if (row.kind === 'notify.deliver') {
    const draft = await draftFromNotification(tx, String(payload.notificationId));
    if (!draft) return { state: 'done' };
    return deliverNotification(tx, ctx, draft, deps.push);
  }
  if (row.kind.startsWith('notify.')) {
    const draft = await draftFromEffect(tx, ctx, row.id, {
      kind: row.kind,
      toUserId: String(payload.toUserId),
      runId: (payload.runId as string | null | undefined) ?? row.run_id,
      stepId: (payload.stepId as string | null | undefined) ?? null,
      data: (payload.data as Record<string, unknown> | undefined) ?? {},
    });
    if (!draft) return { state: 'done' };
    return deliverNotification(tx, ctx, draft, deps.push);
  }
  if (row.kind === INVITE_EMAIL_EFFECT) {
    // Chưa cấu hình thư (ở web quản trị hay môi trường) thì lỗi để hàng effect thử lại; cấu hình xong là gửi được, hoặc
    // it_admin bấm thử lại khi effect đã `dead`. Kiểm trước khi tạo đường dẫn để không phát sinh mã thừa.
    const resolved = await resolveEmailProvider(tx, ctx.orgId, deps.email);
    if (!resolved) throw new Error('email_not_configured');
    await sendInviteEmail(tx, ctx, payload, resolved.provider);
    return { state: 'done' };
  }
  if (row.kind === 'webhook') {
    // Adapter webhook (n8n, ký HMAC) là Giai đoạn 4 (SPEC 4.9): chưa bật, ghi nhận rồi cho qua.
    return { state: 'done' };
  }
  throw new Error(`unknown_effect_kind:${row.kind}`);
}

async function processEffect(row: EffectRow, deps: WorkerDeps): Promise<void> {
  const scan = getScanDb();
  try {
    const outcome = await withOrg(row.org_id, async (tx) => {
      const ctx = await loadOrgContext(tx, row.org_id);
      const res = await handleEffect(tx, ctx, row, deps);
      if (res.state === 'done') await tx.update(schema.effects).set({ state: 'done', lockedAt: null, lastError: null }).where(eq(schema.effects.id, row.id));
      return res;
    });
    if (outcome.state === 'defer') {
      // Giờ yên tĩnh: dời tới 07:00, không tính là một lần thử lỗi.
      await scan.execute(sql`UPDATE effects SET state = 'pending', locked_at = NULL, next_attempt_at = ${outcome.until} WHERE id = ${row.id}`);
    } else if (outcome.state === 'retry') {
      await failEffect(row, outcome.reason);
    }
  } catch (err) {
    // Chỉ lưu tên và mã lỗi: nhật ký không chứa tên người, tên việc, số tiền (CLAUDE.md luật 6).
    const reason = err instanceof ApiError ? err.code : err instanceof Error ? `${err.name}:${err.message.slice(0, 120).replace(/[^\w:. -]/g, '')}` : 'error';
    await failEffect(row, reason);
  }
}

/** Thử lại với next_attempt_at = now + 30s × 2^attempts, tối đa 8 lần rồi chuyển `dead` và báo it_admin (SPEC 4.4). */
async function failEffect(row: EffectRow, reason: string): Promise<void> {
  const attempts = row.attempts + 1;
  const now = clock.now();
  if (attempts >= MAX_EFFECT_ATTEMPTS) {
    await getScanDb().execute(sql`UPDATE effects SET state = 'dead', attempts = ${attempts}, locked_at = NULL, last_error = ${reason} WHERE id = ${row.id}`);
    await withOrg(row.org_id, async (tx) => {
      const ctx = await loadOrgContext(tx, row.org_id);
      for (const u of ctx.users.values()) {
        if (u.status === 'disabled' || !u.roles.some((r) => r.role === 'it_admin')) continue;
        await createSystemNotification(tx, ctx, { id: deterministicId(`dead:${row.id}:${u.id}`), userId: u.id, kind: 'system', payload: { type: 'effect_dead', effectId: row.id, link: null }, body: vi.server.deadEffect });
      }
    }).catch(() => {});
    return;
  }
  const next = new Date(now.getTime() + BACKOFF_BASE_MS * 2 ** row.attempts);
  await getScanDb().execute(sql`UPDATE effects SET state = 'pending', attempts = ${attempts}, locked_at = NULL, next_attempt_at = ${next}, last_error = ${reason} WHERE id = ${row.id}`);
}

/** Mỗi timer chạy trong giao dịch riêng: gọi advance với TimerFired, rồi đặt state = 'done' (SPEC 4.4). */
async function processTimer(row: TimerRow): Promise<void> {
  try {
    await withOrg(row.org_id, async (tx) => {
      const ctx = await loadOrgContext(tx, row.org_id);
      const event: EngineEvent = {
        type: 'TimerFired',
        // id của timer là eventId: bắn lại sau khi worker chết giữa chừng chỉ có hiệu lực một lần.
        eventId: row.id,
        at: clock.now().toISOString(),
        actor: { type: 'system' },
        timerKey: row.dedupe_key,
        stepId: row.step_run_id,
        kind: row.kind as 'reminder' | 'overdue' | 'escalation' | 'wait',
        data: (row.data ?? {}) as TimerData,
      };
      try {
        await applyRunEvent(tx, ctx, row.run_id, event);
      } catch (err) {
        // Lượt chạy đã xong hoặc đã huỷ, việc không còn mở: timer không còn ý nghĩa.
        if (!(err instanceof ApiError) || (err.code !== 'state_conflict' && err.code !== 'not_found')) throw err;
      }
      await tx.update(schema.timers).set({ state: 'done', lockedAt: null }).where(and(eq(schema.timers.id, row.id), eq(schema.timers.state, 'firing')));
    });
  } catch {
    // Để nguyên `firing`: releaseStaleLocks nhả lại sau 10 phút và timer được bắn lại.
  }
}

/** `orgId` chỉ dùng trong test và seed, để mỗi test chỉ chạy việc của tổ chức riêng của nó. */
export async function processDueTimers(limit = 100, orgId?: string): Promise<number> {
  const rows = await claimTimers(limit, orgId);
  for (const row of rows) await processTimer(row);
  return rows.length;
}

export async function processDueEffects(deps: WorkerDeps, limit = 100, orgId?: string): Promise<number> {
  const rows = await claimEffects(limit, orgId);
  for (const row of rows) await processEffect(row, deps);
  return rows.length;
}

/**
 * Một vòng của worker: bắn timer đến hạn rồi xử lý effect, lặp tới khi không còn gì đến hạn tại `clock.now()`.
 * Test kịch bản vàng gọi hàm này sau mỗi lần chỉnh đồng hồ giả.
 */
export async function runWorkerTick(deps: WorkerDeps, opts: { orgId?: string } = {}): Promise<{ timers: number; effects: number }> {
  let timers = 0;
  let effects = 0;
  for (let i = 0; i < 50; i++) {
    const t = await processDueTimers(100, opts.orgId);
    const e = await processDueEffects(deps, 100, opts.orgId);
    timers += t;
    effects += e;
    if (t === 0 && e === 0) break;
  }
  return { timers, effects };
}

type MaintenanceJob = (tx: Tx, ctx: OrgContext, deps: WorkerDeps) => Promise<void>;
const maintenanceJobs: MaintenanceJob[] = [];

/** Việc định kỳ theo từng tổ chức, chạy mỗi phút (hết hạn đề xuất, bản tin sáng…). */
export function registerMaintenanceJob(job: MaintenanceJob): void {
  maintenanceJobs.push(job);
}

/**
 * Việc định kỳ của MỘT tổ chức. Mỗi việc (xoá khoá chống lặp, hỏi biên nhận đẩy, từng việc đã đăng ký) chạy trong savepoint riêng và
 * lỗi được bắt từng việc: Expo lỗi 429 hay một việc dọn tệp lỗi I/O không kéo đổ các việc còn lại (audit worker-3). Nhật ký chỉ có tên việc
 * và tên lỗi, không có dữ liệu nghiệp vụ (CLAUDE.md luật 6).
 */
export async function runOrgMaintenance(orgId: string, deps: WorkerDeps): Promise<{ failed: string[] }> {
  const now = clock.now();
  const failed: string[] = [];
  await withOrg(orgId, async (tx) => {
    const ctx = await loadOrgContext(tx, orgId);
    const steps: [string, (sp: Tx) => Promise<unknown>][] = [
      // idempotency_keys sống 24 giờ (SPEC 10.1)
      ['idempotency_purge', (sp) => sp.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.createdAt, new Date(now.getTime() - 24 * 60 * 60_000)))],
      ['push_receipts', (sp) => checkPushReceipts(sp, ctx, deps.push)],
      ...maintenanceJobs.map((job, i): [string, (sp: Tx) => Promise<unknown>] => [job.name || `job_${i}`, (sp) => job(sp, ctx, deps)]),
    ];
    for (const [name, step] of steps) {
      try {
        await tx.transaction((sp) => step(sp));
      } catch (err) {
        failed.push(name);
        console.error(JSON.stringify({ level: 'error', at: now.toISOString(), msg: 'maintenance_job', job: name, errName: err instanceof Error ? err.name : 'error' }));
      }
    }
  });
  return { failed };
}

export async function runMaintenance(deps: WorkerDeps): Promise<void> {
  await releaseStaleLocks();
  for (const orgId of await listOrgIds()) {
    await runOrgMaintenance(orgId, deps).catch((err: unknown) => {
      console.error(JSON.stringify({ level: 'error', at: clock.now().toISOString(), msg: 'maintenance_org', errName: err instanceof Error ? err.name : 'error' }));
    });
  }
}

/**
 * Worker quét timers và effects của mọi tổ chức bằng vai trò app_scan, nên vai trò đó PHẢI có BYPASSRLS. Thiếu thì RLS trả 0 dòng,
 * migration vẫn áp được, /readyz vẫn xanh, nhưng không có nhắc việc, không leo thang, không thông báo đẩy và không có lỗi nào (audit db-2).
 * Migration 0001 đã áp nên không sửa; kiểm ở đây, lúc worker khởi động, và báo thành lỗi rõ ràng để không chạy im lặng.
 */
export async function assertScanRole(db: Pick<Db, 'execute'> = getScanDb()): Promise<void> {
  const res = await db.execute<{ rolname: string; rolbypassrls: boolean }>(sql`select rolname, rolbypassrls from pg_roles where rolname = current_user`);
  const row = res.rows[0];
  if (!row?.rolbypassrls) {
    throw new Error(
      `Vai trò CSDL "${row?.rolname ?? 'không rõ'}" dùng để quét timers và effects không có BYPASSRLS: worker sẽ không thấy dòng nào và không nhắc việc. ` +
        'Cấp bằng superuser: ALTER ROLE app_scan BYPASSRLS; (xem db/init/00_roles.sql).',
    );
  }
}

/** Nhịp tim cho /readyz: worker chết thì không ai nhắc việc (SPEC 12.4). */
export async function beat(name = 'worker'): Promise<void> {
  await getDb().execute(sql`INSERT INTO worker_heartbeats (name, beat_at) VALUES (${name}, now()) ON CONFLICT (name) DO UPDATE SET beat_at = now()`);
}
