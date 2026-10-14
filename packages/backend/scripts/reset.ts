import { sql } from 'drizzle-orm';
import { closeDb, getOwnerDb } from '../src/db/client';
import { env } from '../src/env';
import { devDatabaseName, devOnlyViolation, isLocalDatabaseHost } from './guard';

/**
 * Xoá sạch CSDL phát triển hoặc thử nghiệm để chạy lại migration từ đầu. Từ chối ở production, khi CSDL không có đuôi
 * _dev hoặc _test, và khi thiếu cờ --yes (hoặc RESET_CONFIRM=<tên CSDL>). In máy chủ và tên CSDL trước khi xoá.
 */
async function main() {
  const violation = devOnlyViolation({ isProd: env.isProd, nodeEnv: env.nodeEnv, databaseUrl: env.databaseUrlOwner });
  if (violation) throw new Error(`Từ chối xoá: ${violation}. Chỉ chạy trên môi trường phát triển hoặc thử nghiệm.`);
  const name = devDatabaseName(env.databaseUrlOwner);
  const url = new URL(env.databaseUrlOwner);
  if (!isLocalDatabaseHost(env.databaseUrlOwner) && process.env.RESET_ALLOW_REMOTE !== 'true') {
    throw new Error(`Từ chối xoá: máy chủ CSDL "${url.hostname}" không phải máy phát triển (đặt RESET_ALLOW_REMOTE=true nếu thật sự muốn).`);
  }
  console.log(`Sẽ xoá sạch CSDL "${name}" ở ${url.hostname}:${url.port || '5432'}.`);
  const confirmed = process.argv.includes('--yes') || process.env.RESET_CONFIRM === name;
  if (!confirmed) throw new Error(`Chưa xác nhận: chạy lại với --yes (pnpm db:reset -- --yes) hoặc RESET_CONFIRM=${name}.`);
  const db = getOwnerDb();
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`GRANT USAGE ON SCHEMA public TO app_user, app_scan`);
  console.log(`Đã xoá sạch ${name}. Chạy pnpm db:migrate rồi pnpm db:seed.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
