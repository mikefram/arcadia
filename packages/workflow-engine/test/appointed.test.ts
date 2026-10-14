import { type AssigneeRule, type DelegationRecord, type ResolveContext } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { appointedFor, assertAppointed, createRun } from '../src';
import { errorCode } from './support/harness';
import { defOf, edge, END, extraUser, makeCtx, runInput, START, TEMPLATE, U, UNIT, vn, withUsers } from './support/world';

/** "Người được bổ nhiệm" của việc nằm trong quy trình (docs/DECISIONS.md 04/10/2026): quy tắc của nút + người được ủy quyền. */

const NOW = vn('2026-10-05', '09:00');

const taskWith = (assignee: AssigneeRule, id = 'a') => ({
  id,
  type: 'task',
  label: `Việc ${id}`,
  title: `Việc ${id}`,
  assignee,
  due: { anchor: 'activation', offset: { value: 2, unit: 'working_day' } },
});

function one(assignee: AssigneeRule, over: Partial<ResolveContext> = {}, initiator: string = U.ADMIN, inputs: Record<string, unknown> = {}) {
  const def = defOf({
    nodes: [START, taskWith(assignee), END],
    edges: [edge('start', 'a'), edge('a', 'end')],
    inputs: [{ key: 'who', label: 'Người phụ trách', type: 'user' }],
  });
  const run = createRun(def, runInput(initiator, inputs));
  return { def, run, step: run.steps.find((s) => s.nodeId === 'a')!, ctx: makeCtx(over) };
}

const idsOf = (c: ReturnType<typeof one>) => appointedFor(c.def, c.run, c.step, c.ctx, NOW);

const delegation = (over: Partial<DelegationRecord> = {}): DelegationRecord => ({
  fromUserId: U.LAN,
  toUserId: U.HUNG,
  validFrom: vn('2026-10-01', '00:00').toISOString(),
  validTo: vn('2026-10-31', '23:00').toISOString(),
  scope: 'all',
  scopeRef: null,
  ...over,
});

describe('appointedFor: quy tắc của nút', () => {
  it('quy tắc user: đúng người đó, không ai khác', () => {
    expect(idsOf(one({ kind: 'user', userId: U.LAN }))).toEqual({ open: false, userIds: [U.LAN] });
  });

  it('quy tắc role: mọi người đang giữ vai trò, kể cả người thứ hai; không lẫn vai trò khác', () => {
    const users = withUsers(extraUser(U.ADMIN2, 'office_admin', UNIT.OFFICE, U.DIRECTOR));
    const r = idsOf(one({ kind: 'role', role: 'office_admin' }, { users }));
    expect(r.open).toBe(false);
    expect(r.userIds).toEqual([U.ADMIN, U.ADMIN2].sort());
    expect(r.userIds).not.toContain(U.IT);
  });

  it('quy tắc role có đơn vị: chỉ người giữ vai trò trong đơn vị đó', () => {
    const r = idsOf(one({ kind: 'role', role: 'employee', unitId: UNIT.SALES }));
    expect(r.userIds).toEqual([U.LAN, U.HUNG].sort());
  });

  it('unit_head: trưởng đơn vị; thiếu unitId thì đơn vị của người khởi chạy', () => {
    expect(idsOf(one({ kind: 'unit_head', unitId: UNIT.SALES })).userIds).toEqual([U.LAN]);
    expect(idsOf(one({ kind: 'unit_head' }, {}, U.HUNG)).userIds).toEqual([U.LAN]);
  });

  it('initiator và initiator_manager', () => {
    expect(idsOf(one({ kind: 'initiator' }, {}, U.TUAN)).userIds).toEqual([U.TUAN]);
    expect(idsOf(one({ kind: 'initiator_manager' }, {}, U.TUAN)).userIds).toEqual([U.HUY]);
  });

  it('form_field: người được chọn trong biểu mẫu khởi chạy', () => {
    expect(idsOf(one({ kind: 'form_field', field: 'who' }, {}, U.ADMIN, { who: U.NGOCANH })).userIds).toEqual([U.NGOCANH]);
  });

  it('nút duyệt: mọi người duyệt trong danh sách', () => {
    const def = defOf({
      nodes: [START, { id: 'a', type: 'approval', label: 'Duyệt', title: 'Duyệt', approvers: [{ kind: 'user', userId: U.HUY }, { kind: 'user', userId: U.DIRECTOR }], mode: 'any', due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } } }, END],
      edges: [edge('start', 'a'), edge('a', 'end', { outcome: 'approved' })],
    });
    const run = createRun(def, runInput(U.ADMIN));
    const r = appointedFor(def, run, run.steps.find((s) => s.nodeId === 'a')!, makeCtx(), NOW);
    expect(r.userIds).toEqual([U.HUY, U.DIRECTOR].sort());
  });
});

