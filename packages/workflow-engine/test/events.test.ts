import { deterministicId, type DelegationRecord, type Effect } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { advance, createRun } from '../src';
import { asUser, errorCode, Harness, SYSTEM } from './support/harness';
import { defOf, due17, edge, END, extraUser, makeCtx, runInput, START, task, TEMPLATE, U, UNIT, vn, withUsers } from './support/world';

/** Test ví dụ cho từng sự kiện ở bảng 4.3. Quy trình thử: start → a (Lan) → b (Hùng) → end. */
const LINEAR = defOf({
  nodes: [START, task('a', U.LAN), task('b', U.HUNG), END],
  edges: [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')],
});

const T0 = vn('2026-10-05', '09:00'); // Thứ Hai
const DUE_A = due17('2026-10-07'); // +2 ngày làm việc

function started(def = LINEAR, ctx = makeCtx(), initiator: string = U.ADMIN, inputs: Record<string, unknown> = {}): Harness {
  const h = new Harness(def, ctx, runInput(initiator, inputs));
  h.dispatch({ type: 'StartRun', actor: asUser(initiator) }, T0);
  return h;
}

const kinds = (effects: Effect[]): string[] => effects.map((e) => e.kind);

describe('StartRun', () => {
  it('chỉ người khởi chạy hoặc Văn phòng được khởi chạy; chỉ từ trạng thái draft', () => {
    const h = new Harness(LINEAR, makeCtx(), runInput(U.HUY));
    expect(errorCode(() => h.dispatch({ type: 'StartRun', actor: asUser(U.LAN) }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'StartRun', actor: SYSTEM }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN) }, T0))).toBeNull(); // Văn phòng khởi chạy thay
    expect(h.run).toMatchObject({ state: 'running', startedAt: T0.toISOString(), version: 1, seq: 1 });
    expect(errorCode(() => h.dispatch({ type: 'StartRun', actor: asUser(U.HUY) }, T0))).toBe('invalid_transition');
  });

  it('mọi sự kiện khác bị từ chối khi lượt chạy còn draft', () => {
    const h = new Harness(LINEAR, makeCtx(), runInput(U.ADMIN));
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, T0))).toBe('invalid_transition');
    expect(errorCode(() => h.dispatch({ type: 'CancelRun', actor: asUser(U.ADMIN), reason: 'thử' }, T0))).toBe('invalid_transition');
  });

  it('assigneeOverrides ưu tiên hơn quy tắc của nút, kể cả với nút tới lượt sau', () => {
    const h = new Harness(LINEAR, makeCtx(), runInput(U.ADMIN));
    h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN), assigneeOverrides: { a: U.TUAN, b: U.NGOCANH } }, T0);
    expect(h.step('a')).toMatchObject({ state: 'ready', assigneeId: U.TUAN, assignedBy: U.ADMIN });
    expect(h.sent({ kind: 'notify.assigned' }).map((s) => s.effect.toUserId)).toEqual([U.TUAN]);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.TUAN), stepId: h.step('a').id }, vn('2026-10-06', '09:00'));
    expect(h.step('b')).toMatchObject({ state: 'ready', assigneeId: U.NGOCANH });
    expect(h.replayed()).toEqual(h.run);
  });

  it('assigneeOverrides sai (nút không phải việc, người không có trong danh bạ) bị từ chối', () => {
    const h = new Harness(LINEAR, makeCtx(), runInput(U.ADMIN));
    expect(errorCode(() => h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN), assigneeOverrides: { end: U.TUAN } }, T0))).toBe('invalid_input');
    expect(errorCode(() => h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN), assigneeOverrides: { a: U.GHOST } }, T0))).toBe('invalid_input');
    expect(h.run.state).toBe('draft');
  });

  it('người được chỉ định đã bị vô hiệu hoá lúc việc tới lượt: việc vào unassigned', () => {
    const ctx = makeCtx({ users: withUsers(extraUser(U.DISABLED, 'employee', UNIT.TECH, U.HUY, 'disabled')) });
    const h = new Harness(LINEAR, ctx, runInput(U.ADMIN));
    h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN), assigneeOverrides: { a: U.DISABLED } }, T0);
    expect(h.step('a')).toMatchObject({ state: 'unassigned', assigneeId: null });
  });
});

describe('đầu vào sai', () => {
  it('sự kiện của người dùng không ghi người thao tác thì not_allowed; `now` hỏng thì invalid_input', () => {
    const h = started();
    const stepId = h.step('a').id;
    const base = { eventId: deterministicId('x'), at: T0.toISOString() };
    const call = (event: Parameters<typeof advance>[0]['event'], now: Date = T0) => errorCode(() => advance({ def: LINEAR, run: h.run, event, ctx: makeCtx(), now }));
    expect(call({ ...base, type: 'CompleteStep', actor: { type: 'user' }, stepId })).toBe('not_allowed');
    expect(call({ ...base, type: 'CompleteStep', actor: { type: 'ai' }, stepId })).toBe('not_allowed');
    expect(call({ ...base, type: 'CompleteStep', actor: asUser(U.LAN), stepId }, new Date(Number.NaN))).toBe('invalid_input');
    expect(call({ ...base, type: 'CompleteStep', actor: asUser(U.LAN), stepId })).toBeNull();
  });

  it('TimerFired không gắn với việc nào: ghi một dòng sự kiện, không đổi gì', () => {
    const h = started();
    const before = h.run;
    const out = h.dispatch({ type: 'TimerFired', actor: SYSTEM, timerKey: 'không rõ', stepId: null, kind: 'reminder', data: {} }, T0);
    expect(out.effects).toEqual([]);
    expect(out.events[0]?.payload.changes).toEqual([]);
    expect(out.run.steps).toEqual(before.steps);
    expect(out.run.seq).toBe(before.seq + 1);
    expect(errorCode(() => h.dispatch({ type: 'TimerFired', actor: SYSTEM, timerKey: 'x', stepId: deterministicId('lạ'), kind: 'reminder', data: {} }, T0))).toBe('not_found');
  });
});

describe('chống lặp eventId', () => {
  it('áp cùng một eventId hai lần cho kết quả giống áp một lần', () => {
    const h = started();
    const eventId = deterministicId('dup');
    const first = h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id, eventId }, vn('2026-10-06', '09:00'));
    const second = h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id, eventId }, vn('2026-10-06', '09:01'));
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ id: eventId, seq: 2, type: 'CompleteStep', actorType: 'user', actorId: U.LAN });
    expect(second).toEqual({ run: first.run, effects: [], events: [] });
    expect(h.run.appliedEventIds.filter((id) => id === eventId)).toHaveLength(1);
  });
});

describe('advance không sửa đầu vào', () => {
  it('lượt chạy truyền vào giữ nguyên sau khi áp sự kiện và sau khi lỗi', () => {
    const run = createRun(LINEAR, runInput(U.ADMIN));
    const frozen = JSON.stringify(run);
    const out = advance({
      def: LINEAR,
      run,
      event: { type: 'StartRun', eventId: deterministicId('e1'), at: T0.toISOString(), actor: asUser(U.ADMIN) },
      ctx: makeCtx(),
      now: T0,
    });
    expect(JSON.stringify(run)).toBe(frozen);
    expect(out.run).not.toBe(run);
    const afterStart = JSON.stringify(out.run);
    expect(() =>
      advance({
        def: LINEAR,
        run: out.run,
        event: { type: 'CompleteStep', eventId: deterministicId('e2'), at: T0.toISOString(), actor: asUser(U.HUNG), stepId: out.run.steps[1]?.id ?? '' },
        ctx: makeCtx(),
        now: T0,
      }),
    ).toThrow();
    expect(JSON.stringify(out.run)).toBe(afterStart);
  });
});

