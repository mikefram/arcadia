import type { FormField, NotificationView, StepDetail, StepHistoryItem, StepView } from '@mihato/domain';
import { color, contrastRatio, type ColorToken } from '@mihato/ui-tokens';
import { describe, expect, it } from 'vitest';
import { isDayOff, monthGrid, shiftMonth, workCalendarOf } from '../src/features/calendar';
import { historyLines, resultValueText } from '../src/features/history';
import { groupNotifications, notificationStepId, notificationTime } from '../src/features/notifications';
import { offlineText, rejectedReason } from '../src/features/queue-text';
import { buildResult, parseMoney, parseNumber, webOnlyRequired } from '../src/features/result-form';
import { dueText, groupTodo, minExtensionDate, personName, proposedDueAt, runLine, stepA11yLabel, stepChips, vnInstant } from '../src/features/steps';
import type { QueueItem } from '../src/offline/queue';
import { stepIdFromLink } from '../src/push/link';

const LAN = { id: '0199d000-0000-7000-8000-000000000001', fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi' as const };
const OFFICE = { id: '0199d000-0000-7000-8000-000000000002', fullName: 'Tài khoản văn phòng', givenName: 'Văn phòng', honorific: null };
const HUNG = { id: '0199d000-0000-7000-8000-000000000003', fullName: 'Võ Hoàng Hùng', givenName: 'Hùng', honorific: 'anh' as const };

/** 10:00 Thứ Năm 15/10/2026 giờ Việt Nam. */
const NOW = Date.parse('2026-10-15T03:00:00Z');

let seq = 0;
function step(over: Partial<StepView> = {}): StepView {
  seq += 1;
  return {
    id: `0199e000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    runId: '0199e000-0000-7000-8000-00000000aaaa',
    runTitle: 'Đón đoàn nhà đầu tư Nhật Bản',
    adhoc: false,
    nodeId: 's1',
    kind: 'task',
    title: 'Lập chương trình đón đoàn',
    description: null,
    state: 'ready',
    bucket: 'upcoming',
    isOverdue: false,
    lateWorkingDays: 0,
    dueAt: '2026-10-20T10:00:00Z',
    dueOriginalAt: '2026-10-20T10:00:00Z',
    assignee: LAN,
    assignedBy: OFFICE,
    onBehalfOf: null,
    blockedReason: null,
    pendingExtension: null,
    amountVnd: null,
    requiresStepUp: false,
    allowedActions: ['accept', 'complete', 'requestExtension', 'block'],
    version: 1,
    checklist: [],
    form: [],
    result: null,
    reason: null,
    activatedAt: '2026-10-01T02:00:00Z',
    completedAt: null,
    unitName: 'Kinh doanh',
    lastNudgedAt: null,
    requestedBy: null,
    ...over,
  };
}

describe('S1: nhóm việc và chữ trên thẻ', () => {
  it('chia nhóm theo bucket của máy chủ, đúng thứ tự Quá hạn, Hôm nay, Sắp tới; trong nhóm sắp theo hạn, việc chưa có hạn xuống cuối', () => {
    const a = step({ bucket: 'upcoming', dueAt: '2026-10-22T10:00:00Z' });
    const b = step({ bucket: 'overdue', isOverdue: true, lateWorkingDays: 2, dueAt: '2026-10-13T10:00:00Z' });
    const c = step({ bucket: 'today', dueAt: '2026-10-15T10:00:00Z' });
    const d = step({ bucket: 'upcoming', dueAt: null });
    const e = step({ bucket: 'upcoming', dueAt: '2026-10-16T10:00:00Z' });
    const f = step({ bucket: 'overdue', isOverdue: true, lateWorkingDays: 5, dueAt: '2026-10-08T10:00:00Z' });
    const done = step({ bucket: 'done', state: 'done' });
    const groups = groupTodo([a, b, c, d, e, f, done]);
    expect(groups.map((g) => g.title)).toEqual(['Quá hạn', 'Hôm nay', 'Sắp tới']);
    expect(groups.map((g) => g.steps.map((s) => s.id))).toEqual([[f.id, b.id], [c.id], [e.id, a.id, d.id]]);
  });

  it('nhóm trống thì không hiện', () => {
    expect(groupTodo([step({ bucket: 'today' })]).map((g) => g.bucket)).toEqual(['today']);
    expect(groupTodo([])).toEqual([]);
  });

  it('hạn viết theo giờ Việt Nam, 24 giờ: hôm nay, ngày mai, hoặc thứ và ngày đủ', () => {
    expect(dueText('2026-10-15T10:00:00Z', NOW)).toBe('hôm nay, 17:00');
    expect(dueText('2026-10-16T01:30:00Z', NOW)).toBe('ngày mai, 08:30');
    expect(dueText('2026-10-20T10:00:00Z', NOW)).toBe('Thứ Ba 20/10/2026, 17:00');
    // 23:30 UTC ngày 14 là 06:30 ngày 15 ở Việt Nam
    expect(dueText('2026-10-14T23:30:00Z', NOW)).toBe('hôm nay, 06:30');
  });

  it('chip trạng thái luôn có chữ; quá hạn dùng tông riêng, xong có dấu tích, chờ gửi và chờ duyệt là tông chờ', () => {
    expect(stepChips(step({ state: 'ready' }), { queued: false })).toEqual([{ key: 'state', label: 'Mới giao', tone: 'neutral' }]);
    expect(stepChips(step({ state: 'in_progress', bucket: 'today' }), { queued: false }).map((c) => [c.label, c.tone])).toEqual([
      ['Đến hạn hôm nay', 'warn'],
      ['Đang làm', 'neutral'],
    ]);
    expect(stepChips(step({ isOverdue: true, lateWorkingDays: 2, bucket: 'overdue' }), { queued: true }).map((c) => [c.label, c.tone])).toEqual([
      ['Chờ gửi', 'waiting'],
      ['Quá hạn 2 ngày làm việc', 'late'],
      ['Mới giao', 'neutral'],
    ]);
    expect(stepChips(step({ isOverdue: true, lateWorkingDays: 0 }), { queued: false })[0]?.label).toBe('Vừa quá hạn');
    expect(stepChips(step({ state: 'done', bucket: 'done' }), { queued: false })).toEqual([{ key: 'state', label: 'Xong', tone: 'done' }]);
    expect(stepChips(step({ kind: 'approval', state: 'ready' }), { queued: false })[0]?.label).toBe('Cần duyệt');
    const waiting = stepChips(step({ pendingExtension: { id: step().id, proposedDueAt: '2026-10-25T10:00:00Z', reason: 'x' }, blockedReason: 'Thiếu thông tin' }), { queued: false });
    expect(waiting.map((c) => c.label)).toEqual(['Mới giao', 'Chờ duyệt', 'Đang vướng']);
  });

  it('chỉ thẻ quá hạn mới dùng tông đỏ nâu', () => {
    const tones = [step({ bucket: 'today' }), step({ state: 'done' }), step({ blockedReason: 'x' }), step({ kind: 'approval' })].flatMap((s) => stepChips(s, { queued: true }).map((c) => c.tone));
    expect(tones).not.toContain('late');
  });

  it('nhãn đọc cho trình đọc màn hình có tên việc, trạng thái và hạn', () => {
    expect(stepA11yLabel(step({ dueAt: '2026-10-15T10:00:00Z', bucket: 'today' }), NOW, false)).toBe('Lập chương trình đón đoàn. Đến hạn hôm nay, Mới giao. Hạn hôm nay, 17:00. Chạm để mở.');
  });

  it('tên người kèm xưng hô; tài khoản dùng chung không có xưng hô', () => {
    expect(personName(LAN)).toBe('chị Nguyễn Thu Lan');
    expect(personName(OFFICE)).toBe('Tài khoản văn phòng');
    expect(personName(null)).toBeNull();
  });
});

describe('S1/S2: việc giao riêng không thuộc quy trình nào', () => {
  it('việc trong quy trình hiện tên lượt; việc giao riêng hiện "Việc giao riêng" thay vì tên lượt trùng tên việc', () => {
    expect(runLine(step())).toBe('Lượt: Đón đoàn nhà đầu tư Nhật Bản');
    expect(runLine(step({ adhoc: true, runTitle: 'Gửi báo giá cho công ty Sakura' }))).toBe('Việc giao riêng');
  });
});

describe('S4: hạn mới đề nghị', () => {
  it('giữ giờ trong ngày của hạn hiện tại, đổi sang thời điểm UTC', () => {
    expect(vnInstant('2026-10-20', '17:00')).toBe('2026-10-20T10:00:00.000Z');
    expect(vnInstant('2026-10-20', '06:30')).toBe('2026-10-19T23:30:00.000Z');
    expect(proposedDueAt('2026-10-22', '2026-10-20T10:00:00Z')).toBe('2026-10-22T10:00:00.000Z');
    expect(proposedDueAt('2026-10-22', null)).toBe('2026-10-22T10:00:00.000Z');
    // Việc chưa có hạn: lấy giờ tan làm của tổ chức (me.calendar.workEnd)
    expect(proposedDueAt('2026-10-22', null, '16:30')).toBe('2026-10-22T09:30:00.000Z');
  });

  it('ngày nghỉ tính như engine: cuối tuần và ngày lễ là nghỉ, ngày làm bù thì vẫn làm', () => {
    const calendar = workCalendarOf({ workdays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00' }, [
      { day: '2026-10-20', name: 'Ngày thành lập công ty', kind: 'company' },
      { day: '2026-10-24', name: 'Làm bù', kind: 'makeup_workday' },
    ]);
    expect(isDayOff('2026-10-03', calendar)).toBe(true); // Thứ Bảy
    expect(isDayOff('2026-10-04', calendar)).toBe(true); // Chủ Nhật
    expect(isDayOff('2026-10-05', calendar)).toBe(false); // Thứ Hai
    expect(isDayOff('2026-10-20', calendar)).toBe(true); // ngày nghỉ của công ty, rơi vào Thứ Ba
    expect(isDayOff('2026-10-24', calendar)).toBe(false); // Thứ Bảy làm bù
    // Tổ chức làm cả Thứ Bảy
    expect(isDayOff('2026-10-03', workCalendarOf({ workdays: [1, 2, 3, 4, 5, 6], workStart: '08:00', workEnd: '17:00' }, []))).toBe(false);
    // Chưa tải được lịch: không làm mờ gì, máy chủ quyết định
    expect(isDayOff('2026-10-03', null)).toBe(false);
  });

  it('ngày sớm nhất: sau hạn hiện tại, và không trước hôm nay', () => {
    expect(minExtensionDate('2026-10-20T10:00:00Z', NOW)).toBe('2026-10-21');
    expect(minExtensionDate('2026-10-01T10:00:00Z', NOW)).toBe('2026-10-15');
    expect(minExtensionDate(null, NOW)).toBe('2026-10-15');
  });

  it('lưới ngày: tuần bắt đầu từ Thứ Hai; tháng 10/2026 bắt đầu vào Thứ Năm', () => {
    const weeks = monthGrid(2026, 10);
    expect(weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(weeks).toHaveLength(5);
    expect(weeks.at(-1)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null]);
    expect(monthGrid(2028, 2).flat().filter(Boolean)).toHaveLength(29);
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });
});

describe('S3: biểu mẫu kết quả', () => {
  const fields: FormField[] = [
    { key: 'amount', label: 'Số tiền đề nghị tạm ứng', type: 'money', required: true },
    { key: 'guests', label: 'Số khách', type: 'number' },
    { key: 'note', label: 'Ghi chú thêm', type: 'text' },
    { key: 'visit', label: 'Ngày đón', type: 'date' },
    { key: 'car', label: 'Loại xe', type: 'select', options: [{ value: 'bus', label: 'Xe 29 chỗ' }] },
  ];

  it('tiền là số nguyên đồng VND; nhận cách viết có dấu chấm ngăn nghìn', () => {
    expect(parseMoney('20.000.000')).toBe(20_000_000);
    expect(parseMoney('20 000 000')).toBe(20_000_000);
    expect(parseMoney('20tr')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseNumber('2,5')).toBe(2.5);
    expect(parseNumber('abc')).toBeNull();
  });

  it('ô bắt buộc còn trống thì báo thiếu; ô số sai thì báo sai; ô trống không gửi lên', () => {
    expect(buildResult(fields, {})).toEqual({ result: undefined, missing: ['amount'], invalid: [] });
    expect(buildResult(fields, { amount: 'hai mươi triệu' })).toEqual({ result: undefined, missing: [], invalid: ['amount'] });
    expect(buildResult(fields, { amount: '35.000.000', guests: '12', note: '  ', visit: '2026-10-20', car: 'bus' })).toEqual({
      result: { amount: 35_000_000, guests: 12, visit: '2026-10-20', car: 'bus' },
      missing: [],
      invalid: [],
    });
  });

  it('viết lại giá trị đã điền để đọc ở S2', () => {
    expect(resultValueText(fields[0]!, 20_000_000)).toBe('20.000.000 đồng');
    expect(resultValueText(fields[3]!, '2026-10-20')).toBe('20/10/2026');
    expect(resultValueText(fields[4]!, 'bus')).toBe('Xe 29 chỗ');
    expect(resultValueText(fields[1]!, undefined)).toBeNull();
  });
});

describe('S2: lịch sử việc dùng câu của vi.timeline', () => {
  const item = (over: Partial<StepHistoryItem>): StepHistoryItem => ({ at: '2026-10-01T02:00:00Z', type: 'event', code: 'AcceptStep', actor: LAN, actorType: 'user', text: null, data: {}, ...over });
  const NUDGE_ID = '0199f000-0000-7000-8000-000000000009';
  const detail: Pick<StepDetail, 'title' | 'runTitle' | 'history' | 'nudges'> = {
    title: 'Lập chương trình đón đoàn',
    runTitle: 'Đón đoàn nhà đầu tư Nhật Bản',
    nudges: [{ id: NUDGE_ID, message: 'Chị cho biết khi nào hoàn thành.', senderName: 'Văn phòng Chủ tịch', aiDisclosure: 'do Trợ lý AI soạn, theo chỉ đạo của Chủ tịch', sentAt: '2026-10-14T02:00:00Z', reply: 'need_time', repliedAt: '2026-10-14T03:00:00Z' }],
    history: [
      item({ code: 'step.activated', actor: null, actorType: 'system', data: { dueAt: '2026-10-08T10:00:00Z', assigneeId: LAN.id, onBehalfOfId: null, people: { [LAN.id]: LAN } } }),
      item({ code: 'AcceptStep' }),
      item({ type: 'reminder', code: 'overdue', actor: null, actorType: 'system', text: 'Đã quá hạn 1 ngày: Lập chương trình đón đoàn' }),
      item({ type: 'nudge', code: 'nudge', actor: null, actorType: 'ai', text: 'Chị cho biết khi nào hoàn thành.', data: { nudgeId: NUDGE_ID, aiDrafted: true } }),
      item({ type: 'nudge_reply', code: 'need_time', data: { nudgeId: NUDGE_ID } }),
      item({ code: 'RequestExtension', text: 'Chờ đoàn chốt số khách', data: { proposedDueAt: '2026-10-16T10:00:00Z' } }),
      item({ code: 'Reassign', actor: OFFICE, text: 'Chị Lan nghỉ phép', data: { toUserId: HUNG.id, people: { [HUNG.id]: HUNG } } }),
      item({ code: 'SuKienLa', data: {} }),
    ],
  };

  it('dựng một câu cho mỗi dòng; lời nhắc AI soạn có dòng ghi rõ', () => {
    const lines = historyLines(detail);
    expect(lines.map((l) => l.text)).toEqual([
      'Giao ‘Lập chương trình đón đoàn’ cho chị Nguyễn Thu Lan, hạn Thứ Năm 08/10/2026, 17:00',
      'chị Nguyễn Thu Lan đã nhận ‘Lập chương trình đón đoàn’',
      'Đã quá hạn 1 ngày: Lập chương trình đón đoàn',
      'Văn phòng Chủ tịch nhắc',
      'chị Nguyễn Thu Lan trả lời lời nhắc về ‘Lập chương trình đón đoàn’: cần thêm thời gian',
      'chị Nguyễn Thu Lan xin thêm thời gian cho ‘Lập chương trình đón đoàn’, đề nghị hạn mới Thứ Sáu 16/10/2026, 17:00',
      'Tài khoản văn phòng giao lại ‘Lập chương trình đón đoàn’ cho anh Võ Hoàng Hùng',
      'chị Nguyễn Thu Lan cập nhật ‘Lập chương trình đón đoàn’',
    ]);
    expect(lines[3]).toMatchObject({ quote: 'Chị cho biết khi nào hoàn thành.', aiNote: 'do Trợ lý AI soạn, theo chỉ đạo của Chủ tịch' });
    expect(lines[5]?.quote).toBe('Chờ đoàn chốt số khách');
    // Không dòng nào còn biến chưa điền.
    expect(lines.every((l) => !/[{}]/.test(l.text))).toBe(true);
  });

  it('câu giao việc nêu tên người nhận lấy từ data.people; làm thay và chưa có người nhận có câu riêng', () => {
    const one = (data: Record<string, unknown>, code = 'step.activated') => historyLines({ ...detail, history: [item({ code, actor: OFFICE, actorType: code === 'step.activated' ? 'system' : 'user', data })] })[0]?.text;
    const people = { [LAN.id]: LAN, [HUNG.id]: HUNG };
    expect(one({ assigneeId: HUNG.id, onBehalfOfId: null, dueAt: null, people })).toBe('Giao ‘Lập chương trình đón đoàn’ cho anh Võ Hoàng Hùng');
    expect(one({ assigneeId: HUNG.id, onBehalfOfId: LAN.id, dueAt: '2026-10-08T10:00:00Z', people })).toBe(
      'Giao ‘Lập chương trình đón đoàn’ cho anh Võ Hoàng Hùng, thay mặt chị Nguyễn Thu Lan, hạn Thứ Năm 08/10/2026, 17:00',
    );
    expect(one({ assigneeId: null, onBehalfOfId: null, dueAt: null, people: {} })).toBe('‘Lập chương trình đón đoàn’ đã tới lượt nhưng chưa có người nhận');
    expect(one({ toUserId: HUNG.id, people }, 'AssignStep')).toBe('Tài khoản văn phòng giao ‘Lập chương trình đón đoàn’ cho anh Võ Hoàng Hùng');
    // Bản lưu cũ chưa có `people`: không để lộ biến chưa điền, nói gọn.
    expect(one({ dueAt: '2026-10-08T10:00:00Z' })).toBe('Việc tới lượt, hạn Thứ Năm 08/10/2026, 17:00');
    expect(one({ toUserId: HUNG.id }, 'Reassign')).toBe('Tài khoản văn phòng đổi người nhận ‘Lập chương trình đón đoàn’');
  });
});

describe('S7: thông báo', () => {
  const STEP = '0199f000-0000-7000-8000-00000000000a';
  const n = (id: string, createdAt: string, over: Partial<NotificationView> = {}): NotificationView => ({ id, kind: 'assigned', title: 'Việc mới', body: '', payload: {}, runId: null, stepId: null, state: 'sent', createdAt, readAt: null, ...over });

  it('chia theo Hôm nay, Hôm qua, Trước đó theo ngày Việt Nam', () => {
    const groups = groupNotifications([n('a', '2026-10-15T01:00:00Z'), n('b', '2026-10-14T18:00:00Z'), n('c', '2026-10-14T10:00:00Z'), n('d', '2026-10-01T10:00:00Z')], NOW);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ['Hôm nay', ['a', 'b']],
      ['Hôm qua', ['c']],
      ['Trước đó', ['d']],
    ]);
    expect(notificationTime('2026-10-15T01:00:00Z', NOW)).toBe('08:00');
    expect(notificationTime('2026-10-01T10:00:00Z', NOW)).toBe('Thứ Năm 01/10/2026, 17:00');
  });

  it('chạm tin mở đúng việc: lấy stepId, hoặc liên kết sâu mihato://step/{id}', () => {
    expect(notificationStepId(n('a', '2026-10-15T01:00:00Z', { stepId: STEP }))).toBe(STEP);
    expect(notificationStepId(n('a', '2026-10-15T01:00:00Z', { payload: { link: `mihato://step/${STEP}` } }))).toBe(STEP);
    expect(notificationStepId(n('a', '2026-10-15T01:00:00Z', { payload: { link: 'mihato://run/abc' } }))).toBeNull();
    expect(stepIdFromLink(`mihato://step/${STEP}`)).toBe(STEP);
    expect(stepIdFromLink('mihato://step/../../etc/passwd')).toBeNull();
    expect(stepIdFromLink('https://vi-du.example/step/123')).toBeNull();
    expect(stepIdFromLink(undefined)).toBeNull();
  });
});

