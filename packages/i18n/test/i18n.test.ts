import { ERROR_CODE_LIST, NOTIFICATION_KINDS, NUDGE_REPLIES } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { STORES, STORE_NAMES, checkString, collectStrings, runChecks } from '../scripts/check';
import { BANNED_WORDS, DEFAULT_ADDRESS, dayPart, findBannedWords, fmt, fmtExecutive, vi } from '../src/index';

describe('findBannedWords', () => {
  it('bắt các từ nêu ở SPEC 7.5 và 7.8, không phân biệt hoa thường', () => {
    for (const word of ['task', 'deadline', 'dashboard', 'ok', 'submit', 'cancel', 'error', 'notification', 'reject', 'late', 'overdue', 'hi', 'sure']) {
      expect(BANNED_WORDS as readonly string[]).toContain(word);
      expect(findBannedWords(`Câu có ${word} ở giữa`)).toEqual([word]);
      expect(findBannedWords(word.toUpperCase())).toEqual([word]);
      expect(findBannedWords(`${word[0]?.toUpperCase()}${word.slice(1)}!`)).toEqual([word]);
    }
  });

  it('các câu "không viết" trong SPEC 7.5 đều bị bắt', () => {
    expect(findBannedWords('OK')).toEqual(['ok']);
    expect(findBannedWords('Sure')).toEqual(['sure']);
    expect(findBannedWords('Hi')).toEqual(['hi']);
    expect(findBannedWords('Cancel')).toEqual(['cancel']);
    expect(findBannedWords('Reject')).toEqual(['reject']);
    expect(findBannedWords('Deadline: 15/10')).toEqual(['deadline']);
    expect(findBannedWords('Late')).toEqual(['late']);
    expect(findBannedWords('Overdue')).toEqual(['overdue']);
    expect(findBannedWords('Error')).toEqual(['error']);
    expect(findBannedWords('Submit task')).toEqual(['submit', 'task']);
  });

  it('khớp nguyên từ: không bắt nhầm bên trong từ khác hay chữ tiếng Việt', () => {
    expect(findBannedWords('Thi công nhà xưởng')).toEqual([]);
    expect(findBannedWords('hình ảnh, chi tiết, hiện tại')).toEqual([]);
    expect(findBannedWords('okê')).toEqual([]);
    expect(findBannedWords('lateral, multitasking, errorless')).toEqual([]);
    expect(findBannedWords('Việc, hạn, tiến độ, thông báo, trợ lý, gửi')).toEqual([]);
    expect(findBannedWords('Dạ, thưa Chủ tịch.')).toEqual([]);
    expect(findBannedWords('')).toEqual([]);
  });

  it('trả mỗi từ một lần, theo thứ tự xuất hiện', () => {
    expect(findBannedWords('Task một, task hai, rồi OK và deadline')).toEqual(['task', 'ok', 'deadline']);
  });

  it('nhận chuỗi dạng tổ hợp (NFD)', () => {
    expect(findBannedWords('Việc quá hạn: overdue'.normalize('NFD'))).toEqual(['overdue']);
  });

  it('ngoại lệ duy nhất: "AI" trong nhãn "Trợ lý AI"', () => {
    expect(findBannedWords('Trợ lý AI')).toEqual([]);
    expect(findBannedWords('do Trợ lý AI soạn, theo chỉ đạo của Chủ tịch')).toEqual([]);
    expect(findBannedWords('TRỢ LÝ AI')).toEqual([]);
    expect(findBannedWords('Hỏi AI')).toEqual(['AI']);
    expect(findBannedWords('AI đang xử lý')).toEqual(['AI']);
    expect(findBannedWords('Trợ lý AI và AI khác')).toEqual(['AI']);
    // chữ "ai" tiếng Việt thì không phải từ cấm
    expect(findBannedWords('Ai đang chậm?')).toEqual([]);
    expect(findBannedWords('Chưa giao cho ai')).toEqual([]);
  });
});

describe('fmt và fmtExecutive', () => {
  it('điền biến tiếng Việt có dấu và có dấu cách', () => {
    expect(fmt('{người gửi} nhắc: {việc}', { 'người gửi': 'Văn phòng Chủ tịch', việc: 'Đặt xe' })).toBe('Văn phòng Chủ tịch nhắc: Đặt xe');
  });

  it('fmtExecutive tự thêm {danh xưng}, mặc định là "Chủ tịch", đổi được theo người dùng', () => {
    expect(DEFAULT_ADDRESS).toBe('Chủ tịch');
    expect(vi.executive.address.default).toBe('Chủ tịch');
    expect(fmtExecutive(vi.executive.assistant.acknowledge)).toBe('Dạ, thưa Chủ tịch.');
    expect(fmtExecutive(vi.executive.assistant.acknowledge, {}, 'Giám đốc')).toBe('Dạ, thưa Giám đốc.');
    expect(fmtExecutive(vi.executive.undo.title, { n: 30 })).toBe('Đã đồng ý. Sẽ gửi sau 30 giây.');
  });
});