describe('AcceptStep và CompleteStep', () => {
  it('người nhận bấm "Đã nhận": ready → in_progress; mặc định không báo người giao', () => {
    const h = started();
    const out = h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-05', '10:00'));
    expect(h.step('a')).toMatchObject({ state: 'in_progress', startedAt: vn('2026-10-05', '10:00').toISOString() });
    expect(out.effects).toEqual([]);
    expect(errorCode(() => h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, T0))).toBe('invalid_transition');
  });

  it('bật notifyOnAccept thì người giao nhận "đã nhận việc"; người tự khởi chạy rồi tự nhận thì không', () => {
    const h = started(LINEAR, makeCtx({ notifyOnAccept: true }), U.DIRECTOR);
    const out = h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-05', '10:00'));
    // người giao là giám đốc → tin đi tới Văn phòng
    expect(out.effects).toMatchObject([{ kind: 'notify.accepted', toUserId: U.ADMIN }]);

    const selfDef = defOf({ nodes: [START, task('a', U.ADMIN), END], edges: [edge('start', 'a'), edge('a', 'end')] });
    const self = started(selfDef, makeCtx({ notifyOnAccept: true }), U.ADMIN);
    const own = self.dispatch({ type: 'AcceptStep', actor: asUser(U.ADMIN), stepId: self.step('a').id }, vn('2026-10-05', '10:00'));
    expect(own.effects).toEqual([]);
    // tự làm xong việc của lượt mình khởi chạy: không tự báo "đã xong", không tự báo "hoàn tất"
    const done = self.dispatch({ type: 'CompleteStep', actor: asUser(U.ADMIN), stepId: self.step('a').id }, vn('2026-10-05', '11:00'));
    expect(kinds(done.effects)).toEqual(['cancel_timers']);
    expect(self.run.state).toBe('completed');
  });

  it('sai người thì not_allowed; không thấy việc thì not_found; việc chưa tới lượt thì invalid_transition', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('a').id }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.ADMIN), stepId: h.step('a').id }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: deterministicId('không có') }, T0))).toBe('not_found');
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('b').id }, T0))).toBe('invalid_transition');
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('start').id }, T0))).toBe('invalid_transition');
  });

  it('báo xong: lưu kết quả gộp ghi chú, huỷ timer, báo người giao, kích hoạt việc kế', () => {
    const h = started();
    const out = h.dispatch(
      { type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id, note: 'đã gửi qua thư', result: { link: 'x' } },
      vn('2026-10-06', '09:00'),
    );
    expect(h.step('a')).toMatchObject({ state: 'done', result: { link: 'x', note: 'đã gửi qua thư' }, completedAt: vn('2026-10-06', '09:00').toISOString() });
    expect(kinds(out.effects)).toEqual(['cancel_timers', 'notify.completed', 'notify.assigned', 'schedule_timer', 'schedule_timer', 'schedule_timer', 'schedule_timer', 'schedule_timer']);
    expect(out.effects[1]).toMatchObject({ toUserId: U.ADMIN, data: { completedBy: U.LAN, stepTitle: 'Việc a', runTitle: 'Lượt chạy thử' } });
    expect(h.step('b')).toMatchObject({ state: 'ready', assigneeId: U.HUNG, activatedAt: vn('2026-10-06', '09:00').toISOString(), dueAt: due17('2026-10-08') });
    // việc đã xong thì không báo xong lần nữa được
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, T0))).toBe('invalid_transition');
  });

  it('kiểm kết quả theo biểu mẫu của nút: ô bắt buộc, tiền là số nguyên không âm', () => {
    const def = defOf({
      nodes: [START, task('a', U.LAN, { form: [{ key: 'amount', label: 'Số tiền', type: 'money', required: true }, { key: 'day', label: 'Ngày', type: 'date' }] }), END],
      edges: [edge('start', 'a'), edge('a', 'end')],
    });
    const h = started(def);
    const complete = (result?: Record<string, unknown>) =>
      errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id, ...(result ? { result } : {}) }, T0));
    expect(complete()).toBe('invalid_input');
    expect(complete({ amount: -1 })).toBe('invalid_input');
    expect(complete({ amount: 1.5 })).toBe('invalid_input');
    expect(complete({ amount: '20000000' })).toBe('invalid_input');
    expect(complete({ amount: 0, day: '2026-13-01' })).toBe('invalid_input');
    expect(h.step('a').state).toBe('ready');
    expect(complete({ amount: 20_000_000, day: '2026-10-09' })).toBeNull();
    expect(h.step('a').result).toEqual({ amount: 20_000_000, day: '2026-10-09' });
  });
});

