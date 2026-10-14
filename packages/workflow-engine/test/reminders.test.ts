import { deterministicId, type ProcessDefinition, type ReminderStep, type ResolveContext } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { STANDARD_REMINDERS, STRICT_REMINDERS } from '../src';
import { asUser, Harness, SYSTEM } from './support/harness';
import { defOf, due17, edge, END, extraUser, makeCtx, runInput, START, task, U, UNIT, vn, withUsers } from './support/world';

/** Nhắc việc, leo thang và chống làm phiền (SPEC 4.6). Việc `a` giao Thứ Hai 05/10 09:00, hạn Thứ Tư 07/10 17:00. */

const T0 = vn('2026-10-05', '09:00');
const one = (extra: Record<string, unknown> = {}, who: string = U.TUAN): ProcessDefinition =>
  defOf({ nodes: [START, task('a', who, extra), END], edges: [edge('start', 'a'), edge('a', 'end')] });

function started(def: ProcessDefinition, ctx: ResolveContext = makeCtx(), initiator: string = U.ADMIN): Harness {
  const h = new Harness(def, ctx, runInput(initiator));
  h.dispatch({ type: 'StartRun', actor: asUser(initiator) }, T0);
  return h;
}
const brief = (h: Harness, from = 0) => h.sent({ from }).map((s) => [s.effect.kind.replace('notify.', ''), s.effect.toUserId]);
const at0830 = (...days: string[]) => days.map((d) => vn(d, '08:30').toISOString());

