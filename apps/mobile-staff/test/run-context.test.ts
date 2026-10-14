import type { FormField, RunDetail, StepParticipant, StepView } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { buildRunContext, myPartRows, peopleOfRun, valueRows } from '../src/features/run-context';
import { awaitingOthers, giverOf, stepChips } from '../src/features/steps';

const CHU_TICH = { id: '0199d000-0000-7000-8000-000000000010', fullName: 'Trần Quốc Bảo', givenName: 'Bảo', honorific: 'ong' as const };
const GIAM_DOC = { id: '0199d000-0000-7000-8000-000000000011', fullName: 'Lê Minh Châu', givenName: 'Châu', honorific: 'ba' as const };
const PHUOC = { id: '0199d000-0000-7000-8000-000000000012', fullName: 'Nguyễn Hữu Phước', givenName: 'Phước', honorific: 'ong' as const };
const LAN = { id: '0199d000-0000-7000-8000-000000000013', fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi' as const };

const RUN = '0199e000-0000-7000-8000-00000000aaaa';
const NHAN = '0199e000-0000-7000-8000-0000000000a1';
const THUC_HIEN = '0199e000-0000-7000-8000-0000000000a2';
const TONG_HOP = '0199e000-0000-7000-8000-0000000000a3';

const inputForm: FormField[] = [
  { key: 'soChiThi', label: 'Số chỉ thị', type: 'autonumber', register: 'CHITHI' },
  { key: 'tieuDe', label: 'Tiêu đề chỉ thị', type: 'text', required: true },
  { key: 'noiDung', label: 'Nội dung chỉ thị', type: 'longtext', required: true },
  { key: 'mucKhan', label: 'Mức khẩn', type: 'select', required: true, options: [{ value: 'khan', label: 'Khẩn' }] },
  { key: 'hanHoanThanh', label: 'Hạn hoàn thành', type: 'date', required: true },
  { key: 'tep', label: 'Tài liệu kèm theo', type: 'file', multiple: true },
];
const nhanForm: FormField[] = [
  { key: 'yKien', label: 'Ý kiến chỉ đạo của Giám đốc', type: 'longtext', required: true },
  { key: 'chuTri', label: 'Người chủ trì thực hiện', type: 'user', required: true },
  { key: 'phoiHop', label: 'Người phối hợp', type: 'users' },
];
const thucHienForm: FormField[] = [
  { key: 'ketQua', label: 'Kết quả thực hiện phần việc của mình', type: 'longtext', required: true },
  { key: 'tep', label: 'Tài liệu minh chứng', type: 'file', multiple: true },
];

function step(over: Partial<StepView>): StepView {
  return {
    id: NHAN,
    runId: RUN,
    runTitle: 'Chỉ thị 03 về an toàn lao động',
    adhoc: false,
    nodeId: 'n',
    kind: 'task',
    title: 'Việc',
    description: null,
    state: 'done',
    bucket: 'done',
    isOverdue: false,
    lateWorkingDays: 0,
    dueAt: '2026-10-20T10:00:00Z',
    dueOriginalAt: '2026-10-20T10:00:00Z',
    assignee: null,
    assignedBy: CHU_TICH,
    onBehalfOf: null,
    blockedReason: null,
    pendingExtension: null,
    amountVnd: null,
    requiresStepUp: false,
    allowedActions: [],
    version: 1,
    checklist: [],
    form: [],
    result: null,
    reason: null,
    activatedAt: null,
    completedAt: null,
    unitName: null,
    lastNudgedAt: null,
    requestedBy: null,
    ...over,
  };
}

const part = (person: StepParticipant['person'], over: Partial<StepParticipant> = {}): StepParticipant => ({ person, onBehalfOf: null, decision: null, comment: null, decidedAt: null, result: null, fileIds: [], ...over });

function run(over: Partial<RunDetail> = {}): RunDetail {
  const nhan = step({ id: NHAN, kind: 'task', title: 'Tiếp nhận chỉ thị, cho ý kiến và phân công', assignee: GIAM_DOC, form: nhanForm, result: { yKien: 'Các đơn vị rà soát trước ngày 20.', chuTri: PHUOC.id, phoiHop: [LAN.id] } });
  const thucHien = step({
    id: THUC_HIEN,
    kind: 'approval',
    action: 'contribute',
    state: 'in_progress',
    bucket: 'upcoming',
    title: 'Thực hiện chỉ thị và gửi kết quả phần việc của mình',
    form: thucHienForm,
    requestedBy: GIAM_DOC,
    participants: [part(PHUOC, { decision: 'approved', comment: 'Đã xong phần của phòng An toàn.', result: { ketQua: 'Đã rà soát 12 xưởng.', tep: ['0199f000-0000-7000-8000-000000000001'] } }), part(LAN)],
  });
  const tongHop = step({ id: TONG_HOP, kind: 'task', state: 'pending', bucket: 'other', title: 'Tổng hợp báo cáo', form: [{ key: 'baoCao', label: 'Báo cáo tổng hợp', type: 'longtext', required: true }] });
  return {
    id: RUN,
    title: 'Chỉ thị 03 về an toàn lao động',
    templateId: '0199e000-0000-7000-8000-0000000000e1',
    templateName: 'Chỉ thị của Chủ tịch',
    templateVersion: 1,
    adhoc: false,
    state: 'running',
    outcome: null,
    targetAt: null,
    startedAt: '2026-10-14T02:00:00Z',
    completedAt: null,
    progress: { done: 1, total: 4 },
    schedule: { status: 'on_track', lateWorkingDays: 0 },
    initiator: CHU_TICH,
    version: 3,
    steps: [nhan, thucHien, tongHop],
    edges: [],
    inputs: { soChiThi: '03/CT-VRG', tieuDe: 'An toàn lao động mùa mưa bão', noiDung: 'Rà soát toàn bộ hệ thống xưởng.\nBáo cáo trước hạn.', mucKhan: 'khan', hanHoanThanh: '2026-10-20', tep: ['0199f000-0000-7000-8000-000000000002', '0199f000-0000-7000-8000-000000000003'] },
    inputForm,
    files: [],
    nodeStates: {},
    ...over,
  };
}

describe('thông tin của lượt: dữ liệu khởi chạy và kết quả các việc trước', () => {
  it('dữ liệu khởi chạy viết ra chữ đọc được: nhãn, ngày, lựa chọn; ô tệp chỉ nói số tệp', () => {
    const ctx = buildRunContext(run(), THUC_HIEN);
    expect(ctx.startedBy).toBe('ông Trần Quốc Bảo');
    expect(ctx.inputs.map((r) => [r.label, r.text])).toEqual([
      ['Số chỉ thị', '03/CT-VRG'],
      ['Tiêu đề chỉ thị', 'An toàn lao động mùa mưa bão'],
      ['Nội dung chỉ thị', 'Rà soát toàn bộ hệ thống xưởng.\nBáo cáo trước hạn.'],
      ['Mức khẩn', 'Khẩn'],
      ['Hạn hoàn thành', '20/10/2026'],
      ['Tài liệu kèm theo', '2 tệp'],
    ]);
  });

  it('kết quả việc đã xong: ô chọn người đọc ra tên (không lộ mã), ô chọn nhiều người nối tên; việc chưa xong và chính việc đang xem không có', () => {
    const ctx = buildRunContext(run(), THUC_HIEN);
    const nhan = ctx.previous.find((g) => g.key === NHAN);
    expect(nhan?.title).toBe('Tiếp nhận chỉ thị, cho ý kiến và phân công');
    expect(nhan?.rows.map((r) => [r.label, r.text])).toEqual([
      ['Ý kiến chỉ đạo của Giám đốc', 'Các đơn vị rà soát trước ngày 20.'],
      ['Người chủ trì thực hiện', 'ông Nguyễn Hữu Phước'],
      ['Người phối hợp', 'chị Nguyễn Thu Lan'],
    ]);
    // việc đang xem (THUC_HIEN, chưa xong) và việc chưa tới lượt (TONG_HOP) không nằm trong "kết quả các việc trước"
    expect(ctx.previous.map((g) => g.key)).toEqual([NHAN]);
  });

  it('người chưa tra được tên thì nói chung chung, không để lộ mã nội bộ', () => {
    const r = run();
    r.steps[0] = { ...r.steps[0]!, result: { yKien: 'ok', chuTri: '0199d000-0000-7000-8000-0000000000ff', phoiHop: ['0199d000-0000-7000-8000-0000000000fe'] } };
    const ctx = buildRunContext(r, THUC_HIEN);
    const text = ctx.previous[0]?.rows.map((x) => x.text).join(' | ') ?? '';
    expect(text).toContain('Người dùng khác');
    expect(text).not.toMatch(/0199d000/);
  });

  it('bước đóng góp đã xong: mỗi người một khối kèm ý kiến; người chưa gửi không có khối', () => {
    const r = run();
    r.steps[1] = { ...r.steps[1]!, state: 'done' };
    const ctx = buildRunContext(r, TONG_HOP);
    const parts = ctx.previous.filter((g) => g.key.startsWith(THUC_HIEN));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.title).toBe('Thực hiện chỉ thị và gửi kết quả phần việc của mình: phần của ông Nguyễn Hữu Phước');
    expect(parts[0]?.rows.map((x) => [x.label, x.text])).toEqual([
      ['Kết quả thực hiện phần việc của mình', 'Đã rà soát 12 xưởng.'],
      ['Tài liệu minh chứng', '1 tệp'],
      ['Ý kiến', 'Đã xong phần của phòng An toàn.'],
    ]);
  });

  it('phần của người khác bị máy chủ che (contentHidden): không sinh khối nội dung rỗng, phần của mình vẫn còn', () => {
    const r = run();
    const step = r.steps[1]!;
    const hidden = (step.participants ?? []).map((p) => (p.person.id === PHUOC.id ? p : { ...p, decision: 'approved' as const, result: null, comment: null, fileIds: [], contentHidden: true }));
    r.steps[1] = { ...step, state: 'done', participants: hidden };
    const parts = buildRunContext(r, TONG_HOP).previous.filter((g) => g.key.startsWith(THUC_HIEN));
    expect(parts.map((g) => g.key)).toEqual([`${step.id}:${PHUOC.id}`]);
  });

  it('lượt không có dữ liệu khởi chạy: chỉ còn người khởi chạy; ô trống bị bỏ', () => {
    const ctx = buildRunContext(run({ inputs: { tieuDe: '', tep: [] } }), THUC_HIEN);
    expect(ctx.inputs).toEqual([]);
    expect(ctx.startedBy).toBe('ông Trần Quốc Bảo');
    expect(valueRows(inputForm, null, { people: new Map() })).toEqual([]);
  });

  it('tên mọi người trong lượt gom từ người khởi chạy, người nhận, người đề nghị và người tham gia', () => {
    const people = peopleOfRun(run());
    expect([...people.keys()].sort()).toEqual([CHU_TICH.id, GIAM_DOC.id, PHUOC.id, LAN.id].sort());
  });
});