describe('ủy quyền (SPEC 4.8)', () => {
  const delegation = (over: Partial<DelegationRecord> = {}): DelegationRecord => ({
    fromUserId: U.LAN,
    toUserId: U.LAN2,
    validFrom: vn('2026-10-01', '00:00').toISOString(),
    validTo: vn('2026-10-10', '23:59').toISOString(),
    scope: 'all',
    scopeRef: null,
    ...over,
  });

  it('ủy quyền đang hiệu lực lúc kích hoạt: việc giao cho người được ủy quyền, ghi on_behalf_of', () => {
    const h = started(LINEAR, makeCtx({ delegations: [delegation()] }));
    expect(h.step('a')).toMatchObject({ state: 'ready', assigneeId: U.LAN2, onBehalfOfId: U.LAN });
    const assigned = h.sent({ kind: 'notify.assigned' });
    expect(assigned.map((s) => s.effect.toUserId)).toEqual([U.LAN2]);
    expect(assigned[0]?.effect.data).toMatchObject({ onBehalfOfId: U.LAN });
    expect(h.records[0]?.payload.changes).toContainEqual(expect.objectContaining({ type: 'step.activated', assigneeId: U.LAN2, onBehalfOfId: U.LAN }));
    // người được ủy quyền báo xong được; người ủy quyền (người gốc) cũng làm được
    expect(errorCode(() => h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, T0))).toBeNull();
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN2), stepId: h.step('a').id }, T0))).toBeNull();
  });

  it('ủy quyền hết hạn hoặc chưa bắt đầu thì không áp', () => {
    const expired = started(LINEAR, makeCtx({ delegations: [delegation({ validTo: vn('2026-10-04', '23:59').toISOString() })] }));
    expect(expired.step('a')).toMatchObject({ assigneeId: U.LAN, onBehalfOfId: null });
    const future = started(LINEAR, makeCtx({ delegations: [delegation({ validFrom: vn('2026-10-06', '00:00').toISOString() })] }));
    expect(future.step('a')).toMatchObject({ assigneeId: U.LAN, onBehalfOfId: null });
  });

  it('phạm vi process chỉ áp cho đúng mẫu quy trình', () => {
    const match = started(LINEAR, makeCtx({ delegations: [delegation({ scope: 'process', scopeRef: TEMPLATE })] }));
    expect(match.step('a').assigneeId).toBe(U.LAN2);
    const other = started(LINEAR, makeCtx({ delegations: [delegation({ scope: 'process', scopeRef: deterministicId('mẫu khác') })] }));
    expect(other.step('a').assigneeId).toBe(U.LAN);
  });

  it('phạm vi role chỉ áp cho việc tới tay qua quy tắc vai trò tương ứng', () => {
    const byRole = defOf({
      nodes: [START, task('a', U.LAN, { assignee: { kind: 'role', role: 'deputy' } }), task('b', U.HUY), END],
      edges: [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')],
    });
    const d = delegation({ fromUserId: U.HUY, toUserId: U.DIRECTOR, scope: 'role', scopeRef: 'deputy' });
    const h = started(byRole, makeCtx({ delegations: [d] }));
    expect(h.step('a')).toMatchObject({ assigneeId: U.DIRECTOR, onBehalfOfId: U.HUY }); // giao qua vai trò deputy
    expect(h.step('b')).toMatchObject({ assigneeId: U.HUY, onBehalfOfId: null }); // giao đích danh: không áp
  });

  it('người được ủy quyền đã bị vô hiệu hoá thì bỏ qua ủy quyền', () => {
    const ctx = makeCtx({
      users: withUsers(extraUser(U.DISABLED, 'employee', UNIT.SALES, U.HUY, 'disabled')),
      delegations: [delegation({ toUserId: U.DISABLED })],
    });
    expect(started(LINEAR, ctx).step('a')).toMatchObject({ assigneeId: U.LAN, onBehalfOfId: null });
  });

  it('ủy quyền lập sau khi việc đã giao: người được ủy quyền vẫn thao tác thay được', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN2), stepId: h.step('a').id }, T0))).toBe('not_allowed');
    h.ctx = makeCtx({ delegations: [delegation()] });
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN2), stepId: h.step('a').id }, vn('2026-10-06', '09:00')))).toBeNull();
    expect(h.step('a').state).toBe('done');
  });

  it('duyệt thay chỉ khi có ủy quyền: người duyệt gốc được ghi ở onBehalfOfId', () => {
    const def = defOf({
      nodes: [START, { id: 'ok', type: 'approval', label: 'Duyệt', title: 'Duyệt', approvers: [{ kind: 'role', role: 'chairman' }], mode: 'any', due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } } }, END],
      edges: [edge('start', 'ok'), edge('ok', 'end', { outcome: 'approved' })],
    });
    const none = started(def);
    expect(none.step('ok')).toMatchObject({ assigneeId: U.CHAIRMAN, approvals: [{ approverId: U.CHAIRMAN, onBehalfOfId: null }] });
    expect(errorCode(() => none.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: none.step('ok').id }, T0))).toBe('not_allowed');

    const d = delegation({ fromUserId: U.CHAIRMAN, toUserId: U.HUY, scope: 'role', scopeRef: 'chairman' });
    const h = started(def, makeCtx({ delegations: [d] }));
    expect(h.step('ok')).toMatchObject({ assigneeId: U.HUY, onBehalfOfId: U.CHAIRMAN, approvals: [{ approverId: U.HUY, onBehalfOfId: U.CHAIRMAN }] });
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, T0))).toBeNull();
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
  });
});

describe('unassigned rồi AssignStep', () => {
  const def = defOf({
    nodes: [START, task('a', U.GHOST), task('b', U.HUNG), END],
    edges: [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')],
  });

  it('không xác định được người nhận: việc vào unassigned, Văn phòng được báo, chưa hẹn nhắc', () => {
    const h = started(def, makeCtx({ users: withUsers(extraUser(U.ADMIN2, 'office_admin', UNIT.OFFICE, U.DIRECTOR)) }), U.HUY);
    expect(h.step('a')).toMatchObject({ state: 'unassigned', assigneeId: null, assignedBy: null, dueAt: DUE_A });
    const told = h.sent({ kind: 'notify.assigned' });
    expect(told.map((s) => s.effect.toUserId).sort()).toEqual([U.ADMIN, U.ADMIN2].sort());
    expect(told[0]?.effect.data).toMatchObject({ needsAssignee: true });
    expect(h.timers.size).toBe(0);
    expect(h.run.state).toBe('running');
  });

  it('AssignStep: unassigned → ready với người mới, báo người mới, hẹn nhắc theo hạn', () => {
    const h = started(def);
    const out = h.dispatch({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId: h.step('a').id, toUserId: U.TUAN }, vn('2026-10-05', '10:00'));
    expect(h.step('a')).toMatchObject({ state: 'ready', assigneeId: U.TUAN, assignedBy: U.ADMIN, dueAt: DUE_A });
    expect(out.effects.filter((e) => e.kind === 'notify.assigned')).toMatchObject([{ toUserId: U.TUAN, data: { reassigned: false } }]);
    expect(h.timersOf('a').map((t) => t.fireAt)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12'].map((d) => vn(d, '08:30').toISOString()));
    expect(out.events[0]?.payload.changes).toEqual([
      { type: 'step.assignee', stepId: h.step('a').id, from: null, to: U.TUAN, onBehalfOfId: null },
      { type: 'step.state', stepId: h.step('a').id, nodeId: 'a', from: 'unassigned', to: 'ready' },
    ]);
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.TUAN), stepId: h.step('a').id }, vn('2026-10-06', '09:00')))).toBeNull();
    expect(h.replayed()).toEqual(h.run);
  });

  it('quyền giao việc: Văn phòng, người giao, người điều phối, trưởng đơn vị của người sắp nhận; người khác thì không', () => {
    const assign = (actor: string, to: string) => {
      const h = started(def, makeCtx(), U.NGOCANH);
      return errorCode(() => h.dispatch({ type: 'AssignStep', actor: asUser(actor), stepId: h.step('a').id, toUserId: to }, T0));
    };
    expect(assign(U.ADMIN, U.TUAN)).toBeNull();
    expect(assign(U.NGOCANH, U.TUAN)).toBeNull(); // người giao (người khởi chạy)
    expect(assign(U.DIRECTOR, U.TUAN)).toBeNull(); // người điều phối
    expect(assign(U.LAN, U.HUNG)).toBeNull(); // Lan là trưởng đơn vị của Hùng
    expect(assign(U.LAN, U.TUAN)).toBe('not_allowed');
    expect(assign(U.PHUONG, U.TUAN)).toBe('not_allowed');
    expect(assign(U.IT, U.TUAN)).toBe('not_allowed');
    expect(assign(U.ADMIN, U.GHOST)).toBe('invalid_input'); // người nhận không tồn tại
  });

  it('AssignStep trên việc đã xong hoặc chưa tới lượt bị từ chối', () => {
    const h = started(def);
    expect(errorCode(() => h.dispatch({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId: h.step('b').id, toUserId: U.TUAN }, T0))).toBe('invalid_transition');
  });
});