describe('bộ nhắc', () => {
  it('bộ standard: −1, 0, +1 (người nhận và người giao), +2 (cấp trên), +3 (Văn phòng), đều lúc 08:30', () => {
    expect(STANDARD_REMINDERS.map((s) => [s.at.offset.value, s.at.atTime, s.to, s.kind])).toEqual([
      [-1, '08:30', 'assignee', 'reminder'],
      [0, '08:30', 'assignee', 'reminder'],
      [1, '08:30', 'assignee', 'overdue'],
      [1, '08:30', 'assigner', 'overdue'],
      [2, '08:30', 'assignee_manager', 'escalation'],
      [3, '08:30', 'office_admin', 'escalation'],
    ]);
    const h = started(one());
    expect(h.timersOf('a').map((t) => [t.fireAt, t.timerKind, t.data.recipients])).toEqual([
      [at0830('2026-10-06')[0], 'reminder', [{ to: 'assignee', kind: 'reminder' }]],
      [at0830('2026-10-07')[0], 'reminder', [{ to: 'assignee', kind: 'reminder' }]],
      // hai mốc cùng thời điểm (người nhận và người giao) gom vào một timer
      [at0830('2026-10-08')[0], 'overdue', [{ to: 'assignee', kind: 'overdue' }, { to: 'assigner', kind: 'overdue' }]],
      [at0830('2026-10-09')[0], 'escalation', [{ to: 'assignee_manager', kind: 'escalation', level: 1 }]],
      [at0830('2026-10-12')[0], 'escalation', [{ to: 'office_admin', kind: 'escalation', level: 2 }]],
    ]);
    // khoá tất định: run:step:timer:seq:thứ tự mốc
    expect(h.timersOf('a').map((t) => t.dedupeKey)).toEqual([0, 1, 2, 3, 4].map((i) => `${h.run.id}:${h.step('a').id}:timer:1:${i}`));
  });

  it('chạy hết bộ standard khi việc bị bỏ mặc: đúng người, đúng ngày, đúng số ngày trễ', () => {
    const h = started(one(), makeCtx(), U.NGOCANH);
    h.advanceTo(vn('2026-10-13', '12:00'));
    expect(h.outbox.slice(1).map((s) => [s.at.toISOString(), s.effect.kind, s.effect.toUserId, s.effect.data['variant'] ?? s.effect.data['lateWorkingDays']])).toEqual([
      [at0830('2026-10-06')[0], 'notify.reminder', U.TUAN, 'due_tomorrow'],
      [at0830('2026-10-07')[0], 'notify.reminder', U.TUAN, 'due_today'],
      [at0830('2026-10-08')[0], 'notify.overdue', U.TUAN, 1],
      [at0830('2026-10-08')[0], 'notify.overdue', U.NGOCANH, 1],
      [at0830('2026-10-09')[0], 'notify.escalation', U.HUY, 2],
      [at0830('2026-10-12')[0], 'notify.escalation', U.ADMIN, 3],
    ]);
    expect(h.step('a')).toMatchObject({ state: 'ready', lastReminderOn: '2026-10-12' });
    expect(h.timers.size).toBe(0);
    expect(h.replayed()).toEqual(h.run);
  });

  it('bộ strict: nhắc sớm hơn một ngày, leo thang nhanh hơn một ngày', () => {
    expect(STRICT_REMINDERS.length).toBeGreaterThan(0);
    const h = started(one({ reminders: { preset: 'strict' }, due: { anchor: 'activation', offset: { value: 3, unit: 'working_day' } } }), makeCtx(), U.NGOCANH);
    expect(h.step('a').dueAt).toBe(due17('2026-10-08'));
    expect(h.timersOf('a').map((t) => t.fireAt)).toEqual(at0830('2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12'));
    h.advanceTo(vn('2026-10-13', '12:00'));
    expect(brief(h, 1)).toEqual([
      ['reminder', U.TUAN],
      ['reminder', U.TUAN],
      ['reminder', U.TUAN],
      ['overdue', U.TUAN],
      ['overdue', U.NGOCANH],
      ['escalation', U.HUY],
      ['escalation', U.ADMIN],
    ]);
  });

  it('bộ none: không hẹn nhắc nào; mặc định của tổ chức cũng áp được', () => {
    expect(started(one({ reminders: { preset: 'none' } })).timers.size).toBe(0);
    expect(started(one(), makeCtx({ defaultReminderPreset: 'none' })).timers.size).toBe(0);
    expect(started(one(), makeCtx({ defaultReminderPreset: 'strict' })).timersOf('a')).toHaveLength(4); // mốc −2 đã qua
    // nút khai báo rõ thì thắng mặc định của tổ chức
    expect(started(one({ reminders: { preset: 'standard' } }), makeCtx({ defaultReminderPreset: 'none' })).timersOf('a')).toHaveLength(5);
  });

  it('bộ nhắc riêng của tổ chức và overrides của nút', () => {
    const orgStandard: ReminderStep[] = [{ at: { anchor: 'due', offset: { value: 0, unit: 'working_day' }, atTime: '07:45' }, to: 'assignee', kind: 'reminder' }];
    const org = started(one(), makeCtx({ reminderPresets: { standard: orgStandard } }));
    expect(org.timersOf('a').map((t) => t.fireAt)).toEqual([vn('2026-10-07', '07:45').toISOString()]);

    const overrides: ReminderStep[] = [
      { at: { anchor: 'assigned', offset: { value: 4, unit: 'hour' } }, to: 'assignee', kind: 'reminder' },
      { at: { anchor: 'due', offset: { value: -2, unit: 'hour' } }, to: 'assignee', kind: 'reminder' },
      { at: { anchor: 'due', offset: { value: 1, unit: 'calendar_day' } }, to: 'office_admin', kind: 'escalation' },
    ];
    const h = started(one({ reminders: { preset: 'standard', overrides } }));
    expect(h.timersOf('a').map((t) => [t.fireAt, t.timerKind])).toEqual([
      [vn('2026-10-05', '13:00').toISOString(), 'reminder'], // 4 giờ sau khi giao
      [vn('2026-10-07', '15:00').toISOString(), 'reminder'], // 2 giờ trước hạn
      [vn('2026-10-08', '17:00').toISOString(), 'escalation'], // bỏ trống atTime: giữ giờ của hạn
    ]);
    h.advanceTo(vn('2026-10-09', '09:00'));
    expect(h.outbox.slice(1).map((s) => [s.effect.kind, s.effect.toUserId, s.effect.data['variant'] ?? s.effect.data['level']])).toEqual([
      ['notify.reminder', U.TUAN, 'custom'],
      ['notify.reminder', U.TUAN, 'due_today'],
      ['notify.escalation', U.ADMIN, 1],
    ]);
  });

  it('mốc đã qua lúc kích hoạt thì không hẹn', () => {
    // hạn ngay trong ngày: mốc −1 và mốc 0 (08:30) đều đã qua lúc 09:00
    const h = started(one({ due: { anchor: 'activation', offset: { value: 0, unit: 'working_day' } } }));
    expect(h.step('a').dueAt).toBe(due17('2026-10-05'));
    expect(h.timersOf('a').map((t) => t.fireAt)).toEqual(at0830('2026-10-06', '2026-10-07', '2026-10-08'));
  });

  it('việc không có hạn (không có mốc đích) thì không có mốc nhắc theo hạn', () => {
    const def = defOf({
      inputs: [{ key: 'day', label: 'Ngày', type: 'date' }],
      targetField: 'day',
      nodes: [START, task('a', U.TUAN, { due: { anchor: 'run_target', offset: { value: -1, unit: 'working_day' } } }), END],
      edges: [edge('start', 'a'), edge('a', 'end')],
    });
    const h = started(def);
    expect(h.step('a')).toMatchObject({ state: 'ready', dueAt: null, dueOriginalAt: null });
    expect(h.timers.size).toBe(0);
  });
});

