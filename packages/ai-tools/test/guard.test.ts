import { describe, expect, it } from 'vitest';
import {
  checkNumbers,
  checkStyle,
  extractNumbers,
  fallbackFromToolResults,
  fallbackOverviewText,
  fallbackRunText,
  numbersFromToolResults,
  splitSentences,
} from '../src/guard';
import { ASSISTANT_PHRASES } from '../src/prompt';

const brief = (text: string) => extractNumbers(text).map((t) => `${t.kind}:${t.raw}=${t.value}`);

/** Kết quả `get_run` của kịch bản vàng lúc 08/10/2026 09:00, dạng tối thiểu. */
const RUN = {
  ok: true,
  result: {
    id: '01920000-0000-7000-8000-0000000000b1',
    title: 'Đón đoàn nhà đầu tư Nhật Bản',
    progress: { done: 4, total: 6 },
    targetAt: '2026-10-15T10:00:00.000Z',
    steps: [
      { id: '01920000-0000-7000-8000-0000000000c1', title: 'Lập chương trình đón đoàn', state: 'done', isOverdue: false, lateWorkingDays: 0, dueAt: '2026-10-06T10:00:00.000Z' },
      { id: '01920000-0000-7000-8000-0000000000c4', title: 'Lập đề nghị tạm ứng', state: 'done', isOverdue: false, lateWorkingDays: 0, dueAt: '2026-10-06T10:00:00.000Z', amountVnd: 20000000 },
      { id: '01920000-0000-7000-8000-0000000000c3', title: 'Kiểm tra tuyến tham quan', state: 'ready', isOverdue: true, lateWorkingDays: 1, dueAt: '2026-10-07T10:00:00.000Z' },
    ],
  },
};

describe('extractNumbers', () => {
  it('số thường, kể cả ngăn nghìn bằng dấu chấm và thập phân bằng dấu phẩy', () => {
    expect(brief('Có 4 trên 6 việc đã xong, số tiền 20.000.000 đồng, tỉ lệ 1,5 và 2.5.')).toEqual([
      'number:4=4',
      'number:6=6',
      'number:20.000.000=20000000',
      'number:1,5=1.5',
      'number:2.5=2.5',
    ]);
  });

  it('đơn vị và phần trăm', () => {
    expect(brief('20 triệu, 1,5 tỷ, 300 nghìn, 20tr, 30k')).toEqual(['number:20 triệu=20000000', 'number:1,5 tỷ=1500000000', 'number:300 nghìn=300000', 'number:20tr=20000000', 'number:30k=30000']);
    expect(extractNumbers('đúng hạn 67%')[0]).toMatchObject({ kind: 'number', value: 67, percent: true });
    expect(extractNumbers('đúng hạn 67 phần trăm')[0]).toMatchObject({ kind: 'number', value: 67, percent: true });
  });

  it('ngày ở mọi cách viết', () => {
    expect(extractNumbers('Hạn: Thứ Năm, ngày 15 tháng 10 năm 2026')[0]).toMatchObject({ kind: 'date', day: 15, month: 10, year: 2026 });
    expect(extractNumbers('15/10/2026')[0]).toMatchObject({ kind: 'date', day: 15, month: 10, year: 2026 });
    expect(extractNumbers('2026-10-15')[0]).toMatchObject({ kind: 'date', day: 15, month: 10, year: 2026 });
    expect(extractNumbers('mùng 5 tháng 9 âm lịch')[0]).toMatchObject({ kind: 'date', day: 5, month: 9 });
    expect(extractNumbers('ngày 9/10')[0]).toMatchObject({ kind: 'date', day: 9, month: 10 });
    expect(extractNumbers('tháng 10 năm 2026')[0]).toMatchObject({ kind: 'date', month: 10, year: 2026 });
    expect(extractNumbers('năm 2026')[0]).toMatchObject({ kind: 'date', year: 2026 });
    expect(extractNumbers('ngày 15 đoàn đến')[0]).toMatchObject({ kind: 'date', day: 15 });
  });

  it('thời điểm ISO đổi sang ngày và giờ Việt Nam', () => {
    const tokens = extractNumbers('2026-10-07T10:00:00.000Z');
    expect(tokens[0]).toMatchObject({ kind: 'date', day: 7, month: 10, year: 2026 });
    expect(tokens[1]).toMatchObject({ kind: 'time', hour: 17, minute: 0 });
    // 18:30 UTC là 01:30 hôm sau ở Việt Nam
    expect(extractNumbers('2026-10-07T18:30:00Z')[0]).toMatchObject({ kind: 'date', day: 8, month: 10 });
  });

  it('giờ và số thứ tự', () => {
    expect(extractNumbers('17:00')[0]).toMatchObject({ kind: 'time', hour: 17, minute: 0 });
    expect(extractNumbers('5 giờ chiều')[0]).toMatchObject({ kind: 'time', hour: 17 });
    expect(extractNumbers('7 giờ 30 sáng')[0]).toMatchObject({ kind: 'time', hour: 7, minute: 30 });
    expect(extractNumbers('9h30')[0]).toMatchObject({ kind: 'time', hour: 9, minute: 30 });
    expect(brief('thứ 5, lần 2, bước 3')).toEqual(['ordinal:thứ 5=5', 'ordinal:lần 2=2', 'ordinal:bước 3=3']);
    expect(brief('1. Việc đầu\n2. Việc sau')).toEqual(['ordinal:1.=1', 'ordinal:2.=2']);
  });

  it('không coi mã định danh và chữ số dính chữ cái là số liệu', () => {
    expect(extractNumbers('việc s3 ở mốc M2, id 01920000-0000-7000-8000-0000000000a6')).toEqual([]);
  });

  it('a/b: ngày/tháng mơ hồ hoặc hai số rời', () => {
    expect(extractNumbers('4/6 việc')[0]).toMatchObject({ kind: 'date', day: 4, month: 6, ambiguous: true });
    expect(brief('40/60')).toEqual(['number:40=40', 'number:60=60']);
  });
});

