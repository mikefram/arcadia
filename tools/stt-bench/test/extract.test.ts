import { describe, expect, it } from 'vitest';
import { extractDates, extractMoney, findMoney, tokenize } from '../src/extract';

/** 03/10/2026 là Thứ Bảy; thứ Tư gần nhất phía trước là 07/10/2026. */
const NOW = new Date('2026-10-03T09:00:00+07:00');

describe('tokenize', () => {
  const cases: [string, string[]][] = [
    ['Hai chục triệu', ['hai', 'chục', 'triệu']],
    ['  nhiều   khoảng   trắng  ', ['nhiều', 'khoảng', 'trắng']],
    ['20.000.000đ', ['20.000.000', 'đ']],
    ['500k', ['500', 'k']],
    ['1,5 triệu', ['1,5', 'triệu']],
    ['ngày 7/10/2026', ['ngày', '7/10/2026']],
    ['2026-10-07', ['2026-10-07']],
    ['Chủ Nhật', ['chủ', 'nhật']],
    ['Hà-Nội, Việt Nam.', ['hà', 'nội', 'việt', 'nam']],
    ['', []],
    ['!!!', []],
    ['Tuấn'.normalize('NFD'), ['tuấn'.normalize('NFC')]],
  ];
  it.each(cases)('%j', (text, expected) => {
    expect(tokenize(text)).toEqual(expected);
  });
});

describe('extractMoney', () => {
  const cases: [string, string, number[]][] = [
    ['hai chục triệu', 'duyệt hai chục triệu', [20_000_000]],
    ['sai đơn vị: nghìn thay triệu', 'duyệt hai chục nghìn', [20_000]],
    ['chữ số kèm triệu', 'duyệt 20 triệu', [20_000_000]],
    ['kèm đồng', 'duyệt hai mươi triệu đồng', [20_000_000]],
    ['viết tắt tr', 'duyệt hai mươi tr', [20_000_000]],
    ['20tr dính liền', 'duyệt 20tr', [20_000_000]],
    ['500k', 'chuyển 500k', [500_000]],
    ['năm trăm nghìn', 'chuyển năm trăm nghìn', [500_000]],
    ['năm trăm trơ trọi không đơn vị', 'chuyển năm trăm', []],
    ['một triệu hai nói tắt', 'chuyển một triệu hai', [1_200_000]],
    ['hai triệu ba trăm nghìn', 'chuyển hai triệu ba trăm nghìn', [2_300_000]],
    ['hai khoản nối bằng "và"', 'chuyển hai triệu và ba trăm nghìn', [2_000_000, 300_000]],
    ['không có tiền', 'không có tiền', []],
    ['câu rỗng', '', []],
    ['"hai đồng chí" không phải 2 đồng', 'hai đồng chí', []],
    ['"ba đồng chí duyệt"', 'ba đồng chí duyệt', []],
    ['năm 2026 viết số', 'năm 2026 hai chục triệu', [20_000_000]],
    ['năm đọc bằng chữ không thành tiền', 'năm hai nghìn không trăm hai mươi sáu hai chục triệu', [20_000_000]],
    ['số lớn có dấu ngăn nghìn kèm đồng', 'tạm ứng 20.000.000 đồng', [20_000_000]],
    ['số lớn có dấu ngăn nghìn trơ trọi', 'tạm ứng 20.000.000', [20_000_000]],
    ['số liền 8 chữ số', 'tạm ứng 20000000', [20_000_000]],
    ['một triệu rưỡi viết 1,5 triệu', 'tạm ứng 1,5 triệu', [1_500_000]],
    ['một tỷ', 'tạm ứng một tỷ', [1_000_000_000]],
    ['hai tỷ rưỡi', 'tạm ứng hai tỷ rưỡi', [2_500_000_000]],
    ['ba mươi nghìn đồng', 'tạm ứng ba mươi nghìn đồng', [30_000]],
    ['tiền đứng trước ngày', 'tạm ứng hai chục triệu ngày mười lăm tháng mười', [20_000_000]],
    ['số liền sau tiền thuộc về tháng', 'hai mươi triệu mười lăm tháng mười', [20_000_000]],
    ['số điện thoại không phải tiền', 'gọi số 0912345678', []],
    ['tiền kèm tên người', 'duyệt hai chục triệu cho chị Phương', [20_000_000]],
    ['hai trăm rưỡi nghìn', 'duyệt hai trăm rưỡi nghìn', [250_000]],
    ['chữ hoa', 'Duyệt Hai Chục Triệu', [20_000_000]],
    ['2 triệu rưỡi', 'duyệt 2 triệu rưỡi', [2_500_000]],
    ['hai triệu rưỡi', 'duyệt hai triệu rưỡi', [2_500_000]],
    ['tiền sau xưng hô là số tiền', 'chuyển cho anh năm triệu', [5_000_000]],
    ['số đứng trước "ngày" thuộc về ngày', 'ba triệu hai ngày', [3_000_000]],
    ['số đứng trước "người" thuộc về người', 'hai chục triệu ba người', [20_000_000]],
    ['500 nghìn', '500 nghìn', [500_000]],
    ['5 tỷ', '5 tỷ', [5_000_000_000]],
    ['3,5 tỷ', '3,5 tỷ', [3_500_000_000]],
    ['bảy trăm năm mươi nghìn đồng', 'bảy trăm năm mươi nghìn đồng', [750_000]],
    ['mười nghìn', 'mười nghìn', [10_000]],
    ['10.000đ', '10.000đ', [10_000]],
    ['10.000 đ', '10.000 đ', [10_000]],
    ['1.000', '1.000', [1000]],
    ['dưới 1.000 không tính', '999', []],
    ['chữ "k" đơn lẻ', 'k', []],
    ['"tr" đơn lẻ', 'tr', []],
    ['"triệu" đơn lẻ', 'triệu', []],
    ['số đọc không có đơn vị', 'hai mươi', []],
    ['"đồng ý" không phải tiền', 'đồng ý', []],
    ['hai khoản bằng chữ số', 'ngân sách 20.000.000 đồng và 500k', [20_000_000, 500_000]],
    ['hai mươi lăm triệu', 'hai mươi lăm triệu', [25_000_000]],
    ['hai lăm triệu nói tắt', 'hai lăm triệu', [25_000_000]],
    ['tám trăm triệu', 'tám trăm triệu', [800_000_000]],
    ['trăm nghìn', 'trăm nghìn', [100_000]],
    ['không có tiền, có ngày', 'ngày 7/10 gặp chị Lan', []],
  ];
  it.each(cases)('%s', (_name, text, expected) => {
    expect(extractMoney(text)).toEqual(expected);
  });

  it('findMoney trả khoảng tiếng để bộ tách ngày tránh trùng', () => {
    const tokens = tokenize('duyệt hai chục triệu cho chị Phương');
    expect(findMoney(tokens)).toEqual([{ value: 20_000_000, from: 1, to: 4 }]);
  });
});

