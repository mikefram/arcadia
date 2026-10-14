import { VALIDATION_CODES, type DefinitionIssue, type DraftDefinition } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { validate } from '../src';
import { edge, END, GOLDEN_DEF, START, task, U, vn } from './support/world';

/**
 * validate(): bảy điều ở SPEC 4.2. Sáu điều chặn xuất bản, điều 7 chỉ cảnh báo.
 * Mỗi điều có ít nhất một định nghĩa đúng và một định nghĩa sai.
 */

type Loose = Record<string, unknown>;
const draft = (nodes: Loose[], edges: Loose[], extra: Loose = {}): DraftDefinition =>
  ({ schemaVersion: 1, name: 'Quy trình thử', inputs: [], nodes, edges, ...extra }) as unknown as DraftDefinition;

const codes = (issues: DefinitionIssue[]): string[] => issues.map((i) => i.code);
const approval = (id: string, extra: Loose = {}): Loose => ({
  id,
  type: 'approval',
  label: `Duyệt ${id}`,
  title: `Duyệt ${id}`,
  approvers: [{ kind: 'user', userId: U.HUY }],
  mode: 'any',
  due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } },
  ...extra,
});
const condition = (id: string, branchIds: string[]): Loose => ({
  id,
  type: 'condition',
  label: `Rẽ ${id}`,
  branches: branchIds.map((b) => ({ id: b, when: { op: 'eq', left: { value: 1 }, right: { value: 1 } } })),
});

/** Quy trình đúng dùng làm gốc: start → a → b → end. */
const OK_NODES = [START, task('a', U.LAN), task('b', U.HUNG), END];
const OK_EDGES = [edge('start', 'a'), edge('a', 'b'), edge('b', 'end')];

describe('định nghĩa hợp lệ', () => {
  it('quy trình mẫu của kịch bản vàng: không lỗi, không cảnh báo, trả bản đã chuẩn hoá', () => {
    const r = validate(GOLDEN_DEF);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.definition).toEqual(GOLDEN_DEF);
  });

  it('quy trình tuyến tính tối giản', () => {
    const r = validate(draft(OK_NODES, OK_EDGES));
    expect(r.errors).toEqual([]);
    expect(r.definition?.nodes.map((n) => n.id)).toEqual(['start', 'a', 'b', 'end']);
  });

  it('bản đã chuẩn hoá bỏ các khoá lạ của trình thiết kế', () => {
    const r = validate(draft([{ ...START, selected: true }, { ...task('a', U.LAN), uiColor: 'red' }, END], [edge('start', 'a'), edge('a', 'end')]));
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r.definition)).not.toContain('uiColor');
  });

  it('có lỗi thì definition là null', () => {
    expect(validate(draft([START, task('a', U.LAN)], [edge('start', 'a')])).definition).toBeNull();
  });
});