describe('Reassign', () => {
  it('giữ trạng thái, đổi người nhận, báo người mới và người cũ, xoá cờ vướng, giữ timer', () => {
    const h = started();
    h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-05', '10:00'));
    h.dispatch({ type: 'ReportBlocked', actor: asUser(U.LAN), stepId: h.step('a').id, reasonCode: 'missing_info' }, vn('2026-10-05', '10:30'));
    const timersBefore = h.timersOf('a').map((t) => t.dedupeKey);
    const out = h.dispatch({ type: 'Reassign', actor: asUser(U.ADMIN), stepId: h.step('a').id, toUserId: U.TUAN, reason: 'Lan nghỉ ốm' }, vn('2026-10-05', '11:00'));
    expect(h.step('a')).toMatchObject({ state: 'in_progress', assigneeId: U.TUAN, onBehalfOfId: null, assignedBy: U.ADMIN, blockedReason: null, dueAt: DUE_A });
    expect(out.effects).toMatchObject([
      { kind: 'notify.assigned', toUserId: U.TUAN, data: { reassigned: true } },
      { kind: 'notify.reassigned', toUserId: U.LAN, data: { toUserId: U.TUAN, reason: 'Lan nghỉ ốm' } },
    ]);
    expect(h.timersOf('a').map((t) => t.dedupeKey)).toEqual(timersBefore);
    // người cũ không còn thao tác được, người mới thì được
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.TUAN), stepId: h.step('a').id }, vn('2026-10-06', '09:00')))).toBeNull();
  });

  it('nhắc tới người nhận mới: người nhận xác định lúc timer bắn', () => {
    const h = started();
    h.dispatch({ type: 'Reassign', actor: asUser(U.ADMIN), stepId: h.step('a').id, toUserId: U.TUAN, reason: 'đổi người' }, vn('2026-10-05', '11:00'));
    const mark = h.mark();
    h.advanceTo(vn('2026-10-06', '08:30'));
    expect(h.sent({ from: mark }).map((s) => [s.effect.kind, s.effect.toUserId])).toEqual([['notify.reminder', U.TUAN]]);
  });

  it('không đổi sang chính người đang nhận; không đổi người của việc chưa giao hoặc đã xong', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'Reassign', actor: asUser(U.ADMIN), stepId: h.step('a').id, toUserId: U.LAN, reason: 'x' }, T0))).toBe('invalid_input');
    expect(errorCode(() => h.dispatch({ type: 'Reassign', actor: asUser(U.ADMIN), stepId: h.step('b').id, toUserId: U.TUAN, reason: 'x' }, T0))).toBe('invalid_transition');
    expect(errorCode(() => h.dispatch({ type: 'Reassign', actor: asUser(U.PHUONG), stepId: h.step('a').id, toUserId: U.TUAN, reason: 'x' }, T0))).toBe('not_allowed');
  });

  it('trưởng đơn vị của người đang nhận được đổi người', () => {
    const def = defOf({ nodes: [START, task('a', U.HUNG), END], edges: [edge('start', 'a'), edge('a', 'end')] });
    const h = started(def);
    expect(errorCode(() => h.dispatch({ type: 'Reassign', actor: asUser(U.LAN), stepId: h.step('a').id, toUserId: U.TUAN, reason: 'chia việc' }, T0))).toBeNull();
  });
});

describe('ExtendDue', () => {
  it('hạn đổi, hạn gốc giữ nguyên, timer cũ bị huỷ và dựng lại theo hạn mới, người nhận được báo', () => {
    const h = started();
    const oldKeys = h.timersOf('a').map((t) => t.dedupeKey);
    expect(oldKeys).toHaveLength(5);
    const newDue = due17('2026-10-09');
    const out = h.dispatch({ type: 'ExtendDue', actor: asUser(U.ADMIN), stepId: h.step('a').id, newDueAt: newDue, reason: 'chờ tài liệu' }, vn('2026-10-06', '14:00'));
    expect(h.step('a')).toMatchObject({ state: 'ready', dueAt: newDue, dueOriginalAt: DUE_A });
    // thứ tự effect: huỷ trước, hẹn sau, rồi báo người nhận
    expect(kinds(out.effects)).toEqual(['cancel_timers', 'schedule_timer', 'schedule_timer', 'schedule_timer', 'schedule_timer', 'schedule_timer', 'notify.due_changed']);
    expect(out.effects.at(-1)).toMatchObject({ toUserId: U.LAN, data: { dueAt: newDue, previousDueAt: DUE_A, reason: 'chờ tài liệu', changedBy: U.ADMIN } });
    const fresh = h.timersOf('a');
    expect(fresh.map((t) => t.fireAt)).toEqual(['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'].map((d) => vn(d, '08:30').toISOString()));
    expect(fresh.some((t) => oldKeys.includes(t.dedupeKey))).toBe(false);
    expect(out.events[0]?.payload.changes).toEqual([{ type: 'step.due', stepId: h.step('a').id, from: DUE_A, to: newDue }]);
    expect(h.replayed()).toEqual(h.run);
  });

  it('mốc nhắc đã qua so với hiện tại thì không hẹn', () => {
    const h = started();
    // Thứ Tư 07/10 16:00, dời hạn sang Thứ Năm 08/10: mốc −1 (07/10 08:30) đã qua
    h.dispatch({ type: 'ExtendDue', actor: asUser(U.ADMIN), stepId: h.step('a').id, newDueAt: due17('2026-10-08'), reason: 'x' }, vn('2026-10-07', '16:00'));
    expect(h.timersOf('a').map((t) => t.fireAt)).toEqual(['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'].map((d) => vn(d, '08:30').toISOString()));
  });

  it('gia hạn từ một yêu cầu của người nhận: ghi extension.decided approved', () => {
    const h = started();
    const requestId = deterministicId('req');
    const out = h.dispatch(
      { type: 'ExtendDue', actor: asUser(U.ADMIN), stepId: h.step('a').id, newDueAt: due17('2026-10-09'), reason: 'đồng ý', extensionRequestId: requestId },
      vn('2026-10-06', '14:00'),
    );
    expect(out.events[0]?.payload.changes).toContainEqual({ type: 'extension.decided', stepId: h.step('a').id, requestId, decision: 'approved', decidedBy: U.ADMIN });
  });

  it('việc chưa có người nhận vẫn đổi hạn được; không hẹn nhắc cho tới khi có người', () => {
    const def = defOf({ nodes: [START, task('a', U.GHOST), END], edges: [edge('start', 'a'), edge('a', 'end')] });
    const h = started(def);
    const out = h.dispatch({ type: 'ExtendDue', actor: asUser(U.ADMIN), stepId: h.step('a').id, newDueAt: due17('2026-10-09'), reason: 'chưa có người' }, vn('2026-10-06', '14:00'));
    expect(h.step('a')).toMatchObject({ state: 'unassigned', dueAt: due17('2026-10-09'), dueOriginalAt: DUE_A });
    expect(kinds(out.effects)).toEqual(['cancel_timers']);
    h.dispatch({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId: h.step('a').id, toUserId: U.TUAN }, vn('2026-10-06', '15:00'));
    expect(h.timersOf('a').map((t) => t.fireAt)).toEqual(['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'].map((d) => vn(d, '08:30').toISOString()));
  });

  it('quyền và dữ liệu: người nhận không tự gia hạn; hạn mới phải ở tương lai và khác hạn cũ; việc chưa tới lượt thì không', () => {
    const h = started();
    const extend = (actor: string, nodeId: string, to: string) =>
      errorCode(() => h.dispatch({ type: 'ExtendDue', actor: asUser(actor), stepId: h.step(nodeId).id, newDueAt: to, reason: 'x' }, vn('2026-10-06', '14:00')));
    expect(extend(U.LAN, 'a', due17('2026-10-09'))).toBe('not_allowed');
    expect(extend(U.ADMIN, 'a', due17('2026-10-05'))).toBe('invalid_input');
    expect(extend(U.ADMIN, 'a', DUE_A)).toBe('invalid_input');
    expect(extend(U.ADMIN, 'b', due17('2026-10-09'))).toBe('invalid_transition');
    expect(extend(U.HUY, 'a', due17('2026-10-09'))).toBeNull(); // người điều phối
  });
});

