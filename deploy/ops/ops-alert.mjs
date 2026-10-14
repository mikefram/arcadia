// Giám sát tối thiểu theo SPEC 12.4, chạy như một service nhỏ trong compose (hoặc `--once` từ cron).
// Chỉ đọc: truy vấn SQL cho effects, timers, nhịp tim worker, tỷ lệ thông báo lỗi; thêm dung lượng ổ, hạn chứng chỉ TLS, kết quả sao lưu.
// Gửi cảnh báo qua webhook (Slack, Mattermost, Teams, n8n: nhận JSON {"text": "..."}) và/hoặc Telegram; luôn ghi nhật ký JSON ra stdout.
// Nhật ký và cảnh báo CHỈ chứa tên điều kiện và con số, không tên người, tên việc, số tiền (CLAUDE.md luật 6).
//
// Biến môi trường:
//   DATABASE_URL         app_user (nhịp tim, thông báo; đọc theo từng tổ chức bằng RLS)
//   DATABASE_URL_SCAN    app_scan (effects, timers của mọi tổ chức)
//   ALERT_WEBHOOK_URL    địa chỉ nhận cảnh báo (tuỳ chọn)
//   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID   (tuỳ chọn)
//   ALERT_PREFIX         tiền tố tin nhắn, ví dụ "[MIHATO production]" (mặc định "[MIHATO]")
//   OPS_INTERVAL_S       chu kỳ kiểm (mặc định 60)
//   OPS_REPEAT_H         nhắc lại khi cảnh báo còn đó (mặc định 6)
//   DISK_PATH            thư mục đo dung lượng (mặc định /data/files)
//   TLS_CHECK_ADDR       host:cổng để đọc chứng chỉ, ví dụ web:443; DOMAIN là tên máy chủ (SNI)
//   BACKUP_STATUS_FILE   tệp trạng thái do deploy/scripts/backup.sh ghi (mặc định /backup/status.json)
//   OPS_STATE_FILE       nơi nhớ trạng thái cảnh báo (mặc định /var/lib/ops-alert/state.json)
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import tls from 'node:tls';
import pg from 'pg';

export const THRESHOLDS = {
  /** effects `dead` quá lâu thì báo (SPEC 12.4: lớn hơn 0 trong 10 phút) */
  deadForMs: 10 * 60_000,
  /** effects và timers đến hạn mà chưa chạy quá 5 phút */
  lagSec: 5 * 60,
  /** worker mất nhịp 2 phút */
  heartbeatSec: 2 * 60,
  /** tỷ lệ thông báo lỗi trong 1 giờ, chỉ xét khi có từ 10 thông báo trở lên */
  pushFailRate: 0.2,
  pushMinSample: 10,
  diskPercent: 80,
  tlsDays: 14,
  /** bản sao lưu cũ hơn từng này giờ là coi như thất bại (sao lưu hằng ngày + dung sai) */
  backupMaxAgeH: 26,
};

/**
 * Hàm thuần: từ số đo sang danh sách điều kiện. `forMs` là thời gian điều kiện phải đúng liên tục mới báo.
 * `value` null nghĩa là không đo được: điều kiện đo không được cũng là điều kiện cần báo (không im lặng khi mù).
 */
export function evaluate(s, t = THRESHOLDS) {
  const checks = [];
  const add = (key, active, text, forMs = 0) => checks.push({ key, active, text, forMs });
  add('effects_dead', s.deadEffects === null ? true : s.deadEffects > 0, s.deadEffects === null ? 'không đếm được effects dead' : `${s.deadEffects} effect ở trạng thái dead (it_admin xem tab effects và thử lại)`, t.deadForMs);
  add('effects_lag', s.effectLagSec === null ? false : s.effectLagSec > t.lagSec, `effect đến hạn chậm ${Math.round((s.effectLagSec ?? 0) / 60)} phút (ngưỡng ${t.lagSec / 60})`);
  add('timers_lag', s.timerLagSec === null ? false : s.timerLagSec > t.lagSec, `timer đến hạn chậm ${Math.round((s.timerLagSec ?? 0) / 60)} phút (ngưỡng ${t.lagSec / 60})`);
  add(
    'worker_heartbeat',
    s.heartbeatAgeSec === null ? true : s.heartbeatAgeSec > t.heartbeatSec,
    s.heartbeatAgeSec === null ? 'worker chưa từng ghi nhịp tim' : `worker mất nhịp ${Math.round(s.heartbeatAgeSec / 60)} phút (ngưỡng ${t.heartbeatSec / 60})`,
  );
  const rate = s.pushTotal >= t.pushMinSample ? s.pushFailed / s.pushTotal : 0;
  add('push_failures', rate > t.pushFailRate, `${Math.round(rate * 100)}% thông báo lỗi trong 1 giờ (${s.pushFailed}/${s.pushTotal}, ngưỡng ${t.pushFailRate * 100}%)`);
  add('disk_usage', s.diskPercent === null ? true : s.diskPercent > t.diskPercent, s.diskPercent === null ? 'không đo được dung lượng ổ' : `ổ đĩa đầy ${s.diskPercent}% (ngưỡng ${t.diskPercent}%)`, s.diskPercent === null ? 30 * 60_000 : 0);
  add('tls_expiry', s.tlsDaysLeft === null ? true : s.tlsDaysLeft < t.tlsDays, s.tlsDaysLeft === null ? 'không đọc được chứng chỉ TLS' : `chứng chỉ TLS còn ${s.tlsDaysLeft} ngày (ngưỡng ${t.tlsDays})`, s.tlsDaysLeft === null ? 30 * 60_000 : 0);
  const b = s.backup;
  const backupBad = !b || b.ok !== true || b.ageHours === null || b.ageHours > t.backupMaxAgeH;
  add('backup', backupBad, !b ? 'chưa thấy tệp trạng thái sao lưu' : b.ok !== true ? 'lần sao lưu gần nhất thất bại' : `bản sao lưu gần nhất đã ${Math.round(b.ageHours)} giờ (ngưỡng ${t.backupMaxAgeH})`, 30 * 60_000);
  return checks;
}