describe('điều 1: đúng một nút bắt đầu và ít nhất một nút kết thúc', () => {
  it('đúng: một bắt đầu, hai kết thúc', () => {
    const r = validate(draft([START, task('a', U.LAN), task('b', U.HUNG), END, { id: 'end2', type: 'end', label: 'Kết thúc 2' }], [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end2')]));
    expect(r.errors).toEqual([]);
  });

  it('sai: không có nút bắt đầu', () => {
    const r = validate(draft([task('a', U.LAN), END], [edge('a', 'end')]));
    expect(codes(r.errors)).toContain(VALIDATION_CODES.startCount);
  });

  it('sai: hai nút bắt đầu', () => {
    const r = validate(draft([START, { id: 'start2', type: 'start', label: 'Bắt đầu 2' }, task('a', U.LAN), END], [edge('start', 'a'), edge('start2', 'a'), edge('a', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.startCount, nodeId: 'start2' }]);
  });

  it('sai: không có nút kết thúc', () => {
    const r = validate(draft([START, task('a', U.LAN)], [edge('start', 'a')]));
    expect(codes(r.errors)).toEqual([VALIDATION_CODES.endMissing]);
  });
});

describe('điều 2: mọi nút đến được từ bắt đầu và đi tới được một kết thúc', () => {
  it('đúng: nhánh song song đều nối đủ hai đầu', () => {
    const r = validate(draft([START, task('a', U.LAN), task('b', U.HUNG), END], [edge('start', 'a'), edge('start', 'b'), edge('a', 'end'), edge('b', 'end')]));
    expect(r.errors).toEqual([]);
  });

  it('sai: nút không nối từ bắt đầu', () => {
    const r = validate(draft([...OK_NODES, task('lost', U.TUAN)], [...OK_EDGES, edge('lost', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.unreachable, nodeId: 'lost' }]);
    expect(r.errors[0]?.message).toContain('Việc lost');
  });

  it('sai: nút không đi tới được kết thúc', () => {
    const r = validate(draft([...OK_NODES, task('stuck', U.TUAN)], [...OK_EDGES, edge('a', 'stuck')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.deadEnd, nodeId: 'stuck' }]);
  });

  it('sai: cạnh trỏ tới nút không tồn tại', () => {
    const r = validate(draft(OK_NODES, [...OK_EDGES, edge('a', 'ghost')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.edgeUnknownNode, edgeId: 'a>ghost' }]);
  });
});

describe('điều 3: bỏ các cạnh rejected thì không còn chu trình', () => {
  it('đúng: quay lại bước trước bằng cạnh rejected của nút duyệt', () => {
    const r = validate(
      draft(
        [START, task('a', U.LAN), approval('ok'), END],
        [edge('start', 'a'), edge('a', 'ok'), edge('ok', 'end', { outcome: 'approved' }), edge('ok', 'a', { outcome: 'rejected' })],
      ),
    );
    expect(r.errors).toEqual([]);
  });

  it('sai: chu trình qua cạnh thường', () => {
    const r = validate(draft(OK_NODES, [...OK_EDGES, edge('b', 'a')]));
    expect(codes(r.errors)).toEqual([VALIDATION_CODES.cycle]);
    expect(r.errors[0]).toMatchObject({ edgeId: 'b>a', nodeId: 'a' });
  });

  it('sai: chu trình qua cạnh approved', () => {
    const r = validate(
      draft([START, task('a', U.LAN), approval('ok'), END], [edge('start', 'a'), edge('a', 'ok'), edge('ok', 'a', { outcome: 'approved' }), edge('ok', 'end', { outcome: 'approved' })]),
    );
    expect(codes(r.errors)).toEqual([VALIDATION_CODES.cycle]);
  });

  it('sai: nút nối vào chính nó', () => {
    const r = validate(draft(OK_NODES, [...OK_EDGES, edge('a', 'a')]));
    expect(codes(r.errors)).toContain(VALIDATION_CODES.cycle);
  });

  it('sai: hai cạnh rejected nối thành vòng mà không cạnh nào quay về bước đứng trước', () => {
    // ok1 --rejected--> x → ok2 --rejected--> a → ok1: vòng chỉ khép kín nhờ hai cạnh rejected nối đuôi nhau
    const r = validate(
      draft(
        [START, task('a', U.LAN), approval('ok1'), task('x', U.TUAN), approval('ok2'), END],
        [
          edge('start', 'a'),
          edge('a', 'ok1'),
          edge('ok1', 'end', { outcome: 'approved' }),
          edge('ok1', 'x', { outcome: 'rejected' }),
          edge('x', 'ok2'),
          edge('ok2', 'end', { outcome: 'approved' }),
          edge('ok2', 'a', { outcome: 'rejected' }),
        ],
      ),
    );
    expect(codes(r.errors)).toContain(VALIDATION_CODES.cycle);
  });
});

describe('điều 4: mọi condition có cạnh else, mọi approval có cạnh approved', () => {
  it('đúng: condition có else, approval có approved và rejected dẫn tới kết thúc', () => {
    const r = validate(
      draft(
        [START, condition('if', ['x']), task('a', U.LAN), approval('ok'), END],
        [
          edge('start', 'if'),
          edge('if', 'a', { branch: 'x' }),
          edge('if', 'ok', { branch: 'else' }),
          edge('a', 'end'),
          edge('ok', 'end', { outcome: 'approved' }),
          edge('ok', 'end', { outcome: 'rejected' }),
        ],
      ),
    );
    expect(r.errors).toEqual([]);
  });

  it('sai: condition thiếu cạnh else', () => {
    const r = validate(draft([START, condition('if', ['x']), task('a', U.LAN), END], [edge('start', 'if'), edge('if', 'a', { branch: 'x' }), edge('a', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.conditionElse, nodeId: 'if' }]);
  });

  it('sai: approval chỉ có cạnh không ghi outcome', () => {
    const r = validate(draft([START, approval('ok'), END], [edge('start', 'ok'), edge('ok', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.approvalApproved, nodeId: 'ok' }]);
  });

  it('sai: approval chỉ có cạnh rejected', () => {
    const r = validate(draft([START, approval('ok'), END], [edge('start', 'ok'), edge('ok', 'end', { outcome: 'rejected' })]));
    expect(codes(r.errors)).toContain(VALIDATION_CODES.approvalApproved);
  });

  it('sai: nhánh khai báo mà không có cạnh, và cạnh gắn nhánh không tồn tại', () => {
    const r = validate(
      draft(
        [START, condition('if', ['x', 'y']), task('a', U.LAN), END],
        [edge('start', 'if'), edge('if', 'a', { branch: 'x' }), edge('if', 'end', { branch: 'else' }), edge('if', 'a', { branch: 'zzz' }), edge('a', 'end')],
      ),
    );
    expect(r.errors).toMatchObject([
      { code: VALIDATION_CODES.schema, nodeId: 'if' },
      { code: VALIDATION_CODES.schema, edgeId: 'if>a:zzz' },
    ]);
  });

  it('sai: nút duyệt vừa có cạnh rejected quay lại vừa có cạnh rejected đi tiếp', () => {
    const r = validate(
      draft(
        [START, task('a', U.LAN), approval('ok'), END],
        [edge('start', 'a'), edge('a', 'ok'), edge('ok', 'end', { outcome: 'approved' }), edge('ok', 'a', { outcome: 'rejected' }), edge('ok', 'end', { outcome: 'rejected' })],
      ),
    );
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.schema, nodeId: 'ok' }]);
  });

  it('sai: cạnh outcome đi ra từ nút không phải nút duyệt', () => {
    const r = validate(draft([START, task('a', U.LAN), END], [edge('start', 'a'), edge('a', 'end', { outcome: 'approved' })]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.schema, edgeId: 'a>end:approved' }]);
  });
});

describe('điều 5: mọi task và approval có người nhận và hạn', () => {
  const FORM_INPUTS = [{ key: 'owner', label: 'Người phụ trách', type: 'user', required: true }];

  it('đúng: nút nhận bằng form_field trỏ tới một ô chọn người của biểu mẫu khởi chạy', () => {
    const r = validate(draft([START, task('a', U.LAN, { assignee: { kind: 'form_field', field: 'owner' } }), END], [edge('start', 'a'), edge('a', 'end')], { inputs: FORM_INPUTS }));
    expect(r.errors).toEqual([]);
  });

  it('sai: task thiếu người nhận', () => {
    const { assignee: _assignee, ...noAssignee } = task('a', U.LAN);
    const r = validate(draft([START, noAssignee, END], [edge('start', 'a'), edge('a', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.assigneeMissing, nodeId: 'a' }]);
    expect(r.errors[0]?.message).toBe('Việc “Việc a” chưa chọn người nhận.');
  });

  it('sai: task thiếu hạn', () => {
    const { due: _due, ...noDue } = task('a', U.LAN);
    const r = validate(draft([START, noDue, END], [edge('start', 'a'), edge('a', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.dueMissing, nodeId: 'a' }]);
    expect(r.errors[0]?.message).toBe('Việc “Việc a” chưa đặt hạn.');
  });

  it('sai: approval không có người duyệt, và thiếu hạn', () => {
    const { due: _due, ...noDue } = approval('ok', { approvers: [] });
    const r = validate(draft([START, noDue, END], [edge('start', 'ok'), edge('ok', 'end', { outcome: 'approved' })]));
    expect(codes(r.errors).sort()).toEqual([VALIDATION_CODES.assigneeMissing, VALIDATION_CODES.dueMissing].sort());
    expect(r.errors.every((e) => e.nodeId === 'ok')).toBe(true);
  });

  it('sai: người nhận ghi sai dạng (userId không phải UUID)', () => {
    const r = validate(draft([START, task('a', 'U_LAN'), END], [edge('start', 'a'), edge('a', 'end')]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.assigneeMissing, nodeId: 'a' }]);
  });

  it('sai: form_field trỏ tới ô không có, hoặc ô không phải kiểu chọn người', () => {
    const node = task('a', U.LAN, { assignee: { kind: 'form_field', field: 'owner' } });
    const missing = validate(draft([START, node, END], [edge('start', 'a'), edge('a', 'end')]));
    expect(missing.errors).toMatchObject([{ code: VALIDATION_CODES.formFieldUnknown, nodeId: 'a' }]);
    const wrongType = validate(draft([START, node, END], [edge('start', 'a'), edge('a', 'end')], { inputs: [{ key: 'owner', label: 'Tên', type: 'text' }] }));
    expect(wrongType.errors).toMatchObject([{ code: VALIDATION_CODES.formFieldUnknown, nodeId: 'a' }]);
  });

  it('sai: hạn tính theo mốc đích mà quy trình không có ô ngày mốc, hoặc ô ngày mốc không hợp lệ', () => {
    const node = task('a', U.LAN, { due: { anchor: 'run_target', offset: { value: -3, unit: 'working_day' } } });
    const noTarget = validate(draft([START, node, END], [edge('start', 'a'), edge('a', 'end')]));
    expect(noTarget.errors).toMatchObject([{ code: VALIDATION_CODES.targetFieldInvalid, nodeId: 'a' }]);
    const notDate = validate(draft([START, node, END], [edge('start', 'a'), edge('a', 'end')], { inputs: [{ key: 'day', label: 'Ngày', type: 'text', required: true }], targetField: 'day' }));
    expect(codes(notDate.errors)).toEqual([VALIDATION_CODES.targetFieldInvalid]);
    const optional = validate(draft([START, node, END], [edge('start', 'a'), edge('a', 'end')], { inputs: [{ key: 'day', label: 'Ngày', type: 'date' }], targetField: 'day' }));
    expect(codes(optional.errors)).toEqual([VALIDATION_CODES.targetFieldInvalid]);
    const good = validate(draft([START, node, END], [edge('start', 'a'), edge('a', 'end')], { inputs: [{ key: 'day', label: 'Ngày', type: 'date', required: true }], targetField: 'day' }));
    expect(good.errors).toEqual([]);
  });
});

describe('điều 6: mọi join any có ít nhất hai cạnh đến', () => {
  it('đúng: nút join any có hai cạnh đến', () => {
    const r = validate(
      draft([START, task('a', U.LAN), task('b', U.HUNG), task('c', U.TUAN, { join: 'any' }), END], [edge('start', 'a'), edge('start', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'end')]),
    );
    expect(r.errors).toEqual([]);
  });

  it('sai: nút join any chỉ có một cạnh đến', () => {
    const r = validate(draft([START, task('a', U.LAN), task('b', U.HUNG, { join: 'any' }), END], OK_EDGES));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.joinAny, nodeId: 'b' }]);
  });

  it('sai: cạnh thứ hai chỉ là cạnh rejected quay lại, không tính là cạnh đến để hợp nhánh', () => {
    const r = validate(
      draft(
        [START, task('a', U.LAN, { join: 'any' }), approval('ok'), END],
        [edge('start', 'a'), edge('a', 'ok'), edge('ok', 'end', { outcome: 'approved' }), edge('ok', 'a', { outcome: 'rejected' })],
      ),
    );
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.joinAny, nodeId: 'a' }]);
  });
});

