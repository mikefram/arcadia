import { deterministicId, EngineError, type StepStateName } from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { describe, expect, it } from 'vitest';
import { validate } from '../src';
import { asUser, errorCode, Harness, SYSTEM } from './support/harness';
import { due17, GOLDEN_DEF, goldenRunInput, makeCtx, U, VN, vn } from './support/world';

/**
 * Kịch bản vàng (SPEC 13.2): quy trình "Đón đoàn nhà đầu tư thăm KCN", mốc đích Thứ Năm 15/10/2026.
 * Chạy trọn 12 bước bằng `advance()` với đồng hồ giả và timer mô phỏng trong bộ nhớ.
 */

const NUDGE_ID = deterministicId('golden:nudge:s3');

const states = (h: Harness): Record<string, StepStateName> => Object.fromEntries(h.run.steps.map((s) => [s.nodeId, s.state]));

/** Chạy bước 1 đến bước 8, dùng chung cho biến thể A, nhánh C và biến thể Chủ tịch khởi chạy. */
function runUntilStep8(initiator: string): Harness {
  const h = new Harness(GOLDEN_DEF, makeCtx(), goldenRunInput(initiator));

  // Bước 1: Thứ Sáu 02/10, 09:00, khởi chạy.
  h.dispatch({ type: 'StartRun', actor: asUser(initiator) }, vn('2026-10-02', '09:00'));

  // Bước 2: Thứ Hai 05/10, 08:30, mốc "1 ngày làm việc trước hạn".
  h.advanceTo(vn('2026-10-05', '08:30'));

  // Bước 3: Thứ Hai 05/10, 11:00, Lan báo xong s1.
  h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('s1').id }, vn('2026-10-05', '11:00'));

  // Bước 4: Thứ Hai 05/10, 14:00, Phương nhập 20.000.000 đồng rồi báo xong s4.
  h.dispatch(
    { type: 'CompleteStep', actor: asUser(U.PHUONG), stepId: h.step('s4').id, result: { amount: 20_000_000 } },
    vn('2026-10-05', '14:00'),
  );

  // Bước 5: Thứ Tư 07/10, 09:00, Huy duyệt s6.
  h.advanceTo(vn('2026-10-07', '09:00'));
  h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('s6').id }, vn('2026-10-07', '09:00'));

  // Bước 6: Thứ Tư 07/10, 10:00, Ngọc Anh báo xong s2 khi mất mạng; app gửi lại sau 5 phút với cùng eventId.
  const offlineEventId = deterministicId('golden:offline:s2');
  h.dispatch({ type: 'CompleteStep', actor: asUser(U.NGOCANH), stepId: h.step('s2').id, eventId: offlineEventId }, vn('2026-10-07', '10:00'));
  h.dispatch({ type: 'CompleteStep', actor: asUser(U.NGOCANH), stepId: h.step('s2').id, eventId: offlineEventId }, vn('2026-10-07', '10:05'));

  // Bước 7: Thứ Năm 08/10, 08:30, s3 đã quá hạn từ Thứ Tư 17:00.
  h.advanceTo(vn('2026-10-08', '08:30'));
  // Bước 8: 09:00, xem tình hình (không có sự kiện).
  h.advanceTo(vn('2026-10-08', '09:00'));
  return h;
}

