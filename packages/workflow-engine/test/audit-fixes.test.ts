import { describe, expect, it } from 'vitest';
import { validate } from '../src';
import { asUser, Harness, SYSTEM } from './support/harness';
import { defOf, edge, END, extraUser, makeCtx, runInput, START, task, U, UNIT, vn, withUsers } from './support/world';

/**
 * Sửa lỗi sau rà soát 07/10/2026 (docs/RA-SOAT-2026-10-07.md): engine-1 (bế tắc không được thành "thành công"),
 * engine-2 (gỡ đúng người bị vô hiệu hoá), engine-3 (làm lại tính lại người nhận), engine-5 (đóng góp theo vai trò).
 */

const NOW = vn('2026-10-06', '09:00');
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };
const approval = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'approval',
  label: `Duyệt ${id}`,
  title: `Duyệt ${id}`,
  approvers: [{ kind: 'user', userId: U.HUY }],
  mode: 'any',
  due: DUE,
  ...extra,
});
const contribute = (id: string, approvers: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  approval(id, { action: 'contribute', approvers, mode: 'all', form: [{ key: 'ketQua', label: 'Kết quả', type: 'longtext' }], ...extra });

function started(def: ReturnType<typeof defOf>, ctx = makeCtx(), inputs: Record<string, unknown> = {}): Harness {
  const h = new Harness(def, ctx, runInput(U.CHAIRMAN, inputs));
  h.dispatch({ type: 'StartRun', actor: asUser(U.CHAIRMAN) }, NOW);
  return h;
}

describe('engine-1: đồ thị có bước sửa chỉ tới được qua "Chưa đồng ý"', () => {
  const nodes = [START, task('draft', U.LAN), approval('appr'), task('fix', U.HUNG), END];
  const edges = [edge('start', 'draft'), edge('draft', 'appr'), edge('appr', 'end', { outcome: 'approved' }), edge('appr', 'fix', { outcome: 'rejected' }), edge('fix', 'appr')];

  it('validate() chặn xuất bản, báo đúng bước sửa', () => {
    const r = validate({ schemaVersion: 1, name: 'Thử', inputs: [], nodes, edges } as never);
    expect(r.definition).toBeNull();
    expect(r.errors).toMatchObject([{ code: 'node_only_via_return', nodeId: 'fix' }]);
  });

  it('engine: lượt chạy không bao giờ hoàn tất "success" khi nút duyệt chưa tới lượt còn cạnh đến chưa giải quyết', () => {
    const h = started(defOf({ nodes, edges }));
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('draft').id }, NOW);
    expect(h.run.state).toBe('running');
    expect(h.run.outcome).toBeNull();
    expect(h.step('appr').state).toBe('pending'); // không bị chuyển skipped
    expect(h.step('end').state).toBe('pending');
    // Văn phòng vẫn huỷ được lượt chạy bị kẹt.
    h.dispatch({ type: 'CancelRun', actor: asUser(U.ADMIN), reason: 'bản vẽ lỗi' }, NOW);
    expect(h.run.state).toBe('cancelled');
  });
});

describe('engine-2: UnassignStep chỉ gỡ người bị vô hiệu hoá', () => {
  const def = defOf({
    nodes: [START, contribute('gop', [{ kind: 'user', userId: U.HUY }, { kind: 'user', userId: U.LAN }, { kind: 'user', userId: U.TUAN }]), END],
    edges: [edge('start', 'gop'), edge('gop', 'end', { outcome: 'approved' })],
  });
  const T1 = vn('2026-10-06', '12:00');

  it('bước đóng góp ba người, gỡ một người: hai người còn lại vẫn giữ việc, timer giữ nguyên, phát lại đúng từng bit', () => {
    const h = started(def);
    const timersBefore = h.timersOf('gop').length;
    expect(timersBefore).toBeGreaterThan(0);
    h.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: h.step('gop').id, reason: 'user_disabled', userId: U.LAN }, T1);
    expect(h.step('gop')).toMatchObject({ state: 'ready', assigneeId: U.HUY });
    expect(h.step('gop').approvals.map((a) => a.approverId)).toEqual([U.HUY, U.TUAN]);
    expect(h.timersOf('gop')).toHaveLength(timersBefore);
    expect(h.sent({ kind: 'notify.assigned', to: U.ADMIN, nodeId: 'gop' })).toHaveLength(0); // không phải "Cần giao người"

    h.dispatch({ type: 'ApproveStep', actor: asUser(U.TUAN), stepId: h.step('gop').id, result: { ketQua: 'phần Tuấn' } }, T1);
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('gop').id, result: { ketQua: 'phần Huy' } }, T1);
    expect(h.step('gop').state).toBe('done');
    expect((h.step('gop').result as { responses: { userId: string }[] }).responses.map((r) => r.userId)).toEqual([U.HUY, U.TUAN]);
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
    expect(JSON.stringify(h.replayed())).toBe(JSON.stringify(h.run));
  });

  it('gỡ đúng người đang được trỏ tới: con trỏ chuyển sang người còn lại, phần đã gửi của người khác được giữ', () => {
    const h = started(def);
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.LAN), stepId: h.step('gop').id, result: { ketQua: 'phần Lan' } }, T1);
    h.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: h.step('gop').id, reason: 'user_disabled', userId: U.HUY }, T1);
    expect(h.step('gop').assigneeId).toBe(U.TUAN);
    expect(h.step('gop').approvals.map((a) => [a.approverId, a.decision])).toEqual([[U.LAN, 'approved'], [U.TUAN, null]]);
    expect(JSON.stringify(h.replayed())).toBe(JSON.stringify(h.run));
  });

  it('gỡ người cuối cùng chưa quyết: bước về "Cần giao người", giữ phần đã gửi; sự kiện không có userId vẫn gỡ cả bước như cũ', () => {
    const solo = defOf({
      nodes: [START, contribute('gop', [{ kind: 'user', userId: U.HUY }, { kind: 'user', userId: U.LAN }]), END],
      edges: [edge('start', 'gop'), edge('gop', 'end', { outcome: 'approved' })],
    });
    const h = started(solo);
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('gop').id, result: { ketQua: 'x' } }, T1);
    h.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: h.step('gop').id, reason: 'user_disabled', userId: U.LAN }, T1);
    expect(h.step('gop')).toMatchObject({ state: 'unassigned', assigneeId: null });
    expect(h.step('gop').approvals.map((a) => [a.approverId, a.decision])).toEqual([[U.HUY, 'approved']]);
    expect(h.timersOf('gop')).toEqual([]);

    const legacy = started(def);
    legacy.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: legacy.step('gop').id, reason: 'user_disabled' }, T1);
    expect(legacy.step('gop')).toMatchObject({ state: 'unassigned' });
    expect(legacy.step('gop').approvals).toEqual([]);
  });

  it('người không giữ phần nào chưa quyết ở bước này: không đổi gì', () => {
    const h = started(def);
    const before = JSON.stringify(h.run.steps);
    h.dispatch({ type: 'UnassignStep', actor: SYSTEM, stepId: h.step('gop').id, reason: 'user_disabled', userId: U.NGOCANH }, T1);
    expect(JSON.stringify(h.run.steps)).toBe(before);
  });
});