describe('mọi kho chuỗi', () => {
  it('lệnh kiểm tổng không báo điểm nào chưa đạt', () => {
    expect(runChecks()).toEqual([]);
  });

  it.each(STORE_NAMES)('vi.%s: không có từ cấm', (name) => {
    const entries = collectStrings(vi[name], name);
    expect(entries.length).toBeGreaterThan(0);
    const bad = entries.flatMap((e) => findBannedWords(e.value).map((w) => `${e.path}: ${w}`));
    expect(bad).toEqual([]);
  });

  it.each(STORE_NAMES)('vi.%s: không chuỗi nào rỗng, không biểu tượng cảm xúc, biến đúng danh sách', (name) => {
    const problems = collectStrings(vi[name], name).flatMap((e) => checkString(e, STORES[name]));
    expect(problems).toEqual([]);
  });

  it('bộ kiểm bắt được chuỗi sai', () => {
    expect(checkString({ path: 'x', value: '' }, [])).toEqual([{ path: 'x', problem: 'chuỗi rỗng' }]);
    expect(checkString({ path: 'x', value: '   ' }, [])).toEqual([{ path: 'x', problem: 'chuỗi rỗng' }]);
    expect(checkString({ path: 'x', value: 'Deadline gần rồi' }, []).map((p) => p.problem)).toEqual(['có từ cấm “deadline”']);
    expect(checkString({ path: 'x', value: 'Xin {danh xương} chờ' }, ['danh xưng']).map((p) => p.problem)).toEqual(['biến lạ {danh xương}']);
    expect(checkString({ path: 'x', value: 'Thiếu ngoặc {n' }, ['n']).map((p) => p.problem)).toEqual(['ngoặc nhọn không khớp']);
    expect(checkString({ path: 'x', value: 'Xong rồi \u{1F389}' }, []).map((p) => p.problem)).toEqual(['có biểu tượng cảm xúc']);
    expect(checkString({ path: 'x', value: 'Đã rõ' }, [])).toEqual([]);
  });
});

describe('vi.errors', () => {
  it.each(['staff', 'executive', 'admin'] as const)('nhóm %s có câu cho MỌI mã lỗi và không thừa mã lạ', (audience) => {
    const table: Record<string, string> = vi.errors[audience];
    expect(Object.keys(table).sort()).toEqual([...ERROR_CODE_LIST].sort());
    for (const code of ERROR_CODE_LIST) expect(table[code]?.trim().length, code).toBeGreaterThan(0);
  });

  it('app Chủ tịch: lỗi nhận về phía hệ thống, có bước tiếp theo, không trách người dùng (SPEC 7.2 điều 8)', () => {
    expect(fmtExecutive(vi.errors.executive.internal_error)).toBe('Dạ, hệ thống chưa làm được việc này. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.');
    for (const code of ERROR_CODE_LIST) {
      const text = vi.errors.executive[code];
      expect(text, code).not.toMatch(/sai|lỗi|bạn/iu);
      expect(text, code).not.toMatch(/\d{3}/);
      // có bước tiếp theo hoặc nói rõ phần nào vẫn dùng được
      expect(text, code).toMatch(/[Xx]in \{danh xưng\}|vẫn dùng bình thường/u);
      expect(fmtExecutive(text)).not.toMatch(/[{}]/);
    }
  });

  it('trợ lý tắt hoặc hết lượt: app Chủ tịch báo "Trợ lý tạm nghỉ" (SPEC 6.11)', () => {
    expect(vi.errors.executive.ai_disabled).toMatch(/^Trợ lý tạm nghỉ\./);
    expect(vi.errors.executive.quota_exceeded).toMatch(/^Trợ lý tạm nghỉ\./);
  });
});