describe('appointedFor: người được ủy quyền', () => {
  it('ủy quyền đang hiệu lực: người được ủy quyền cũng được nhận', () => {
    const r = idsOf(one({ kind: 'user', userId: U.LAN }, { delegations: [delegation()] }));
    expect(r.userIds).toEqual([U.LAN, U.HUNG].sort());
  });

  it('ủy quyền hết hạn hoặc chưa tới hạn: không tính', () => {
    const expired = delegation({ validFrom: vn('2026-09-01', '00:00').toISOString(), validTo: vn('2026-09-30', '23:00').toISOString() });
    const future = delegation({ validFrom: vn('2026-11-01', '00:00').toISOString(), validTo: vn('2026-11-30', '23:00').toISOString() });
    expect(idsOf(one({ kind: 'user', userId: U.LAN }, { delegations: [expired, future] })).userIds).toEqual([U.LAN]);
  });

  it('ủy quyền theo quy trình khác hoặc vai trò khác: không phủ việc này', () => {
    const otherProcess = delegation({ scope: 'process', scopeRef: '01920000-0000-7000-8000-000000009999' });
    const otherRole = delegation({ scope: 'role', scopeRef: 'director' });
    expect(idsOf(one({ kind: 'user', userId: U.LAN }, { delegations: [otherProcess, otherRole] })).userIds).toEqual([U.LAN]);
  });

  it('ủy quyền theo đúng quy trình này: được tính', () => {
    const r = idsOf(one({ kind: 'user', userId: U.LAN }, { delegations: [delegation({ scope: 'process', scopeRef: TEMPLATE })] }));
    expect(r.userIds).toEqual([U.LAN, U.HUNG].sort());
  });

  it('người được ủy quyền không ủy quyền tiếp (không bắc cầu)', () => {
    const chain = [delegation(), delegation({ fromUserId: U.HUNG, toUserId: U.TUAN })];
    expect(idsOf(one({ kind: 'user', userId: U.LAN }, { delegations: chain })).userIds).toEqual([U.LAN, U.HUNG].sort());
  });

  it('ủy quyền cho người đã bị vô hiệu hoá: không tính', () => {
    const users = withUsers(extraUser(U.DISABLED, 'employee', UNIT.TECH, U.HUY, 'disabled'));
    const r = idsOf(one({ kind: 'user', userId: U.LAN }, { users, delegations: [delegation({ toUserId: U.DISABLED })] }));
    expect(r.userIds).toEqual([U.LAN]);
  });
});

describe('appointedFor: không có ai được bổ nhiệm thì mở cho Văn phòng', () => {
  it('người được chỉ định đã bị vô hiệu hoá', () => {
    const users = withUsers(extraUser(U.DISABLED, 'employee', UNIT.TECH, U.HUY, 'disabled'));
    expect(idsOf(one({ kind: 'user', userId: U.DISABLED }, { users }))).toEqual({ open: true, userIds: [] });
  });

  it('vai trò chưa có người giữ; trưởng đơn vị để trống; ô biểu mẫu để trống', () => {
    expect(idsOf(one({ kind: 'role', role: 'process_designer' })).open).toBe(true);
    expect(idsOf(one({ kind: 'unit_head', unitId: UNIT.LEGAL })).open).toBe(true);
    expect(idsOf(one({ kind: 'form_field', field: 'who' })).open).toBe(true);
  });
});

describe('assertAppointed', () => {
  const lan = one({ kind: 'user', userId: U.LAN }, { delegations: [delegation()] });
  const call = (c: ReturnType<typeof one>, to: string) => errorCode(() => assertAppointed(c.def, c.run, c.step, to, c.ctx, NOW));

  it('cho qua người được bổ nhiệm và người được ủy quyền; chặn người khác bằng invalid_input', () => {
    expect(call(lan, U.LAN)).toBeNull();
    expect(call(lan, U.HUNG)).toBeNull();
    expect(call(lan, U.TUAN)).toBe('invalid_input');
  });

  it('lỗi mang mã not_appointed ở body.toUserId để API trả đúng chỗ', () => {
    try {
      assertAppointed(lan.def, lan.run, lan.step, U.TUAN, lan.ctx, NOW);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'invalid_input', detail: { errors: [{ path: 'body.toUserId', code: 'not_appointed' }] } });
    }
  });

  it('khi không ai được bổ nhiệm thì ai còn hoạt động cũng nhận được', () => {
    const users = withUsers(extraUser(U.DISABLED, 'employee', UNIT.TECH, U.HUY, 'disabled'));
    const c = one({ kind: 'user', userId: U.DISABLED }, { users });
    expect(call(c, U.TUAN)).toBeNull();
  });

  it('không đổi dữ liệu đầu vào', () => {
    const before = JSON.stringify([lan.def, lan.run, lan.ctx]);
    call(lan, U.TUAN);
    appointedFor(lan.def, lan.run, lan.step, lan.ctx, NOW);
    expect(JSON.stringify([lan.def, lan.run, lan.ctx])).toBe(before);
  });
});