describe('người nhận tin leo thang', () => {
  it('cấp trên trực tiếp: managerId; thiếu thì trưởng đơn vị; thiếu nữa thì Văn phòng', () => {
    const escalatedTo = (ctx: ResolveContext, who: string = U.HUNG) => {
      const h = started(one({}, who), ctx);
      h.advanceTo(vn('2026-10-09', '08:30'));
      return h.sent({ kind: 'notify.escalation' }).map((s) => s.effect.toUserId);
    };
    expect(escalatedTo(makeCtx())).toEqual([U.HUY]);
    // Hùng không có managerId: trưởng đơn vị Kinh doanh là Lan
    expect(escalatedTo(makeCtx({ users: withUsers(extraUser(U.HUNG, 'employee', UNIT.SALES, null)) }))).toEqual([U.LAN]);
    // cấp trên đã bị vô hiệu hoá: cũng leo lên trưởng đơn vị
    expect(escalatedTo(makeCtx({ users: withUsers(extraUser(U.HUY, 'deputy', UNIT.BOARD, U.DIRECTOR, 'disabled')) }))).toEqual([U.LAN]);
    // không có managerId, đơn vị không có trưởng, đơn vị cha có trưởng là giám đốc
    expect(escalatedTo(makeCtx({ users: withUsers(extraUser(U.TUAN, 'employee', UNIT.TECH, null)) }), U.TUAN)).toEqual([U.DIRECTOR]);
    // không tìm được ai: Văn phòng
    const flat = makeCtx({ users: withUsers(extraUser(U.TUAN, 'employee', UNIT.TECH, null)), units: [] });
    expect(escalatedTo(flat, U.TUAN)).toEqual([U.ADMIN]);
  });

  it('cấp trên trực tiếp là Chủ tịch thì tin đi tới Văn phòng, không nhắn thẳng cho Chủ tịch', () => {
    const h = started(one({}, U.DIRECTOR));
    h.advanceTo(vn('2026-10-12', '08:30'));
    expect(h.sent({ kind: 'notify.escalation' }).map((s) => [s.effect.toUserId, s.effect.data['level']])).toEqual([
      [U.ADMIN, 1],
      [U.ADMIN, 2],
    ]);
    expect(h.sent({ to: U.CHAIRMAN })).toEqual([]);
  });

  it('nút có escalateTo: leo thang cấp 1 tới người đó', () => {
    const h = started(one({ escalateTo: { kind: 'user', userId: U.DIRECTOR } }));
    h.advanceTo(vn('2026-10-09', '08:30'));
    expect(h.sent({ kind: 'notify.escalation' }).map((s) => s.effect.toUserId)).toEqual([U.DIRECTOR]);
  });

  it('người vừa là người nhận vừa là người giao chỉ nhận một tin quá hạn', () => {
    const h = started(one({}, U.NGOCANH), makeCtx(), U.NGOCANH);
    h.advanceTo(vn('2026-10-08', '08:30'));
    expect(h.sent({ kind: 'notify.overdue' }).map((s) => [s.effect.toUserId, s.effect.data['audience']])).toEqual([[U.NGOCANH, 'assignee']]);
  });
});