describe('kịch bản vàng, biến thể A: U_ADMIN khởi chạy', () => {
  it('định nghĩa mẫu qua được validate() không lỗi, không cảnh báo', () => {
    const result = validate(GOLDEN_DEF);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.definition).not.toBeNull();
  });

  it('chạy trọn 12 bước', () => {
    const h = new Harness(GOLDEN_DEF, makeCtx(), goldenRunInput(U.ADMIN));
    expect(h.run.state).toBe('draft');
    expect(h.run.targetAt).toBe('2026-10-14T17:00:00.000Z'); // 00:00 ngày 15/10 giờ Việt Nam

    // ── Bước 1: Thứ Sáu 02/10, 09:00 ──
    let mark = h.mark();
    const started = h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN) }, vn('2026-10-02', '09:00'));
    expect(h.run.state).toBe('running');
    expect(started.events).toHaveLength(1);
    expect(states(h)).toMatchObject({ start: 'done', s1: 'ready', s4: 'ready', s2: 'pending', s3: 'pending', s5: 'pending', s6: 'pending', end: 'pending' });
    expect(h.step('s1')).toMatchObject({ assigneeId: U.LAN, dueAt: due17('2026-10-06'), dueOriginalAt: due17('2026-10-06'), assignedBy: U.ADMIN });
    expect(h.step('s4')).toMatchObject({ assigneeId: U.PHUONG, dueAt: due17('2026-10-06') });
    // Lan và Phương mỗi người đúng một thông báo "vừa giao"; không ai khác nhận gì.
    expect(h.sent({ from: mark })).toHaveLength(2);
    expect(h.sent({ from: mark, kind: 'notify.assigned', to: U.LAN, nodeId: 's1' })).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.assigned', to: U.PHUONG, nodeId: 's4' })).toHaveLength(1);
    expect(h.sent({ from: mark, to: U.LAN })[0]?.effect.data).toMatchObject({ stepKind: 'task', dueAt: due17('2026-10-06'), assignedBy: U.ADMIN });
    // Mỗi việc năm mốc nhắc: −1, 0, +1, +2, +3 ngày làm việc so với hạn, lúc 08:30.
    expect(h.timersOf('s1').map((t) => t.fireAt)).toEqual(
      ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d) => vn(d, '08:30').toISOString()),
    );
    expect(h.timersOf('s1').map((t) => t.timerKind)).toEqual(['reminder', 'reminder', 'overdue', 'escalation', 'escalation']);
    expect(h.timers.size).toBe(10);

    // ── Bước 2: Thứ Hai 05/10, 08:30 ──
    mark = h.mark();
    h.advanceTo(vn('2026-10-05', '08:30'));
    expect(h.sent({ from: mark })).toHaveLength(2);
    for (const who of [U.LAN, U.PHUONG]) {
      const got = h.sent({ from: mark, kind: 'notify.reminder', to: who });
      expect(got).toHaveLength(1);
      expect(got[0]?.effect.data).toMatchObject({ variant: 'due_tomorrow' });
      expect(got[0]?.at.toISOString()).toBe(vn('2026-10-05', '08:30').toISOString());
    }

    // ── Bước 3: Thứ Hai 05/10, 11:00, Lan báo xong s1 ──
    mark = h.mark();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('s1').id }, vn('2026-10-05', '11:00'));
    expect(states(h)).toMatchObject({ s1: 'done', s2: 'ready', s3: 'ready', s5: 'pending' });
    expect(h.step('s2')).toMatchObject({ assigneeId: U.NGOCANH, dueAt: due17('2026-10-08') });
    expect(h.step('s3')).toMatchObject({ assigneeId: U.TUAN, dueAt: due17('2026-10-07') });
    expect(h.sent({ from: mark, kind: 'notify.assigned', to: U.NGOCANH, nodeId: 's2' })).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.assigned', to: U.TUAN, nodeId: 's3' })).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.assigned' })).toHaveLength(2);
    expect(h.sent({ from: mark, kind: 'notify.completed', to: U.ADMIN, nodeId: 's1' })).toHaveLength(1); // người giao
    expect(h.timersOf('s1')).toEqual([]); // timer của s1 bị huỷ

    // ── Bước 4: Thứ Hai 05/10, 14:00, Phương báo xong s4 ──
    // Thiếu số tiền thì không báo xong được, và không có gì thay đổi.
    const before = h.run;
    expect(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.PHUONG), stepId: h.step('s4').id }, vn('2026-10-05', '14:00'))).toThrow(EngineError);
    expect(h.run).toBe(before);
    mark = h.mark();
    h.dispatch(
      { type: 'CompleteStep', actor: asUser(U.PHUONG), stepId: h.step('s4').id, result: { amount: 20_000_000 } },
      vn('2026-10-05', '14:00'),
    );
    expect(h.step('s4')).toMatchObject({ state: 'done', result: { amount: 20_000_000 } });
    expect(h.step('s6')).toMatchObject({ state: 'ready', assigneeId: U.HUY, dueAt: due17('2026-10-07'), kind: 'approval' });
    const needApproval = h.sent({ from: mark, kind: 'notify.assigned', to: U.HUY });
    expect(needApproval).toHaveLength(1);
    expect(needApproval[0]?.effect.data).toMatchObject({ stepKind: 'approval', nodeId: 's6' }); // worker chọn câu "Cần duyệt"

    // ── Giữa chừng: Thứ Ba 06/10 08:30 (s3, s6 "ngày mai đến hạn"); Thứ Tư 07/10 08:30 (s3, s6 "hôm nay", s2 "ngày mai") ──
    mark = h.mark();
    h.advanceTo(vn('2026-10-06', '08:30'));
    expect(h.sent({ from: mark }).map((s) => [s.effect.toUserId, s.effect.data['variant']]).sort()).toEqual(
      [
        [U.HUY, 'due_tomorrow'],
        [U.TUAN, 'due_tomorrow'],
      ].sort(),
    );
    mark = h.mark();
    h.advanceTo(vn('2026-10-07', '08:30'));
    expect(h.sent({ from: mark }).map((s) => [s.effect.toUserId, s.effect.data['variant']]).sort()).toEqual(
      [
        [U.HUY, 'due_today'],
        [U.NGOCANH, 'due_tomorrow'],
        [U.TUAN, 'due_today'],
      ].sort(),
    );

    // ── Bước 5: Thứ Tư 07/10, 09:00, Huy duyệt s6 ──
    // Số tiền 20.000.000 đồng lấy từ kết quả s4: tầng API dựa vào đây để bật requiresStepUp.
    expect(h.step('s4').result?.['amount']).toBe(20_000_000);
    mark = h.mark();
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('s6').id }, vn('2026-10-07', '09:00'));
    // người giao (U_ADMIN) được báo việc duyệt đã xong; không ai khác nhận tin
    expect(h.sent({ from: mark }).map((s) => [s.effect.kind, s.effect.toUserId, s.effect.data['decision']])).toEqual([['notify.completed', U.ADMIN, 'approved']]);
    expect(h.step('s6')).toMatchObject({
      state: 'done',
      completedAt: vn('2026-10-07', '09:00').toISOString(),
      approvals: [{ approverId: U.HUY, decision: 'approved', decidedAt: vn('2026-10-07', '09:00').toISOString() }],
    });
    expect(h.timersOf('s6')).toEqual([]);
    expect(h.run.state).toBe('running');

    // ── Bước 6: Thứ Tư 07/10, 10:00, Ngọc Anh báo xong s2 lúc mất mạng, app gửi lại sau 5 phút ──
    mark = h.mark();
    const offlineEventId = deterministicId('golden:offline:s2');
    const complete = { type: 'CompleteStep', actor: asUser(U.NGOCANH), stepId: h.step('s2').id, eventId: offlineEventId } as const;
    const first = h.dispatch(complete, vn('2026-10-07', '10:00'));
    const seqAfterFirst = h.run.seq;
    const second = h.dispatch(complete, vn('2026-10-07', '10:05'));
    expect(first.events).toHaveLength(1);
    expect(second.events).toEqual([]); // máy chủ ghi đúng một lần
    expect(second.effects).toEqual([]);
    expect(second.run).toBe(first.run);
    expect(h.run.seq).toBe(seqAfterFirst);
    expect(h.records.filter((r) => r.id === offlineEventId)).toHaveLength(1);
    expect(h.step('s2').completedAt).toBe(vn('2026-10-07', '10:00').toISOString());
    expect(h.step('s5')).toMatchObject({ state: 'ready', assigneeId: U.HUNG, dueAt: due17('2026-10-09') });
    expect(h.sent({ from: mark, kind: 'notify.assigned', to: U.HUNG, nodeId: 's5' })).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.assigned' })).toHaveLength(1);

    // ── Bước 7: Thứ Năm 08/10, 08:30, s3 quá hạn 1 ngày ──
    mark = h.mark();
    h.advanceTo(vn('2026-10-08', '08:30'));
    const overdue = h.sent({ from: mark, kind: 'notify.overdue' });
    expect(overdue.map((s) => s.effect.toUserId).sort()).toEqual([U.ADMIN, U.TUAN].sort());
    expect(h.sent({ from: mark, kind: 'notify.overdue', to: U.TUAN })[0]?.effect.data).toMatchObject({ nodeId: 's3', lateWorkingDays: 1, audience: 'assignee' });
    // Người giao ở biến thể A là U_ADMIN: nhận tin tương ứng, đúng một lần.
    expect(h.sent({ from: mark, kind: 'notify.overdue', to: U.ADMIN })[0]?.effect.data).toMatchObject({ nodeId: 's3', lateWorkingDays: 1, audience: 'assigner', assigneeId: U.TUAN });
    // Cùng lúc đó Hùng nhận "ngày mai đến hạn" của s5; không có tin nào khác.
    expect(h.sent({ from: mark, kind: 'notify.reminder', to: U.HUNG })[0]?.effect.data).toMatchObject({ variant: 'due_tomorrow', nodeId: 's5' });
    expect(h.sent({ from: mark })).toHaveLength(3);

    // ── Bước 8: Thứ Năm 08/10, 09:00, tình hình ──
    const now8 = vn('2026-10-08', '09:00');
    const isOverdue = (nodeId: string): boolean => {
      const s = h.step(nodeId);
      return ['unassigned', 'ready', 'in_progress'].includes(s.state) && s.dueAt !== null && now8.getTime() > new Date(s.dueAt).getTime();
    };
    expect(states(h)).toMatchObject({ s1: 'done', s4: 'done', s6: 'done', s2: 'done', s5: 'ready', s3: 'ready' });
    expect(isOverdue('s5')).toBe(false);
    expect(isOverdue('s3')).toBe(true);

    // ── Bước 9: Thứ Năm 08/10, 09:05, U_ADMIN bấm Đi thúc ──
    mark = h.mark();
    h.dispatch(
      {
        type: 'NudgeSent',
        actor: asUser(U.ADMIN),
        stepId: h.step('s3').id,
        nudgeId: NUDGE_ID,
        fromUserId: U.ADMIN,
        toUserId: U.TUAN,
        message: 'Văn phòng Chủ tịch nhắc anh Tuấn: việc ‘Kiểm tra tuyến tham quan’ đã quá hạn 1 ngày. Anh cho biết khi nào hoàn thành.',
        aiDrafted: false,
      },
      vn('2026-10-08', '09:05'),
    );
    const nudges = h.sent({ from: mark });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.effect).toMatchObject({ kind: 'notify.nudge', toUserId: U.TUAN, data: { nudgeId: NUDGE_ID, aiDrafted: false, lateWorkingDays: 1 } });
    expect(h.step('s3').lastNudgedAt).toBe(vn('2026-10-08', '09:05').toISOString());

    // ── Bước 10: Thứ Năm 08/10, 10:00, Tuấn báo xong s3 từ lời nhắc ──
    const done3 = h.dispatch({ type: 'CompleteStep', actor: asUser(U.TUAN), stepId: h.step('s3').id, nudgeId: NUDGE_ID }, vn('2026-10-08', '10:00'));
    expect(h.step('s3').state).toBe('done');
    expect(h.timersOf('s3')).toEqual([]); // mọi timer leo thang của s3 bị huỷ
    expect(done3.events[0]?.payload.changes).toContainEqual({ type: 'nudge.replied', stepId: h.step('s3').id, nudgeId: NUDGE_ID, reply: 'done' });
    expect(h.run.state).toBe('running');

    // ── Bước 11: Thứ Sáu 09/10, 08:30, "hôm nay đến hạn" của s5 ──
    mark = h.mark();
    h.advanceTo(vn('2026-10-09', '08:30'));
    expect(h.sent({ from: mark })).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.reminder', to: U.HUNG })[0]?.effect.data).toMatchObject({ variant: 'due_today', nodeId: 's5' });
    expect(h.sent({ kind: 'notify.escalation' })).toEqual([]); // không có tin leo thang nào về s3

    // ── Bước 12: Thứ Sáu 09/10, 15:00, Hùng báo xong s5 ──
    mark = h.mark();
    const last = h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('s5').id }, vn('2026-10-09', '15:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success', completedAt: vn('2026-10-09', '15:00').toISOString() });
    expect(states(h)).toEqual({ start: 'done', s1: 'done', s4: 'done', s2: 'done', s3: 'done', s6: 'done', s5: 'done', end: 'done' });
    expect(last.events[0]?.payload.changes).toContainEqual({ type: 'run.completed', outcome: 'success' });
    expect(h.sent({ from: mark, kind: 'notify.run_completed', to: U.ADMIN })).toHaveLength(1);
    expect(h.timers.size).toBe(0); // không còn timer chờ chạy
    // Không còn gì bắn ra về sau.
    mark = h.mark();
    expect(h.advanceTo(vn('2026-10-20', '08:30'))).toBe(0);
    expect(h.sent({ from: mark })).toEqual([]);

    // ── Kiểm cuối kịch bản ──
    const dues = Object.fromEntries(h.run.steps.filter((s) => s.dueAt !== null).map((s) => [s.nodeId, s.dueAt]));
    expect(dues).toEqual({
      s1: '2026-10-06T10:00:00.000Z', // Thứ Ba 06/10, 17:00 giờ Việt Nam
      s4: '2026-10-06T10:00:00.000Z',
      s3: '2026-10-07T10:00:00.000Z', // Thứ Tư 07/10
      s6: '2026-10-07T10:00:00.000Z',
      s2: '2026-10-08T10:00:00.000Z', // Thứ Năm 08/10
      s5: '2026-10-09T10:00:00.000Z', // Thứ Sáu 09/10
    });
    for (const s of h.run.steps) expect(s.dueOriginalAt).toBe(s.dueAt);
    // Phát lại toàn bộ run_events cho đúng trạng thái cuối, từng bit.
    expect(h.replayed()).toEqual(h.run);
    expect(JSON.stringify(h.replayed())).toBe(JSON.stringify(h.run));
    // seq liên tục, mỗi sự kiện một dòng.
    expect(h.records.map((r) => r.seq)).toEqual(h.records.map((_, i) => i + 1));
    expect(h.run.seq).toBe(h.records.length);
    expect(h.run.version).toBe(h.records.length);
    // Mỗi thông báo đúng một lần (dedupeKey không trùng) và không có tin nào trong giờ yên tĩnh 21:00–07:00.
    expect(new Set(h.effects.map((e) => e.dedupeKey)).size).toBe(h.effects.length);
    for (const s of h.outbox) {
      const minutes = Math.floor((s.at.getTime() + VN.utcOffsetMinutes * 60_000) / 60_000) % 1440;
      expect(minutes).toBeGreaterThanOrEqual(7 * 60);
      expect(minutes).toBeLessThan(21 * 60);
    }
    // Chủ tịch không có việc gì trong kịch bản và không nhận tin nào.
    expect(h.sent({ to: U.CHAIRMAN })).toEqual([]);
  });
});

