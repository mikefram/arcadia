import { describe, expect, it } from 'vitest';
import { parseMoney, parseNumber } from '../src/vi-normalize';
import { dateToWords, moneyToWords, moneyTwice, numberToWords, splitForTts, toSpeakable } from '../src/vi-speak';

describe('numberToWords', () => {
  const cases: [number | bigint, string][] = [
    [0, 'không'],
    [1, 'một'],
    [4, 'bốn'],
    [5, 'năm'],
    [10, 'mười'],
    [11, 'mười một'],
    [14, 'mười bốn'],
    [15, 'mười lăm'],
    [19, 'mười chín'],
    [20, 'hai mươi'],
    [21, 'hai mươi mốt'],
    [24, 'hai mươi tư'],
    [25, 'hai mươi lăm'],
    [31, 'ba mươi mốt'],
    [55, 'năm mươi lăm'],
    [99, 'chín mươi chín'],
    [100, 'một trăm'],
    [101, 'một trăm linh một'],
    [104, 'một trăm linh bốn'],
    [105, 'một trăm linh năm'],
    [110, 'một trăm mười'],
    [111, 'một trăm mười một'],
    [115, 'một trăm mười lăm'],
    [121, 'một trăm hai mươi mốt'],
    [500, 'năm trăm'],
    [999, 'chín trăm chín mươi chín'],
    [1000, 'một nghìn'],
    [1001, 'một nghìn không trăm linh một'],
    [1010, 'một nghìn không trăm mười'],
    [1015, 'một nghìn không trăm mười lăm'],
    [1100, 'một nghìn một trăm'],
    [2026, 'hai nghìn không trăm hai mươi sáu'],
    [10_000, 'mười nghìn'],
    [15_000, 'mười lăm nghìn'],
    [21_000, 'hai mươi mốt nghìn'],
    [100_000, 'một trăm nghìn'],
    [250_000, 'hai trăm năm mươi nghìn'],
    [1_000_000, 'một triệu'],
    [1_000_001, 'một triệu không trăm linh một'],
    [1_200_000, 'một triệu hai trăm nghìn'],
    [20_000_000, 'hai mươi triệu'],
    [123_456_789, 'một trăm hai mươi ba triệu bốn trăm năm mươi sáu nghìn bảy trăm tám mươi chín'],
    [1_000_000_000, 'một tỷ'],
    [1_500_000_000, 'một tỷ năm trăm triệu'],
    [1_020_000_000, 'một tỷ không trăm hai mươi triệu'],
    [2_000_000_005, 'hai tỷ không trăm linh năm'],
    [1_000_000_000_000, 'một nghìn tỷ'],
    [20_000_000n, 'hai mươi triệu'],
    [-5, 'âm năm'],
    [-20_000_000n, 'âm hai mươi triệu'],
    [1.5, 'một phẩy năm'],
    [2.25, 'hai phẩy hai mươi lăm'],
    [0.05, 'không phẩy không năm'],
  ];

  it.each(cases)('%s → %j', (n, expected) => {
    expect(numberToWords(n)).toBe(expected);
  });

  it('đọc rồi nghe lại ra đúng số cũ: parseNumber(numberToWords(n)) = n', () => {
    for (let n = 0; n <= 2100; n += 1) {
      if (parseNumber(numberToWords(n)) !== n) throw new Error(`Sai ở ${n}: ${numberToWords(n)}`);
    }
    // Bộ sinh số giả ngẫu nhiên cố định hạt giống, để test lặp lại được.
    let seed = 20261003;
    for (let i = 0; i < 3000; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const n = seed % 2 === 0 ? seed : Math.floor(seed / 977) * 1000;
      if (parseNumber(numberToWords(n)) !== n) throw new Error(`Sai ở ${n}: ${numberToWords(n)}`);
    }
    for (const n of [1_000_000_000, 1_020_000_000, 2_000_000_005, 999_999_999_999, 1_000_000_000_000, 123_456_789_012_345]) {
      expect(parseNumber(numberToWords(n))).toBe(n);
    }
  });

  it('số không hợp lệ thì báo lỗi', () => {
    expect(() => numberToWords(Number.NaN)).toThrow(RangeError);
    expect(() => numberToWords(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => numberToWords(2 ** 60)).toThrow(RangeError);
  });
});

describe('moneyToWords và moneyTwice', () => {
  it('đọc tiền thành chữ', () => {
    expect(moneyToWords(20_000_000)).toBe('hai mươi triệu đồng');
    expect(moneyToWords(250_000)).toBe('hai trăm năm mươi nghìn đồng');
    expect(moneyToWords(1_500_000_000)).toBe('một tỷ năm trăm triệu đồng');
    expect(moneyToWords(0)).toBe('không đồng');
    expect(moneyToWords(20_000_000n)).toBe('hai mươi triệu đồng');
    expect(moneyToWords(5_000_000_000_000n)).toBe('năm nghìn tỷ đồng');
  });

  it('viết tiền hai lần theo SPEC 7.5', () => {
    expect(moneyTwice(20_000_000)).toBe('20.000.000 đồng (hai mươi triệu đồng)');
    expect(moneyTwice(500_000)).toBe('500.000 đồng (năm trăm nghìn đồng)');
    expect(moneyTwice(999)).toBe('999 đồng (chín trăm chín mươi chín đồng)');
    expect(moneyTwice(1_234_567n)).toBe('1.234.567 đồng (một triệu hai trăm ba mươi tư nghìn năm trăm sáu mươi bảy đồng)');
    expect(moneyTwice(0)).toBe('0 đồng (không đồng)');
  });

  it('tiền phải là số nguyên', () => {
    expect(() => moneyToWords(1.5)).toThrow(RangeError);
    expect(() => moneyTwice(Number.NaN)).toThrow(RangeError);
  });

  it('đọc rồi nghe lại ra đúng số tiền với mọi số tiền tròn nghìn', () => {
    // Số tiền tròn nghìn là số tiền thực tế bằng VND. Số lẻ kiểu 1.000.200 đọc là "một triệu hai trăm đồng",
    // mà người nói câu ấy gần như luôn muốn nói 1.200.000: parseMoney theo cách hiểu của người nói [GIẢ ĐỊNH].
    let seed = 7;
    for (let i = 0; i < 3000; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const vnd = (seed % 5_000_000) * 1000;
      if (parseMoney(moneyToWords(vnd)) !== vnd) throw new Error(`Sai ở ${vnd}: ${moneyToWords(vnd)}`);
    }
    for (const vnd of [0, 1000, 20_000_000, 250_000, 1_500_000_000, 1_234_567, 999, 1_000_005]) {
      expect(parseMoney(moneyToWords(vnd))).toBe(vnd);
    }
  });
});

describe('dateToWords', () => {
  it('đọc ngày đầy đủ kèm thứ', () => {
    expect(dateToWords('2026-10-15')).toBe('Thứ Năm, ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu');
    expect(dateToWords('2027-02-06')).toBe('Thứ Bảy, ngày mùng sáu tháng hai năm hai nghìn không trăm hai mươi bảy');
    expect(dateToWords('2026-10-03')).toBe('Thứ Bảy, ngày mùng ba tháng mười năm hai nghìn không trăm hai mươi sáu');
  });

  it('ngày 1 đến 10 đọc "mùng", tháng 4 đọc "tư", ngày 21 đọc "hai mươi mốt"', () => {
    expect(dateToWords('2026-04-10', { weekday: false })).toBe('ngày mùng mười tháng tư năm hai nghìn không trăm hai mươi sáu');
    expect(dateToWords('2026-04-11', { weekday: false, year: false })).toBe('ngày mười một tháng tư');
    expect(dateToWords('2026-12-21', { weekday: false, year: false })).toBe('ngày hai mươi mốt tháng mười hai');
    expect(dateToWords('2026-01-24', { weekday: false, year: false })).toBe('ngày hai mươi tư tháng một');
  });

  it('Date và chuỗi thời điểm tính theo giờ Việt Nam', () => {
    // 10:00 UTC ngày 15/10 là 17:00 cùng ngày giờ Việt Nam.
    expect(dateToWords(new Date('2026-10-15T10:00:00Z'))).toBe('Thứ Năm, ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu');
    // 18:00 UTC ngày 14/10 đã là 01:00 ngày 15/10 giờ Việt Nam.
    expect(dateToWords('2026-10-14T18:00:00Z', { year: false })).toBe('Thứ Năm, ngày mười lăm tháng mười');
  });

  it('ngày không hợp lệ thì báo lỗi', () => {
    expect(() => dateToWords('2026-02-30')).toThrow(RangeError);
    expect(() => dateToWords('không phải ngày')).toThrow(RangeError);
  });
});

describe('toSpeakable', () => {
  const cases: [string, string][] = [
    // SPEC 6.4.1 điều 5
    ['20.000.000 đồng', 'hai mươi triệu đồng'],
    ['KCN', 'khu công nghiệp'],
    ['PGĐ và GĐ', 'phó giám đốc và giám đốc'],
    // tiền
    ['20.000.000 đồng (hai mươi triệu đồng)', 'hai mươi triệu đồng'],
    ['20.000.000 đồng, hai mươi triệu đồng', 'hai mươi triệu đồng'],
    ['Đề nghị tạm ứng 20.000.000 đồng (hai mươi triệu đồng).', 'Đề nghị tạm ứng hai mươi triệu đồng.'],
    ['20.000.000đ', 'hai mươi triệu đồng'],
    ['20.000.000 VNĐ', 'hai mươi triệu đồng'],
    ['1,5 tỷ đồng', 'một phẩy năm tỷ đồng'],
    ['20 triệu', 'hai mươi triệu'],
    ['PGĐ duyệt 20tr', 'phó giám đốc duyệt hai mươi triệu'],
    ['500k', 'năm trăm nghìn'],
    // ngày
    ['Hạn: Thứ Năm, ngày 15 tháng 10 năm 2026', 'Hạn: Thứ Năm, ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu'],
    ['15/10/2026', 'ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu'],
    ['ngày 5/10/2026', 'ngày mùng năm tháng mười năm hai nghìn không trăm hai mươi sáu'],
    ['2026-10-15', 'ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu'],
    ['Hạn 15/10', 'Hạn ngày mười lăm tháng mười'],
    ['ngày 15/10', 'ngày mười lăm tháng mười'],
    ['mùng 5 tháng 9 âm lịch', 'mùng năm tháng chín âm lịch'],
    ['ngày 15 tháng 8 âm lịch', 'ngày mười lăm tháng tám âm lịch'],
    ['mùng 1 tháng Giêng âm lịch', 'mùng một tháng Giêng âm lịch'],
    ['tháng 4 năm 2026', 'tháng tư năm hai nghìn không trăm hai mươi sáu'],
    ['Thứ 2', 'Thứ hai'],
    // giờ
    ['07:30', 'bảy giờ ba mươi sáng'],
    ['17:00', 'năm giờ chiều'],
    ['12:15', 'mười hai giờ mười lăm trưa'],
    ['20:05', 'tám giờ không năm tối'],
    ['7 giờ 30 sáng', 'bảy giờ ba mươi sáng'],
    ['lúc 07:30 sáng', 'lúc bảy giờ ba mươi sáng'],
    ['9h30', 'chín giờ ba mươi'],
    ['14h', 'mười bốn giờ'],
    ['Đang không có mạng. Số liệu lúc 09:15.', 'Đang không có mạng. Số liệu lúc chín giờ mười lăm sáng.'],
    // số đếm, phần trăm, phân số
    ['4 trên 6 việc đã xong', 'bốn trên sáu việc đã xong'],
    ['4/6 việc', 'bốn trên sáu việc'],
    ['Đã quá hạn 2 ngày làm việc', 'Đã quá hạn hai ngày làm việc'],
    ['Có 1 việc cần Chủ tịch quyết', 'Có một việc cần Chủ tịch quyết'],
    ['Sẽ gửi sau 30 giây.', 'Sẽ gửi sau ba mươi giây.'],
    ['85%', 'tám mươi lăm phần trăm'],
    ['12,5 %', 'mười hai phẩy năm phần trăm'],
    ['mã 007', 'mã không không bảy'],
    // tên riêng và ký hiệu
    ['Trợ lý AI', 'Trợ lý ây ai'],
    ['Ai đang chậm?', 'Ai đang chậm?'],
    ['MIHATO và VRG', 'Mi ha tô và Vê Rờ Gờ'],
    ['MIHATO & VRG', 'Mi ha tô và Vê Rờ Gờ'],
    ['TP. Hồ Chí Minh', 'thành phố Hồ Chí Minh'],
    // không đụng vào chữ thường và mã
    ['Dạ, thưa Chủ tịch.', 'Dạ, thưa Chủ tịch.'],
    ['GĐ2', 'GĐ2'],
    ['', ''],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(toSpeakable(input)).toBe(expected);
  });

  it('dạng tổ hợp (NFD) cho cùng kết quả', () => {
    for (const [input, expected] of cases) expect(toSpeakable(input.normalize('NFD'))).toBe(expected);
  });

  it('câu dài lẫn nhiều loại: không còn chữ số nào để TTS tự đọc', () => {
    const text =
      'Dạ, thưa Chủ tịch. Lượt ‘Đón đoàn Nhật’ có 4 trên 6 việc đã xong. PGĐ Huy đề nghị tạm ứng 20.000.000 đồng (hai mươi triệu đồng), hạn Thứ Năm, ngày 15 tháng 10 năm 2026, lúc 17:00. Việc ‘Đặt xe’ đã quá hạn 2 ngày làm việc.';
    const out = toSpeakable(text);
    expect(out).not.toMatch(/\d/);
    expect(out).toBe(
      'Dạ, thưa Chủ tịch. Lượt ‘Đón đoàn Nhật’ có bốn trên sáu việc đã xong. phó giám đốc Huy đề nghị tạm ứng hai mươi triệu đồng, hạn Thứ Năm, ngày mười lăm tháng mười năm hai nghìn không trăm hai mươi sáu, lúc năm giờ chiều. Việc ‘Đặt xe’ đã quá hạn hai ngày làm việc.',
    );
  });

  it('từ điển viết tắt và cách đọc tên riêng ghi đè được qua tham số', () => {
    expect(toSpeakable('BQL KCN', { abbreviations: { BQL: 'ban quản lý' } })).toBe('ban quản lý khu công nghiệp');
    expect(toSpeakable('VRG', { pronunciations: { VRG: 'Tập đoàn Cao su' } })).toBe('Tập đoàn Cao su');
    expect(toSpeakable('Trợ lý AI', { pronunciations: { AI: '' } })).toBe('Trợ lý AI');
    expect(toSpeakable('CT đón đoàn', { abbreviations: { CT: 'chương trình' } })).toBe('chương trình đón đoàn');
  });

  it('tiền viết hai lần mà phần chữ không khớp phần số thì đọc cả hai, không tự bỏ', () => {
    expect(toSpeakable('20.000.000 đồng (hai mươi mốt triệu đồng)')).toBe('hai mươi triệu đồng (hai mươi mốt triệu đồng)');
  });
});