describe('điều 7 (chỉ cảnh báo): hạn sớm hơn việc đứng trước, hoặc chạy thử cho ra hạn đã qua', () => {
  const TARGET = { inputs: [{ key: 'day', label: 'Ngày diễn ra', type: 'date', required: true }], targetField: 'day' };
  const back = (value: number) => ({ due: { anchor: 'run_target', offset: { value, unit: 'working_day' } } });

  it('đúng: hạn việc sau muộn hơn hạn việc trước, không cảnh báo', () => {
    const r = validate(draft([START, task('a', U.LAN, back(-5)), task('b', U.HUNG, back(-3)), END], OK_EDGES, TARGET));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('cảnh báo: hạn của việc sau sớm hơn hạn của việc đứng trước nó; vẫn xuất bản được', () => {
    const r = validate(draft([START, task('a', U.LAN, back(-3)), task('b', U.HUNG, back(-5)), END], OK_EDGES, TARGET));
    expect(r.errors).toEqual([]);
    expect(r.definition).not.toBeNull();
    expect(r.warnings).toMatchObject([{ code: VALIDATION_CODES.dueBeforePredecessor, nodeId: 'b' }]);
    expect(r.warnings[0]?.message).toBe('Hạn của việc “Việc b” sớm hơn hạn của việc đứng trước nó là “Việc a”.');
  });

  it('cảnh báo: việc đứng trước nằm sau một nút hệ thống vẫn được so', () => {
    const r = validate(
      draft(
        [START, task('a', U.LAN, back(-2)), { id: 'tell', type: 'notify', label: 'Báo', to: [{ kind: 'initiator' }], template: 't' }, task('b', U.HUNG, back(-4)), END],
        [edge('start', 'a'), edge('a', 'tell'), edge('tell', 'b'), edge('b', 'end')],
        TARGET,
      ),
    );
    expect(r.warnings).toMatchObject([{ code: VALIDATION_CODES.dueBeforePredecessor, nodeId: 'b' }]);
  });

  it('cảnh báo: chạy thử với mốc đích mẫu (cách 10 ngày làm việc) cho ra hạn đã qua', () => {
    const r = validate(draft([START, task('a', U.LAN, back(-15)), task('b', U.HUNG, back(-2)), END], OK_EDGES, TARGET));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toMatchObject([{ code: VALIDATION_CODES.dueInPast, nodeId: 'a' }]);
    expect(r.warnings[0]?.message).toContain('10 ngày làm việc');
  });

  it('truyền now và lịch làm việc: kết quả tính theo lịch đó', () => {
    const def = draft([START, task('a', U.LAN, back(-10)), END], [edge('start', 'a'), edge('a', 'end')], TARGET);
    // mốc mẫu = now + 10 ngày làm việc; hạn = mốc − 10 ngày làm việc = hôm nay 17:00: chưa qua lúc 09:00
    expect(validate(def, { now: vn('2026-10-05', '09:00') }).warnings).toEqual([]);
    // lúc 18:00 thì hạn 17:00 hôm nay đã qua
    expect(codes(validate(def, { now: vn('2026-10-05', '18:00') }).warnings)).toEqual([VALIDATION_CODES.dueInPast]);
  });
});

describe('lỗi cấu trúc khác và câu chữ', () => {
  it('bản vẽ hỏng tới mức không đọc được', () => {
    const r = validate({ schemaVersion: 1 } as unknown as DraftDefinition);
    expect(codes(r.errors)).toEqual([VALIDATION_CODES.schema]);
    expect(r.definition).toBeNull();
  });

  it('mã nút trùng, mã cạnh trùng', () => {
    const r = validate(draft([...OK_NODES, task('a', U.TUAN)], [...OK_EDGES, edge('a', 'b')]));
    expect(codes(r.errors).sort()).toEqual([VALIDATION_CODES.duplicateId, VALIDATION_CODES.duplicateId]);
  });

  it('trường khác của nút sai: báo schema_invalid gắn với nút, nêu tên phần sai bằng tiếng Việt', () => {
    const { title: _title, ...noTitle } = task('a', U.LAN);
    const r = validate(draft([START, noTitle, { id: 'wait', type: 'timer', label: 'Chờ', wait: { value: 0, unit: 'hour' } }, END], [edge('start', 'a'), edge('a', 'wait'), edge('wait', 'end')]));
    expect(r.errors).toMatchObject([
      { code: VALIDATION_CODES.schema, nodeId: 'a' },
      { code: VALIDATION_CODES.schema, nodeId: 'wait' },
    ]);
    expect(r.errors[0]?.message).toContain('tên việc');
  });

  it('điều kiện rẽ nhánh tham chiếu ô không có trong biểu mẫu', () => {
    const cond = { id: 'if', type: 'condition', label: 'Rẽ', branches: [{ id: 'x', when: { op: 'gt', left: { ref: 'inputs.amount' }, right: { value: 1 } } }] };
    const edges = [edge('start', 'if'), edge('if', 'a', { branch: 'x' }), edge('if', 'end', { branch: 'else' }), edge('a', 'end')];
    expect(validate(draft([START, cond, task('a', U.LAN), END], edges)).errors).toMatchObject([{ code: VALIDATION_CODES.formFieldUnknown, nodeId: 'if' }]);
    expect(validate(draft([START, cond, task('a', U.LAN), END], edges, { inputs: [{ key: 'amount', label: 'Số tiền', type: 'money' }] })).errors).toEqual([]);
  });

  it('báo nhiều lỗi cùng lúc để người vẽ sửa một lượt', () => {
    const { assignee: _assignee, ...noAssignee } = task('a', U.LAN);
    const r = validate(draft([START, noAssignee, approval('ok'), task('lost', U.TUAN)], [edge('start', 'a'), edge('a', 'ok'), edge('ok', 'a')]));
    expect(new Set(codes(r.errors))).toEqual(
      new Set([
        VALIDATION_CODES.assigneeMissing,
        VALIDATION_CODES.endMissing,
        VALIDATION_CODES.unreachable,
        VALIDATION_CODES.cycle,
        VALIDATION_CODES.approvalApproved,
      ]),
    );
  });

  it('câu báo lỗi là tiếng Việt cho người vẽ: không dùng "task", "deadline" hay từ vay mượn', () => {
    const { assignee: _a, due: _d, ...bare } = task('a', U.LAN);
    const samples = [
      validate(draft([task('x', U.LAN)], [])),
      validate(draft([START, bare, approval('ok', { approvers: [] }), condition('if', ['p']), task('lost', U.TUAN, { join: 'any' }), END], [edge('start', 'a'), edge('a', 'ok'), edge('ok', 'if'), edge('if', 'a', { branch: 'p' }), edge('lost', 'nowhere')])),
      validate(draft([START, task('a', U.LAN, { due: { anchor: 'run_target', offset: { value: -30, unit: 'working_day' } } }), task('b', U.HUNG, { due: { anchor: 'run_target', offset: { value: -40, unit: 'working_day' } } }), END], OK_EDGES, { inputs: [{ key: 'day', label: 'Ngày', type: 'date', required: true }], targetField: 'day' })),
    ];
    const messages = samples.flatMap((r) => [...r.errors, ...r.warnings]).map((i) => i.message);
    expect(messages.length).toBeGreaterThan(10);
    for (const m of messages) {
      expect(m).not.toMatch(/task|deadline|dashboard|notification|submit|node|edge|approval|assignee/i);
      expect(m).toMatch(/[àáạảãâăèéẹẻẽêìíịỉĩòóọỏõôơùúụủũưỳýỵỷỹđ]/i);
      expect(m.trim().endsWith('.')).toBe(true);
    }
  });
});

describe('đường "Chưa đồng ý" quay lại không được tính là đường tới (engine-1, engine-4)', () => {
  const nodes = [START, task('draft', U.LAN), approval('appr'), task('fix', U.HUNG), END];
  const edges = [edge('start', 'draft'), edge('draft', 'appr'), edge('appr', 'end', { outcome: 'approved' }), edge('appr', 'fix', { outcome: 'rejected' }), edge('fix', 'appr')];

  it('bước sửa chỉ tới được qua cạnh quay lại bị chặn bằng mã riêng, không lẫn với "chưa nối từ Bắt đầu"', () => {
    const r = validate(draft(nodes, edges));
    expect(r.definition).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: VALIDATION_CODES.onlyViaReturn, nodeId: 'fix' });
    expect(r.errors[0]?.message).toContain('Chưa đồng ý');
    // Bước thật sự không nối ở đâu vẫn báo mã cũ.
    expect(codes(validate(draft([...nodes, task('lost', U.TUAN)], [...edges, edge('lost', 'end')])).errors)).toContain(VALIDATION_CODES.unreachable);
  });

  it('nối đường "Chưa đồng ý" về bước đã nằm trên đường chính thì hợp lệ', () => {
    const ok = validate(draft([START, task('draft', U.LAN), approval('appr'), END], [edge('start', 'draft'), edge('draft', 'appr'), edge('appr', 'end', { outcome: 'approved' }), edge('appr', 'draft', { outcome: 'rejected' })]));
    expect(ok.errors).toEqual([]);
  });

  it('step_field và tệp tổng hợp không được trỏ tới bước đứng SAU dù nó nằm trong cùng vòng làm lại', () => {
    const form = [{ key: 'ai', label: 'Người', type: 'user' }];
    const loop = (assignee: unknown, compile?: unknown) =>
      draft(
        [START, task('a', U.LAN, { assignee, ...(compile ? { compile } : {}) }), approval('duyet', { form }), END],
        [edge('start', 'a'), edge('a', 'duyet'), edge('duyet', 'end', { outcome: 'approved' }), edge('duyet', 'a', { outcome: 'rejected' })],
      );
    expect(codes(validate(loop({ kind: 'step_field', node: 'duyet', field: 'ai' })).errors)).toContain(VALIDATION_CODES.stepFieldInvalid);
    const sec = (ref: string) => ({ layout: 'report', title: 'Báo cáo', sections: [{ heading: 'Phần', ref }] });
    expect(codes(validate(loop({ kind: 'user', userId: U.LAN }, sec('steps.duyet.ai'))).errors)).toContain(VALIDATION_CODES.compileInvalid);
  });
});

