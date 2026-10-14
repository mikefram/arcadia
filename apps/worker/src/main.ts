import { assertRuntime, assertScanRole, beat, closeDb, env, processDueEffects, processDueTimers, runMaintenance, type WorkerDeps } from '@mihato/backend';
import { ExpoPush, FakePush, type PushProvider } from '@mihato/providers/push';
import { registerWorkerExtensions } from './extensions';

/**
 * Worker (SPEC 3.2, 12.2): thực thi effects, quét timers, việc định kỳ. Chạy nhiều bản được nhờ SKIP LOCKED.
 * API và worker gặp nhau ở PostgreSQL chứ không gọi trực tiếp nhau.
 */
// Production: cấu hình sai (kể cả nhà cung cấp push là fake mà chưa cho phép) thì dừng ngay, không lặng lẽ chạy bản giả.
assertRuntime('worker');
const pushKind = env.providers.push;
if (pushKind !== 'fake' && pushKind !== 'expo') throw new Error(`PUSH_PROVIDER không hợp lệ: "${pushKind}" (fake hoặc expo)`);
const push: PushProvider = pushKind === 'expo' ? new ExpoPush({ accessToken: env.expoAccessToken || undefined }) : new FakePush();
// Thư: worker chọn nhà cung cấp theo từng tổ chức lúc gửi (cấu hình ở web quản trị, lưu mã hoá trong CSDL); biến môi trường chỉ là dự phòng.
const deps: WorkerDeps = { push };
// Vai trò quét timers và effects không có BYPASSRLS thì RLS trả 0 dòng và worker chạy im lặng mà không nhắc ai (audit db-2): dừng ngay, báo rõ.
await assertScanRole().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), msg: 'scan_role_invalid', detail: err instanceof Error ? err.message : 'error' }));
  process.exit(1);
});
registerWorkerExtensions(deps);

const EFFECT_INTERVAL_MS = 2_000;
const TIMER_INTERVAL_MS = env.isProd ? 60_000 : 5_000;
const MAINTENANCE_INTERVAL_MS = 60_000;

let stopping = false;
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: 'info', at: new Date().toISOString(), msg, ...extra }));

const timers = new Set<NodeJS.Timeout>();
const inflight = new Set<Promise<void>>();

function loop(name: string, intervalMs: number, fn: () => Promise<unknown>): void {
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (timer) timers.delete(timer);
    if (stopping) return;
    const pass = (async () => {
      try {
        const n = await fn();
        if (typeof n === 'number' && n > 0) log(name, { count: n });
      } catch (err) {
        // Chỉ ghi tên lỗi: nhật ký không chứa dữ liệu nghiệp vụ (CLAUDE.md luật 6).
        console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), msg: name, errName: err instanceof Error ? err.name : 'error' }));
      }
    })();
    inflight.add(pass);
    await pass;
    inflight.delete(pass);
    if (!stopping) {
      timer = setTimeout(run, intervalMs);
      timers.add(timer);
    }
  };
  void run();
}

loop('timers', TIMER_INTERVAL_MS, () => processDueTimers());
loop('effects', EFFECT_INTERVAL_MS, () => processDueEffects(deps));
loop('maintenance', MAINTENANCE_INTERVAL_MS, () => runMaintenance(deps));
loop('heartbeat', 30_000, () => beat());

log('worker_started', { push: env.providers.push });

// Tắt êm: ngừng hẹn vòng mới, chờ các vòng đang chạy xong (tối đa 25 giây, dưới stop_grace_period 35 giây) rồi mới đóng CSDL.
// Nếu không, một lô effect đang xử lý giữa chừng sẽ nằm `processing` tới 10 phút (releaseStaleLocks), trễ hơn ngưỡng 5 phút của SPEC 12.4.
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 25_000).unref());
  await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), deadline]);
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
