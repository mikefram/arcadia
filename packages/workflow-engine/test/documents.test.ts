import { type ProcessDefinition } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { appointedFor, canStartRun, simulate, validate } from '../src';
import { checkFormValues } from '../src/forms';
import { Harness, SYSTEM, asUser, errorCode } from './support/harness';
import { END, START, U, UNIT, defOf, edge, makeCtx, runInput, vn, withUsers, extraUser } from './support/world';

/**
 * Văn thư và chỉ thị (docs/DECISIONS.md, 06/10/2026): ô nhiều người, ô tệp, quy tắc `step_field`, nút duyệt kiêm đóng góp
 * có biểu mẫu, và ai được khởi chạy. Kịch bản "Chỉ thị": Chủ tịch ra chỉ thị, Giám đốc nhận và chọn người chủ trì cùng
 * những người phối hợp, họ gửi phần của mình, người chủ trì tổng hợp, Chủ tịch xác nhận.
 */

const NOW = vn('2026-10-06', '09:00');
const DUE = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } };

function directive(): ProcessDefinition {
  return defOf({
    inputs: [
      { key: 'noiDung', label: 'Nội dung chỉ thị', type: 'longtext', required: true },
      { key: 'tep', label: 'Tài liệu kèm theo', type: 'file', multiple: true },
      { key: 'soChiThi', label: 'Số chỉ thị', type: 'autonumber', register: 'CHITHI', required: true },
    ],
    nodes: [
      START,
      {
        id: 'nhan',
        type: 'task',
        label: 'Tiếp nhận và phân công',
        title: 'Tiếp nhận chỉ thị và phân công',
        assignee: { kind: 'role', role: 'director' },
        due: DUE,
        form: [
          { key: 'chuTri', label: 'Người chủ trì', type: 'user', required: true },
          { key: 'phoiHop', label: 'Người phối hợp', type: 'users' },
          { key: 'yKien', label: 'Ý kiến chỉ đạo', type: 'longtext' },
        ],
      },
      {
        id: 'thuchien',
        type: 'approval',
        label: 'Thực hiện chỉ thị',
        title: 'Gửi kết quả thực hiện',
        action: 'contribute',
        approvers: [
          { kind: 'step_field', node: 'nhan', field: 'chuTri' },
          { kind: 'step_field', node: 'nhan', field: 'phoiHop' },
        ],
        mode: 'all',
        due: DUE,
        form: [
          { key: 'ketQua', label: 'Kết quả thực hiện', type: 'longtext', required: true },
          { key: 'tep', label: 'Tệp kèm theo', type: 'file', multiple: true },
        ],
      },
      { id: 'tonghop', type: 'task', label: 'Tổng hợp báo cáo', title: 'Tổng hợp báo cáo', assignee: { kind: 'step_field', node: 'nhan', field: 'chuTri' }, due: DUE },
      { id: 'duyet', type: 'approval', label: 'Chủ tịch xác nhận', title: 'Xác nhận hoàn thành chỉ thị', approvers: [{ kind: 'user', userId: U.CHAIRMAN }], mode: 'any', due: DUE },
      END,
    ],
    edges: [
      edge('start', 'nhan'),
      edge('nhan', 'thuchien'),
      edge('thuchien', 'tonghop', { outcome: 'approved' }),
      edge('tonghop', 'duyet'),
      edge('duyet', 'end', { outcome: 'approved' }),
    ],
  });
}

const F1 = '01920000-0000-7000-8000-00000000f001';
const F2 = '01920000-0000-7000-8000-00000000f002';

function started(def = directive()) {
  const h = new Harness(def, makeCtx(), runInput(U.CHAIRMAN, { noiDung: 'Triển khai kế hoạch quý IV', soChiThi: '01/CT-VRG' }));
  h.dispatch({ type: 'StartRun', actor: asUser(U.CHAIRMAN) }, NOW);
  return h;
}