describe('vi.notifications', () => {
  it('có tiêu đề và thân cho MỌI loại thông báo, không thừa loại lạ', () => {
    expect(Object.keys(vi.notifications).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const kind of NOTIFICATION_KINDS) {
      expect(vi.notifications[kind].title.trim().length, kind).toBeGreaterThan(0);
      expect(vi.notifications[kind].body.trim().length, kind).toBeGreaterThan(0);
    }
  });

  it('mẫu tiêu đề theo SPEC 8.3 và 10.9', () => {
    const n = vi.notifications;
    expect(n.assigned.title).toBe('Việc mới: {việc}');
    expect(n.reminder_due_tomorrow.title).toBe('Ngày mai đến hạn: {việc}');
    expect(n.reminder_due_today.title).toBe('Hôm nay đến hạn: {việc}');
    expect(n.overdue.title).toBe('Đã quá hạn {n} ngày: {việc}');
    expect(n.nudge.title).toBe('{người gửi} nhắc: {việc}');
    expect(n.extension_approved.title).toBe('Đã duyệt gia hạn: {việc}');
    expect(n.approval_needed.title).toBe('Cần duyệt: {việc}');
    expect(n.briefing.title).toBe('Báo cáo đầu ngày đã sẵn sàng');
    expect(n.approval.title).toBe('Có {n} việc cần Chủ tịch quyết');
    expect(n['proposal.office'].title).toBe('Văn phòng có {n} đề xuất xin Chủ tịch xem');
    expect(n['proposal.failed'].title).toBe('Có {n} việc trợ lý chưa làm được');
    expect(fmt(n.assigned.title, { việc: 'Lập chương trình đón đoàn' })).toBe('Việc mới: Lập chương trình đón đoàn');
    expect(fmt(n.nudge.title, { 'người gửi': 'Văn phòng Chủ tịch', việc: 'Đặt xe' })).toBe('Văn phòng Chủ tịch nhắc: Đặt xe');
    expect(fmt(n.approval.title, { n: 1 })).toBe('Có 1 việc cần Chủ tịch quyết');
  });

  it('không đưa số tiền hay nội dung nhạy cảm vào mẫu', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const text = `${vi.notifications[kind].title} ${vi.notifications[kind].body}`;
      expect(text, kind).not.toMatch(/\{(?:tiền|số tiền|lý do|ghi chú|lời nhắc|nội dung)\}/u);
      expect(text, kind).not.toMatch(/\d|lương|triệu|tỷ/u);
    }
  });

  it('thông báo đẩy cho app Chủ tịch ngắn và không có tên việc hay tên người (SPEC 10.9)', () => {
    for (const kind of ['briefing', 'approval', 'proposal.office', 'proposal.failed'] as const) {
      const { title, body } = vi.notifications[kind];
      expect(title.length).toBeLessThanOrEqual(50);
      expect(`${title} ${body}`).not.toMatch(/\{(?:việc|người|người gửi|lượt)\}/u);
    }
  });
});