describe('bước đóng góp: phần của chính mình', () => {
  it('đã gửi thì có phần của mình để xem lại; chưa gửi thì không có; không biết mình là ai thì không có', () => {
    const contribute = run().steps[1]!;
    expect(myPartRows(contribute, PHUOC.id, { people: new Map() })?.map((r) => r.label)).toEqual(['Kết quả thực hiện phần việc của mình', 'Tài liệu minh chứng', 'Ý kiến']);
    expect(myPartRows(contribute, LAN.id, { people: new Map() })).toBeNull();
    expect(myPartRows(contribute, null, { people: new Map() })).toBeNull();
  });
});

describe('Việc của tôi: bước đóng góp', () => {
  const contribute = (): StepView => run().steps[1]!;

  it('thẻ nói "Cần gửi phần của bạn", không phải "Cần duyệt"; bước duyệt thường vẫn là "Cần duyệt"', () => {
    expect(stepChips({ ...contribute(), state: 'ready' }, { queued: false }).map((c) => c.label)).toEqual(['Cần gửi phần của bạn']);
    expect(stepChips(step({ kind: 'approval', action: 'approve', state: 'ready' }), { queued: false }).map((c) => c.label)).toEqual(['Cần duyệt']);
  });

  it('người giao: bước đóng góp lấy người đề nghị (người đứng ngay trước) gọi là "Người giao"; bước duyệt gọi là "Người đề nghị"; việc thường lấy người giao', () => {
    expect(giverOf(contribute())).toEqual({ person: GIAM_DOC, label: 'assignedBy' });
    expect(giverOf(step({ kind: 'approval', action: 'contribute', requestedBy: null, assignedBy: CHU_TICH }))).toEqual({ person: CHU_TICH, label: 'assignedBy' });
    expect(giverOf(step({ kind: 'approval', action: 'approve', requestedBy: LAN }))).toEqual({ person: LAN, label: 'requestedBy' });
    expect(giverOf(step({ kind: 'task', assignedBy: CHU_TICH, requestedBy: LAN }))).toEqual({ person: CHU_TICH, label: 'assignedBy' });
  });

  it('việc đã gửi phần của mình mà còn mở vì người khác chưa gửi: có ở danh sách "chờ người khác", sắp theo hạn', () => {
    const mine = (id: string, dueAt: string, decision: 'approved' | null, state: StepView['state'] = 'in_progress') =>
      step({ id, kind: 'approval', action: 'contribute', state, dueAt, participants: [part(PHUOC, { decision }), part(LAN)] });
    const later = mine('0199e000-0000-7000-8000-0000000000b2', '2026-10-25T10:00:00Z', 'approved');
    const sooner = mine('0199e000-0000-7000-8000-0000000000b3', '2026-10-22T10:00:00Z', 'approved');
    const notYet = mine('0199e000-0000-7000-8000-0000000000b4', '2026-10-21T10:00:00Z', null);
    const closed = mine('0199e000-0000-7000-8000-0000000000b5', '2026-10-20T10:00:00Z', 'approved', 'done');
    const task = step({ id: '0199e000-0000-7000-8000-0000000000b6', kind: 'task', state: 'in_progress' });
    expect(awaitingOthers([later, notYet, closed, sooner, task], PHUOC.id).map((s) => s.id)).toEqual([sooner.id, later.id]);
    expect(awaitingOthers([later], null)).toEqual([]);
    expect(awaitingOthers([later], LAN.id)).toEqual([]);
  });

  it('thẻ chờ người khác chỉ có chip "Chờ người khác gửi"', () => {
    expect(stepChips({ ...contribute(), state: 'in_progress' }, { queued: false, awaitingOthers: true }).map((c) => c.label)).toEqual(['Chờ người khác gửi']);
  });
});