describe('kịch bản vàng, nhánh C: Tuấn không làm s3, leo thang', () => {
  it('Thứ Sáu 09/10 08:30 cấp trên trực tiếp nhận tin; Thứ Hai 12/10 08:30 Văn phòng nhận tin; Chủ tịch không nhận gì', () => {
    const h = runUntilStep8(U.ADMIN);
    expect(h.step('s3').state).toBe('ready');

    // Thứ Sáu 09/10, 08:30: quá hạn 2 ngày làm việc → cấp trên trực tiếp của Tuấn (U_HUY).
    let mark = h.mark();
    h.advanceTo(vn('2026-10-09', '08:30'));
    const level1 = h.sent({ from: mark, kind: 'notify.escalation' });
    expect(level1).toHaveLength(1);
    expect(level1[0]?.effect).toMatchObject({
      toUserId: U.HUY,
      data: { nodeId: 's3', lateWorkingDays: 2, level: 1, audience: 'assignee_manager', assigneeId: U.TUAN },
    });
    expect(level1[0]?.at.toISOString()).toBe(vn('2026-10-09', '08:30').toISOString());

    // Hùng vẫn làm xong s5 trong ngày; lượt chạy chưa hoàn tất vì s3 còn mở.
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('s5').id }, vn('2026-10-09', '15:00'));
    expect(h.run.state).toBe('running');

    // Cuối tuần không có gì bắn ra.
    mark = h.mark();
    h.advanceTo(vn('2026-10-11', '23:00'));
    expect(h.sent({ from: mark })).toEqual([]);

    // Thứ Hai 12/10, 08:30: quá hạn 3 ngày làm việc → Văn phòng.
    mark = h.mark();
    h.advanceTo(vn('2026-10-12', '08:30'));
    const level2 = h.sent({ from: mark });
    expect(level2).toHaveLength(1);
    expect(level2[0]?.effect).toMatchObject({
      kind: 'notify.escalation',
      toUserId: U.ADMIN,
      data: { nodeId: 's3', lateWorkingDays: 3, level: 2, audience: 'office_admin' },
    });
    expect(level2[0]?.at.toISOString()).toBe(vn('2026-10-12', '08:30').toISOString());

    // Chủ tịch không nhận thông báo đẩy nào trong cả kịch bản.
    expect(h.sent({ to: U.CHAIRMAN })).toEqual([]);
    // Hết mốc nhắc của s3; việc vẫn mở và vẫn quá hạn (cờ tính, không phải trạng thái lưu).
    expect(h.timersOf('s3')).toEqual([]);
    expect(h.step('s3').state).toBe('ready');
    expect(h.replayed()).toEqual(h.run);
  });

  it('mỗi ngày làm việc tối đa một nhắc tự động cho s3', () => {
    const h = runUntilStep8(U.ADMIN);
    h.advanceTo(vn('2026-10-12', '08:30'));
    const days = h.records
      .filter((r) => r.type === 'TimerFired' && r.payload.changes.some((c) => c.type === 'reminder.sent' && c.stepId === h.step('s3').id))
      .map((r) => toLocalDate(r.at, VN));
    expect(days).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']);
    expect(new Set(days).size).toBe(days.length);
  });
});