/**
 * Hàm thuần: nhận trạng thái cũ và kết quả kiểm, trả trạng thái mới cùng các tin cần gửi.
 * state: { since: {key: ms}, firing: {key: {sinceMs, lastSentMs}} }
 */
export function step(state, checks, nowMs, repeatMs) {
  const next = { since: { ...state.since }, firing: { ...state.firing } };
  const messages = [];
  for (const c of checks) {
    if (c.active) {
      next.since[c.key] ??= nowMs;
      const held = nowMs - next.since[c.key];
      if (held >= c.forMs) {
        const f = next.firing[c.key];
        if (!f) {
          next.firing[c.key] = { sinceMs: nowMs, lastSentMs: null };
          messages.push({ key: c.key, kind: 'firing', text: c.text });
        } else if (f.lastSentMs !== null && nowMs - f.lastSentMs >= repeatMs) {
          messages.push({ key: c.key, kind: 'repeat', text: c.text });
        } else if (f.lastSentMs === null) {
          messages.push({ key: c.key, kind: 'firing', text: c.text });
        }
      }
    } else {
      delete next.since[c.key];
      if (next.firing[c.key]) {
        delete next.firing[c.key];
        messages.push({ key: c.key, kind: 'resolved', text: c.text });
      }
    }
  }
  return { next, messages };
}