describe('RequestExtension và DeclineExtension', () => {
  it('xin thêm thời gian: trạng thái và hạn giữ nguyên, người giao được báo; từ chối thì người nhận được báo', () => {
    const h = started(LINEAR, makeCtx(), U.NGOCANH);
    const requestId = deterministicId('req-1');
    const nudgeId = deterministicId('nudge-1');
    const proposed = due17('2026-10-09');
    const req = h.dispatch(
      { type: 'RequestExtension', actor: asUser(U.LAN), stepId: h.step('a').id, requestId, proposedDueAt: proposed, reason: 'chờ số liệu', nudgeId },
      vn('2026-10-06', '10:00'),
    );
    expect(h.step('a')).toMatchObject({ state: 'ready', dueAt: DUE_A, dueOriginalAt: DUE_A });
    expect(req.effects).toMatchObject([{ kind: 'notify.extension_requested', toUserId: U.NGOCANH, data: { requestId, proposedDueAt: proposed, requestedBy: U.LAN, reason: 'chờ số liệu' } }]);
    expect(req.events[0]?.payload.changes).toEqual([
      { type: 'extension.requested', stepId: h.step('a').id, requestId, requestedBy: U.LAN, proposedDueAt: proposed, reason: 'chờ số liệu' },
      { type: 'nudge.replied', stepId: h.step('a').id, nudgeId, reply: 'need_time' },
    ]);

    const dec = h.dispatch({ type: 'DeclineExtension', actor: asUser(U.NGOCANH), stepId: h.step('a').id, requestId, comment: 'cần đúng hạn' }, vn('2026-10-06', '11:00'));
    expect(h.step('a')).toMatchObject({ state: 'ready', dueAt: DUE_A });
    expect(dec.effects).toMatchObject([{ kind: 'notify.extension_declined', toUserId: U.LAN, data: { requestId, comment: 'cần đúng hạn', declinedBy: U.NGOCANH } }]);
    expect(dec.events[0]?.payload.changes).toEqual([{ type: 'extension.decided', stepId: h.step('a').id, requestId, decision: 'declined', decidedBy: U.NGOCANH }]);
    expect(h.timersOf('a')).toHaveLength(5); // timer không đổi
    expect(h.replayed()).toEqual(h.run);
  });

  it('chỉ người nhận được xin; chỉ người giao, Văn phòng, người điều phối được từ chối; hạn đề nghị phải ở tương lai', () => {
    const h = started();
    const requestId = deterministicId('req-2');
    const at = vn('2026-10-06', '10:00');
    expect(errorCode(() => h.dispatch({ type: 'RequestExtension', actor: asUser(U.HUNG), stepId: h.step('a').id, requestId, proposedDueAt: due17('2026-10-09'), reason: 'x' }, at))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'RequestExtension', actor: asUser(U.LAN), stepId: h.step('a').id, requestId, proposedDueAt: due17('2026-10-05'), reason: 'x' }, at))).toBe('invalid_input');
    expect(errorCode(() => h.dispatch({ type: 'DeclineExtension', actor: asUser(U.LAN), stepId: h.step('a').id, requestId }, at))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'DeclineExtension', actor: asUser(U.ADMIN), stepId: h.step('b').id, requestId }, at))).toBe('invalid_transition');
  });

  it('người giao là điều hành: yêu cầu gia hạn đi tới Văn phòng', () => {
    const h = started(LINEAR, makeCtx(), U.CHAIRMAN);
    const out = h.dispatch(
      { type: 'RequestExtension', actor: asUser(U.LAN), stepId: h.step('a').id, requestId: deterministicId('r'), proposedDueAt: due17('2026-10-09'), reason: 'x' },
      vn('2026-10-06', '10:00'),
    );
    expect(out.effects.map((e) => (e.kind === 'notify.extension_requested' ? e.toUserId : null))).toEqual([U.ADMIN]);
  });
});

describe('ReportBlocked', () => {
  it('đặt cờ vướng, báo người giao và Văn phòng (không trùng); cờ tự xoá khi việc xong', () => {
    const ctx = makeCtx({ users: withUsers(extraUser(U.ADMIN2, 'office_admin', UNIT.OFFICE, U.DIRECTOR)) });
    const h = started(LINEAR, ctx, U.ADMIN);
    const nudgeId = deterministicId('n');
    const out = h.dispatch({ type: 'ReportBlocked', actor: asUser(U.LAN), stepId: h.step('a').id, reasonCode: 'waiting_on_other', note: 'chờ phòng khác', nudgeId }, vn('2026-10-05', '15:00'));
    expect(h.step('a')).toMatchObject({ state: 'ready', blockedReason: 'waiting_on_other' });
    // U_ADMIN vừa là người giao vừa là Văn phòng: chỉ một tin
    expect(out.effects.map((e) => (e.kind === 'notify.blocked' ? e.toUserId : e.kind)).sort()).toEqual([U.ADMIN, U.ADMIN2].sort());
    expect(out.events[0]?.payload.changes).toEqual([
      { type: 'step.blocked', stepId: h.step('a').id, reasonCode: 'waiting_on_other', note: 'chờ phòng khác' },
      { type: 'nudge.replied', stepId: h.step('a').id, nudgeId, reply: 'blocked' },
    ]);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-06', '09:00'));
    expect(h.step('a').blockedReason).toBeNull();
  });

  it('chỉ người nhận được báo vướng, và chỉ khi việc đang mở', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'ReportBlocked', actor: asUser(U.ADMIN), stepId: h.step('a').id, reasonCode: 'other' }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'ReportBlocked', actor: asUser(U.HUNG), stepId: h.step('b').id, reasonCode: 'other' }, T0))).toBe('invalid_transition');
  });
});