describe('numbersFromToolResults', () => {
  it('gom giá trị số, số trong chuỗi, số phần tử của mảng, ngày và giờ Việt Nam', () => {
    const facts = numbersFromToolResults([RUN]);
    for (const n of [4, 6, 1, 0, 3, 20000000]) expect(facts.values.has(n)).toBe(true);
    expect(facts.values.has(99)).toBe(false);
    expect(facts.dates).toContainEqual({ day: 7, month: 10, year: 2026 });
    expect(facts.dates).toContainEqual({ day: 15, month: 10, year: 2026 });
    expect(facts.times).toContainEqual({ hour: 17, minute: 0 });
  });

  it('không lấy số từ UUID hay từ khoá của object', () => {
    const facts = numbersFromToolResults([{ id: '01920000-0000-7000-8000-000000001234', k2026: 'x' }]);
    expect([...facts.values]).toEqual([]);
  });
});

describe('checkNumbers', () => {
  it('đạt khi mọi số có trong kết quả tool', () => {
    expect(checkNumbers('Dạ thưa Chủ tịch, có 4 trên 6 việc đã xong, 1 việc quá hạn 1 ngày làm việc.', [RUN])).toEqual([]);
    expect(checkNumbers('Đã xong 4/6 việc.', [RUN])).toEqual([]);
    expect(checkNumbers('Khoản tạm ứng là 20.000.000 đồng, tức 20 triệu đồng.', [RUN])).toEqual([]);
    expect(checkNumbers('Dạ, không có con số nào ở đây.', [])).toEqual([]);
  });

  it('bắt số bịa', () => {
    expect(checkNumbers('Dạ, có 99 việc quá hạn và 4 việc xong.', [RUN])).toEqual(['99']);
    expect(checkNumbers('Khoản tạm ứng là 25.000.000 đồng.', [RUN])).toEqual(['25.000.000']);
    expect(checkNumbers('Có 7 việc, 7 việc, 8 việc.', [])).toEqual(['7', '8']);
  });

  it('ngày và giờ: chỉ nhận khi có trong kết quả tool hoặc trong ngày hôm nay', () => {
    expect(checkNumbers('Việc này hạn ngày 7 tháng 10 năm 2026, lúc 17:00.', [RUN])).toEqual([]);
    expect(checkNumbers('Việc này hạn 5 giờ chiều ngày 7/10.', [RUN])).toEqual([]);
    expect(checkNumbers('Đoàn đến ngày 15 tháng 10.', [RUN])).toEqual([]);
    expect(checkNumbers('Việc này hạn ngày 12 tháng 10.', [RUN])).toEqual(['ngày 12 tháng 10']);
    expect(checkNumbers('Việc này hạn lúc 9 giờ 30.', [RUN])).toEqual(['9 giờ 30']);
    const today = 'Hôm nay là Thứ Năm, ngày 8 tháng 10 năm 2026 (ngày 28 tháng 8 âm lịch)';
    expect(checkNumbers('Hôm nay là ngày 8 tháng 10 năm 2026.', [RUN])).toEqual(['ngày 8 tháng 10 năm 2026']);
    expect(checkNumbers('Hôm nay là ngày 8 tháng 10 năm 2026.', [RUN], { allowed: [today] })).toEqual([]);
  });

  it('số thứ tự luôn được phép; số người dùng vừa nói cũng được phép', () => {
    expect(checkNumbers('Dạ, việc thứ 2 ở bước 3.', [])).toEqual([]);
    expect(checkNumbers('Dạ, trợ lý hiểu là 30 triệu đồng, đúng không ạ?', [], { allowed: ['tạm ứng ba mươi triệu, à 30 triệu'] })).toEqual([]);
    expect(checkNumbers('Dạ, có 5 việc.', [], { allowed: [5] })).toEqual([]);
  });

  it('phần trăm khớp với tỉ lệ 0..1 trong kết quả tool', () => {
    expect(checkNumbers('Tuần này đúng hạn 67%.', [{ onTimeRateThisWeek: 0.6667 }])).toEqual([]);
    expect(checkNumbers('Tuần này đúng hạn 80%.', [{ onTimeRateThisWeek: 0.6667 }])).toEqual(['80%']);
  });

  it('số đếm bằng số phần tử của danh sách là hợp lệ', () => {
    expect(checkNumbers('Dạ, có 2 việc quá hạn.', [{ ok: true, result: { steps: [{ title: 'a' }, { title: 'b' }] } }])).toEqual([]);
    expect(checkNumbers('Dạ, không có việc nào, tức 0 việc.', [{ ok: true, result: { steps: [] } }])).toEqual([]);
  });
});