const PREFIX = process.env.ALERT_PREFIX ?? '[MIHATO]';
const log = (msg, extra = {}) => console.log(JSON.stringify({ level: 'info', at: new Date().toISOString(), msg, ...extra }));
const errlog = (msg, extra = {}) => console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), msg, ...extra }));

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Gửi một tin. Trả true nếu có kênh nhận, false nếu mọi kênh đều lỗi (sẽ thử lại), null nếu chưa cấu hình kênh nào (chỉ ghi nhật ký). */
async function send(text) {
  const channels = [];
  if (process.env.ALERT_WEBHOOK_URL) channels.push(['webhook', () => postJson(process.env.ALERT_WEBHOOK_URL, { text })]);
  if (process.env.ALERT_TELEGRAM_BOT_TOKEN && process.env.ALERT_TELEGRAM_CHAT_ID) {
    channels.push(['telegram', () => postJson(`https://api.telegram.org/bot${process.env.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: process.env.ALERT_TELEGRAM_CHAT_ID, text })]);
  }
  if (channels.length === 0) return null;
  let ok = false;
  for (const [name, fn] of channels) {
    try {
      await fn();
      ok = true;
    } catch (err) {
      // Không in err.message: URL webhook và token Telegram nằm trong đó.
      errlog('alert_send_failed', { channel: name, errName: err instanceof Error ? err.name : 'error' });
    }
  }
  return ok;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function diskPercent(path) {
  try {
    const st = statfsSync(path);
    return Math.round((1 - Number(st.bavail) / Number(st.blocks)) * 100);
  } catch {
    return null;
  }
}

function tlsDaysLeft(addr, servername) {
  return new Promise((resolve) => {
    const [host, port] = addr.split(':');
    const sock = tls.connect({ host, port: Number(port ?? 443), servername, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve(cert?.valid_to ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000) : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(null);
    });
  });
}

function backupStatus(path, nowMs) {
  if (!existsSync(path)) return null;
  const j = readJson(path, null);
  if (!j) return { ok: false, ageHours: null };
  const finished = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
  return { ok: j.ok === true, ageHours: Number.isFinite(finished) ? (nowMs - finished) / 3_600_000 : null };
}

async function collect() {
  const now = Date.now();
  const snap = { deadEffects: null, effectLagSec: null, timerLagSec: null, heartbeatAgeSec: null, pushFailed: 0, pushTotal: 0, diskPercent: null, tlsDaysLeft: null, backup: null };

  if (process.env.DATABASE_URL_SCAN) {
    const scan = new pg.Client({ connectionString: process.env.DATABASE_URL_SCAN, connectionTimeoutMillis: 5000 });
    try {
      await scan.connect();
      snap.deadEffects = (await scan.query("select count(*)::int as n from effects where state = 'dead'")).rows[0].n;
      snap.effectLagSec = (await scan.query("select extract(epoch from now() - min(next_attempt_at))::int as s from effects where state = 'pending' and next_attempt_at < now()")).rows[0].s;
      snap.timerLagSec = (await scan.query("select extract(epoch from now() - min(fire_at))::int as s from timers where state = 'pending' and fire_at < now()")).rows[0].s;
    } catch (err) {
      errlog('collect_scan_failed', { errName: err instanceof Error ? err.name : 'error' });
    } finally {
      await scan.end().catch(() => {});
    }
  }

  if (process.env.DATABASE_URL) {
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    try {
      await app.connect();
      snap.heartbeatAgeSec = (await app.query('select extract(epoch from now() - max(beat_at))::int as s from worker_heartbeats')).rows[0].s;
      // Thông báo nằm sau RLS: đọc lần lượt từng tổ chức (hàm list_org_ids() chỉ trả id, không trả nội dung).
      const orgs = (await app.query('select list_org_ids() as id')).rows.map((r) => r.id);
      for (const id of orgs) {
        await app.query('begin');
        try {
          await app.query("select set_config('app.org_id', $1, true)", [id]);
          const r = await app.query(
            "select count(*) filter (where state = 'failed')::int as failed, count(*) filter (where state in ('sent','delivered','opened','failed'))::int as total from notifications where created_at > now() - interval '1 hour'",
          );
          snap.pushFailed += r.rows[0].failed;
          snap.pushTotal += r.rows[0].total;
        } finally {
          await app.query('rollback').catch(() => {});
        }
      }
    } catch (err) {
      errlog('collect_app_failed', { errName: err instanceof Error ? err.name : 'error' });
    } finally {
      await app.end().catch(() => {});
    }
  }

  snap.diskPercent = diskPercent(process.env.DISK_PATH ?? '/data/files');
  if (process.env.TLS_CHECK_ADDR && process.env.DOMAIN) snap.tlsDaysLeft = await tlsDaysLeft(process.env.TLS_CHECK_ADDR, process.env.DOMAIN);
  snap.backup = backupStatus(process.env.BACKUP_STATUS_FILE ?? '/backup/status.json', now);
  return snap;
}

async function cycle(stateFile, repeatMs) {
  const snap = await collect();
  const checks = evaluate(snap);
  const state = readJson(stateFile, { since: {}, firing: {} });
  const { next, messages } = step(state, checks, Date.now(), repeatMs);
  for (const m of messages) {
    const label = m.kind === 'resolved' ? 'ĐÃ XỬ LÝ' : m.kind === 'repeat' ? 'VẪN CÒN' : 'CẢNH BÁO';
    const delivered = await send(`${PREFIX} ${label}: ${m.key}${m.kind === 'resolved' ? '' : ` - ${m.text}`}`);
    log('alert', { key: m.key, kind: m.kind, delivered });
    if (m.kind === 'resolved') continue;
    if (delivered !== false && next.firing[m.key]) next.firing[m.key].lastSentMs = Date.now();
  }
  writeJsonAtomic(stateFile, next);
  return { snap, checks };
}

async function main() {
  const stateFile = process.env.OPS_STATE_FILE ?? '/var/lib/ops-alert/state.json';
  const repeatMs = Number(process.env.OPS_REPEAT_H ?? 6) * 3_600_000;
  if (!process.env.ALERT_WEBHOOK_URL && !process.env.ALERT_TELEGRAM_BOT_TOKEN) {
    errlog('alert_channel_missing', { fix: 'set_ALERT_WEBHOOK_URL_or_ALERT_TELEGRAM_*' });
  }
  if (process.argv.includes('--once')) {
    const { snap, checks } = await cycle(stateFile, repeatMs);
    console.log(JSON.stringify({ snapshot: snap, firing: checks.filter((c) => c.active).map((c) => c.key) }, null, 2));
    process.exitCode = checks.some((c) => c.active && c.forMs === 0) ? 1 : 0;
    return;
  }
  const intervalMs = Number(process.env.OPS_INTERVAL_S ?? 60) * 1000;
  log('ops_alert_started', { intervalS: intervalMs / 1000 });
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopping = true));
  while (!stopping) {
    try {
      await cycle(stateFile, repeatMs);
    } catch (err) {
      errlog('cycle_failed', { errName: err instanceof Error ? err.name : 'error' });
    }
    for (let waited = 0; waited < intervalMs && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