describe('chống làm phiền', () => {
  const fire = (h: Harness, at: Date, kind: 'reminder' | 'overdue' = 'reminder') =>
    h.dispatch(
      { type: 'TimerFired', actor: SYSTEM, timerKey: `thủ công:${at.toISOString()}`, stepId: h.step('a').id, kind, data: { to: 'assignee' } },
      at,
    );

  it('tối đa một nhắc tự động cho mỗi việc mỗi ngày: nhắc thứ hai trong ngày bị bỏ qua', () => {
    const h = started(one());
    h.advanceTo(vn('2026-10-06', '08:30'));
    expect(h.step('a').lastReminderOn).toBe('2026-10-06');
    const mark = h.mark();
    const second = fire(h, vn('2026-10-06', '14:00'));
    expect(second.effects).toEqual([]);
    expect(second.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'already_reminded_today' }]);
    expect(h.sent({ from: mark })).toEqual([]);
    // sang ngày hôm sau thì nhắc lại được
    h.advanceTo(vn('2026-10-07', '08:30'));
    expect(brief(h, mark)).toEqual([['reminder', U.TUAN]]);
    expect(h.step('a').lastReminderOn).toBe('2026-10-07');
  });

  it('timer dồn lại sau khi worker ngừng chạy: mốc trước hạn đã lỗi thời bị bỏ, chỉ tin quá hạn được gửi', () => {
    const h = started(one());
    // worker ngừng từ 06/10 tới sáng 08/10: ba timer (−1, 0, +1) cùng bắn lúc 08/10 09:00, khi việc đã quá hạn
    const pending = h.timersOf('a').filter((t) => t.fireAt <= vn('2026-10-08', '09:00').toISOString());
    expect(pending).toHaveLength(3);
    const outs = pending.map((t) =>
      h.dispatch({ type: 'TimerFired', actor: SYSTEM, timerKey: t.dedupeKey, stepId: t.stepId, kind: t.timerKind, data: t.data }, vn('2026-10-08', '09:00')),
    );
    // không gửi "ngày mai đến hạn" hay "hôm nay đến hạn" cho một việc đã quá hạn
    expect(outs.map((o) => o.effects.map((e) => e.kind))).toEqual([[], [], ['notify.overdue', 'notify.overdue']]);
    expect(outs[0]?.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'not_open' }]);
    expect(outs[2]?.effects).toMatchObject([
      { toUserId: U.TUAN, data: { lateWorkingDays: 1 } },
      { toUserId: U.ADMIN, data: { lateWorkingDays: 1 } },
    ]);
  });

  it('hai timer của cùng một việc bắn trong cùng ngày: timer sau bị bỏ qua', () => {
    const h = started(one());
    // worker ngừng tới Thứ Hai 12/10: mốc +1, +2, +3 dồn lại; chỉ mốc đầu được gửi trong ngày
    for (const t of h.timersOf('a').slice(0, 2)) h.timers.delete(t.dedupeKey);
    const mark = h.mark();
    h.advanceTo(vn('2026-10-12', '08:30'));
    // advanceTo bắn đúng giờ hẹn của từng timer nên mỗi mốc rơi vào một ngày riêng: đủ ba ngày, ba đợt tin
    expect(brief(h, mark)).toEqual([
      ['overdue', U.TUAN],
      ['overdue', U.ADMIN],
      ['escalation', U.HUY],
      ['escalation', U.ADMIN],
    ]);
    const lateTogether = started(one());
    const piled = lateTogether.timersOf('a').slice(2);
    const outs = piled.map((t) =>
      lateTogether.dispatch({ type: 'TimerFired', actor: SYSTEM, timerKey: t.dedupeKey, stepId: t.stepId, kind: t.timerKind, data: t.data }, vn('2026-10-12', '09:00')),
    );
    expect(outs.map((o) => o.effects.length)).toEqual([2, 0, 0]);
    expect(outs[1]?.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: lateTogether.step('a').id, why: 'already_reminded_today' }]);
    expect(outs[0]?.effects).toMatchObject([{ data: { lateWorkingDays: 3 } }, { data: { lateWorkingDays: 3 } }]);
  });

  it('việc vừa được đi thúc trong 4 giờ: nhắc tự động bị bỏ qua; sau 4 giờ thì nhắc lại', () => {
    const h = started(one());
    const nudgeAt = vn('2026-10-06', '06:00');
    h.dispatch(
      { type: 'NudgeSent', actor: SYSTEM, stepId: h.step('a').id, nudgeId: deterministicId('n1'), fromUserId: U.ADMIN, toUserId: U.TUAN, message: 'Nhắc', aiDrafted: false },
      nudgeAt,
    );
    const mark = h.mark();
    h.advanceTo(vn('2026-10-06', '08:30')); // 2 giờ 30 phút sau khi đi thúc
    expect(h.sent({ from: mark })).toEqual([]);
    expect(h.records.at(-1)?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'recently_nudged' }]);
    expect(h.step('a').lastReminderOn).toBeNull();
    // đúng 4 giờ sau thì không còn bị chặn
    const later = fire(h, new Date(nudgeAt.getTime() + 4 * 3_600_000));
    expect(later.effects).toMatchObject([{ kind: 'notify.reminder', toUserId: U.TUAN }]);
  });

  it('việc không còn mở (đã xong) thì timer bắn muộn bị bỏ qua', () => {
    const h = started(one());
    const timer = h.timersOf('a')[0];
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.TUAN), stepId: h.step('a').id }, vn('2026-10-05', '16:00'));
    expect(h.timers.size).toBe(0);
    expect(timer).toBeDefined();
    if (!timer) return;
    const late = h.dispatch({ type: 'TimerFired', actor: SYSTEM, timerKey: timer.dedupeKey, stepId: timer.stepId, kind: timer.timerKind, data: timer.data }, new Date(timer.fireAt));
    expect(late.effects).toEqual([]);
    expect(late.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'not_open' }]);
  });

  it('mốc quá hạn bắn ra khi việc không còn quá hạn (hạn vừa được dời) thì bị bỏ qua', () => {
    const h = started(one());
    const overdueTimer = h.timersOf('a').find((t) => t.timerKind === 'overdue');
    h.dispatch({ type: 'ExtendDue', actor: asUser(U.ADMIN), stepId: h.step('a').id, newDueAt: due17('2026-10-14'), reason: 'dời' }, vn('2026-10-07', '16:00'));
    expect(overdueTimer).toBeDefined();
    if (!overdueTimer) return;
    const stale = h.dispatch(
      { type: 'TimerFired', actor: SYSTEM, timerKey: overdueTimer.dedupeKey, stepId: overdueTimer.stepId, kind: overdueTimer.timerKind, data: overdueTimer.data },
      new Date(overdueTimer.fireAt),
    );
    expect(stale.effects).toEqual([]);
    expect(stale.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'not_open' }]);
    expect(h.step('a').lastReminderOn).toBeNull();
  });

  it('không có ai để nhắc thì ghi no_recipient', () => {
    const noOffice = makeCtx({ users: withUsers(extraUser(U.ADMIN, 'office_admin', UNIT.OFFICE, U.DIRECTOR, 'disabled')) });
    const h = started(one(), noOffice, U.NGOCANH);
    const out = h.dispatch(
      { type: 'TimerFired', actor: SYSTEM, timerKey: 'thủ công', stepId: h.step('a').id, kind: 'escalation', data: { recipients: [{ to: 'office_admin', kind: 'escalation', level: 2 }] } },
      vn('2026-10-12', '08:30'),
    );
    expect(out.effects).toEqual([]);
    expect(out.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'no_recipient' }]);
  });

  it('timer kiểu cũ không có data.recipients vẫn chạy theo data.to và kind', () => {
    const h = started(one());
    const out = fire(h, vn('2026-10-08', '08:30'), 'overdue');
    expect(out.effects).toMatchObject([{ kind: 'notify.overdue', toUserId: U.TUAN, data: { lateWorkingDays: 1, audience: 'assignee' } }]);
  });
});