describe('vi.executive', () => {
  const e = vi.executive;

  it('các câu bắt buộc theo SPEC 6.6, 6.10, 6.11, 7.4, 7.5', () => {
    expect(fmtExecutive(e.home.greeting.sáng)).toBe('Chào buổi sáng, thưa Chủ tịch.');
    expect(fmtExecutive(e.assistant.acknowledge)).toBe('Dạ, thưa Chủ tịch.');
    expect(fmtExecutive(e.review.title)).toBe('Xin Chủ tịch xem lại');
    expect(e.review.confirm).toBe('Đồng ý gửi');
    expect(e.review.reject).toBe('Không gửi');
    expect(fmtExecutive(e.undo.title, { n: 30 })).toBe('Đã đồng ý. Sẽ gửi sau 30 giây.');
    expect(e.undo.undo).toBe('Hoàn tác');
    expect(e.undo.sendNow).toBe('Gửi ngay');
    expect(e.undo.understood).toBe('Đã rõ');
    expect(fmtExecutive(e.assistant.processing)).toBe('Trợ lý đang xử lý, xin Chủ tịch chờ một chút.');
    expect(fmtExecutive(e.assistant.unclear)).toBe('Dạ, trợ lý nghe chưa rõ, xin Chủ tịch nhắc lại.');
    expect(fmtExecutive(e.assistant.waitSpoken)).toBe('Dạ, xin Chủ tịch chờ một chút.');
    expect(e.assistant.resting).toBe('Trợ lý tạm nghỉ.');
    expect(e.assistant.understood).toBe('Dạ, trợ lý hiểu như sau:');
    expect(e.assistant.label).toBe('Trợ lý AI');
    expect(e.assistant.typeInstead).toBe('Gõ chữ');
    expect(e.nav.askOffice).toBe('Nhờ Văn phòng');
    expect([e.nav.home, e.nav.assistant, e.nav.progress]).toEqual(['Trang chủ', 'Trợ lý', 'Tiến độ']);
    expect(fmtExecutive(e.home.cards.decisions)).toBe('Việc cần Chủ tịch quyết');
    expect(e.home.briefing.listen).toBe('Nghe báo cáo tổng hợp đầu ngày');
    expect([e.decisions.approve, e.decisions.reject]).toEqual(['Đồng ý', 'Chưa đồng ý']);
    expect(e.runDetail.nudgeLate).toBe('Nhờ trợ lý đi thúc những việc chậm');
    expect(fmtExecutive(e.progress.card.progress, { xong: 4, tổng: 6 })).toBe('4 trên 6 việc đã xong');
    expect(fmtExecutive(e.progress.card.late, { n: 2 })).toBe('Chậm 2 ngày làm việc');
    expect(fmtExecutive(e.delegation.banner, { người: 'ông Huy', ngày: '20 tháng 10' })).toBe('Đang ủy quyền cho ông Huy đến ngày 20 tháng 10');
  });

  it('ba nút cỡ chữ và ba nút tốc độ đọc', () => {
    expect([e.settings.fontSize.large, e.settings.fontSize.xlarge, e.settings.fontSize.xxlarge]).toEqual(['Lớn', 'Rất lớn', 'Cực lớn']);
    expect([e.settings.speechRate.slow, e.settings.speechRate.normal, e.settings.speechRate.fast]).toEqual(['Chậm', 'Vừa', 'Nhanh']);
  });

  it('lời chào có đủ bốn buổi và khớp với dayPart()', () => {
    const at = (hourVn: number) => new Date(Date.UTC(2026, 9, 15, hourVn - 7));
    expect(fmtExecutive(e.home.greeting[dayPart(at(8))])).toBe('Chào buổi sáng, thưa Chủ tịch.');
    expect(fmtExecutive(e.home.greeting[dayPart(at(12))])).toBe('Chào buổi trưa, thưa Chủ tịch.');
    expect(fmtExecutive(e.home.greeting[dayPart(at(15))])).toBe('Chào buổi chiều, thưa Chủ tịch.');
    expect(fmtExecutive(e.home.greeting[dayPart(at(20))])).toBe('Chào buổi tối, thưa Chủ tịch.');
  });

  it('màn đồng ý lần đầu nói rõ về micro, âm thanh, bản chép chữ và nút xoá (SPEC 6.8)', () => {
    // Chế độ trò chuyện (04/10/2026): nói đúng điều app làm, không còn câu "không nghe liên tục".
    const mic = fmtExecutive(e.consent.points.mic);
    expect(mic).toMatch(/^Micro chỉ mở sau khi Chủ tịch bấm nút micro\./u);
    expect(mic).toMatch(/bấm dừng/u);
    expect(mic).toMatch(/lâu không nghe thấy gì/u);
    expect(mic).toMatch(/rời màn hình/u);
    expect(mic).toMatch(/luôn báo rõ lúc micro đang mở/u);
    expect(mic).not.toMatch(/không nghe liên tục/u);
    expect(e.consent.points.audio).toBe('Âm thanh không được lưu lại.');
    expect(fmtExecutive(e.consent.points.transcript, { n: 90 })).toBe('Bản chép chữ của cuộc trò chuyện được lưu 90 ngày để làm dấu vết.');
    expect(e.consent.points.erase).toMatch(/xoá lịch sử hội thoại/u);
    expect(e.consent.points.machine).toMatch(/Trợ lý AI/u);
  });

  it('cách gọi là biến: không viết cứng "Chủ tịch" ngoài mục address; {danh xưng} không đứng đầu câu', () => {
    const entries = collectStrings(e, 'executive').filter((x) => !x.path.startsWith('executive.address.'));
    for (const { path, value } of entries) {
      expect(value, path).not.toContain('Chủ tịch');
      expect(value, path).not.toMatch(/(?:^|[.!?…]\s+)\{danh xưng\}/u);
    }
    // đổi cách gọi thì mọi câu đổi theo, không sót chỗ nào
    for (const { path, value } of entries) {
      const out = fmtExecutive(value, {}, 'Giám đốc');
      expect(out, path).not.toContain('{danh xưng}');
      expect(out, path).not.toContain('Chủ tịch');
    }
    expect(e.address.byRole).toEqual({ chairman: 'Chủ tịch', director: 'Giám đốc', deputy: 'Phó giám đốc' });
  });

  it('không có nút "Hủy", "Từ chối" (SPEC 7.5)', () => {
    for (const { path, value } of collectStrings(e, 'executive')) {
      expect(value, path).not.toMatch(/^(?:Hủy|Huỷ|Từ chối)$/u);
      expect(value, path).not.toMatch(/[Tt]ừ chối/u);
    }
  });
});