describe('chỉ thị: Giám đốc chọn người, các bước sau giao đúng những người đó', () => {
  it('Giám đốc nhận chỉ thị đầu tiên; chọn người chủ trì và hai người phối hợp thì bước thực hiện có ba dòng gửi', () => {
    const h = started();
    expect(h.step('nhan')).toMatchObject({ state: 'ready', assigneeId: U.DIRECTOR });
    h.dispatch(
      { type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY, phoiHop: [U.LAN, U.TUAN], yKien: 'Ưu tiên hạng mục hạ tầng' } },
      NOW,
    );
    const step = h.step('thuchien');
    expect(step.state).toBe('ready');
    expect(step.approvals.map((a) => a.approverId)).toEqual([U.HUY, U.LAN, U.TUAN]);
    expect(step.assigneeId).toBe(U.HUY);
    // Mỗi người trong ba người đều nhận thông báo có việc.
    for (const who of [U.HUY, U.LAN, U.TUAN]) expect(h.sent({ kind: 'notify.assigned', to: who, nodeId: 'thuchien' })).toHaveLength(1);
    expect(h.sent({ kind: 'notify.assigned', to: U.DIRECTOR, nodeId: 'thuchien' })).toHaveLength(0);
  });

  it('mỗi người gửi phần của mình; bước xong khi đủ ba người; kết quả gom ở result.responses theo từng người', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY, phoiHop: [U.LAN, U.TUAN] } }, NOW);
    const id = h.step('thuchien').id;

    h.dispatch({ type: 'ApproveStep', actor: asUser(U.LAN), stepId: id, result: { ketQua: 'Đã khảo sát xong 3 lô', tep: [F1] }, fileIds: [F1] }, NOW);
    expect(h.step('thuchien').state).toBe('ready');
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.TUAN), stepId: id, result: { ketQua: 'Đã kiểm tra hạ tầng điện' } }, NOW);
    expect(h.step('thuchien').state).toBe('ready');
    expect(h.step('thuchien').assigneeId).toBe(U.HUY); // còn lại người chủ trì
    h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUY), stepId: id, result: { ketQua: 'Tổng hợp phần của phòng' }, fileIds: [F2] }, NOW);

    const done = h.step('thuchien');
    expect(done.state).toBe('done');
    const responses = (done.result as { responses: { userId: string; result: Record<string, unknown>; fileIds: string[] }[] }).responses;
    expect(responses.map((r) => r.userId)).toEqual([U.HUY, U.LAN, U.TUAN]);
    expect(responses.find((r) => r.userId === U.LAN)).toMatchObject({ result: { ketQua: 'Đã khảo sát xong 3 lô' }, fileIds: [F1] });
    expect(responses.find((r) => r.userId === U.HUY)?.fileIds).toEqual([F2]);

    // Bước tổng hợp giao đúng cho người chủ trì, không phải người khác.
    expect(h.step('tonghop')).toMatchObject({ state: 'ready', assigneeId: U.HUY });
  });

  it('thiếu ô bắt buộc thì bị từ chối, chưa ai được ghi nhận; người không có trong danh sách không gửi được', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY, phoiHop: [U.LAN] } }, NOW);
    const id = h.step('thuchien').id;
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.LAN), stepId: id, result: {} }, NOW))).toBe('invalid_input');
    expect(h.step('thuchien').approvals.every((a) => a.decision === null)).toBe(true);
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: asUser(U.HUNG), stepId: id, result: { ketQua: 'x' } }, NOW))).toBe('not_allowed');
  });

  it('bước đóng góp không có "Chưa đồng ý"', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY } }, NOW);
    expect(errorCode(() => h.dispatch({ type: 'RejectStep', actor: asUser(U.HUY), stepId: h.step('thuchien').id, reason: 'không' }, NOW))).toBe('invalid_transition');
  });

  it('ô phối hợp để trống thì chỉ còn người chủ trì', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY } }, NOW);
    expect(h.step('thuchien').approvals.map((a) => a.approverId)).toEqual([U.HUY]);
  });

  it('người được chọn đang được ủy quyền thì người nhận ủy quyền gửi thay', () => {
    const h = new Harness(
      directive(),
      makeCtx({ delegations: [{ fromUserId: U.LAN, toUserId: U.HUNG, validFrom: vn('2026-10-01', '00:00').toISOString(), validTo: vn('2026-10-31', '23:00').toISOString(), scope: 'all', scopeRef: null }] }),
      runInput(U.CHAIRMAN, { noiDung: 'x', soChiThi: '02/CT-VRG' }),
    );
    h.dispatch({ type: 'StartRun', actor: asUser(U.CHAIRMAN) }, NOW);
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY, phoiHop: [U.LAN] } }, NOW);
    expect(h.step('thuchien').approvals).toMatchObject([{ approverId: U.HUY }, { approverId: U.HUNG, onBehalfOfId: U.LAN }]);
  });

  it('phát lại đúng từng bit, kể cả phần gửi của từng người', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY, phoiHop: [U.LAN, U.TUAN] } }, NOW);
    const id = h.step('thuchien').id;
    for (const who of [U.TUAN, U.LAN, U.HUY]) h.dispatch({ type: 'ApproveStep', actor: asUser(who), stepId: id, result: { ketQua: `phần của ${who.slice(-2)}` }, fileIds: [F1] }, NOW);
    expect(JSON.stringify(h.replayed())).toBe(JSON.stringify(h.run));
  });

  it('người được bổ nhiệm của bước đóng góp gồm cả những người đã được chọn', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY, phoiHop: [U.LAN] } }, NOW);
    const step = h.step('thuchien');
    const got = appointedFor(h.def, h.run, step, h.ctx, NOW);
    expect(got.userIds.sort()).toEqual([U.HUY, U.LAN].sort());
  });
});

