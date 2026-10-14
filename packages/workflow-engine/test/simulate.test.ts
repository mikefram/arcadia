import { VALIDATION_CODES, type DelegationRecord } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { simulate } from '../src';
import { asUser, Harness } from './support/harness';
import { defOf, due17, edge, END, GOLDEN_DEF, goldenRunInput, makeCtx, START, task, TEMPLATE, U, vn } from './support/world';

/** simulate(): bảng dự kiến "ai làm gì, hạn nào" trước khi khởi chạy. Thuần, không ghi gì (SPEC 4.5, 9.3). */

const GOLDEN_INPUTS = { delegation: 'Đoàn nhà đầu tư Nhật Bản', visitDate: '2026-10-15' };

describe('bản xem trước của kịch bản vàng', () => {
  it('đúng 6 việc, 6 người nhận, 6 hạn; không cảnh báo', () => {
    const r = simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.CHAIRMAN, ctx: makeCtx(), now: vn('2026-10-02', '09:00'), templateId: TEMPLATE });
    expect(r.targetAt).toBe('2026-10-14T17:00:00.000Z');
    expect(r.warnings).toEqual([]);
    expect(r.rows.map((row) => [row.nodeId, row.kind, row.assigneeId, row.dueAt, row.pastDue])).toEqual([
      ['s1', 'task', U.LAN, due17('2026-10-06'), false],
      ['s4', 'task', U.PHUONG, due17('2026-10-06'), false],
      ['s2', 'task', U.NGOCANH, due17('2026-10-08'), false],
      ['s3', 'task', U.TUAN, due17('2026-10-07'), false],
      ['s6', 'approval', U.HUY, due17('2026-10-07'), false],
      ['s5', 'task', U.HUNG, due17('2026-10-09'), false],
    ]);
    expect(r.rows.map((row) => row.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.rows[0]).toMatchObject({ title: 'Lập chương trình đón đoàn', onBehalfOfId: null });
  });

  it('khớp với lượt chạy thật: cùng người nhận và cùng hạn như engine tính khi chạy', () => {
    const now = vn('2026-10-02', '09:00');
    const preview = simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.ADMIN, ctx: makeCtx(), now, templateId: TEMPLATE });
    const h = new Harness(GOLDEN_DEF, makeCtx(), goldenRunInput(U.ADMIN));
    h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN) }, now);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step('s1').id }, vn('2026-10-05', '11:00'));
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.PHUONG), stepId: h.step('s4').id, result: { amount: 1 } }, vn('2026-10-05', '14:00'));
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.NGOCANH), stepId: h.step('s2').id }, vn('2026-10-07', '10:00'));
    for (const row of preview.rows) {
      expect(h.step(row.nodeId)).toMatchObject({ assigneeId: row.assigneeId, dueAt: row.dueAt });
    }
  });

  it('khởi chạy khi hạn đã qua: báo trước bằng cảnh báo, KHÔNG tự dịch hạn', () => {
    // Thứ Năm 08/10: hạn của s1, s4 (06/10) và s3, s6 (07/10) đã qua
    const r = simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.ADMIN, ctx: makeCtx(), now: vn('2026-10-08', '09:00') });
    expect(Object.fromEntries(r.rows.map((row) => [row.nodeId, [row.dueAt, row.pastDue]]))).toEqual({
      s1: [due17('2026-10-06'), true],
      s4: [due17('2026-10-06'), true],
      s3: [due17('2026-10-07'), true],
      s6: [due17('2026-10-07'), true],
      s2: [due17('2026-10-08'), false],
      s5: [due17('2026-10-09'), false],
    });
    expect(r.warnings.map((w) => [w.code, w.nodeId])).toEqual([
      [VALIDATION_CODES.dueInPast, 's1'],
      [VALIDATION_CODES.dueInPast, 's4'],
      [VALIDATION_CODES.dueInPast, 's3'],
      [VALIDATION_CODES.dueInPast, 's6'],
    ]);
    expect(r.warnings[0]?.message).toContain('Lập chương trình đón đoàn');
    expect(r.warnings[0]?.message).not.toMatch(/task|deadline/i);
  });

  it('thiếu ngày mốc: hạn để trống và có cảnh báo, không ném lỗi', () => {
    const r = simulate({ def: GOLDEN_DEF, inputs: { delegation: 'Đoàn A' }, initiatorId: U.ADMIN, ctx: makeCtx(), now: vn('2026-10-02', '09:00') });
    expect(r.targetAt).toBeNull();
    expect(r.rows).toHaveLength(6);
    expect(r.rows.every((row) => row.dueAt === null && !row.pastDue)).toBe(true);
    expect(new Set(r.warnings.map((w) => w.code))).toEqual(new Set([VALIDATION_CODES.dueMissing]));
  });

  it('không sửa định nghĩa, biểu mẫu hay danh bạ truyền vào', () => {
    const ctx = makeCtx();
    const frozen = JSON.stringify([GOLDEN_DEF, GOLDEN_INPUTS, ctx]);
    simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.ADMIN, ctx, now: vn('2026-10-02', '09:00') });
    expect(JSON.stringify([GOLDEN_DEF, GOLDEN_INPUTS, ctx])).toBe(frozen);
  });
});