describe('vi.staff', () => {
  const s = vi.staff;

  it('màn kích hoạt có đoạn "Hệ thống ghi nhận gì về tôi" và nút "Tôi đã đọc" (SPEC 11.7)', () => {
    expect(s.activation.notice.title).toBe('Hệ thống ghi nhận gì về tôi');
    expect(s.activation.notice.confirm).toBe('Tôi đã đọc');
    expect(s.me.whatIsRecorded).toBe('Hệ thống ghi nhận gì về tôi');
    const notice = collectStrings(s.activation.notice, 'notice')
      .map((x) => x.value)
      .join(' ');
    for (const must of ['Việc được giao', 'Hạn', 'báo hoàn thành', 'lời nhắc', 'đúng hạn', 'Cấp trên trực tiếp', 'Văn phòng', 'Trợ lý AI']) {
      expect(notice).toContain(must);
    }
  });

  it('hai tab, ba nhóm và bốn nút theo SPEC 8.2', () => {
    expect([s.myWork.tabs.todo, s.myWork.tabs.done]).toEqual(['Cần làm', 'Đã xong']);
    expect([s.myWork.groups.overdue, s.myWork.groups.today, s.myWork.groups.upcoming]).toEqual(['Quá hạn', 'Hôm nay', 'Sắp tới']);
    expect([s.stepDetail.actions.accept, s.stepDetail.actions.complete, s.stepDetail.actions.requestExtension, s.stepDetail.actions.block]).toEqual([
      'Đã nhận',
      'Báo hoàn thành',
      'Xin thêm thời gian',
      'Báo vướng',
    ]);
    expect([s.approval.approve, s.approval.reject]).toEqual(['Đồng ý', 'Chưa đồng ý']);
    expect(s.complete.send).toBe('Gửi');
    expect(s.extension.pendingChip).toBe('Chờ duyệt');
    expect(s.offline.queuedChip).toBe('Chờ gửi');
  });

  it('ba nút trả lời nhanh khớp với vi.common.nudgeReply', () => {
    expect(s.stepDetail.nudge.replyDone).toBe(vi.common.nudgeReply.done);
    expect(s.stepDetail.nudge.replyNeedTime).toBe(vi.common.nudgeReply.need_time);
    expect(s.stepDetail.nudge.replyBlocked).toBe(vi.common.nudgeReply.blocked);
    expect(Object.keys(vi.common.nudgeReply).sort()).toEqual([...NUDGE_REPLIES].sort());
  });

  it('lý do báo vướng khớp với vi.common.blockReason', () => {
    expect(s.blocked.reasons).toEqual(vi.common.blockReason);
  });

  it('có đủ nhóm chuỗi cho S0 đến S9', () => {
    for (const group of ['activation', 'myWork', 'stepDetail', 'complete', 'extension', 'blocked', 'approval', 'notifications', 'team', 'me'] as const) {
      expect(collectStrings(s[group], group).length, group).toBeGreaterThan(5);
    }
  });
});

describe('vi.timeline', () => {
  it('ví dụ ở đề bài', () => {
    expect(fmt(vi.timeline.event.CompleteStep, { người: 'chị Lan', việc: 'Đặt xe' })).toBe('chị Lan báo hoàn thành ‘Đặt xe’');
    expect(fmt(vi.timeline.change['step.activated'], { việc: 'Đặt xe', người: 'chị Lan', hạn: 'Thứ Năm 15/10/2026' })).toBe(
      'Giao ‘Đặt xe’ cho chị Lan, hạn Thứ Năm 15/10/2026',
    );
  });

  it('có câu cho mọi loại sự kiện và mọi loại thay đổi', () => {
    expect(Object.keys(vi.timeline.event).length).toBe(17);
    expect(Object.keys(vi.timeline.change).length).toBe(16);
    for (const { path, value } of collectStrings(vi.timeline, 'timeline')) expect(value.trim().length, path).toBeGreaterThan(0);
  });

  it('không dùng "từ chối"', () => {
    for (const { path, value } of collectStrings(vi.timeline, 'timeline')) expect(value, path).not.toMatch(/từ chối/iu);
  });
});