describe('biểu mẫu: loại ô mới', () => {
  const fields = [
    { key: 'a', label: 'Nội dung', type: 'longtext', required: true },
    { key: 'b', label: 'Người', type: 'users' },
    { key: 'c', label: 'Tệp', type: 'file' },
    { key: 'd', label: 'Nhiều tệp', type: 'file', multiple: true },
    { key: 'e', label: 'Số', type: 'autonumber', register: 'VBDI', required: true },
  ] as const;

  it('chấp nhận giá trị đúng; ô cấp số không bao giờ bắt buộc nhập', () => {
    expect(checkFormValues(fields, { a: 'dòng 1\ndòng 2', b: [U.LAN], c: [F1], d: [F1, F2] })).toEqual([]);
  });

  it('sai hình dạng, quá nhiều tệp, quá dài đều bị báo đúng ô', () => {
    const errors = checkFormValues(fields, { a: 'x'.repeat(50_001), b: 'không phải danh sách', c: [F1, F2], d: ['không phải id'] });
    expect(errors).toEqual(
      expect.arrayContaining([
        { path: 'a', code: 'too_long' },
        { path: 'b', code: 'invalid_type' },
        { path: 'c', code: 'too_many' },
        { path: 'd', code: 'invalid_type' },
      ]),
    );
    expect(checkFormValues(fields, {})).toEqual([{ path: 'a', code: 'required' }]);
  });
});

describe('validate() cho ô cấp số, quy tắc step_field và tệp tổng hợp', () => {
  const check = (def: unknown) => validate(def as ProcessDefinition);
  const codes = (def: unknown) => check(def).errors.map((e) => e.code);

  it('chỉ thị mẫu hợp lệ', () => {
    expect(validate(directive()).errors).toEqual([]);
  });

  it('step_field trỏ tới bước không đứng trước, hoặc ô không phải kiểu chọn người, là lỗi gắn đúng bước', () => {
    const def = directive();
    const bad = (rule: unknown) => ({ ...def, nodes: def.nodes.map((n) => (n.id === 'tonghop' ? { ...n, assignee: rule } : n)) });
    expect(codes(bad({ kind: 'step_field', node: 'duyet', field: 'chuTri' }))).toContain('step_field_invalid');
    expect(codes(bad({ kind: 'step_field', node: 'nhan', field: 'yKien' }))).toContain('step_field_invalid');
    expect(codes(bad({ kind: 'step_field', node: 'nhan', field: 'khongCo' }))).toContain('step_field_invalid');
    expect(codes(bad({ kind: 'step_field', node: 'nhan', field: 'chuTri' }))).not.toContain('step_field_invalid');
    // Việc chỉ giao cho một người: ô nhiều người không dùng được ở nút task, nhưng dùng được ở nút đóng góp.
    expect(codes(bad({ kind: 'step_field', node: 'nhan', field: 'phoiHop' }))).toContain('step_field_invalid');
  });

  it('ô cấp số thiếu mã sổ bị chặn ở cả biểu mẫu khởi chạy lẫn biểu mẫu của bước', () => {
    const def = directive();
    const noRegister = { ...def, inputs: def.inputs.map((f) => (f.key === 'soChiThi' ? { key: f.key, label: f.label, type: f.type } : f)) };
    expect(codes(noRegister)).toContain('form_field_invalid');
  });

  it('bước đóng góp cần có biểu mẫu và không được nối đường "Chưa đồng ý"', () => {
    const def = directive();
    const noForm = { ...def, nodes: def.nodes.map((n) => (n.id === 'thuchien' ? { ...n, form: [] } : n)) };
    expect(check(noForm).errors.some((e) => e.nodeId === 'thuchien')).toBe(true);
    const withReject = { ...def, edges: [...def.edges, { id: 'x', from: 'thuchien', to: 'end', outcome: 'rejected' }] };
    expect(check(withReject).errors.some((e) => e.nodeId === 'thuchien')).toBe(true);
  });

  it('tệp tổng hợp: mục trỏ tới dữ liệu không có thì chặn, có thì cho qua', () => {
    const def = directive();
    const withCompile = (ref: string) => ({
      ...def,
      nodes: def.nodes.map((n) => (n.id === 'tonghop' ? { ...n, compile: { layout: 'report', title: 'Báo cáo', sections: [{ heading: 'Phần', ref }] } } : n)),
    });
    expect(check(withCompile('inputs.noiDung')).errors).toEqual([]);
    expect(check(withCompile('responses.thuchien.ketQua')).errors).toEqual([]);
    expect(check(withCompile('steps.nhan.yKien')).errors).toEqual([]);
    expect(codes(withCompile('inputs.khongCo'))).toContain('compile_invalid');
    expect(codes(withCompile('responses.duyet.ketQua'))).toContain('compile_invalid');
    expect(codes(withCompile('steps.thuchien.ketQua'))).not.toContain('compile_invalid');
  });
});

