import { stepRunId, type ProcessDefinition, type StepStateName } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { createRun, validate } from '../src';
import { asUser, errorCode, Harness, SYSTEM } from './support/harness';
import { defOf, due17, edge, END, makeCtx, RUN, runInput, START, task, U, vn } from './support/world';

/** Song song, hợp nhánh, rẽ nhánh, nút hệ thống, hoàn tất lượt chạy và vòng làm lại (SPEC 4.2, 4.4). */

const T0 = vn('2026-10-05', '09:00'); // Thứ Hai

function started(def: ProcessDefinition, inputs: Record<string, unknown> = {}, initiator: string = U.ADMIN): Harness {
  const h = new Harness(def, makeCtx(), runInput(initiator, inputs));
  h.dispatch({ type: 'StartRun', actor: asUser(initiator) }, T0);
  return h;
}
const states = (h: Harness): Record<string, StepStateName> => Object.fromEntries(h.run.steps.map((s) => [`${s.nodeId}${s.attempt > 1 ? `#${s.attempt}` : ''}`, s.state]));
const complete = (h: Harness, nodeId: string, who: string, at: Date, result?: Record<string, unknown>) =>
  h.dispatch({ type: 'CompleteStep', actor: asUser(who), stepId: h.step(nodeId).id, ...(result ? { result } : {}) }, at);

describe('createRun', () => {
  it('dựng lượt chạy draft với một dòng pending cho mọi nút, id dẫn xuất từ (lượt chạy, nút, lần thử)', () => {
    const def = defOf({ nodes: [START, task('a', U.LAN), END], edges: [edge('start', 'a'), edge('a', 'end')] });
    const run = createRun(def, runInput(U.ADMIN));
    expect(run).toMatchObject({ id: RUN, state: 'draft', outcome: null, targetAt: null, startedAt: null, version: 0, seq: 0, appliedEventIds: [] });
    expect(run.steps.map((s) => [s.nodeId, s.kind, s.state, s.attempt, s.id])).toEqual([
      ['start', 'start', 'pending', 1, stepRunId(RUN, 'start', 1)],
      ['a', 'task', 'pending', 1, stepRunId(RUN, 'a', 1)],
      ['end', 'end', 'pending', 1, stepRunId(RUN, 'end', 1)],
    ]);
    expect(run.steps[1]).toMatchObject({ title: 'Việc a', assigneeId: null, dueAt: null, approvals: [], result: null });
  });

  it('kiểm inputs theo biểu mẫu khởi chạy: ô bắt buộc, kiểu tiền, kiểu ngày, lựa chọn', () => {
    const def = defOf({
      nodes: [START, END],
      edges: [edge('start', 'end')],
      inputs: [
        { key: 'name', label: 'Tên đoàn', type: 'text', required: true },
        { key: 'day', label: 'Ngày', type: 'date', required: true },
        { key: 'budget', label: 'Kinh phí', type: 'money' },
        { key: 'level', label: 'Mức', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        { key: 'count', label: 'Số người', type: 'number' },
      ],
      targetField: 'day',
    });
    const make = (inputs: Record<string, unknown>) => errorCode(() => createRun(def, runInput(U.ADMIN, inputs)));
    expect(make({ name: 'Đoàn A', day: '2026-10-15' })).toBeNull();
    expect(make({ day: '2026-10-15' })).toBe('invalid_input');
    expect(make({ name: '  ', day: '2026-10-15' })).toBe('invalid_input');
    expect(make({ name: 'Đoàn A' })).toBe('invalid_input');
    expect(make({ name: 'Đoàn A', day: '15/10/2026' })).toBe('invalid_input');
    expect(make({ name: 'Đoàn A', day: '2026-10-15', budget: 12.5 })).toBe('invalid_input');
    expect(make({ name: 'Đoàn A', day: '2026-10-15', budget: -5 })).toBe('invalid_input');
    expect(make({ name: 'Đoàn A', day: '2026-10-15', budget: 5_000_000, level: 'a', count: 12 })).toBeNull();
    expect(make({ name: 'Đoàn A', day: '2026-10-15', level: 'c' })).toBe('invalid_input');
    expect(make({ name: 'Đoàn A', day: '2026-10-15', count: 'mười' })).toBe('invalid_input');
  });

  it('targetAt là 00:00 giờ địa phương của ngày mốc; utcOffsetMinutes mặc định 420', () => {
    const def = defOf({ nodes: [START, END], edges: [edge('start', 'end')], inputs: [{ key: 'day', label: 'Ngày', type: 'date' }], targetField: 'day' });
    expect(createRun(def, runInput(U.ADMIN, { day: '2026-10-15' })).targetAt).toBe('2026-10-14T17:00:00.000Z');
    expect(createRun(def, { ...runInput(U.ADMIN, { day: '2026-10-15' }), utcOffsetMinutes: 0 }).targetAt).toBe('2026-10-15T00:00:00.000Z');
    expect(createRun(def, runInput(U.ADMIN, { day: '2026-10-14T18:30:00.000Z' })).targetAt).toBe('2026-10-14T17:00:00.000Z'); // 01:30 ngày 15 giờ VN
    expect(createRun(def, runInput(U.ADMIN, {})).targetAt).toBeNull();
  });
});

describe('song song và hợp nhánh', () => {
  const diamond = (join?: 'all' | 'any') =>
    defOf({
      nodes: [START, task('a', U.LAN), task('b', U.HUNG), task('c', U.TUAN, join ? { join } : {}), END],
      edges: [edge('start', 'a'), edge('start', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'end')],
    });

  it('nhiều cạnh đi ra khỏi một nút: các nhánh chạy song song', () => {
    const h = started(diamond());
    expect(states(h)).toEqual({ start: 'done', a: 'ready', b: 'ready', c: 'pending', end: 'pending' });
  });

  it('join all (mặc định): chờ mọi cạnh đến', () => {
    const h = started(diamond());
    complete(h, 'a', U.LAN, vn('2026-10-05', '10:00'));
    expect(h.step('c').state).toBe('pending');
    complete(h, 'b', U.HUNG, vn('2026-10-05', '11:00'));
    expect(h.step('c')).toMatchObject({ state: 'ready', activatedAt: vn('2026-10-05', '11:00').toISOString() });
  });

  it('join any: kích hoạt khi cạnh đến đầu tiên xong, không kích hoạt lần hai', () => {
    const h = started(diamond('any'));
    complete(h, 'a', U.LAN, vn('2026-10-05', '10:00'));
    expect(h.step('c')).toMatchObject({ state: 'ready', activatedAt: vn('2026-10-05', '10:00').toISOString() });
    const mark = h.mark();
    const out = complete(h, 'b', U.HUNG, vn('2026-10-05', '11:00'));
    expect(h.step('c').activatedAt).toBe(vn('2026-10-05', '10:00').toISOString());
    expect(h.run.steps.filter((s) => s.nodeId === 'c')).toHaveLength(1);
    expect(h.sent({ from: mark, kind: 'notify.assigned' })).toEqual([]);
    expect(out.events[0]?.payload.changes.some((c) => c.type === 'step.activated')).toBe(false);
  });

  it('join any với một nhánh bị bỏ qua: chờ nhánh còn lại; mọi nhánh bị bỏ qua thì nút cũng bị bỏ qua', () => {
    const def = (when: unknown) =>
      defOf({
        inputs: [{ key: 'flag', label: 'Cờ', type: 'text' }],
        nodes: [
          START,
          { id: 'if', type: 'condition', label: 'Rẽ', branches: [{ id: 'x', when }] },
          task('a', U.LAN),
          task('b', U.HUNG),
          task('c', U.TUAN, { join: 'any' }),
          END,
        ],
        edges: [edge('start', 'if'), edge('start', 'b'), edge('if', 'a', { branch: 'x' }), edge('if', 'end', { branch: 'else' }), edge('a', 'c'), edge('b', 'c'), edge('c', 'end')],
      });
    const yes = { op: 'eq', left: { ref: 'inputs.flag' }, right: { value: 'x' } };
    // nhánh a bị bỏ qua: c chờ b
    const h = started(def(yes), { flag: 'khác' });
    expect(states(h)).toMatchObject({ a: 'skipped', b: 'ready', c: 'pending' });
    complete(h, 'b', U.HUNG, vn('2026-10-05', '10:00'));
    expect(h.step('c').state).toBe('ready');
    // cả hai nhánh tới c đều bị bỏ qua (b được Văn phòng cho qua thì KHÔNG tính là bỏ qua: luồng vẫn đi tiếp)
    const g = started(def(yes), { flag: 'khác' });
    g.dispatch({ type: 'SkipStep', actor: asUser(U.ADMIN), stepId: g.step('b').id, reason: 'không cần' }, vn('2026-10-05', '10:00'));
    expect(g.step('c').state).toBe('ready');
  });

  it('nút kết thúc join any: tới kết thúc là lượt chạy hoàn tất, việc còn dở thành "Không cần làm" và timer bị huỷ', () => {
    const def = defOf({
      nodes: [START, task('a', U.LAN), task('b', U.HUNG), { ...END, join: 'any' }],
      edges: [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')],
    });
    const h = started(def);
    const out = complete(h, 'a', U.LAN, vn('2026-10-05', '10:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
    expect(states(h)).toEqual({ start: 'done', a: 'done', b: 'skipped', end: 'done' });
    expect(out.effects.filter((e) => e.kind === 'cancel_timers').map((e) => e.stepId)).toEqual([h.step('a').id, h.step('b').id]);
    expect(h.timers.size).toBe(0);
    expect(h.replayed()).toEqual(h.run);
  });

  it('hai nút kết thúc: chỉ hoàn tất khi cả hai đã tới', () => {
    const def = defOf({
      nodes: [START, task('a', U.LAN), task('b', U.HUNG), { id: 'end1', type: 'end', label: 'Xong A' }, { id: 'end2', type: 'end', label: 'Xong B' }],
      edges: [edge('start', 'a'), edge('start', 'b'), edge('a', 'end1'), edge('b', 'end2')],
    });
    const h = started(def);
    complete(h, 'a', U.LAN, vn('2026-10-05', '10:00'));
    expect(h.run.state).toBe('running');
    expect(h.step('end1').state).toBe('done');
    complete(h, 'b', U.HUNG, vn('2026-10-05', '11:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
  });
});

describe('rẽ nhánh', () => {
  const branching = defOf({
    inputs: [{ key: 'amount', label: 'Số tiền', type: 'money', required: true }],
    nodes: [
      START,
      {
        id: 'if',
        type: 'condition',
        label: 'Số tiền lớn?',
        branches: [
          { id: 'big', when: { op: 'gte', left: { ref: 'inputs.amount' }, right: { value: 50_000_000 } } },
          { id: 'mid', when: { op: 'and', args: [{ op: 'gte', left: { ref: 'inputs.amount' }, right: { value: 10_000_000 } }, { op: 'not', arg: { op: 'eq', left: { ref: 'inputs.amount' }, right: { value: 10_000_001 } } }] } },
        ],
      },
      task('director', U.DIRECTOR),
      task('deputy', U.HUY),
      task('clerk', U.PHUONG),
      task('after', U.LAN),
      task('pay', U.LAN2),
      END,
    ],
    edges: [
      edge('start', 'if'),
      edge('if', 'director', { branch: 'big' }),
      edge('if', 'deputy', { branch: 'mid' }),
      edge('if', 'clerk', { branch: 'else' }),
      edge('director', 'after'),
      edge('after', 'pay'),
      edge('deputy', 'pay'),
      edge('clerk', 'pay'),
      edge('pay', 'end'),
    ],
  });

  it('chọn nhánh đầu tiên có điều kiện đúng; nhánh không được chọn bị skipped và lan xuống đường chết', () => {
    const h = started(branching, { amount: 60_000_000 });
    expect(states(h)).toEqual({ start: 'done', if: 'done', director: 'ready', deputy: 'skipped', clerk: 'skipped', after: 'pending', pay: 'pending', end: 'pending' });
    expect(h.step('if').result).toEqual({ branch: 'big' });
    // nhánh bị bỏ qua không sinh thông báo hay timer
    expect(h.sent().map((s) => s.effect.toUserId)).toEqual([U.DIRECTOR]);
    complete(h, 'director', U.DIRECTOR, vn('2026-10-05', '10:00'));
    complete(h, 'after', U.LAN, vn('2026-10-05', '11:00'));
    // pay hợp nhánh all: hai cạnh skipped, một cạnh xong → kích hoạt
    expect(h.step('pay').state).toBe('ready');
    complete(h, 'pay', U.LAN2, vn('2026-10-05', '12:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
    expect(h.replayed()).toEqual(h.run);
  });

  it('nhánh giữa và nhánh else', () => {
    expect(started(branching, { amount: 20_000_000 }).step('if').result).toEqual({ branch: 'mid' });
    expect(states(started(branching, { amount: 20_000_000 }))).toMatchObject({ director: 'skipped', deputy: 'ready', clerk: 'skipped', after: 'skipped', pay: 'pending' });
    expect(started(branching, { amount: 10_000_001 }).step('if').result).toEqual({ branch: 'else' });
    expect(states(started(branching, { amount: 5_000_000 }))).toMatchObject({ director: 'skipped', deputy: 'skipped', clerk: 'ready', after: 'skipped' });
  });

  it('điều kiện đọc kết quả của việc trước (steps.<nodeId>.result.<key>)', () => {
    const def = defOf({
      nodes: [
        START,
        task('ask', U.PHUONG, { form: [{ key: 'amount', label: 'Số tiền', type: 'money', required: true }, { key: 'urgent', label: 'Gấp', type: 'select', options: [{ value: 'yes', label: 'Có' }, { value: 'no', label: 'Không' }] }] }),
        {
          id: 'if',
          type: 'condition',
          label: 'Cần duyệt?',
          branches: [{ id: 'approve', when: { op: 'or', args: [{ op: 'gt', left: { ref: 'steps.ask.result.amount' }, right: { value: 5_000_000 } }, { op: 'eq', left: { ref: 'steps.ask.result.urgent' }, right: { value: 'yes' } }] } }],
        },
        task('check', U.HUY),
        END,
      ],
      edges: [edge('start', 'ask'), edge('ask', 'if'), edge('if', 'check', { branch: 'approve' }), edge('if', 'end', { branch: 'else' }), edge('check', 'end')],
    });
    const big = started(def);
    complete(big, 'ask', U.PHUONG, vn('2026-10-05', '10:00'), { amount: 20_000_000 });
    expect(big.step('check').state).toBe('ready');
    const urgent = started(def);
    complete(urgent, 'ask', U.PHUONG, vn('2026-10-05', '10:00'), { amount: 1_000, urgent: 'yes' });
    expect(urgent.step('check').state).toBe('ready');
    const small = started(def);
    complete(small, 'ask', U.PHUONG, vn('2026-10-05', '10:00'), { amount: 1_000, urgent: 'no' });
    expect(states(small)).toEqual({ start: 'done', ask: 'done', if: 'done', check: 'skipped', end: 'done' });
    expect(small.run).toMatchObject({ state: 'completed', outcome: 'success' });
  });

  it('tham chiếu thiếu giá trị hoặc lạ không làm hỏng engine: điều kiện sai, đi nhánh else', () => {
    const def = defOf({
      nodes: [
        START,
        {
          id: 'if',
          type: 'condition',
          label: 'Thử',
          branches: [
            { id: 'x', when: { op: 'eq', left: { ref: 'inputs.constructor' }, right: { value: 'x' } } },
            { id: 'y', when: { op: 'gt', left: { ref: 'steps.nope.result.amount' }, right: { value: 1 } } },
            { id: 'z', when: { op: 'lt', left: { ref: 'cái gì đó' }, right: { value: 1 } } },
          ],
        },
        task('a', U.LAN),
        END,
      ],
      edges: [edge('start', 'if'), edge('if', 'a', { branch: 'x' }), edge('if', 'a', { branch: 'y' }), edge('if', 'a', { branch: 'z' }), edge('if', 'end', { branch: 'else' })],
    });
    const h = started(def);
    expect(h.step('if').result).toEqual({ branch: 'else' });
    expect(h.run.state).toBe('completed');
  });
});

describe('nút hệ thống: timer, notify, webhook', () => {
  it('timer: hẹn schedule_timer loại wait, in_progress tới khi TimerFired', () => {
    const def = defOf({
      nodes: [START, { id: 'wait', type: 'timer', label: 'Chờ 2 ngày', wait: { value: 2, unit: 'working_day' } }, task('a', U.LAN), END],
      edges: [edge('start', 'wait'), edge('wait', 'a'), edge('a', 'end')],
    });
    const h = started(def);
    expect(h.step('wait')).toMatchObject({ state: 'in_progress', dueAt: null });
    expect([...h.timers.values()]).toMatchObject([{ kind: 'schedule_timer', timerKind: 'wait', stepId: h.step('wait').id, fireAt: vn('2026-10-07', '09:00').toISOString() }]);
    expect(h.step('a').state).toBe('pending');
    expect(h.advanceTo(vn('2026-10-07', '08:59'))).toBe(0);
    expect(h.advanceTo(vn('2026-10-07', '09:00'))).toBe(1);
    expect(h.step('wait')).toMatchObject({ state: 'done', completedAt: vn('2026-10-07', '09:00').toISOString() });
    expect(h.step('a')).toMatchObject({ state: 'ready', dueAt: due17('2026-10-09') });
    expect(h.replayed()).toEqual(h.run);
  });

  it('timer bắn hai lần (worker chạy lại): lần hai bị bỏ qua', () => {
    const def = defOf({
      nodes: [START, { id: 'wait', type: 'timer', label: 'Chờ', wait: { value: 1, unit: 'hour' } }, END],
      edges: [edge('start', 'wait'), edge('wait', 'end')],
    });
    const h = started(def);
    const timer = [...h.timers.values()][0];
    expect(timer).toBeDefined();
    if (!timer) return;
    const fire = { type: 'TimerFired', actor: SYSTEM, timerKey: timer.dedupeKey, stepId: timer.stepId, kind: 'wait', data: {} } as const;
    h.dispatch(fire, vn('2026-10-05', '10:00'));
    expect(h.run.state).toBe('completed');
    const again = h.dispatch(fire, vn('2026-10-05', '10:01'));
    expect(again.effects).toEqual([]);
    expect(again.events[0]?.payload.changes).toEqual([{ type: 'reminder.suppressed', stepId: h.step('wait').id, why: 'not_open' }]);
  });

  it('notify: một effect notify.custom cho từng người, nút xong ngay; quy tắc role gửi cho mọi người giữ vai trò', () => {
    const def = defOf({
      nodes: [
        START,
        { id: 'tell', type: 'notify', label: 'Báo tin', to: [{ kind: 'role', role: 'employee' }, { kind: 'user', userId: U.LAN }, { kind: 'initiator' }], template: 'run_started' },
        END,
      ],
      edges: [edge('start', 'tell'), edge('tell', 'end')],
    });
    const h = started(def);
    const custom = h.sent({ kind: 'notify.custom' });
    expect(custom.map((s) => s.effect.toUserId)).toEqual([U.LAN, U.NGOCANH, U.TUAN, U.PHUONG, U.HUNG, U.LAN2, U.ADMIN]);
    expect(custom[0]?.effect).toMatchObject({ stepId: h.step('tell').id, data: { template: 'run_started', nodeLabel: 'Báo tin' } });
    expect(h.step('tell').state).toBe('done');
    expect(h.run.state).toBe('completed');
  });

  it('webhook: effect webhook, nút xong ngay', () => {
    const def = defOf({
      nodes: [START, { id: 'hook', type: 'webhook', label: 'Gọi n8n', url: 'https://example.invalid/hook', bodyTemplate: '{"run":"{{run.id}}"}' }, END],
      edges: [edge('start', 'hook'), edge('hook', 'end')],
    });
    const h = started(def);
    expect(h.effects.find((e) => e.kind === 'webhook')).toMatchObject({ url: 'https://example.invalid/hook', body: '{"run":"{{run.id}}"}', stepId: h.step('hook').id });
    expect(h.run.state).toBe('completed');
  });
});

describe('vòng làm lại qua cạnh rejected (giai đoạn 3)', () => {
  const approval = { id: 'ok', type: 'approval', label: 'Duyệt', title: 'Duyệt báo giá', approvers: [{ kind: 'user', userId: U.HUY }], mode: 'any', due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } } };
  const loop = defOf({
    nodes: [START, task('prep', U.NGOCANH), task('draft', U.LAN), task('review', U.HUNG), approval, task('send', U.TUAN), END],
    edges: [
      edge('start', 'prep'),
      edge('prep', 'draft'),
      edge('draft', 'review'),
      edge('review', 'ok'),
      edge('ok', 'send', { outcome: 'approved' }),
      edge('ok', 'draft', { outcome: 'rejected' }),
      edge('send', 'end'),
    ],
  });

  it('định nghĩa có vòng làm lại qua được validate()', () => {
    expect(validate(loop).errors).toEqual([]);
  });

  it('"Chưa đồng ý" tạo lần thử mới cho nút đích và các nút trên đường tới nút duyệt, rồi kích hoạt lại nút đích', () => {
    const h = started(loop);
    complete(h, 'prep', U.NGOCANH, vn('2026-10-05', '10:00'));
    complete(h, 'draft', U.LAN, vn('2026-10-05', '11:00'));
    complete(h, 'review', U.HUNG, vn('2026-10-05', '12:00'));
    const firstOk = h.step('ok').id;
    const out = h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: firstOk, reason: 'giá chưa hợp lý' }, vn('2026-10-05', '14:00'));

    expect(states(h)).toEqual({
      start: 'done',
      prep: 'done', // đứng trước nút đích: không làm lại
      draft: 'done',
      review: 'done',
      ok: 'rejected',
      send: 'pending',
      end: 'pending',
      'draft#2': 'ready',
      'review#2': 'pending',
      'ok#2': 'pending',
    });
    expect(h.step('draft')).toMatchObject({ attempt: 2, id: stepRunId(RUN, 'draft', 2), assigneeId: U.LAN, activatedAt: vn('2026-10-05', '14:00').toISOString(), dueAt: due17('2026-10-07') });
    expect(h.run.steps.find((s) => s.id === firstOk)).toMatchObject({ state: 'rejected', reason: 'giá chưa hợp lý' });
    expect(h.run.state).toBe('running');
    expect(out.effects.filter((e) => e.kind === 'notify.assigned')).toMatchObject([{ toUserId: U.LAN, stepId: stepRunId(RUN, 'draft', 2) }]);
    expect(out.effects.filter((e) => e.kind === 'notify.rejected')).toMatchObject([{ toUserId: U.ADMIN }]);
    // timer của lần thử mới mang stepId mới
    expect(h.timersOf('draft').every((t) => t.stepId === stepRunId(RUN, 'draft', 2))).toBe(true);
    // lần thử cũ không thao tác được nữa
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: firstOk }, vn('2026-10-05', '15:00')))).toBe('invalid_transition');

    // làm lại rồi được đồng ý: lượt chạy thành công
    complete(h, 'draft', U.LAN, vn('2026-10-06', '09:00'));
    complete(h, 'review', U.HUNG, vn('2026-10-06', '10:00'));
    expect(h.step('ok')).toMatchObject({ attempt: 2, state: 'ready', assigneeId: U.HUY });
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('ok').id }, vn('2026-10-06', '11:00'));
    expect(h.step('send').state).toBe('ready');
    complete(h, 'send', U.TUAN, vn('2026-10-06', '12:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' }); // lần thử mới nhất của nút duyệt là đồng ý
    expect(h.timers.size).toBe(0);
    expect(h.replayed()).toEqual(h.run);
    expect(JSON.stringify(h.replayed())).toBe(JSON.stringify(h.run));
  });

  it('bị từ chối hai lần: lần thử thứ ba', () => {
    const h = started(loop);
    complete(h, 'prep', U.NGOCANH, vn('2026-10-05', '10:00'));
    for (const day of ['2026-10-05', '2026-10-06']) {
      complete(h, 'draft', U.LAN, vn(day, '11:00'));
      complete(h, 'review', U.HUNG, vn(day, '12:00'));
      h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: 'chưa đạt' }, vn(day, '14:00'));
    }
    expect(h.step('draft')).toMatchObject({ attempt: 3, state: 'ready' });
    expect(h.run.steps.filter((s) => s.nodeId === 'ok').map((s) => [s.attempt, s.state])).toEqual([
      [1, 'rejected'],
      [2, 'rejected'],
      [3, 'pending'],
    ]);
    expect(new Set(h.run.steps.map((s) => s.id)).size).toBe(h.run.steps.length);
    expect(h.replayed()).toEqual(h.run);
  });

  it('việc làm lại giao cho người đã làm lần trước (sau khi đã đổi người)', () => {
    const h = started(loop);
    complete(h, 'prep', U.NGOCANH, vn('2026-10-05', '10:00'));
    h.dispatch({ type: 'Reassign', actor: asUser(U.ADMIN), stepId: h.step('draft').id, toUserId: U.PHUONG, reason: 'Lan bận' }, vn('2026-10-05', '10:30'));
    complete(h, 'draft', U.PHUONG, vn('2026-10-05', '11:00'));
    complete(h, 'review', U.HUNG, vn('2026-10-05', '12:00'));
    h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: 'làm lại' }, vn('2026-10-05', '14:00'));
    expect(h.step('draft')).toMatchObject({ attempt: 2, state: 'ready', assigneeId: U.PHUONG });
  });
});
