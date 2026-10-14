// Healthcheck của worker (docker compose): sống khi nhịp tim mới nhất trong worker_heartbeats không quá 120 giây (SPEC 12.4).
// Chạy trong ảnh runtime: node deploy/ops/worker-health.mjs (đọc DATABASE_URL, chỉ SELECT).
import pg from 'pg';

const MAX_AGE_S = Number(process.env.WORKER_HEARTBEAT_MAX_S ?? 120);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
try {
  await client.connect();
  const res = await client.query('select extract(epoch from now() - max(beat_at))::int as age from worker_heartbeats');
  const age = res.rows[0]?.age;
  if (age === null || age === undefined || age > MAX_AGE_S) {
    console.error(`worker không có nhịp tim trong ${MAX_AGE_S} giây`);
    process.exitCode = 1;
  }
} catch {
  console.error('không kiểm được nhịp tim worker (CSDL)');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