describe('người nhận trong bản xem trước', () => {
  it('assigneeOverrides ưu tiên hơn quy tắc của nút', () => {
    const r = simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.ADMIN, ctx: makeCtx(), now: vn('2026-10-02', '09:00'), assigneeOverrides: { s3: U.HUNG } });
    expect(r.rows.find((row) => row.nodeId === 's3')?.assigneeId).toBe(U.HUNG);
    expect(r.rows.find((row) => row.nodeId === 's1')?.assigneeId).toBe(U.LAN);
  });

  it('ủy quyền xét tại lúc việc dự kiến tới lượt', () => {
    // Ngọc Anh ủy quyền cho Lan2 từ 06/10: s2 dự kiến tới lượt khi s1 xong đúng hạn (06/10 17:00)
    const delegation: DelegationRecord = {
      fromUserId: U.NGOCANH,
      toUserId: U.LAN2,
      validFrom: vn('2026-10-06', '00:00').toISOString(),
      validTo: vn('2026-10-20', '00:00').toISOString(),
      scope: 'process',
      scopeRef: TEMPLATE,
    };
    const r = simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.ADMIN, ctx: makeCtx({ delegations: [delegation] }), now: vn('2026-10-02', '09:00'), templateId: TEMPLATE });
    expect(r.rows.find((row) => row.nodeId === 's2')).toMatchObject({ assigneeId: U.LAN2, onBehalfOfId: U.NGOCANH });
    // không truyền templateId thì ủy quyền theo mẫu không áp
    const noTemplate = simulate({ def: GOLDEN_DEF, inputs: GOLDEN_INPUTS, initiatorId: U.ADMIN, ctx: makeCtx({ delegations: [delegation] }), now: vn('2026-10-02', '09:00') });
    expect(noTemplate.rows.find((row) => row.nodeId === 's2')).toMatchObject({ assigneeId: U.NGOCANH, onBehalfOfId: null });
  });

  it('không xác định được người nhận: để trống và cảnh báo Văn phòng sẽ phải giao', () => {
    const def = defOf({ nodes: [START, task('a', U.GHOST), END], edges: [edge('start', 'a'), edge('a', 'end')] });
    const r = simulate({ def, inputs: {}, initiatorId: U.ADMIN, ctx: makeCtx(), now: vn('2026-10-05', '09:00') });
    expect(r.rows).toMatchObject([{ nodeId: 'a', assigneeId: null }]);
    expect(r.warnings).toMatchObject([{ code: VALIDATION_CODES.assigneeMissing, nodeId: 'a' }]);
  });
});

describe('lúc tới lượt dự kiến', () => {
  it('giả định mỗi việc xong đúng hạn: hạn tính từ lúc kích hoạt của việc sau nối tiếp hạn việc trước', () => {
    const def = defOf({
      nodes: [
        START,
        task('a', U.LAN), // +2 ngày làm việc
        { id: 'wait', type: 'timer', label: 'Chờ', wait: { value: 1, unit: 'working_day' } },
        task('b', U.HUNG, { due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } } }),
        task('c', U.TUAN, { due: { anchor: 'run_start', offset: { value: 1, unit: 'working_day' } } }),
        END,
      ],
      edges: [edge('start', 'a'), edge('a', 'wait'), edge('wait', 'b'), edge('b', 'c'), edge('c', 'end')],
    });
    const r = simulate({ def, inputs: {}, initiatorId: U.ADMIN, ctx: makeCtx(), now: vn('2026-10-05', '09:00') });
    expect(r.rows.map((row) => [row.nodeId, row.dueAt])).toEqual([
      ['a', due17('2026-10-07')], // Thứ Hai + 2
      ['b', due17('2026-10-09')], // a xong 07/10 17:00, chờ 1 ngày tới 08/10 17:00, + 1 ngày làm việc
      ['c', due17('2026-10-06')], // tính từ lúc khởi chạy: sớm hơn việc trước, nhưng chưa qua so với hiện tại
    ]);
    expect(r.rows.every((row) => !row.pastDue)).toBe(true);
  });

  it('rẽ nhánh theo biểu mẫu khởi chạy: chỉ liệt kê nhánh sẽ chạy; phụ thuộc kết quả việc trước thì liệt kê mọi nhánh', () => {
    const cond = (when: unknown) => ({ id: 'if', type: 'condition', label: 'Rẽ', branches: [{ id: 'big', when }] });
    const nodes = (when: unknown) => [START, task('ask', U.PHUONG), cond(when), task('boss', U.HUY), task('clerk', U.LAN2), END];
    const edges = [edge('start', 'ask'), edge('ask', 'if'), edge('if', 'boss', { branch: 'big' }), edge('if', 'clerk', { branch: 'else' }), edge('boss', 'end'), edge('clerk', 'end')];
    const inputs = [{ key: 'amount', label: 'Số tiền', type: 'money' }];
    const byInput = defOf({ nodes: nodes({ op: 'gt', left: { ref: 'inputs.amount' }, right: { value: 1_000_000 } }), edges, inputs });
    const ids = (amount: number, def = byInput) =>
      simulate({ def, inputs: { amount }, initiatorId: U.ADMIN, ctx: makeCtx(), now: vn('2026-10-05', '09:00') }).rows.map((row) => row.nodeId);
    expect(ids(5_000_000)).toEqual(['ask', 'boss']);
    expect(ids(500)).toEqual(['ask', 'clerk']);
    const byStep = defOf({ nodes: nodes({ op: 'gt', left: { ref: 'steps.ask.result.amount' }, right: { value: 1_000_000 } }), edges, inputs });
    expect(ids(500, byStep)).toEqual(['ask', 'boss', 'clerk']);
  });
});