describe('simulate(): người nhận do bước trước chọn lúc chạy', () => {
  it('không báo thiếu người, và đánh dấu để giao diện ghi "chọn lúc chạy"', () => {
    const def = directive();
    const out = simulate({ def, inputs: { noiDung: 'x', soChiThi: '1' }, initiatorId: U.CHAIRMAN, ctx: makeCtx(), now: NOW });
    const row = out.rows.find((r) => r.nodeId === 'tonghop')!;
    expect(row).toMatchObject({ assigneeId: null, assigneeChosenLater: true });
    expect(out.warnings.some((w) => w.nodeId === 'tonghop' && w.code === 'assignee_missing')).toBe(false);
    expect(out.rows.find((r) => r.nodeId === 'nhan')).toMatchObject({ assigneeId: U.DIRECTOR });
  });

  it('việc góp nội dung được đánh dấu để giao diện không gọi nó là "Duyệt"; việc duyệt thường và việc làm không có dấu', () => {
    const out = simulate({ def: directive(), inputs: { noiDung: 'x', soChiThi: '1' }, initiatorId: U.CHAIRMAN, ctx: makeCtx(), now: NOW });
    expect(out.rows.find((r) => r.nodeId === 'thuchien')).toMatchObject({ kind: 'approval', action: 'contribute' });
    expect(out.rows.find((r) => r.nodeId === 'duyet')).toMatchObject({ kind: 'approval' }); // duyệt thường
    expect(out.rows.find((r) => r.nodeId === 'duyet')).not.toHaveProperty('action');
    expect(out.rows.find((r) => r.nodeId === 'nhan')).not.toHaveProperty('action');
  });
});

describe('canStartRun: ai được khởi chạy', () => {
  const withStarters = (starters: unknown) => ({ ...directive(), starters }) as ProcessDefinition;
  const ctx = makeCtx({ users: withUsers(extraUser(U.ADMIN2, 'office_admin', UNIT.OFFICE, U.DIRECTOR)) });

  it('không khai báo: người có quyền run.start (cách cũ)', () => {
    const def = directive();
    expect(canStartRun(def, U.ADMIN, ctx)).toBe(true);
    expect(canStartRun(def, U.CHAIRMAN, ctx)).toBe(true);
    expect(canStartRun(def, U.LAN, ctx)).toBe(false);
  });

  it('chỉ vai Chủ tịch: Văn phòng và Giám đốc không khởi chạy được', () => {
    const def = withStarters([{ kind: 'role', role: 'chairman' }]);
    expect(canStartRun(def, U.CHAIRMAN, ctx)).toBe(true);
    for (const who of [U.ADMIN, U.DIRECTOR, U.HUY, U.LAN]) expect(canStartRun(def, who, ctx), who).toBe(false);
  });

  it('mọi cán bộ, một đơn vị, một người, hoặc người có quyền', () => {
    expect(canStartRun(withStarters([{ kind: 'everyone' }]), U.LAN, ctx)).toBe(true);
    expect(canStartRun(withStarters([{ kind: 'unit', unitId: UNIT.SALES }]), U.LAN, ctx)).toBe(true);
    expect(canStartRun(withStarters([{ kind: 'unit', unitId: UNIT.SALES }]), U.TUAN, ctx)).toBe(false);
    expect(canStartRun(withStarters([{ kind: 'user', userId: U.TUAN }]), U.TUAN, ctx)).toBe(true);
    expect(canStartRun(withStarters([{ kind: 'permission' }, { kind: 'user', userId: U.LAN }]), U.ADMIN, ctx)).toBe(true);
    expect(canStartRun(withStarters([{ kind: 'permission' }, { kind: 'user', userId: U.LAN }]), U.LAN, ctx)).toBe(true);
    expect(canStartRun(withStarters([{ kind: 'permission' }]), U.LAN, ctx)).toBe(false);
  });

  it('người đã vô hiệu hoá hoặc không có trong danh bạ thì không khởi chạy được', () => {
    const users = withUsers(extraUser(U.DISABLED, 'employee', UNIT.TECH, U.HUY, 'disabled'));
    const def = withStarters([{ kind: 'everyone' }]);
    expect(canStartRun(def, U.DISABLED, makeCtx({ users }))).toBe(false);
    expect(canStartRun(def, U.GHOST, ctx)).toBe(false);
  });
});