describe('UnassignStep', () => {
  it('hệ thống gỡ người nhận bị vô hiệu hoá: việc về unassigned, timer bị huỷ, Văn phòng được báo, rồi giao lại', () => {
    const h = started();
    h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-05', '10:00'));
    const out = h.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: h.step('a').id, reason: 'user_disabled' }, vn('2026-10-05', '12:00'));
    expect(h.step('a')).toMatchObject({ state: 'unassigned', assigneeId: null, onBehalfOfId: null, startedAt: null, dueAt: DUE_A });
    expect(kinds(out.effects)).toEqual(['cancel_timers', 'notify.assigned']);
    expect(out.effects[1]).toMatchObject({ toUserId: U.ADMIN, data: { needsAssignee: true } });
    expect(h.timersOf('a')).toEqual([]);
    expect(h.run.state).toBe('running');

    h.dispatch({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId: h.step('a').id, toUserId: U.TUAN }, vn('2026-10-05', '13:00'));
    expect(h.step('a')).toMatchObject({ state: 'ready', assigneeId: U.TUAN });
    expect(h.timersOf('a')).toHaveLength(5);
    expect(h.replayed()).toEqual(h.run);
  });

  it('chỉ hệ thống (hoặc it_admin) được gỡ; việc chưa giao thì không gỡ được', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'UnassignStep', actor: asUser(U.ADMIN), stepId: h.step('a').id, reason: 'x' }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: h.step('b').id, reason: 'x' }, T0))).toBe('invalid_transition');
    expect(errorCode(() => h.dispatch({ type: 'UnassignStep', actor: asUser(U.IT), stepId: h.step('a').id, reason: 'x' }, T0))).toBeNull();
  });
});

describe('SkipStep thủ công của Văn phòng và Chủ tịch', () => {
  it('cho qua một việc đang ready: việc thành skipped, timer bị huỷ, luồng đi tiếp sang việc kế', () => {
    const h = started();
    const out = h.dispatch({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId: h.step('a').id, reason: 'đoàn không cần phần này' }, vn('2026-10-05', '10:00'));
    expect(h.step('a')).toMatchObject({ state: 'skipped', reason: 'đoàn không cần phần này', result: { skippedManually: true } });
    expect(kinds(out.effects).slice(0, 2)).toEqual(['cancel_timers', 'notify.assigned']);
    expect(h.timersOf('a')).toEqual([]);
    expect(h.step('b')).toMatchObject({ state: 'ready', assigneeId: U.HUNG });
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('b').id }, vn('2026-10-06', '10:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
    expect(h.replayed()).toEqual(h.run);
  });

  it('cho qua một việc chưa tới lượt: việc sau nó chỉ chạy khi luồng đi tới, không chạy trước việc đứng trước', () => {
    const def = defOf({
      nodes: [START, task('a', U.LAN), task('b', U.HUNG), task('c', U.TUAN), END],
      edges: [edge('start', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'end')],
    });
    const h = started(def);
    h.dispatch({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId: h.step('b').id, reason: 'không cần' }, vn('2026-10-05', '10:00'));
    expect(h.step('b')).toMatchObject({ state: 'skipped', activatedAt: null });
    expect(h.step('c').state).toBe('pending'); // a chưa xong thì c chưa tới lượt
    expect(h.run.state).toBe('running');
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-06', '10:00'));
    expect(h.step('b')).toMatchObject({ state: 'skipped', activatedAt: vn('2026-10-06', '10:00').toISOString() });
    expect(h.step('c')).toMatchObject({ state: 'ready', assigneeId: U.TUAN });
    expect(h.replayed()).toEqual(h.run);
  });

  it('chỉ Văn phòng và Chủ tịch được cho qua, bắt buộc từ pending, unassigned hoặc ready', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'SkipStep', actor: asUser(U.HUY), stepId: h.step('a').id, reason: 'x' }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'SkipStep', actor: asUser(U.LAN), stepId: h.step('a').id, reason: 'x' }, T0))).toBe('not_allowed');
    h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step('a').id }, T0);
    expect(errorCode(() => h.dispatch({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId: h.step('a').id, reason: 'x' }, T0))).toBe('invalid_transition');
    expect(errorCode(() => h.dispatch({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId: h.step('end').id, reason: 'x' }, T0))).toBe('invalid_transition');
  });

  it('Chủ tịch toàn quyền nên cũng cho qua được; Giám đốc và Phó giám đốc thì không (docs/DECISIONS.md, 04/10/2026)', () => {
    const h = started();
    expect(errorCode(() => h.dispatch({ type: 'SkipStep', actor: asUser(U.DIRECTOR), stepId: h.step('a').id, reason: 'x' }, T0))).toBe('not_allowed');
    h.dispatch({ type: 'SkipStep', actor: asUser(U.CHAIRMAN), stepId: h.step('a').id, reason: 'Chủ tịch cho qua' }, vn('2026-10-05', '10:00'));
    expect(h.step('a')).toMatchObject({ state: 'skipped', reason: 'Chủ tịch cho qua', result: { skippedManually: true } });
    expect(h.step('b')).toMatchObject({ state: 'ready', assigneeId: U.HUNG });
    expect(h.replayed()).toEqual(h.run);
  });
});

describe('CancelRun', () => {
  it('lượt chạy và mọi việc chưa xong thành cancelled; huỷ mọi timer; báo người đang giữ việc mở', () => {
    const def = defOf({
      nodes: [START, task('a', U.LAN), task('b', U.HUNG), task('c', U.TUAN), END],
      edges: [edge('start', 'a'), edge('start', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'end')],
    });
    const h = started(def);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-05', '10:00'));
    const out = h.dispatch({ type: 'CancelRun', actor: asUser(U.ADMIN), reason: 'đoàn hoãn chuyến' }, vn('2026-10-05', '11:00'));
    expect(h.run).toMatchObject({ state: 'cancelled', outcome: null, completedAt: vn('2026-10-05', '11:00').toISOString() });
    expect(Object.fromEntries(h.run.steps.map((s) => [s.nodeId, s.state]))).toEqual({ start: 'done', a: 'done', b: 'cancelled', c: 'cancelled', end: 'cancelled' });
    expect(out.effects).toMatchObject([
      { kind: 'cancel_timers', stepId: null },
      { kind: 'notify.run_cancelled', toUserId: U.HUNG, stepId: null, data: { reason: 'đoàn hoãn chuyến', cancelledBy: U.ADMIN } },
    ]);
    expect(h.timers.size).toBe(0);
    expect(out.events[0]?.payload.changes[0]).toEqual({ type: 'run.cancelled', reason: 'đoàn hoãn chuyến' });
    // sau khi huỷ, không thao tác gì được nữa
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUNG), stepId: h.step('b').id }, vn('2026-10-05', '12:00')))).toBe('invalid_transition');
    expect(errorCode(() => h.dispatch({ type: 'CancelRun', actor: asUser(U.ADMIN), reason: 'lần nữa' }, vn('2026-10-05', '12:00')))).toBe('invalid_transition');
    expect(h.replayed()).toEqual(h.run);
  });

  it('người khởi chạy, Văn phòng, người điều phối được huỷ; người nhận việc thì không', () => {
    const cancel = (actor: string) => {
      const h = started(LINEAR, makeCtx(), U.NGOCANH);
      return errorCode(() => h.dispatch({ type: 'CancelRun', actor: asUser(actor), reason: 'x' }, T0));
    };
    expect(cancel(U.NGOCANH)).toBeNull();
    expect(cancel(U.ADMIN)).toBeNull();
    expect(cancel(U.CHAIRMAN)).toBeNull();
    expect(cancel(U.LAN)).toBe('not_allowed');
  });

  it('timer bắn muộn sau khi lượt chạy đã huỷ thì bị bỏ qua, không lỗi', () => {
    const h = started();
    const timer = h.timersOf('a')[0];
    h.dispatch({ type: 'CancelRun', actor: asUser(U.ADMIN), reason: 'x' }, vn('2026-10-05', '11:00'));
    expect(timer).toBeDefined();
    if (!timer) return;
    const out = h.dispatch({ type: 'TimerFired', actor: SYSTEM, timerKey: timer.dedupeKey, stepId: timer.stepId, kind: timer.timerKind, data: timer.data }, new Date(timer.fireAt));
    expect(out.effects).toEqual([]);
    expect(out.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('a').id, why: 'not_open' }]);
  });
});

