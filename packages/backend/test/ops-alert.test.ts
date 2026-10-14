import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Logic cảnh báo của deploy/ops/ops-alert.mjs (SPEC 12.4): hàm thuần evaluate() và step(); phần truy vấn và gửi tin không chạy ở đây. */
type Snapshot = {
  deadEffects: number | null;
  effectLagSec: number | null;
  timerLagSec: number | null;
  heartbeatAgeSec: number | null;
  pushFailed: number;
  pushTotal: number;
  diskPercent: number | null;
  tlsDaysLeft: number | null;
  backup: { ok: boolean; ageHours: number | null } | null;
};
type Check = { key: string; active: boolean; text: string; forMs: number };
type State = { since: Record<string, number>; firing: Record<string, { sinceMs: number; lastSentMs: number | null }> };
type Msg = { key: string; kind: 'firing' | 'repeat' | 'resolved'; text: string };
const mod = (await import(pathToFileURL(fileURLToPath(new URL('../../../deploy/ops/ops-alert.mjs', import.meta.url))).href)) as {
  evaluate: (s: Snapshot) => Check[];
  step: (state: State, checks: Check[], nowMs: number, repeatMs: number) => { next: State; messages: Msg[] };
};

const healthy: Snapshot = { deadEffects: 0, effectLagSec: null, timerLagSec: null, heartbeatAgeSec: 20, pushFailed: 0, pushTotal: 0, diskPercent: 40, tlsDaysLeft: 60, backup: { ok: true, ageHours: 3 } };
const active = (s: Snapshot) => mod.evaluate(s).filter((c) => c.active).map((c) => c.key);

describe('ops-alert evaluate', () => {
  it('hệ thống khoẻ thì không điều kiện nào kích hoạt', () => {
    expect(active(healthy)).toEqual([]);
  });

  it('mỗi ngưỡng của SPEC 12.4 kích hoạt đúng điều kiện', () => {
    expect(active({ ...healthy, deadEffects: 1 })).toEqual(['effects_dead']);
    expect(active({ ...healthy, effectLagSec: 301 })).toEqual(['effects_lag']);
    expect(active({ ...healthy, effectLagSec: 299 })).toEqual([]);
    expect(active({ ...healthy, timerLagSec: 600 })).toEqual(['timers_lag']);
    expect(active({ ...healthy, heartbeatAgeSec: 121 })).toEqual(['worker_heartbeat']);
    expect(active({ ...healthy, heartbeatAgeSec: 119 })).toEqual([]);
    expect(active({ ...healthy, diskPercent: 81 })).toEqual(['disk_usage']);
    expect(active({ ...healthy, tlsDaysLeft: 13 })).toEqual(['tls_expiry']);
    expect(active({ ...healthy, backup: { ok: false, ageHours: 1 } })).toEqual(['backup']);
    expect(active({ ...healthy, backup: { ok: true, ageHours: 27 } })).toEqual(['backup']);
    expect(active({ ...healthy, backup: null })).toEqual(['backup']);
  });

  it('tỷ lệ thông báo lỗi chỉ tính khi đủ mẫu', () => {
    expect(active({ ...healthy, pushFailed: 5, pushTotal: 9 })).toEqual([]);
    expect(active({ ...healthy, pushFailed: 3, pushTotal: 10 })).toEqual(['push_failures']);
    expect(active({ ...healthy, pushFailed: 2, pushTotal: 10 })).toEqual([]);
  });

  it('không đo được thì cũng báo (không im lặng khi mù)', () => {
    expect(active({ ...healthy, heartbeatAgeSec: null, deadEffects: null, diskPercent: null, tlsDaysLeft: null })).toEqual(['effects_dead', 'worker_heartbeat', 'disk_usage', 'tls_expiry']);
  });

  it('nội dung cảnh báo chỉ có tên điều kiện và con số', () => {
    const text = JSON.stringify(mod.evaluate({ ...healthy, deadEffects: 3, diskPercent: 90 }));
    expect(text).not.toMatch(/@|token|password/i);
  });
});

describe('ops-alert step (chống báo trùng)', () => {
  const REPEAT = 6 * 3_600_000;
  const empty: State = { since: {}, firing: {} };
  const dead = (n: number): Check[] => mod.evaluate({ ...healthy, deadEffects: n });

  it('effects dead phải kéo dài 10 phút mới báo, sau đó báo một lần', () => {
    let r = mod.step(empty, dead(1), 0, REPEAT);
    expect(r.messages).toEqual([]);
    r = mod.step(r.next, dead(1), 5 * 60_000, REPEAT);
    expect(r.messages).toEqual([]);
    r = mod.step(r.next, dead(1), 10 * 60_000, REPEAT);
    expect(r.messages.map((m) => `${m.key}:${m.kind}`)).toEqual(['effects_dead:firing']);
    // đã gửi thành công thì lần sau không báo lại cho tới hạn nhắc
    r.next.firing.effects_dead!.lastSentMs = 10 * 60_000;
    r = mod.step(r.next, dead(1), 11 * 60_000, REPEAT);
    expect(r.messages).toEqual([]);
    r = mod.step(r.next, dead(1), 10 * 60_000 + REPEAT, REPEAT);
    expect(r.messages.map((m) => m.kind)).toEqual(['repeat']);
  });

  it('gửi lỗi (lastSentMs còn null) thì thử lại vòng sau; hết lỗi thì báo đã xử lý một lần', () => {
    let r = mod.step(empty, mod.evaluate({ ...healthy, heartbeatAgeSec: 500 }), 1000, REPEAT);
    expect(r.messages.map((m) => m.kind)).toEqual(['firing']);
    r = mod.step(r.next, mod.evaluate({ ...healthy, heartbeatAgeSec: 560 }), 61_000, REPEAT);
    expect(r.messages.map((m) => m.kind)).toEqual(['firing']);
    r = mod.step(r.next, mod.evaluate(healthy), 121_000, REPEAT);
    expect(r.messages.map((m) => `${m.key}:${m.kind}`)).toEqual(['worker_heartbeat:resolved']);
    r = mod.step(r.next, mod.evaluate(healthy), 181_000, REPEAT);
    expect(r.messages).toEqual([]);
  });

  it('điều kiện chớp tắt dưới ngưỡng thời gian không gây báo', () => {
    let r = mod.step(empty, dead(1), 0, REPEAT);
    r = mod.step(r.next, dead(0), 60_000, REPEAT);
    r = mod.step(r.next, dead(1), 9 * 60_000, REPEAT);
    expect(r.messages).toEqual([]);
    r = mod.step(r.next, dead(1), 18 * 60_000, REPEAT);
    expect(r.messages).toEqual([]);
    r = mod.step(r.next, dead(1), 19 * 60_000, REPEAT);
    expect(r.messages.map((m) => m.kind)).toEqual(['firing']);
  });
});