describe('engine-3: làm lại tính lại người nhận', () => {
  const T = (h: string) => vn('2026-10-06', h);

  it('step_field trỏ tới bước cũng nằm trong vòng làm lại: lần 2 chọn người khác thì việc tổng hợp về người mới', () => {
    const def = defOf({
      nodes: [
        START,
        task('nhan', U.DIRECTOR, { form: [{ key: 'chuTri', label: 'Người chủ trì', type: 'user', required: true }] }),
        task('tonghop', U.LAN, { assignee: { kind: 'step_field', node: 'nhan', field: 'chuTri' } }),
        approval('xacnhan', { approvers: [{ kind: 'user', userId: U.CHAIRMAN }] }),
        END,
      ],
      edges: [edge('start', 'nhan'), edge('nhan', 'tonghop'), edge('tonghop', 'xacnhan'), edge('xacnhan', 'end', { outcome: 'approved' }), edge('xacnhan', 'nhan', { outcome: 'rejected' })],
    });
    expect(validate(def).errors).toEqual([]);
    const h = started(def);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.LAN } }, T('09:30'));
    expect(h.step('tonghop').assigneeId).toBe(U.LAN);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('tonghop').id }, T('10:00'));
    h.dispatch({ type: 'RejectStep', actor: asUser(U.CHAIRMAN), stepId: h.step('xacnhan').id, reason: 'chọn lại người' }, T('11:00'));
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.TUAN } }, T('12:00'));
    expect(h.step('tonghop')).toMatchObject({ attempt: 2, state: 'ready', assigneeId: U.TUAN });
    expect(JSON.stringify(h.replayed())).toBe(JSON.stringify(h.run));
  });

  it('người làm lần trước đã bị vô hiệu hoá: tính lại theo quy tắc vai trò thay vì kẹt ở "Cần giao người"', () => {
    const def = defOf({
      nodes: [START, task('lam', U.LAN, { assignee: { kind: 'role', role: 'employee' } }), approval('ok'), END],
      edges: [edge('start', 'lam'), edge('lam', 'ok'), edge('ok', 'end', { outcome: 'approved' }), edge('ok', 'lam', { outcome: 'rejected' })],
    });
    const h = started(def);
    expect(h.step('lam').assigneeId).toBe(U.LAN);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('lam').id }, T('10:00'));
    h.ctx = makeCtx({ users: withUsers(extraUser(U.LAN, 'employee', UNIT.SALES, U.HUY, 'disabled')) });
    h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('ok').id, reason: 'làm lại' }, T('11:00'));
    expect(h.step('lam')).toMatchObject({ attempt: 2, state: 'ready', assigneeId: U.NGOCANH });
  });
});

describe('engine-5: bước đóng góp giao cho mọi người giữ vai trò', () => {
  const ctx = makeCtx({ users: withUsers(extraUser(U.PHUONG, 'deputy', UNIT.BOARD, U.DIRECTOR)) });
  const nodes = (node: Record<string, unknown>) => defOf({ nodes: [START, node, END], edges: [edge('start', node['id'] as string), edge(node['id'] as string, 'end', { outcome: 'approved' })] });

  it('contribute + role deputy với hai Phó giám đốc: hai dòng gửi, xong khi cả hai gửi', () => {
    const h = started(nodes(contribute('gop', [{ kind: 'role', role: 'deputy' }])), ctx);
    expect(h.step('gop').approvals.map((a) => a.approverId)).toEqual([U.HUY, U.PHUONG]);
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: h.step('gop').id, result: { ketQua: 'a' } }, NOW);
    expect(h.step('gop').state).toBe('ready');
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.PHUONG), stepId: h.step('gop').id, result: { ketQua: 'b' } }, NOW);
    expect(h.run.state).toBe('completed');
  });

  it('nút duyệt thường với quy tắc role vẫn chỉ giao cho một người (id nhỏ nhất)', () => {
    const h = started(nodes(approval('duyet', { approvers: [{ kind: 'role', role: 'deputy' }] })), ctx);
    expect(h.step('duyet').approvals.map((a) => a.approverId)).toEqual([U.HUY]);
  });
});