describe('nút duyệt', () => {
  const approval = (mode: 'any' | 'all', approvers: string[], extra: Record<string, unknown> = {}) => ({
    id: 'ok',
    type: 'approval',
    label: 'Duyệt',
    title: 'Duyệt đề nghị',
    approvers: approvers.map((userId) => ({ kind: 'user', userId })),
    mode,
    due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } },
    ...extra,
  });
  const defWith = (mode: 'any' | 'all', approvers: string[]) =>
    defOf({
      nodes: [START, approval(mode, approvers), task('after', U.LAN), END],
      edges: [edge('start', 'ok'), edge('ok', 'after', { outcome: 'approved' }), edge('after', 'end')],
    });

  it('mode all: mỗi người duyệt một dòng, mỗi người một thông báo; xong khi tất cả đồng ý', () => {
    const h = started(defWith('all', [U.HUY, U.DIRECTOR]));
    expect(h.step('ok')).toMatchObject({ state: 'ready', assigneeId: U.HUY });
    expect(h.step('ok').approvals).toMatchObject([
      { approverId: U.HUY, decision: null },
      { approverId: U.DIRECTOR, decision: null },
    ]);
    expect(h.sent({ kind: 'notify.assigned' }).map((s) => s.effect.toUserId)).toEqual([U.HUY, U.DIRECTOR]);

    const first = h.dispatch({ type: 'ApproveStep', actor: asUser(U.DIRECTOR), stepId: h.step('ok').id, comment: 'đồng ý' }, vn('2026-10-05', '10:00'));
    expect(h.step('ok')).toMatchObject({ state: 'ready', assigneeId: U.HUY }); // còn chờ Huy
    expect(first.effects).toEqual([]);
    expect(first.events[0]?.payload.changes).toEqual([{ type: 'approval.decided', stepId: h.step('ok').id, approverId: U.DIRECTOR, decision: 'approved' }]);
    expect(h.step('after').state).toBe('pending');
    // người đã quyết không quyết lần nữa
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.DIRECTOR), stepId: h.step('ok').id }, T0))).toBe('not_allowed');

    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, vn('2026-10-05', '11:00'));
    expect(h.step('ok')).toMatchObject({ state: 'done', result: { decision: 'approved' } });
    expect(h.step('ok').approvals.map((a) => [a.approverId, a.decision, a.decidedAt])).toEqual([
      [U.HUY, 'approved', vn('2026-10-05', '11:00').toISOString()],
      [U.DIRECTOR, 'approved', vn('2026-10-05', '10:00').toISOString()],
    ]);
    expect(h.step('after').state).toBe('ready');
    expect(h.timersOf('ok')).toEqual([]);
    expect(h.replayed()).toEqual(h.run);
  });

  it('mode all: sau khi một người đã đồng ý, nhắc chỉ tới người còn chưa quyết', () => {
    const h = started(defWith('all', [U.HUY, U.DIRECTOR]));
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, vn('2026-10-05', '10:00'));
    expect(h.step('ok').assigneeId).toBe(U.DIRECTOR); // con trỏ chuyển sang người chưa quyết
    const mark = h.mark();
    h.advanceTo(vn('2026-10-06', '08:30')); // hạn Thứ Ba 06/10: "hôm nay đến hạn"
    expect(h.sent({ from: mark }).map((s) => [s.effect.kind, s.effect.toUserId, s.effect.data['variant']])).toEqual([['notify.reminder', U.DIRECTOR, 'due_today']]);
  });

  it('mode any: một người đồng ý là xong', () => {
    const h = started(defWith('any', [U.HUY, U.DIRECTOR]));
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.DIRECTOR), stepId: h.step('ok').id }, vn('2026-10-05', '10:00'));
    expect(h.step('ok').state).toBe('done');
    expect(h.step('after').state).toBe('ready');
  });

  it('người không phải người duyệt thì not_allowed; CompleteStep trên nút duyệt và ApproveStep trên việc thường thì invalid_transition', () => {
    const h = started(defWith('any', [U.HUY]));
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.LAN), stepId: h.step('ok').id }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'RejectStep', actor: asUser(U.ADMIN), stepId: h.step('ok').id, reason: 'x' }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'CompleteStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, T0))).toBe('invalid_transition');
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, T0);
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.LAN), stepId: h.step('after').id }, T0))).toBe('invalid_transition');
  });

  it('RejectStep, không có cạnh rejected: nút duyệt rejected, việc sau bị bỏ qua, lượt chạy completed với outcome rejected', () => {
    const h = started(defWith('all', [U.HUY, U.DIRECTOR]), makeCtx(), U.NGOCANH);
    const out = h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: 'vượt định mức' }, vn('2026-10-05', '10:00'));
    expect(h.step('ok')).toMatchObject({ state: 'rejected', reason: 'vượt định mức', result: { decision: 'rejected' } });
    expect(h.step('ok').approvals).toMatchObject([
      { approverId: U.HUY, decision: 'rejected', reason: 'vượt định mức' },
      { approverId: U.DIRECTOR, decision: null },
    ]);
    expect(h.step('after').state).toBe('skipped');
    expect(h.step('end').state).toBe('skipped');
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'rejected' });
    // người giao và Văn phòng được báo "Chưa đồng ý"
    expect(out.effects.filter((e) => e.kind === 'notify.rejected').map((e) => ('toUserId' in e ? e.toUserId : '')).sort()).toEqual([U.ADMIN, U.NGOCANH].sort());
    expect(kinds(out.effects)).toContain('cancel_timers');
    expect(kinds(out.effects)).toContain('notify.run_completed');
    expect(h.timers.size).toBe(0);
    expect(h.replayed()).toEqual(h.run);
  });

  it('RejectStep với cạnh rejected dẫn tới kết thúc (giai đoạn 1)', () => {
    const def = defOf({
      nodes: [START, approval('any', [U.HUY]), task('after', U.LAN), { id: 'tell', type: 'notify', label: 'Báo', to: [{ kind: 'initiator' }], template: 'rejected' }, END],
      edges: [
        edge('start', 'ok'),
        edge('ok', 'after', { outcome: 'approved' }),
        edge('ok', 'tell', { outcome: 'rejected' }),
        edge('after', 'end'),
        edge('tell', 'end'),
      ],
    });
    const h = started(def, makeCtx(), U.NGOCANH);
    const out = h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: 'chưa đủ hồ sơ' }, vn('2026-10-05', '10:00'));
    expect(Object.fromEntries(h.run.steps.map((s) => [s.nodeId, s.state]))).toEqual({ start: 'done', ok: 'rejected', after: 'skipped', tell: 'done', end: 'done' });
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'rejected' });
    expect(out.effects.find((e) => e.kind === 'notify.custom')).toMatchObject({ toUserId: U.NGOCANH, data: { template: 'rejected' } });
  });

  it('"Chưa đồng ý" bắt buộc có lý do (schema sự kiện chặn lý do rỗng)', () => {
    const h = started(defWith('any', [U.HUY]));
    expect(() => h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: '' }, T0)).toThrow();
    expect(errorCode(() => h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: '   ' }, T0))).toBe('invalid_input');
  });

  it('Reassign trên nút duyệt thay người duyệt đang chờ', () => {
    const h = started(defWith('all', [U.HUY, U.DIRECTOR]));
    h.dispatch({ type: 'Reassign', actor: asUser(U.ADMIN), stepId: h.step('ok').id, toUserId: U.CHAIRMAN, reason: 'Huy đi công tác' }, T0);
    expect(h.step('ok').approvals.map((a) => a.approverId)).toEqual([U.CHAIRMAN, U.DIRECTOR]);
    expect(h.step('ok').assigneeId).toBe(U.CHAIRMAN);
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, T0))).toBe('not_allowed');
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.CHAIRMAN), stepId: h.step('ok').id }, T0))).toBeNull();
  });

  it('không tìm được người duyệt nào: unassigned, rồi Văn phòng giao người duyệt', () => {
    const h = started(defWith('any', [U.GHOST]));
    expect(h.step('ok')).toMatchObject({ state: 'unassigned', approvals: [] });
    h.dispatch({ type: 'AssignStep', actor: asUser(U.ADMIN), stepId: h.step('ok').id, toUserId: U.HUY }, T0);
    expect(h.step('ok')).toMatchObject({ state: 'ready', assigneeId: U.HUY, approvals: [{ approverId: U.HUY, decision: null }] });
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, T0))).toBeNull();
  });
});