describe('ngoại tuyến: lý do bằng chữ khi máy chủ không nhận', () => {
  const item = (over: Partial<QueueItem>): QueueItem => ({
    eventId: '0199f000-0000-7000-8000-0000000000e1',
    stepId: '0199f000-0000-7000-8000-00000000000a',
    stepTitle: 'Lập chương trình đón đoàn',
    runTitle: 'Đón đoàn nhà đầu tư Nhật Bản',
    action: { kind: 'complete', note: 'Đã gửi' },
    createdAt: '2026-10-15T03:00:00Z',
    status: 'rejected',
    attempts: 1,
    lastErrorCode: 'state_conflict',
    conflictState: null,
    ...over,
  });

  it('nói rõ việc đã xong, lượt đã hủy, hay việc đã chuyển người', () => {
    expect(rejectedReason(item({ conflictState: 'done' }))).toBe('Việc ‘Lập chương trình đón đoàn’ đã xong từ trước.');
    expect(rejectedReason(item({ conflictState: 'cancelled' }))).toBe('Lượt ‘Đón đoàn nhà đầu tư Nhật Bản’ đã hủy nên thao tác không còn áp dụng.');
    expect(rejectedReason(item({ lastErrorCode: 'not_found' }))).toBe('Việc ‘Lập chương trình đón đoàn’ đã chuyển cho người khác nên thao tác không còn áp dụng.');
    expect(rejectedReason(item({ lastErrorCode: 'forbidden' }))).toContain('đã chuyển cho người khác');
    expect(rejectedReason(item({ conflictState: 'skipped' }))).toContain('tình trạng việc đã đổi');
  });

  it('dải mất mạng ghi giờ của bản lưu; bản lưu ngày khác thì ghi cả ngày', () => {
    expect(offlineText(Date.parse('2026-10-15T02:05:00Z'), NOW)).toBe('Đang không có mạng. Số liệu lúc 09:05.');
    expect(offlineText(Date.parse('2026-10-13T02:05:00Z'), NOW)).toBe('Đang không có mạng. Số liệu lúc Thứ Ba 13/10/2026, 09:05.');
  });
});