describe('splitForTts', () => {
  it('văn bản ngắn giữ nguyên một đoạn', () => {
    expect(splitForTts('Dạ, thưa Chủ tịch.')).toEqual(['Dạ, thưa Chủ tịch.']);
    expect(splitForTts('  Dạ,   thưa Chủ tịch.  ')).toEqual(['Dạ, thưa Chủ tịch.']);
  });

  it('văn bản rỗng trả danh sách rỗng', () => {
    expect(splitForTts('')).toEqual([]);
    expect(splitForTts('   \n  ')).toEqual([]);
  });

  it('tách theo câu, gộp các câu ngắn liền nhau, không đoạn nào quá giới hạn', () => {
    const text = 'Câu một ngắn. Câu hai cũng ngắn! Câu ba thì sao? Câu bốn kết thúc…';
    expect(splitForTts(text, 300)).toEqual([text]);
    expect(splitForTts(text, 32)).toEqual(['Câu một ngắn. Câu hai cũng ngắn!', 'Câu ba thì sao?', 'Câu bốn kết thúc…']);
    expect(splitForTts(text, 16)).toEqual(['Câu một ngắn.', 'Câu hai cũng', 'ngắn!', 'Câu ba thì sao?', 'Câu bốn kết', 'thúc…']);
  });

  it('mặc định tối đa 300 ký tự mỗi đoạn và không mất chữ nào', () => {
    const sentence = 'Việc cần Chủ tịch quyết hôm nay gồm ba việc, trong đó có một đề nghị tạm ứng.';
    const text = Array.from({ length: 20 }, (_, i) => `${sentence} Số thứ tự ${i + 1}.`).join(' ');
    const chunks = splitForTts(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300);
      expect(c).toBe(c.trim());
      expect(c).toMatch(/[.!?…]$/);
    }
    expect(chunks.join(' ')).toBe(text);
  });

  it('câu dài hơn giới hạn được cắt ở dấu phẩy, rồi ở khoảng trắng', () => {
    const long = 'Một câu rất dài không có dấu chấm, chỉ có dấu phẩy, kéo mãi, kéo mãi, kéo mãi không dừng';
    const chunks = splitForTts(long, 40);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    expect(chunks.join(' ')).toBe(long);
    expect(chunks[0]).toBe('Một câu rất dài không có dấu chấm,');

    const noComma = 'chữ '.repeat(50).trim();
    const pieces = splitForTts(noComma, 30);
    for (const c of pieces) expect(c.length).toBeLessThanOrEqual(30);
    expect(pieces.join(' ')).toBe(noComma);
  });

  it('một từ dài hơn giới hạn thì cắt cứng', () => {
    const chunks = splitForTts('a'.repeat(25), 10);
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });

  it('không tách ở dấu chấm trong số tiền và sau chữ viết tắt', () => {
    expect(splitForTts('Tạm ứng 20.000.000 đồng. Hạn ngày mai.', 30)).toEqual(['Tạm ứng 20.000.000 đồng.', 'Hạn ngày mai.']);
    expect(splitForTts('Họp tại TP. Hồ Chí Minh. Xong báo lại.', 26)).toEqual(['Họp tại TP. Hồ Chí Minh.', 'Xong báo lại.']);
  });

  it('xuống dòng cũng là chỗ tách', () => {
    expect(splitForTts('Dòng một\nDòng hai', 10)).toEqual(['Dòng một', 'Dòng hai']);
  });

  it('nhận văn bản dạng tổ hợp (NFD) và đếm ký tự theo dạng dựng sẵn', () => {
    const text = 'Việc đã quá hạn.';
    expect(splitForTts(text.normalize('NFD'), 16)).toEqual([text]);
  });
});