describe('hệ thống không can thiệp vào phần gửi của người dùng', () => {
  it('sự kiện hệ thống không gửi thay được phần của ai', () => {
    const h = started();
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.DIRECTOR), stepId: h.step('nhan').id, result: { chuTri: U.HUY } }, NOW);
    expect(errorCode(() => h.dispatch({ type: 'ApproveStep', actor: SYSTEM, stepId: h.step('thuchien').id, result: { ketQua: 'x' } }, NOW))).toBe('not_allowed');
  });
});

describe('văn bản đi: người phối hợp chọn ngay lúc soạn', () => {
  function outgoing(): ProcessDefinition {
    return defOf({
      inputs: [
        { key: 'trichYeu', label: 'Trích yếu', type: 'text', required: true },
        { key: 'phoiHop', label: 'Đơn vị phối hợp', type: 'users', required: true },
      ],
      nodes: [
        START,
        {
          id: 'gop',
          type: 'approval',
          label: 'Góp nội dung',
          title: 'Góp nội dung vào dự thảo',
          action: 'contribute',
          approvers: [{ kind: 'form_field', field: 'phoiHop' }],
          mode: 'all',
          due: DUE,
          form: [{ key: 'noiDung', label: 'Nội dung phần của đơn vị', type: 'longtext', required: true }],
        },
        { id: 'tonghop', type: 'task', label: 'Tổng hợp', title: 'Tổng hợp dự thảo', assignee: { kind: 'initiator' }, due: DUE },
        END,
      ],
      edges: [edge('start', 'gop'), edge('gop', 'tonghop', { outcome: 'approved' }), edge('tonghop', 'end')],
    });
  }

  it('mỗi người ở ô nhiều người của biểu mẫu khởi chạy có một dòng gửi; xong đủ thì người soạn tổng hợp', () => {
    const h = new Harness(outgoing(), makeCtx(), runInput(U.HUNG, { trichYeu: 'Báo cáo quý', phoiHop: [U.LAN, U.TUAN, U.NGOCANH] }));
    h.dispatch({ type: 'StartRun', actor: asUser(U.HUNG) }, NOW);
    expect(h.step('gop').approvals.map((a) => a.approverId)).toEqual([U.LAN, U.TUAN, U.NGOCANH]);
    for (const who of [U.NGOCANH, U.LAN, U.TUAN]) h.dispatch({ type: 'ApproveStep', actor: asUser(who), stepId: h.step('gop').id, result: { noiDung: `Phần của ${who.slice(-1)}` } }, NOW);
    expect(h.step('tonghop')).toMatchObject({ state: 'ready', assigneeId: U.HUNG });
  });

  it('validate: ô nhiều người dùng được ở nút đóng góp, không dùng được ở nút task', () => {
    const def = outgoing();
    expect(validate(def).errors).toEqual([]);
    const asTask = { ...def, nodes: def.nodes.map((n) => (n.id === 'tonghop' ? { ...n, assignee: { kind: 'form_field', field: 'phoiHop' } } : n)) } as unknown as ProcessDefinition;
    expect(validate(asTask).errors.map((e) => e.code)).toContain('form_field_unknown');
  });
});