describe('kịch bản vàng, người khởi chạy là Chủ tịch', () => {
  it('tin dành cho "người giao" đi tới Văn phòng; Chủ tịch không nhận tin nào', () => {
    const h = runUntilStep8(U.CHAIRMAN);
    expect(h.run.initiatorId).toBe(U.CHAIRMAN);
    expect(h.step('s1').assignedBy).toBe(U.CHAIRMAN);

    // Bước 3 và 4: "đã xong" báo cho Văn phòng thay vì Chủ tịch.
    expect(h.sent({ kind: 'notify.completed', to: U.ADMIN }).map((s) => s.effect.data['nodeId']).sort()).toEqual(['s1', 's2', 's4', 's6']);
    // Bước 7: Tuấn nhận quá hạn; tin của người giao đi tới U_ADMIN.
    const overdue = h.sent({ kind: 'notify.overdue' });
    expect(overdue.map((s) => s.effect.toUserId).sort()).toEqual([U.ADMIN, U.TUAN].sort());
    expect(overdue.find((s) => s.effect.toUserId === U.ADMIN)?.effect.data).toMatchObject({ audience: 'assigner', lateWorkingDays: 1, nodeId: 's3' });

    // Bước 9: Chủ tịch nói "đi thúc anh Tuấn" rồi "đồng ý": sự kiện do AI soạn, người xác nhận là Chủ tịch.
    const proposalId = deterministicId('golden:proposal:nudge');
    let mark = h.mark();
    h.dispatch(
      {
        type: 'NudgeSent',
        actor: { type: 'ai', userId: U.CHAIRMAN, proposalId },
        stepId: h.step('s3').id,
        nudgeId: NUDGE_ID,
        fromUserId: U.CHAIRMAN,
        toUserId: U.TUAN,
        message: 'Văn phòng Chủ tịch nhắc anh Tuấn: việc ‘Kiểm tra tuyến tham quan’ đã quá hạn 1 ngày. Anh cho biết khi nào hoàn thành.',
        aiDrafted: true,
      },
      vn('2026-10-08', '09:05'),
    );
    expect(h.sent({ from: mark })).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.nudge', to: U.TUAN })[0]?.effect.data).toMatchObject({ aiDrafted: true, fromUserId: U.CHAIRMAN });
    expect(h.records.at(-1)).toMatchObject({ type: 'NudgeSent', actorType: 'ai', actorId: U.CHAIRMAN, proposalId });

    // Bước 10 đến 12.
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.TUAN), stepId: h.step('s3').id, nudgeId: NUDGE_ID }, vn('2026-10-08', '10:00'));
    h.advanceTo(vn('2026-10-09', '08:30'));
    mark = h.mark();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('s5').id }, vn('2026-10-09', '15:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
    expect(h.sent({ from: mark, kind: 'notify.run_completed' }).map((s) => s.effect.toUserId)).toEqual([U.ADMIN]);
    expect(h.timers.size).toBe(0);

    // Chủ tịch không nhận thông báo đẩy nào: xem tình hình ở bản tin sáng và màn Tiến độ.
    expect(h.sent({ to: U.CHAIRMAN })).toEqual([]);
    expect(h.replayed()).toEqual(h.run);
  });

  it('nhánh C với Chủ tịch khởi chạy: leo thang vẫn tới cấp trên trực tiếp rồi Văn phòng, không tới Chủ tịch', () => {
    const h = runUntilStep8(U.CHAIRMAN);
    h.advanceTo(vn('2026-10-12', '08:30'));
    expect(h.sent({ kind: 'notify.escalation' }).map((s) => [s.effect.toUserId, s.effect.data['level']])).toEqual([
      [U.HUY, 1],
      [U.ADMIN, 2],
    ]);
    expect(h.sent({ to: U.CHAIRMAN })).toEqual([]);
  });

  it('timer hệ thống không bị từ chối quyền, còn người thường thì không được bắn timer', () => {
    const h = new Harness(GOLDEN_DEF, makeCtx(), goldenRunInput(U.ADMIN));
    h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN) }, vn('2026-10-02', '09:00'));
    const timer = h.timersOf('s1')[0];
    expect(timer).toBeDefined();
    if (!timer) return;
    const fire = { type: 'TimerFired', timerKey: timer.dedupeKey, stepId: timer.stepId, kind: timer.timerKind, data: timer.data } as const;
    expect(errorCode(() => h.dispatch({ ...fire, actor: asUser(U.LAN) }, new Date(timer.fireAt)))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ ...fire, actor: SYSTEM }, new Date(timer.fireAt)))).toBeNull();
  });
});
