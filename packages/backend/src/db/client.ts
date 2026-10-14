import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { clock } from '../clock';
import { env } from '../env';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Giao dịch đã đặt app.org_id: mọi truy vấn trong đó chịu RLS của tổ chức. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type Handle = { pool: pg.Pool; db: Db };
const handles: Partial<Record<'user' | 'scan' | 'owner', Handle>> = {};

function open(kind: 'user' | 'scan' | 'owner'): Handle {
  const existing = handles[kind];
  if (existing) return existing;
  const connectionString = kind === 'user' ? env.databaseUrl : kind === 'scan' ? env.databaseUrlScan : env.databaseUrlOwner;
  const pool = new pg.Pool({ connectionString, max: kind === 'user' ? 10 : 3 });
  // Kết nối rỗi bị đứt không được làm sập tiến trình.
  pool.on('error', () => {});
  const handle = { pool, db: drizzle(pool, { schema }) };
  handles[kind] = handle;
  return handle;
}

/** app_user: chịu RLS. Dùng qua withOrg(). */
export const getDb = (): Db => open('user').db;
/** app_scan: BYPASSRLS, chỉ SELECT và UPDATE trên timers, effects (worker quét chéo tổ chức). */
export const getScanDb = (): Db => open('scan').db;
/** app_owner: chỉ cho migration và script quản trị. */
export const getOwnerDb = (): Db => open('owner').db;
export const getPool = (kind: 'user' | 'scan' | 'owner' = 'user'): pg.Pool => open(kind).pool;

/**
 * Mọi giao dịch nghiệp vụ bắt đầu bằng SET LOCAL app.org_id (SPEC 3.1 ràng buộc 3).
 * Quên gọi hàm này thì RLS không trả dòng nào: an toàn theo mặc định.
 */
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const fake = clock.fakeIso();
    if (fake) await tx.execute(sql`select set_config('app.now', ${fake}, true)`);
    return fn(tx);
  });
}

/** Giao dịch chưa có tổ chức: chỉ dùng cho hàm SECURITY DEFINER (auth_find_login, list_org_ids). */
export async function withoutOrg<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

export async function listOrgIds(): Promise<string[]> {
  const res = await getDb().execute<{ id: string }>(sql`select list_org_ids() as id`);
  return res.rows.map((r) => r.id);
}

export async function closeDb(): Promise<void> {
  for (const kind of ['user', 'scan', 'owner'] as const) {
    const h = handles[kind];
    if (h) {
      delete handles[kind];
      await h.pool.end();
    }
  }
}

/** Chuẩn hoá thời điểm đọc từ CSDL (Date hoặc chuỗi của Postgres) về ISO 8601 UTC. */
export function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  let s = v.includes('T') ? v : v.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  return new Date(s).toISOString();
}

/**
 * Chạy lần lượt các truy vấn trên cùng một kết nối giao dịch. Một kết nối PostgreSQL chỉ xử lý một truy vấn
 * tại một thời điểm, nên không dùng Promise.all trong giao dịch. Truy vấn Drizzle chỉ chạy khi được await.
 */
export async function inOrder<T extends readonly unknown[]>(queries: readonly [...T]): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await q);
  return out as { -readonly [K in keyof T]: Awaited<T[K]> };
}

export { schema, sql };
