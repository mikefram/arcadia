import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getOwnerDb, getPool } from '../src/db/client';
import { assertRuntime, env } from '../src/env';

/**
 * Áp migration bằng app_owner. Migration chỉ tiến (CLAUDE.md luật 9). Lấy khoá tư vấn của PostgreSQL để hai tiến trình
 * migrate (CI và tay, hai máy) không áp song song; bên đến sau chờ rồi thấy đã áp xong.
 */
const LOCK_KEY = 'mihato_migrate';

async function main() {
  assertRuntime('migrate');
  const name = new URL(env.databaseUrlOwner).pathname.slice(1);
  // Khoá giữ trên MỘT kết nối riêng cho tới khi xong (khoá tư vấn gắn với phiên, không với giao dịch).
  const lockClient = await getPool('owner').connect();
  try {
    await lockClient.query('select pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await migrate(getOwnerDb(), { migrationsFolder: join(env.root, 'db', 'migrations') });
    const res = await getOwnerDb().execute<{ n: string }>(sql`select count(*) as n from drizzle.__drizzle_migrations`);
    console.log(`Đã áp migration lên ${name} (${res.rows[0]?.n ?? '?'} migration đã áp)`);
  } finally {
    await lockClient.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
