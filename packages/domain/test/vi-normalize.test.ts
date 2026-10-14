import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR, type WorkCalendar } from '../src/engine';
import { formatLunar } from '../src/lunar';
import {
  DEFAULT_ABBREVIATIONS,
  REDACTED,
  expandAbbrev,
  matchPerson,
  matchVoiceConfirm,
  normalizeText,
  normalizeVoiceCommand,
  parseMoney,
  parseNumber,
  redact,
  resolveDate,
  stripDiacritics,
  type PersonCandidate,
} from '../src/vi-normalize';

/** Dạng tổ hợp (NFD) của một chuỗi: cùng chữ nhưng dấu tách rời. */
const nfd = (s: string) => s.normalize('NFD');

// ───────────────────────── stripDiacritics ─────────────────────────

describe('stripDiacritics', () => {
  const cases: [string, string][] = [
    ['Nguyễn Thu Lan', 'Nguyen Thu Lan'],
    ['Trần Thị Đào', 'Tran Thi Dao'],
    ['đ', 'd'],
    ['Đ', 'D'],
    ['Đỗ Quang Huy', 'Do Quang Huy'],
    ['chị Lan', 'chi Lan'],
    ['anh Tuấn', 'anh Tuan'],
    ['ông', 'ong'],
    ['bà', 'ba'],
    ['cô', 'co'],
    ['chú', 'chu'],
    ['bác', 'bac'],
    ['ệ ữ ặ ỡ ẫ ộ', 'e u a o a o'],
    ['Ệ Ữ Ặ Ỡ Ẫ Ộ', 'E U A O A O'],
    ['hai mươi lăm', 'hai muoi lam'],
    ['rưỡi', 'ruoi'],
    ['tỷ', 'ty'],
    ['thứ Năm tuần sau', 'thu Nam tuan sau'],
    ['ngày kia', 'ngay kia'],
    ['cuối tuần này', 'cuoi tuan nay'],
    ['Phòng Kinh doanh', 'Phong Kinh doanh'],
    ['HĐQT', 'HDQT'],
    ['PGĐ', 'PGD'],
    ['Văn phòng Chủ tịch', 'Van phong Chu tich'],
    ['Đã quá hạn 2 ngày', 'Da qua han 2 ngay'],
    ['‘Lập chương trình đón đoàn’', '‘Lap chuong trinh don doan’'],
    ['20.000.000 đồng', '20.000.000 dong'],
    ['abc XYZ 123', 'abc XYZ 123'],
    ['', ''],
    ['ưu tiên', 'uu tien'],
    ['Hà Nội', 'Ha Noi'],
    ['Giỗ Tổ Hùng Vương', 'Gio To Hung Vuong'],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(stripDiacritics(input)).toBe(expected);
  });

  it.each(cases)('dạng tổ hợp (NFD) của %j cho cùng kết quả', (input, expected) => {
    expect(stripDiacritics(nfd(input))).toBe(expected);
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ───────────────────────── normalizeText ─────────────────────────

describe('normalizeText', () => {
  const cases: [string, string][] = [
    ['Nguyễn Thu Lan', 'nguyễn thu lan'],
    ['  Nguyễn   Thu\tLan  ', 'nguyễn thu lan'],
    ['CHỊ LAN', 'chị lan'],
    ['Đỗ Quang Huy', 'đỗ quang huy'],
    ['ĐỒNG Ý', 'đồng ý'],
    ['Thứ Năm\nTuần Sau', 'thứ năm tuần sau'],
    ['PGĐ', 'pgđ'],
    ['HĐQT', 'hđqt'],
    ['Ệ Ữ Ặ Ỡ Ẫ Ộ', 'ệ ữ ặ ỡ ẫ ộ'],
    ['hai   mươi    lăm', 'hai mươi lăm'],
    ['\u00a0ngày\u00a0mai\u00a0', 'ngày mai'],
    ['Hôm Nay', 'hôm nay'],
    ['', ''],
    ['   ', ''],
    ['a', 'a'],
    ['Ư', 'ư'],
    ['Ơ', 'ơ'],
    ['Ă Â Ê Ô', 'ă â ê ô'],
    ['Văn phòng Chủ tịch', 'văn phòng chủ tịch'],
    ['20 Triệu', '20 triệu'],
    ['Cuối  Tuần  Này', 'cuối tuần này'],
    ['Dạ, Đồng Ý Ạ.', 'dạ, đồng ý ạ.'],
    ['Lan\r\nKinh doanh', 'lan kinh doanh'],
    ['MIHATO', 'mihato'],
    ['VRG', 'vrg'],
    ['Giỗ Tổ Hùng Vương', 'giỗ tổ hùng vương'],
    ['Tết Nguyên Đán', 'tết nguyên đán'],
    ['Trợ lý AI', 'trợ lý ai'],
    ['Quá Hạn', 'quá hạn'],
    ['Ủy quyền', 'ủy quyền'],
    ['RƯỠI', 'rưỡi'],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it.each(cases)('dạng tổ hợp (NFD) của %j về cùng một chuỗi dựng sẵn (NFC)', (input, expected) => {
    const out = normalizeText(nfd(input));
    expect(out).toBe(expected);
    expect(out).toBe(out.normalize('NFC'));
  });

  it('cùng một tên ở NFC và NFD cho chuỗi giống hệt nhau', () => {
    const composed = 'Nguyễn Thị Hồng Nhung';
    expect(nfd(composed)).not.toBe(composed);
    expect(normalizeText(nfd(composed))).toBe(normalizeText(composed));
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ───────────────────────── parseNumber ─────────────────────────

describe('parseNumber', () => {
  const cases: [string, number | null][] = [
    // SPEC 6.6
    ['hai mươi lăm', 25],
    ['hai lăm', 25],
    ['một nghìn rưỡi', 1500],
    // số cơ bản
    ['không', 0],
    ['một', 1],
    ['năm', 5],
    ['mười', 10],
    ['mười một', 11],
    ['mười bốn', 14],
    ['mười lăm', 15],
    ['hai mươi', 20],
    ['hai mươi mốt', 21],
    ['hai mươi tư', 24],
    ['năm mươi nhăm', 55],
    ['bảy mươi bẩy', 77],
    ['chín mươi chín', 99],
    ['một trăm', 100],
    ['một trăm linh năm', 105],
    ['một trăm lẻ năm', 105],
    ['một trăm mười', 110],
    ['một trăm mười lăm', 115],
    ['một trăm hai mươi ba', 123],
    ['chín trăm chín mươi chín', 999],
    ['một nghìn', 1000],
    ['một ngàn', 1000],
    ['một nghìn không trăm linh một', 1001],
    ['một nghìn linh năm', 1005],
    ['hai nghìn không trăm hai mươi sáu', 2026],
    ['mười hai nghìn', 12000],
    ['một triệu', 1_000_000],
    ['một tỷ hai trăm triệu', 1_200_000_000],
    ['một nghìn tỷ', 1_000_000_000_000],
    // cách nói tắt
    ['hai mốt', 21],
    ['ba tư', 34],
    ['hai chục', 20],
    ['ba chục', 30],
    ['một trăm hai', 120],
    ['hai trăm năm', 250],
    ['hai trăm rưỡi', 250],
    ['trăm rưỡi', 150],
    ['một nghìn hai', 1200],
    ['một triệu hai', 1_200_000],
    ['hai triệu rưỡi', 2_500_000],
    ['ba rưỡi', 3.5],
    // chữ số
    ['25', 25],
    ['1.500', 1500],
    ['20.000.000', 20_000_000],
    ['1,5', 1.5],
    ['2 trăm', 200],
    ['2 trăm 50', 250],
    ['20 nghìn', 20_000],
    // không dấu
    ['hai muoi lam', 25],
    ['hai lam', 25],
    ['mot nghin ruoi', 1500],
    ['muoi lam', 15],
    ['mot tram linh nam', 105],
    ['chin muoi chin', 99],
    // hoa thường, khoảng trắng, dấu câu cuối
    ['HAI MƯƠI LĂM', 25],
    ['  hai   lăm  ', 25],
    ['hai mươi lăm.', 25],
    // không phải số: trả null, không đoán
    ['', null],
    ['   ', null],
    ['abc', null],
    ['hai mươi cái', null],
    ['một hai ba', null],
    ['mươi', null],
    ['hai mười', null],
    ['vài chục', null],
    ['rưỡi', null],
    ['hai trăm ba trăm', null],
    ['hai nghìn ba nghìn', null],
    ['hai mươi lăm đồng', null],
    ['bà', null],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it.each(cases.filter(([s]) => s.trim() !== ''))('dạng tổ hợp (NFD) của %j → %j', (input, expected) => {
    expect(parseNumber(nfd(input))).toBe(expected);
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ───────────────────────── parseMoney ─────────────────────────

describe('parseMoney', () => {
  const cases: [string, number | null][] = [
    // SPEC 6.6
    ['hai chục triệu', 20_000_000],
    ['20 triệu', 20_000_000],
    ['hai mươi tr', 20_000_000],
    ['hai trăm rưỡi nghìn', 250_000],
    // ca khó ở 13.4: "rưỡi", "chục", "tr"
    ['1,5 tỷ', 1_500_000_000],
    ['500k', 500_000],
    ['hai tỷ rưỡi', 2_500_000_000],
    ['một triệu rưỡi', 1_500_000],
    ['ba chục nghìn', 30_000],
    ['20tr', 20_000_000],
    ['20 tr', 20_000_000],
    ['2,5 tr', 2_500_000],
    // viết đủ
    ['20.000.000 đồng', 20_000_000],
    ['20.000.000đ', 20_000_000],
    ['20.000.000 VNĐ', 20_000_000],
    ['20,000,000', 20_000_000],
    ['hai mươi triệu đồng', 20_000_000],
    ['hai mươi triệu đồng chẵn', 20_000_000],
    ['năm trăm nghìn', 500_000],
    ['năm trăm ngàn đồng', 500_000],
    ['một trăm nghìn', 100_000],
    ['100 nghìn', 100_000],
    ['100k', 100_000],
    ['mười triệu', 10_000_000],
    ['ba mươi lăm triệu năm trăm nghìn', 35_500_000],
    ['một tỷ hai trăm triệu', 1_200_000_000],
    ['một nghìn tỷ', 1_000_000_000_000],
    ['1.234.567 đồng', 1_234_567],
    ['một trăm hai mươi ba triệu bốn trăm năm mươi sáu nghìn bảy trăm tám mươi chín đồng', 123_456_789],
    ['không đồng', 0],
    // cách nói tiền
    ['một triệu hai', 1_200_000],
    ['một triệu hai trăm', 1_200_000],
    ['một triệu hai trăm nghìn', 1_200_000],
    ['một triệu hai trăm năm mươi', 1_250_000],
    ['hai tỷ ba', 2_300_000_000],
    ['2 tỷ 3', 2_300_000_000],
    ['hai tỷ ba trăm', 2_300_000_000],
    ['một triệu không trăm linh năm đồng', 1_000_005],
    ['hai mươi triệu rưỡi', 20_500_000],
    ['1,3 tỷ', 1_300_000_000],
    ['0,5 triệu', 500_000],
    ['1 triệu 200 nghìn', 1_200_000],
    // không dấu, hoa thường
    ['hai chuc trieu', 20_000_000],
    ['hai muoi trieu dong', 20_000_000],
    ['hai tram ruoi nghin', 250_000],
    ['HAI MƯƠI TRIỆU', 20_000_000],
    ['Hai Tỷ Rưỡi', 2_500_000_000],
    // không ra số tiền: trả null
    ['', null],
    ['đồng', null],
    ['hai mươi cái', null],
    ['khoảng hai triệu', null],
    ['1,5', null],
    ['ba rưỡi', null],
    ['triệu triệu', null],
    ['hai triệu đồng đồng', null],
    ['-5 triệu', null],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each(cases.filter(([s]) => s !== ''))('dạng tổ hợp (NFD) của %j → %j', (input, expected) => {
    expect(parseMoney(nfd(input))).toBe(expected);
  });

  it('kết quả luôn là số nguyên', () => {
    for (const [input, expected] of cases) {
      if (expected !== null) expect(Number.isInteger(parseMoney(input)), input).toBe(true);
    }
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ───────────────────────── resolveDate ─────────────────────────

describe('resolveDate', () => {
  /** Thứ Bảy 03/10/2026, 09:00 giờ Việt Nam. Mốc đích kịch bản vàng là Thứ Năm 15/10/2026 (SPEC 4.5). */
  const NOW = new Date('2026-10-03T02:00:00Z');
  const cal = DEFAULT_CALENDAR;

  const cases: [string, string | null][] = [
    // SPEC 6.6
    ['thứ Năm tuần sau', '2026-10-08'],
    ['mười lăm tháng mười', '2026-10-15'],
    ['ngày mai', '2026-10-04'],
    ['ngày kia', '2026-10-05'],
    ['cuối tuần này', '2026-10-02'],
    // thêm theo đề bài
    ['15/10', '2026-10-15'],
    ['hôm nay', '2026-10-03'],
    ['thứ hai tới', '2026-10-05'],
    ['đầu tháng sau', '2026-11-02'],
    // ngày tương đối
    ['mai', '2026-10-04'],
    ['sáng mai', '2026-10-04'],
    ['tối nay', '2026-10-03'],
    ['ngày mốt', '2026-10-05'],
    ['ngày kìa', '2026-10-06'],
    ['hôm qua', '2026-10-02'],
    ['hôm kia', '2026-10-01'],
    ['3 ngày nữa', '2026-10-06'],
    ['ba ngày nữa', '2026-10-06'],
    ['hai tuần nữa', '2026-10-17'],
    ['ba ngày làm việc nữa', '2026-10-07'],
    // thứ trong tuần
    ['thứ hai', '2026-10-05'],
    ['thứ 2', '2026-10-05'],
    ['T2', '2026-10-05'],
    ['thứ bảy', '2026-10-03'],
    ['thứ bảy tới', '2026-10-10'],
    ['thứ sáu', '2026-10-09'],
    ['thứ sáu tuần sau', '2026-10-09'],
    ['thứ sáu tuần này', '2026-10-02'],
    ['thứ sáu tuần trước', '2026-09-25'],
    ['thứ hai vừa rồi', '2026-09-28'],
    ['thứ tư tuần tới', '2026-10-07'],
    ['chủ nhật', '2026-10-04'],
    ['CN tuần này', '2026-10-04'],
    ['chủ nhật tuần sau', '2026-10-11'],
    ['chiều thứ sáu tuần sau', '2026-10-09'],
    // đầu, cuối khoảng
    ['cuối tuần sau', '2026-10-09'],
    ['đầu tuần sau', '2026-10-05'],
    ['cuối tháng', '2026-10-30'],
    ['cuối tháng này', '2026-10-30'],
    ['cuối tháng sau', '2026-11-30'],
    ['đầu tháng 11', '2026-11-02'],
    ['cuối tháng sáu', '2027-06-30'],
    ['cuối năm', '2026-12-31'],
    // ngày viết rõ
    ['15/10/2026', '2026-10-15'],
    ['15-10-2026', '2026-10-15'],
    ['2026-10-15', '2026-10-15'],
    ['ngày 15 tháng 10', '2026-10-15'],
    ['ngày 15 tháng 10 năm 2026', '2026-10-15'],
    ['ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu', '2026-10-15'],
    ['Thứ Năm, ngày 15 tháng 10 năm 2026', '2026-10-15'],
    ['thứ Năm 15/10', '2026-10-15'],
    ['15/1', '2027-01-15'],
    ['ngày 20 tháng sáu', '2027-06-20'],
    ['ngày 20 tháng sau', '2026-11-20'],
    ['ngày 15 tháng này', '2026-10-15'],
    ['mùng 5', '2026-10-05'],
    ['ngày 2', '2026-11-02'],
    ['mùng một tháng mười một', '2026-11-01'],
    ['ngày hai mươi tháng mười hai', '2026-12-20'],
    ['9h sáng mai', '2026-10-04'],
    // không dấu
    ['thu nam tuan sau', '2026-10-08'],
    ['ngay mai', '2026-10-04'],
    ['ngay kia', '2026-10-05'],
    ['cuoi tuan nay', '2026-10-02'],
    ['muoi lam thang muoi', '2026-10-15'],
    ['hom nay', '2026-10-03'],
    // mơ hồ hoặc sai: trả null để trợ lý hỏi lại
    ['', null],
    ['tuần sau', null],
    ['tháng sau', null],
    ['tháng sáu', null],
    ['dau thang sau', null],
    ['31/2', null],
    ['30 tháng 2', null],
    ['thứ Sáu 15/10', null],
    ['ngày 15 tháng 8 âm lịch', null],
    ['khi nào xong thì báo', null],
    ['15', null],
  ];

  it.each(cases)('%j → %j', (phrase, expected) => {
    const out = resolveDate(phrase, NOW, cal);
    expect(out?.date ?? null).toBe(expected);
  });

  it.each(cases.filter(([s]) => s !== ''))('dạng tổ hợp (NFD) của %j → %j', (phrase, expected) => {
    expect(resolveDate(nfd(phrase), NOW, cal)?.date ?? null).toBe(expected);
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it('trả đủ thứ, ngày âm và cờ ngày làm việc', () => {
    const thu = resolveDate('thứ Năm tuần sau', NOW, cal);
    expect(thu).toEqual({ date: '2026-10-08', weekday: 'Thứ Năm', lunarLabel: formatLunar('2026-10-08'), isWorkingDay: true });
    const target = resolveDate('mười lăm tháng mười', NOW, cal);
    expect(target?.weekday).toBe('Thứ Năm');
    expect(target?.isWorkingDay).toBe(true);
    const sunday = resolveDate('ngày mai', NOW, cal);
    expect(sunday?.weekday).toBe('Chủ Nhật');
    expect(sunday?.isWorkingDay).toBe(false);
    const today = resolveDate('hôm nay', NOW, cal);
    expect(today?.weekday).toBe('Thứ Bảy');
    expect(today?.isWorkingDay).toBe(false);
    expect(today?.lunarLabel).toMatch(/âm lịch$/);
  });

  it('"hôm nay" theo giờ Việt Nam, không theo UTC', () => {
    // 18:00 UTC ngày 03/10 là 01:00 ngày 04/10 giờ Việt Nam.
    expect(resolveDate('hôm nay', new Date('2026-10-03T18:00:00Z'), cal)?.date).toBe('2026-10-04');
    expect(resolveDate('hôm nay', new Date('2026-10-03T16:59:00Z'), cal)?.date).toBe('2026-10-03');
  });

  it('thứ trống không tính cả hôm nay; "tới" là sau hôm nay', () => {
    const thursday = new Date('2026-10-15T02:00:00Z');
    expect(resolveDate('thứ năm', thursday, cal)?.date).toBe('2026-10-15');
    expect(resolveDate('thứ năm tới', thursday, cal)?.date).toBe('2026-10-22');
    expect(resolveDate('thứ năm tuần sau', thursday, cal)?.date).toBe('2026-10-22');
    expect(resolveDate('thứ năm tuần này', thursday, cal)?.date).toBe('2026-10-15');
    expect(resolveDate('cuối tuần này', thursday, cal)?.date).toBe('2026-10-16');
  });

  it('tuần làm việc có Thứ Bảy: "cuối tuần này" là Thứ Bảy', () => {
    const sixDays: WorkCalendar = { ...cal, workdays: [1, 2, 3, 4, 5, 6] };
    const out = resolveDate('cuối tuần này', NOW, sixDays);
    expect(out?.date).toBe('2026-10-03');
    expect(out?.isWorkingDay).toBe(true);
    expect(resolveDate('ba ngày làm việc nữa', NOW, sixDays)?.date).toBe('2026-10-07');
  });

  it('ngày nghỉ do Văn phòng nhập được tính vào', () => {
    const withHolidays: WorkCalendar = {
      ...cal,
      holidays: [
        { day: '2026-10-02', kind: 'company' },
        { day: '2026-11-02', kind: 'public' },
        { day: '2026-10-10', kind: 'makeup_workday' },
        { day: '2026-10-06', kind: 'public' },
      ],
    };
    expect(resolveDate('cuối tuần này', NOW, withHolidays)?.date).toBe('2026-10-01');
    expect(resolveDate('đầu tháng sau', NOW, withHolidays)?.date).toBe('2026-11-03');
    expect(resolveDate('hôm qua', NOW, withHolidays)?.isWorkingDay).toBe(false);
    expect(resolveDate('thứ bảy tới', NOW, withHolidays)?.isWorkingDay).toBe(true);
    // 05, 07, 08: nhảy qua ngày nghỉ 06/10
    expect(resolveDate('ba ngày làm việc nữa', NOW, withHolidays)?.date).toBe('2026-10-08');
    // cuối tuần sau có ngày làm bù Thứ Bảy 10/10
    expect(resolveDate('cuối tuần sau', NOW, withHolidays)?.date).toBe('2026-10-10');
  });

  it('thời điểm không hợp lệ thì trả null', () => {
    expect(resolveDate('ngày mai', new Date(Number.NaN), cal)).toBeNull();
  });
});

// ───────────────────────── expandAbbrev ─────────────────────────

describe('expandAbbrev', () => {
  const cases: [string, string][] = [
    // SPEC 6.6
    ['PGĐ', 'phó giám đốc'],
    ['GĐ', 'giám đốc'],
    ['KCN', 'khu công nghiệp'],
    ['HĐQT', 'hội đồng quản trị'],
    // theo đề bài
    ['CT', 'chủ tịch'],
    ['TP', 'trưởng phòng'],
    ['VP', 'văn phòng'],
    // thêm
    ['TGĐ', 'tổng giám đốc'],
    ['PTGĐ', 'phó tổng giám đốc'],
    ['BGĐ', 'ban giám đốc'],
    ['PCT', 'phó chủ tịch'],
    ['HĐTV', 'hội đồng thành viên'],
    ['CVP', 'chánh văn phòng'],
    ['VPCT', 'văn phòng chủ tịch'],
    ['KTT', 'kế toán trưởng'],
    ['CNTT', 'công nghệ thông tin'],
    ['UBND', 'ủy ban nhân dân'],
    ['CTCP', 'công ty cổ phần'],
    // trong câu
    ['PGĐ Huy duyệt', 'phó giám đốc Huy duyệt'],
    ['Trình GĐ và PGĐ.', 'Trình giám đốc và phó giám đốc.'],
    ['họp HĐQT tại KCN Tân Bình', 'họp hội đồng quản trị tại khu công nghiệp Tân Bình'],
    ['TP Kinh doanh báo cáo CT', 'trưởng phòng Kinh doanh báo cáo chủ tịch'],
    ['(PGĐ)', '(phó giám đốc)'],
    ['“GĐ”, PGĐ; VP', '“giám đốc”, phó giám đốc; văn phòng'],
    ['phòng KD và phòng HCNS', 'phòng kinh doanh và phòng hành chính nhân sự'],
    // không phân biệt hoa thường
    ['pgđ', 'phó giám đốc'],
    ['Gđ', 'giám đốc'],
    ['kcn', 'khu công nghiệp'],
    // "TP" trước tên thành phố
    ['TP. Hồ Chí Minh', 'thành phố Hồ Chí Minh'],
    ['TP.HCM', 'thành phố Hồ Chí Minh'],
    ['TP Hà Nội', 'thành phố Hà Nội'],
    // không đụng vào chữ thường, mã, từ dài hơn
    ['giám đốc', 'giám đốc'],
    ['CTV', 'CTV'],
    ['XGĐ', 'XGĐ'],
    ['số 12/QĐ-CT', 'số 12/QĐ-CT'],
    ['mã CT-0012', 'mã CT-0012'],
    ['GĐ2', 'GĐ2'],
    ['', ''],
    ['Không có viết tắt nào.', 'Không có viết tắt nào.'],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(expandAbbrev(input)).toBe(expected);
  });

  it.each(cases)('dạng tổ hợp (NFD) của %j → %j', (input, expected) => {
    expect(expandAbbrev(nfd(input))).toBe(expected);
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it('từ điển mở rộng được qua tham số: thêm, ghi đè và tắt một mục', () => {
    expect(expandAbbrev('KH tháng 10', { KH: 'kế hoạch' })).toBe('kế hoạch tháng 10');
    expect(expandAbbrev('CT đón đoàn', { CT: 'chương trình' })).toBe('chương trình đón đoàn');
    expect(expandAbbrev('TP dự họp', { TP: '' })).toBe('TP dự họp');
    expect(expandAbbrev('PGĐ và bql', { BQL: 'ban quản lý' })).toBe('phó giám đốc và ban quản lý');
    // từ điển mặc định không bị sửa
    expect(expandAbbrev('CT')).toBe('chủ tịch');
    expect(DEFAULT_ABBREVIATIONS.CT).toBe('chủ tịch');
  });
});

// ───────────────────────── matchPerson ─────────────────────────

describe('matchPerson', () => {
  const people: PersonCandidate[] = [
    { id: 'lan-kd', fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi', unitName: 'Phòng Kinh doanh' },
    { id: 'lan-kt', fullName: 'Trần Thị Lan', givenName: 'Lan', honorific: 'chi', unitName: 'Phòng Kế toán' },
    { id: 'lan-anh', fullName: 'Lê Văn Lân', givenName: 'Lân', honorific: 'anh', unitName: 'Phòng Kỹ thuật' },
    { id: 'tuan', fullName: 'Phạm Minh Tuấn', givenName: 'Tuấn', honorific: 'anh', unitName: 'Phòng Hành chính' },
    { id: 'lananh', fullName: 'Vũ Lan Anh', givenName: 'Anh', honorific: 'chi', unitName: 'Phòng Kinh doanh' },
    { id: 'huy', fullName: 'Đỗ Quang Huy', givenName: 'Huy', honorific: 'ong', unitName: 'Ban Giám đốc' },
    { id: 'office', fullName: 'Văn phòng Chủ tịch', givenName: 'Văn phòng', honorific: null, unitName: 'Văn phòng' },
    { id: 'dao', fullName: 'Hoàng Thị Đào', givenName: 'Đào', honorific: 'ba', unitName: 'Phòng Hành chính' },
  ];
  const ids = (q: string) => matchPerson(q, people).map((m) => m.id);
  const scoreOf = (q: string, id: string) => matchPerson(q, people).find((m) => m.id === id)?.score ?? 0;

  /** [câu hỏi, id đứng đầu theo đúng thứ tự (các id cùng điểm đứng đầu)] */
  const cases: [string, string[]][] = [
    // SPEC 6.6
    ['chị Lan', ['lan-kd', 'lan-kt']],
    ['anh Tuấn', ['tuan']],
    ['Lan kinh doanh', ['lan-kd']],
    // có dấu, không dấu, hoa thường
    ['Lan', ['lan-kd', 'lan-kt']],
    ['lan', ['lan-kd', 'lan-kt']],
    ['LAN', ['lan-kd', 'lan-kt']],
    ['chi lan', ['lan-kd', 'lan-kt']],
    ['CHỊ LAN', ['lan-kd', 'lan-kt']],
    ['anh tuan', ['tuan']],
    ['tuan', ['tuan']],
    ['Tuấn', ['tuan']],
    // họ tên đầy đủ hoặc một phần
    ['Nguyễn Thu Lan', ['lan-kd']],
    ['nguyen thu lan', ['lan-kd']],
    ['Thu Lan', ['lan-kd']],
    ['chị Thu Lan', ['lan-kd']],
    ['Trần Thị Lan', ['lan-kt']],
    ['chị Nguyễn Thu Lan', ['lan-kd']],
    ['Phạm Minh Tuấn', ['tuan']],
    ['Đỗ Quang Huy', ['huy']],
    // kèm đơn vị
    ['Lan kế toán', ['lan-kt']],
    ['chị Lan phòng kế toán', ['lan-kt']],
    ['chị Lan bên kinh doanh', ['lan-kd']],
    ['Lan KD', ['lan-kd']],
    ['lan ke toan', ['lan-kt']],
    // xưng hô
    ['ông Huy', ['huy']],
    ['anh Lân', ['lan-anh']],
    ['anh Lan', ['lan-anh']],
    ['Lân', ['lan-anh']],
    ['bà Đào', ['dao']],
    ['ba dao', ['dao']],
    ['cô Lan', ['lan-kd', 'lan-kt']],
    ['em Lan', ['lan-kd', 'lan-kt']],
    ['cháu Tuấn', ['tuan']],
    // tên hai tiếng và tên gọi trùng tiếng xưng hô
    ['Lan Anh', ['lananh']],
    ['chị Lan Anh', ['lananh']],
    ['Vũ Lan Anh', ['lananh']],
    // tài khoản không có xưng hô
    ['văn phòng', ['office']],
    ['Văn phòng Chủ tịch', ['office']],
  ];

  it.each(cases)('%j → đứng đầu %j', (query, expectedTop) => {
    const out = matchPerson(query, people);
    expect(out.slice(0, expectedTop.length).map((m) => m.id)).toEqual(expectedTop);
    if (expectedTop.length > 1) {
      // trùng tên: cùng điểm, không chọn thay người dùng
      expect(new Set(out.slice(0, expectedTop.length).map((m) => m.score)).size).toBe(1);
    }
    const next = out[expectedTop.length];
    if (next) expect(next.score).toBeLessThan((out[0] as { score: number }).score);
  });

  it.each(cases)('dạng tổ hợp (NFD) của %j cho cùng kết quả', (query) => {
    expect(matchPerson(nfd(query), people)).toEqual(matchPerson(query, people));
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it('hai người trùng tên: trả về CẢ HAI với cùng điểm, theo thứ tự danh bạ', () => {
    const out = matchPerson('chị Lan', people);
    expect(out[0]?.id).toBe('lan-kd');
    expect(out[1]?.id).toBe('lan-kt');
    expect(out[0]?.score).toBe(out[1]?.score);
    const reversed = matchPerson('chị Lan', [...people].reverse());
    expect(reversed.slice(0, 2).map((m) => m.id)).toEqual(['lan-kt', 'lan-kd']);
  });

  it('tên lưu ở dạng tổ hợp (NFD) vẫn khớp với câu hỏi dạng dựng sẵn (NFC)', () => {
    const decomposed = people.map((p) => ({ ...p, fullName: nfd(p.fullName), givenName: nfd(p.givenName), unitName: p.unitName ? nfd(p.unitName) : null }));
    expect(matchPerson('anh Tuấn', decomposed)).toEqual(matchPerson('anh Tuấn', people));
    expect(matchPerson('bà Đào', decomposed)[0]?.id).toBe('dao');
  });

  it('ưu tiên tên gọi cùng xưng hô', () => {
    expect(scoreOf('chị Lan', 'lan-kd')).toBeGreaterThan(scoreOf('Lan', 'lan-kd'));
    expect(scoreOf('chị Lan', 'lan-kd')).toBeGreaterThan(scoreOf('chị Lan', 'lan-anh'));
    expect(scoreOf('anh Lan', 'lan-anh')).toBeGreaterThan(scoreOf('anh Lan', 'lan-kd'));
    // xưng hô lưu ở dạng có dấu cũng nhận
    const labelled = people.map((p) => (p.id === 'lan-kd' ? { ...p, honorific: 'chị' } : p));
    expect(matchPerson('chị Lan', labelled)[0]?.score).toBe(scoreOf('chị Lan', 'lan-kd'));
  });

  it('khác dấu là tên khác: "Lân" xếp sau khi hỏi "Lan" có dấu rõ, nhưng vẫn là ứng viên', () => {
    expect(ids('Lân')[0]).toBe('lan-anh');
    expect(ids('Lân')).toContain('lan-kd');
    expect(scoreOf('Lân', 'lan-kd')).toBeLessThan(scoreOf('Lân', 'lan-anh'));
    // gõ không dấu thì cả Lan và Lân đều gần khớp
    expect(ids('lan')).toEqual(expect.arrayContaining(['lan-kd', 'lan-kt', 'lan-anh']));
  });

  it('điểm nằm trong (0, 1] và xếp giảm dần', () => {
    for (const [query] of cases) {
      const out = matchPerson(query, people);
      out.forEach((m, i) => {
        expect(m.score).toBeGreaterThan(0);
        expect(m.score).toBeLessThanOrEqual(1);
        if (i > 0) expect(m.score).toBeLessThanOrEqual((out[i - 1] as { score: number }).score);
      });
    }
  });

  it('không khớp ai thì trả danh sách rỗng', () => {
    expect(matchPerson('', people)).toEqual([]);
    expect(matchPerson('   ', people)).toEqual([]);
    expect(matchPerson('chị Hoa', people)).toEqual([]);
    expect(matchPerson('anh', [])).toEqual([]);
    expect(matchPerson('?!', people)).toEqual([]);
  });
});

// ───────────────────────── Xác nhận bằng giọng ─────────────────────────

describe('normalizeVoiceCommand và matchVoiceConfirm', () => {
  const cases: [string, string, 'confirm' | 'reject' | null][] = [
    // tập câu đóng (SPEC 6.5 điều 10)
    ['đồng ý', 'đồng ý', 'confirm'],
    ['gửi đi', 'gửi đi', 'confirm'],
    ['không', 'không', 'reject'],
    ['thôi', 'thôi', 'reject'],
    // hoa thường, dấu câu, "dạ" và "ạ"
    ['Đồng ý.', 'đồng ý', 'confirm'],
    ['ĐỒNG Ý', 'đồng ý', 'confirm'],
    ['Dạ, đồng ý ạ.', 'đồng ý', 'confirm'],
    ['Dạ đồng ý', 'đồng ý', 'confirm'],
    ['đồng ý ạ', 'đồng ý', 'confirm'],
    ['  đồng   ý  ', 'đồng ý', 'confirm'],
    ['Gửi đi!', 'gửi đi', 'confirm'],
    ['Dạ, gửi đi ạ', 'gửi đi', 'confirm'],
    ['"Gửi đi"', 'gửi đi', 'confirm'],
    ['Không.', 'không', 'reject'],
    ['Dạ không', 'không', 'reject'],
    ['Không ạ', 'không', 'reject'],
    ['Thôi!', 'thôi', 'reject'],
    ['Thôi ạ.', 'thôi', 'reject'],
    ['Dạ, thôi ạ', 'thôi', 'reject'],
    ['KHÔNG', 'không', 'reject'],
    // ngoài tập đóng: không xác nhận (SPEC 13.3 điều 10)
    ['ừ, cứ thế đi nhé', 'ừ cứ thế đi nhé', null],
    ['ừ', 'ừ', null],
    ['vâng', 'vâng', null],
    ['được', 'được', null],
    ['đồng ý gửi', 'đồng ý gửi', null],
    ['đồng ý đi', 'đồng ý đi', null],
    ['gửi', 'gửi', null],
    ['gửi đi nhé', 'gửi đi nhé', null],
    ['không gửi', 'không gửi', null],
    ['không đồng ý', 'không đồng ý', null],
    ['thôi không gửi', 'thôi không gửi', null],
    ['thôi được, đồng ý', 'thôi được đồng ý', null],
    ['tôi đồng ý', 'tôi đồng ý', null],
    ['dong y', 'dong y', null],
    ['khong', 'khong', null],
    ['đồng  ý kiến', 'đồng ý kiến', null],
    ['', '', null],
    ['dạ', '', null],
    ['ạ', '', null],
    ['...', '', null],
  ];

  it.each(cases)('%j → %j → %j', (input, normalized, result) => {
    expect(normalizeVoiceCommand(input)).toBe(normalized);
    expect(matchVoiceConfirm(input)).toBe(result);
  });

  it.each(cases)('dạng tổ hợp (NFD) của %j cho cùng kết quả', (input, normalized, result) => {
    expect(normalizeVoiceCommand(nfd(input))).toBe(normalized);
    expect(matchVoiceConfirm(nfd(input))).toBe(result);
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ───────────────────────── redact ─────────────────────────

describe('redact (dữ liệu giả)', () => {
  const P = REDACTED.phone;
  const E = REDACTED.email;
  const N = REDACTED.nationalId;

  const cases: [string, string][] = [
    // số điện thoại
    ['Gọi 0912345678 nhé', `Gọi ${P} nhé`],
    ['0912 345 678', P],
    ['0912.345.678', P],
    ['091-234-5678', P],
    ['+84912345678', P],
    ['+84 912 345 678', P],
    ['(+84) 912 345 678', P],
    ['84912345678', P],
    ['02438251234', P],
    ['(024) 3825 1234', P],
    ['Tel.0912345678', `Tel.${P}`],
    ['SĐT:0987654321.', `SĐT:${P}.`],
    ['hai số 0912345678 và 0987654321', `hai số ${P} và ${P}`],
    // thư điện tử
    ['lan.nguyen@mihato.vn', E],
    ['Gửi tới thu.lan+test@demo.mihato.local nhé', `Gửi tới ${E} nhé`],
    ['TUAN_PM@VRG.COM.VN', E],
    ['thư: a@b.vn, c@d.com', `thư: ${E}, ${E}`],
    // số căn cước 12 số
    ['CCCD 001099012345', `CCCD ${N}`],
    ['số căn cước: 079203004567.', `số căn cước: ${N}.`],
    ['001 099 012 345', N],
    // nhiều loại trong một câu
    ['Chị Lan (0912345678, lan@mihato.vn), CCCD 001099012345', `Chị Lan (${P}, ${E}), CCCD ${N}`],
    // không đụng vào số tiền, ngày, giờ, mã, UUID
    ['20.000.000 đồng', '20.000.000 đồng'],
    ['20000000 đồng', '20000000 đồng'],
    ['100000000000 đồng', '100000000000 đồng'],
    ['1.234.567.890 đồng', '1.234.567.890 đồng'],
    ['0,5 triệu', '0,5 triệu'],
    ['Hạn: Thứ Năm, ngày 15 tháng 10 năm 2026', 'Hạn: Thứ Năm, ngày 15 tháng 10 năm 2026'],
    ['15/10/2026', '15/10/2026'],
    ['ngày 02-10-2026 08:30', 'ngày 02-10-2026 08:30'],
    ['02.10.2026 08.30', '02.10.2026 08.30'],
    ['2026-10-03T02:00:00Z', '2026-10-03T02:00:00Z'],
    ['2026-10-03 09:00:00', '2026-10-03 09:00:00'],
    ['việc 018f5a2e-7b3c-7d4e-8f9a-012345678901', 'việc 018f5a2e-7b3c-7d4e-8f9a-012345678901'],
    ['mihato://step/0199a8b0-0000-7000-8000-000912345678', 'mihato://step/0199a8b0-0000-7000-8000-000912345678'],
    ['4 trên 6 việc đã xong', '4 trên 6 việc đã xong'],
    ['Đã quá hạn 2 ngày làm việc', 'Đã quá hạn 2 ngày làm việc'],
    ['', ''],
    ['Không có gì cần che.', 'Không có gì cần che.'],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('có đủ ít nhất 30 ví dụ', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it('sau khi che không còn dấu vết của dữ liệu gốc', () => {
    const fake = 'Anh Tuấn, điện thoại 0912 345 678 hoặc +84 987 654 321, thư tuan.pham@mihato.vn, căn cước 001099012345.';
    const out = redact(fake);
    expect(out).not.toMatch(/\d{4,}/);
    expect(out).not.toContain('@');
    expect(out).toContain('Anh Tuấn');
    expect(out).toBe(`Anh Tuấn, điện thoại ${P} hoặc ${P}, thư ${E}, căn cước ${N}.`);
  });

  it('che lần hai không đổi gì thêm', () => {
    for (const [input] of cases) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
    }
  });
});
