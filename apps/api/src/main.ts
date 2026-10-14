import { assertRuntime, closeDb, env } from '@mihato/backend';
import { buildApp } from './app';

// Production: cấu hình sai thì dừng ngay và nêu tên biến (kho tệp ghi được, khoá Scribe, địa chỉ CSDL của vai trò api).
assertRuntime('api');

const app = await buildApp();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // stop_grace_period của compose là 30 giây; quá 25 giây thì thoát cưỡng bức thay vì bị SIGKILL giữa chừng.
  setTimeout(() => process.exit(1), 25_000).unref();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.apiPort, host: '0.0.0.0' });