describe('NudgeSent và AddNote', () => {
  it('đi thúc: ghi lastNudgedAt, người nhận được lời nhắc; việc đã xong hoặc đã đổi người thì invalid_transition', () => {
    const h = started();
    const nudge = (toUserId: string, at: Date, actor = asUser(U.ADMIN)) => ({
      type: 'NudgeSent' as const,
      actor,
      stepId: h.step('a').id,
      nudgeId: deterministicId(`n:${at.toISOString()}`),
      fromUserId: U.ADMIN,
      toUserId,
      message: 'Nhắc việc',
      aiDrafted: false,
    });
    expect(errorCode(() => h.dispatch(nudge(U.HUNG, T0), T0))).toBe('invalid_transition'); // Hùng không giữ việc này
    expect(errorCode(() => h.dispatch(nudge(U.LAN, T0, asUser(U.PHUONG)), T0))).toBe('not_allowed');
    const out = h.dispatch(nudge(U.LAN, T0, SYSTEM), T0);
    expect(out.effects).toMatchObject([{ kind: 'notify.nudge', toUserId: U.LAN, data: { message: 'Nhắc việc', aiDrafted: false, lateWorkingDays: 0 } }]);
    expect(h.step('a').lastNudgedAt).toBe(T0.toISOString());
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('a').id }, vn('2026-10-06', '09:00'));
    expect(errorCode(() => h.dispatch(nudge(U.LAN, vn('2026-10-06', '10:00')), vn('2026-10-06', '10:00')))).toBe('invalid_transition');
  });

  it('AddNote ghi một dòng sự kiện, không đổi việc nào', () => {
    const h = started();
    const before = h.run.steps;
    const out = h.dispatch({ type: 'AddNote', actor: asUser(U.ADMIN), text: 'Đoàn đổi giờ đến' }, T0);
    expect(out.events[0]?.payload.changes).toEqual([{ type: 'note', text: 'Đoàn đổi giờ đến' }]);
    expect(out.effects).toEqual([]);
    expect(h.run.steps).toEqual(before);
    expect(h.run.seq).toBe(2);
    expect(errorCode(() => h.dispatch({ type: 'AddNote', actor: asUser(U.LAN), text: 'x' }, T0))).toBe('not_allowed');
  });
});

describe('các loại quy tắc người nhận', () => {
  const one = (assignee: Record<string, unknown>, inputs: unknown[] = []) =>
    defOf({ nodes: [START, task('a', U.LAN, { assignee }), END], edges: [edge('start', 'a'), edge('a', 'end')], inputs });

  it('role: nhiều người khớp thì chọn người có id nhỏ nhất; có unitId thì lọc theo đơn vị', () => {
    expect(started(one({ kind: 'role', role: 'employee' })).step('a').assigneeId).toBe(U.LAN);
    expect(started(one({ kind: 'role', role: 'office_admin' })).step('a').assigneeId).toBe(U.ADMIN);
    const scoped = makeCtx({
      users: withUsers({ id: U.ADMIN2, unitId: UNIT.TECH, managerId: U.HUY, status: 'active', roles: [{ role: 'employee', unitId: UNIT.TECH }] }),
    });
    expect(started(one({ kind: 'role', role: 'employee', unitId: UNIT.TECH }), scoped).step('a').assigneeId).toBe(U.TUAN);
    expect(started(one({ kind: 'role', role: 'employee', unitId: UNIT.ACCOUNTING }), scoped).step('a').assigneeId).toBe(U.PHUONG);
    expect(started(one({ kind: 'role', role: 'process_designer' })).step('a').state).toBe('unassigned');
  });

  it('unit_head: đơn vị ghi rõ, hoặc đơn vị của người khởi chạy', () => {
    expect(started(one({ kind: 'unit_head', unitId: UNIT.SALES })).step('a').assigneeId).toBe(U.LAN);
    expect(started(one({ kind: 'unit_head' }), makeCtx(), U.HUNG).step('a').assigneeId).toBe(U.LAN);
    expect(started(one({ kind: 'unit_head', unitId: UNIT.TECH })).step('a').state).toBe('unassigned'); // đơn vị chưa có trưởng
  });

  it('initiator và initiator_manager', () => {
    expect(started(one({ kind: 'initiator' }), makeCtx(), U.HUNG).step('a').assigneeId).toBe(U.HUNG);
    expect(started(one({ kind: 'initiator_manager' }), makeCtx(), U.HUNG).step('a').assigneeId).toBe(U.HUY);
    expect(started(one({ kind: 'initiator_manager', level: 2 }), makeCtx(), U.HUNG).step('a').assigneeId).toBe(U.DIRECTOR);
    expect(started(one({ kind: 'initiator_manager' }), makeCtx(), U.CHAIRMAN).step('a').state).toBe('unassigned'); // Chủ tịch không có cấp trên
  });

  it('form_field: người được chọn trong biểu mẫu khởi chạy', () => {
    const def = one({ kind: 'form_field', field: 'owner' }, [{ key: 'owner', label: 'Người phụ trách', type: 'user' }]);
    expect(started(def, makeCtx(), U.ADMIN, { owner: U.NGOCANH }).step('a').assigneeId).toBe(U.NGOCANH);
    expect(started(def, makeCtx(), U.ADMIN, {}).step('a').state).toBe('unassigned');
  });

  it('người bị vô hiệu hoá không được nhận việc', () => {
    const ctx = makeCtx({ users: withUsers(extraUser(U.LAN, 'employee', UNIT.SALES, U.HUY, 'disabled')) });
    expect(started(LINEAR, ctx).step('a')).toMatchObject({ state: 'unassigned', assigneeId: null });
  });
});