describe('mẫu văn bản dựng thẳng từ số liệu', () => {
  it('fallbackOverviewText: không quá ba câu, mọi số lấy từ số liệu', () => {
    const overview = { running: 3, overdue: 2, dueToday: 1, dueTomorrow: 4, awaitingMyDecision: 1 };
    const text = fallbackOverviewText(overview);
    expect(text).toBe('Dạ thưa Chủ tịch, hiện có 3 quy trình đang chạy và 2 việc quá hạn. Hôm nay có 1 việc đến hạn, ngày mai có 4 việc đến hạn. Có 1 việc đang chờ Chủ tịch quyết.');
    expect(checkNumbers(text, [overview])).toEqual([]);
    expect(checkStyle(text).ok).toBe(true);
  });

  it('fallbackOverviewText: số 0 đọc thành lời, đổi được chức danh', () => {
    const text = fallbackOverviewText({ running: 0, overdue: 0, dueToday: 0, dueTomorrow: 0, awaitingMyDecision: 0 }, 'Giám đốc');
    expect(text).toBe('Dạ thưa Giám đốc, hiện không có quy trình nào đang chạy, không có việc nào quá hạn. Hôm nay không có việc nào đến hạn, ngày mai không có việc nào đến hạn. Không có việc nào đang chờ Giám đốc quyết.');
    expect(extractNumbers(text)).toEqual([]);
  });

  it('fallbackRunText dựng từ kết quả get_run', () => {
    expect(fallbackRunText(RUN.result)).toBe('Dạ thưa Chủ tịch, đợt “Đón đoàn nhà đầu tư Nhật Bản” có 4 trên 6 việc đã xong. Có 1 việc quá hạn. Chi tiết có trên màn hình Tiến độ.');
    expect(fallbackRunText({ title: 'x' })).toBeNull();
  });

  it('fallbackFromToolResults: ưu tiên get_overview, rồi get_run, cuối cùng là câu mẫu', () => {
    const overview = { ok: true, result: { running: 1, overdue: 1, dueToday: 0, dueTomorrow: 1 } };
    expect(fallbackFromToolResults([{ name: 'get_run', result: RUN }, { name: 'get_overview', result: overview }])).toContain('1 quy trình đang chạy');
    expect(fallbackFromToolResults([{ name: 'get_run', result: RUN }])).toContain('4 trên 6 việc đã xong');
    expect(fallbackFromToolResults([{ name: 'search_people', result: { ok: true, result: { people: [] } } }])).toBe(ASSISTANT_PHRASES.guardFallback('Chủ tịch'));
    expect(fallbackFromToolResults([], 'Giám đốc')).toBe(ASSISTANT_PHRASES.guardFallback('Giám đốc'));
  });
});

describe('checkStyle', () => {
  it('đếm câu và câu hỏi', () => {
    expect(splitSentences('Dạ thưa Chủ tịch, có 4 trên 6 việc đã xong. Còn 1 việc quá hạn. Chủ tịch có muốn đi thúc không ạ?')).toHaveLength(3);
    expect(checkStyle('Dạ, chị Lan nào ạ?')).toMatchObject({ sentences: 1, questions: 1, ok: true });
    expect(checkStyle('Một. Hai. Ba. Bốn.')).toMatchObject({ sentences: 4, violations: ['too_many_sentences'], ok: false });
    expect(checkStyle('Chị Lan nào ạ? Ngày nào ạ?')).toMatchObject({ questions: 2, violations: ['too_many_questions'], ok: false });
  });

  it('số có dấu chấm và chữ viết tắt không cắt câu', () => {
    expect(checkStyle('Khoản này là 20.000.000 đồng ở TP. Hồ Chí Minh.').sentences).toBe(1);
  });

  it('từ cấm lấy từ @mihato/i18n; nhãn "Trợ lý AI" được phép', () => {
    expect(checkStyle('Dạ, deadline là ngày mai, OK ạ.')).toMatchObject({ banned: ['deadline', 'ok'], ok: false });
    expect(checkStyle('Dạ, đây là Trợ lý AI.').ok).toBe(true);
    expect(checkStyle('Dạ, ai đang chậm ạ?').ok).toBe(true);
  });

  it('biểu tượng cảm xúc bị coi là lỗi văn phong', () => {
    expect(checkStyle('Dạ, xong rồi ạ 🙂')).toMatchObject({ emoji: true, violations: ['emoji'] });
  });

  it('mọi câu mẫu của trợ lý đều đạt văn phong', () => {
    for (const phrase of Object.values(ASSISTANT_PHRASES)) expect(checkStyle(phrase('Chủ tịch')), phrase('Chủ tịch')).toMatchObject({ ok: true });
  });
});