describe('tương phản màu của các cặp app nhân viên dùng thêm (mức AA 4.5:1, SPEC 8.1)', () => {
  const pairs: [ColorToken, ColorToken, string][] = [
    ['gold', 'goldTint', 'chip Chờ gửi, Chờ duyệt'],
    ['text', 'goldTint', 'thẻ lời nhắc'],
    ['textSub', 'goldTint', 'chữ phụ trong thẻ lời nhắc'],
    ['text', 'surfaceAlt', 'dải báo'],
    ['textSub', 'surfaceAlt', 'chữ phụ trong dải báo'],
    ['textSub', 'lateBg', 'chữ phụ trên thẻ quá hạn'],
    ['text', 'lateBg', 'tên việc trên thẻ quá hạn'],
    ['textSub', 'primaryTint', 'chữ phụ trên thẻ đã xong'],
    ['text', 'primaryTint', 'dòng đang chọn'],
    ['primary', 'surface', 'chữ nút viền'],
    ['primary', 'primaryTint', 'chữ nút viền khi đang nhấn'],
    ['border', 'surface', 'chữ gợi ý trong ô nhập'],
    ['onPrimary', 'primary', 'chữ nút chính'],
    ['warnText', 'warnBg', 'chip Đến hạn hôm nay'],
    ['lateText', 'lateBg', 'chip Quá hạn'],
  ];
  it.each(pairs)('%s trên %s (%s) đạt từ 4.5:1', (fg, bg) => {
    expect(contrastRatio(color[fg], color[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('biểu mẫu có ô tệp, chọn nhiều người và cấp số (docs/DECISIONS.md, 06/10/2026)', () => {
  const fields = [
    { key: 'ketQua', label: 'Kết quả', type: 'longtext', required: true },
    { key: 'tep', label: 'Tệp', type: 'file', multiple: true, required: true },
    { key: 'nguoi', label: 'Phối hợp', type: 'users' },
    { key: 'so', label: 'Số', type: 'autonumber', register: 'VBDI' },
  ] as const;
  const done = (id: string) => ({ localId: `l-${id}`, id, name: `${id}.pdf`, sizeBytes: 10, status: 'done' as const, problem: null });

  it('ô nhiều dòng và ô tệp đi vào kết quả gửi từ app (tệp là mảng id); ô chọn nhiều người và cấp số thì không', () => {
    expect(buildResult(fields, { ketQua: 'Đã xong\nphần việc của tôi', nguoi: 'y', so: 'z' }, { tep: [done('f1'), done('f2')] })).toEqual({
      result: { ketQua: 'Đã xong\nphần việc của tôi', tep: ['f1', 'f2'] },
      missing: [],
      invalid: [],
    });
  });

  it('ô tệp bắt buộc mà chưa có tệp nào tải xong thì báo thiếu, như mọi ô bắt buộc khác', () => {
    expect(buildResult(fields, {})).toEqual({ result: undefined, missing: ['ketQua', 'tep'], invalid: [] });
    expect(buildResult(fields, { ketQua: 'Xong' })).toEqual({ result: { ketQua: 'Xong' }, missing: ['tep'], invalid: [] });
  });

  it('chỉ ô chọn nhiều người bắt buộc mới còn phải làm trên web; ô tệp bắt buộc không còn bị chặn', () => {
    expect(webOnlyRequired(fields)).toEqual([]);
    expect(webOnlyRequired([...fields, { key: 'bb', label: 'Bắt buộc', type: 'users', required: true }])).toEqual(['bb']);
    expect(webOnlyRequired([{ key: 'a', label: 'A', type: 'text', required: true }])).toEqual([]);
  });

  it('ô tệp đã lưu đọc ra số tệp, ô chọn người đọc ra tên hoặc nói chung chung', () => {
    expect(resultValueText(fields[1], ['f1', 'f2'])).toBe('2 tệp');
    expect(resultValueText(fields[1], [])).toBeNull();
    expect(resultValueText({ key: 'u', label: 'U', type: 'user' }, LAN.id, new Map([[LAN.id, LAN]]))).toBe('chị Nguyễn Thu Lan');
    expect(resultValueText({ key: 'u', label: 'U', type: 'user' }, 'ma-la')).toBe('Người dùng khác');
  });
});