describe('cờ finalApproval: nút duyệt cuối (quyết định 07/10/2026, điểm c)', () => {
  const final = (id: string): Loose => approval(id, { finalApproval: true });
  const lastOf = (r: ReturnType<typeof validate>): string[] => codes(r.errors).filter((c) => c === VALIDATION_CODES.finalApprovalNotLast);

  it('đường thẳng: còn nút duyệt khác phía sau thì chặn, lỗi gắn đúng nút có cờ', () => {
    const r = validate(draft([START, final('chutich'), approval('khac'), END], [edge('start', 'chutich'), edge('chutich', 'khac', { outcome: 'approved' }), edge('khac', 'end', { outcome: 'approved' })]));
    expect(r.errors).toMatchObject([{ code: VALIDATION_CODES.finalApprovalNotLast, nodeId: 'chutich' }]);
    expect(r.errors[0]?.message).toContain('Duyệt khac');
  });

  it('đường thẳng: nút duyệt cuối đứng sau cùng, hoặc chỉ có nút việc (task) phía sau, thì hợp lệ', () => {
    const edges = [edge('start', 'khac'), edge('khac', 'chutich', { outcome: 'approved' }), edge('chutich', 'end', { outcome: 'approved' })];
    expect(validate(draft([START, approval('khac'), final('chutich'), END], edges)).errors).toEqual([]);
    const withTask = [edge('start', 'khac'), edge('khac', 'chutich', { outcome: 'approved' }), edge('chutich', 'phat', { outcome: 'approved' }), edge('phat', 'end')];
    expect(validate(draft([START, approval('khac'), final('chutich'), task('phat', U.LAN), END], withTask)).errors).toEqual([]);
  });

  it('nhánh condition: nút duyệt ở một nhánh phía sau cũng bị chặn; nhánh khác không liên quan thì không', () => {
    const nodes = (extra: Loose[]) => [START, final('chutich'), condition('if', ['p']), ...extra, END];
    const base = [edge('start', 'chutich'), edge('chutich', 'if', { outcome: 'approved' }), edge('if', 'khac', { branch: 'p' }), edge('if', 'end', { branch: 'else' }), edge('khac', 'end', { outcome: 'approved' })];
    expect(lastOf(validate(draft(nodes([approval('khac')]), base)))).toHaveLength(1);
    // Nút duyệt khác nằm ở nhánh song song, không đứng sau nút duyệt cuối.
    const parallel = [START, condition('if', ['p']), final('chutich'), approval('khac'), END];
    const e = [edge('start', 'if'), edge('if', 'chutich', { branch: 'p' }), edge('if', 'khac', { branch: 'else' }), edge('chutich', 'end', { outcome: 'approved' }), edge('khac', 'end', { outcome: 'approved' })];
    expect(lastOf(validate(draft(parallel, e)))).toHaveLength(0);
  });

  it('vòng "Chưa đồng ý" quay lại, hoặc đường "Chưa đồng ý" đi sang nút duyệt khác, không bị tính là phía sau', () => {
    const loop = draft(
      [START, task('soan', U.LAN), approval('khac'), final('chutich'), END],
      [edge('start', 'soan'), edge('soan', 'khac'), edge('khac', 'chutich', { outcome: 'approved' }), edge('khac', 'soan', { outcome: 'rejected' }), edge('chutich', 'end', { outcome: 'approved' }), edge('chutich', 'soan', { outcome: 'rejected' })],
    );
    expect(validate(loop).errors).toEqual([]);
    const toOther = draft(
      [START, final('chutich'), approval('xemlai'), END],
      [edge('start', 'chutich'), edge('chutich', 'end', { outcome: 'approved' }), edge('chutich', 'xemlai', { outcome: 'rejected' }), edge('xemlai', 'end', { outcome: 'approved' })],
    );
    expect(lastOf(validate(toOther))).toHaveLength(0);
  });

  it('nút duyệt kiểu góp nội dung phía sau cũng là nút duyệt khác', () => {
    const contribute = approval('gop', { action: 'contribute', mode: 'all', form: [{ key: 'k', label: 'Nội dung', type: 'longtext' }] });
    const r = validate(draft([START, final('chutich'), contribute, END], [edge('start', 'chutich'), edge('chutich', 'gop', { outcome: 'approved' }), edge('gop', 'end', { outcome: 'approved' })]));
    expect(lastOf(r)).toHaveLength(1);
  });
});