describe('extractDates', () => {
  const cases: [string, string, string[]][] = [
    ['thứ Tư ngày bảy tháng mười (đúng thứ)', 'trước thứ Tư ngày bảy tháng mười', ['2026-10-07']],
    ['sai số: thứ Tư ngày sáu tháng mười thì không đọc được, KHÔNG tụt về "thứ Tư"', 'trước thứ Tư ngày sáu tháng mười', []],
    ['sai thứ: thứ Năm ngày bảy tháng mười', 'thứ Năm ngày bảy tháng mười', []],
    ['ngày bảy tháng mười', 'ngày bảy tháng mười', ['2026-10-07']],
    ['ngày 7 tháng 10 bằng chữ số', 'ngày 7 tháng 10', ['2026-10-07']],
    ['ngày 7/10', 'ngày 7/10', ['2026-10-07']],
    ['ngày mai', 'ngày mai', ['2026-10-04']],
    ['ngày kia', 'ngày kia', ['2026-10-05']],
    ['hôm nay', 'hôm nay', ['2026-10-03']],
    ['ngày hôm nay', 'ngày hôm nay', ['2026-10-03']],
    ['hôm qua', 'hôm qua', ['2026-10-02']],
    ['thứ Năm tuần sau', 'thứ Năm tuần sau', ['2026-10-08']],
    ['thứ Tư tuần sau', 'thứ Tư tuần sau', ['2026-10-07']],
    ['thứ Hai tuần sau', 'thứ Hai tuần sau', ['2026-10-05']],
    ['thứ hai tới', 'thứ hai tới', ['2026-10-05']],
    ['chủ nhật đứng một mình', 'chủ nhật', ['2026-10-04']],
    ['chủ nhật trong câu', 'nghỉ chủ nhật nhé', ['2026-10-04']],
    ['chủ nhật tuần sau', 'chủ nhật tuần sau', ['2026-10-11']],
    ['mười lăm tháng mười không có chữ ngày', 'mười lăm tháng mười', ['2026-10-15']],
    ['hai mươi tháng mười', 'hai mươi tháng mười', ['2026-10-20']],
    ['hai mươi sáu tháng mười', 'hai mươi sáu tháng mười', ['2026-10-26']],
    ['ngày hai mươi tháng sau', 'ngày hai mươi tháng sau', ['2026-11-20']],
    ['ba ngày nữa', 'ba ngày nữa', ['2026-10-06']],
    ['hai khoảng ngày nối bằng "đến"', 'từ ngày mười lăm tháng mười đến ngày hai mươi tháng mười', ['2026-10-15', '2026-10-20']],
    ['hai ngày nối bằng "và"', 'ngày mai và ngày kia', ['2026-10-04', '2026-10-05']],
    ['không có ngày', 'không có ngày', []],
    ['câu rỗng', '', []],
    ['"Mai" sau xưng hô là tên người', 'chị Mai họp', []],
    ['tên Mai rồi mới tới "ngày mai"', 'chị Mai hẹn ngày mai', ['2026-10-04']],
    ['"mai" đứng một mình không đủ nghĩa', 'mai họp', []],
    ['sáng mai', 'sáng mai chị Hà gọi', ['2026-10-04']],
    ['chiều mai', 'chiều mai', ['2026-10-04']],
    ['từ đệm "này" đứng trước', 'việc này ngày mai xong', ['2026-10-04']],
    ['giờ trong ngày không lẫn vào ngày', 'tám giờ ngày mai', ['2026-10-04']],
    ['khoảng thời gian "ba ngày" không phải ngày', 'hoàn thành trong ba ngày', []],
    ['tháng mười hai', 'ngày mười lăm tháng mười hai', ['2026-12-15']],
    ['có năm bằng chữ số', 'ngày 15 tháng 10 năm 2026', ['2026-10-15']],
    ['thứ Sáu nhưng 15/10 là thứ Năm', 'thứ sáu ngày mười lăm tháng mười', []],
    ['thứ Năm đúng với 15/10', 'thứ năm ngày mười lăm tháng mười', ['2026-10-15']],
    ['từ đệm "này" đứng sau cụm ngày', 'ngày bảy tháng mười này', ['2026-10-07']],
    ['bảy tháng mười', 'bảy tháng mười', ['2026-10-07']],
    ['đầu tháng sau', 'đầu tháng sau', ['2026-11-02']],
    ['mùng năm tháng mười một', 'mùng năm tháng mười một', ['2026-11-05']],
    ['mùng mười tháng mười', 'mùng mười tháng mười', ['2026-10-10']],
    ['mồng ba tháng mười một', 'ngày mồng ba tháng mười một', ['2026-11-03']],
    ['tiền không bị nuốt thành ngày', 'ngày 7/10 chuyển 20 triệu', ['2026-10-07']],
    ['số thuộc về tiền không lọt vào ngày', 'hai mươi triệu mười lăm tháng mười', ['2026-10-15']],
    ['"tuần này" mơ hồ', 'tuần này', []],
    ['"tháng sau" mơ hồ', 'tháng sau', []],
    ['ngày 15 không nêu tháng', 'ngày 15', ['2026-10-15']],
    ['ngày mười lăm bằng chữ', 'ngày mười lăm', ['2026-10-15']],
    ['dạng 07/10/2026', '07/10/2026', ['2026-10-07']],
    ['dạng ISO', '2026-10-07', ['2026-10-07']],
    ['ngày 31 tháng 2 không có thật', 'ngày 31 tháng 2', []],
    ['ngày ba mươi tháng hai không có thật', 'ngày ba mươi tháng hai', []],
    ['thứ Năm 15/10', 'thứ năm 15/10', ['2026-10-15']],
    ['thứ Tư ngày bảy không nêu tháng', 'thứ tư ngày bảy', ['2026-10-07']],
    ['hạn là ngày 15 tháng 10', 'hạn là ngày 15 tháng 10', ['2026-10-15']],
    ['ngày mười tháng mười', 'ngày mười tháng mười', ['2026-10-10']],
    ['một chữ "nay" không đủ nghĩa', 'nay', []],
    ['"hiện nay" không phải ngày', 'hiện nay chị Lan nghỉ', []],
  ];
  it.each(cases)('%s', (_name, text, expected) => {
    expect(extractDates(text, NOW)).toEqual(expected);
  });

  it('mốc now khác thì ngày tương đối đổi theo', () => {
    expect(extractDates('ngày mai', new Date('2026-10-30T09:00:00+07:00'))).toEqual(['2026-10-31']);
    expect(extractDates('ngày mai', new Date('2026-12-31T09:00:00+07:00'))).toEqual(['2027-01-01']);
  });

  it('múi giờ: 23:30 ngày 03/10 giờ Việt Nam vẫn là ngày 03/10', () => {
    expect(extractDates('hôm nay', new Date('2026-10-03T23:30:00+07:00'))).toEqual(['2026-10-03']);
  });

  it('mốc now không hợp lệ thì không ra ngày', () => {
    expect(extractDates('ngày mai', new Date('không phải ngày'))).toEqual([]);
  });
});
