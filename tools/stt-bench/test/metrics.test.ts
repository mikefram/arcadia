import { describe, expect, it } from 'vitest';
import { BYTES_PER_MS } from '../src/audio';
import {
  audioMinutes,
  checkDates,
  checkMoney,
  checkNames,
  compareMultiset,
  computeLatencyMs,
  countEarlyEvents,
  estimateCostUsd,
  judge,
  lintEntities,
  matchName,
  normalizeForWer,
  PROPOSED_THRESHOLDS,
  percentile,
  rateOf,
  scoreItem,
  summarize,
  summarizeLatency,
  sumWordErrors,
  wer,
  wordErrors,
  wordsOf,
  type ItemScore,
  type ScoredItem,
  type Summary,
  type TimedEvent,
} from '../src/metrics';
import { makeItem } from './helpers';

const NOW = new Date('2026-10-03T09:00:00+07:00');

// ───────────────────────── (a) WER ─────────────────────────

describe('normalizeForWer', () => {
  const cases: [string, string, boolean | undefined, string][] = [
    ['dấu hỏi ở cuối câu', 'Tình hình đón đoàn Nhật thế nào?', false, 'tình hình đón đoàn nhật thế nào'],
    ['nhiều khoảng trắng', '  nhiều   khoảng   trắng ', false, 'nhiều khoảng trắng'],
    ['gạch nối và dấu phẩy', 'Hà-Nội, Việt Nam.', false, 'hà nội việt nam'],
    ['Unicode tổ hợp về dựng sẵn', 'Tuấn'.normalize('NFD'), false, 'tuấn'.normalize('NFC')],
    ['chữ hoa có dấu', 'ĐÀ NẴNG', false, 'đà nẵng'],
    ['số có dấu ngăn nghìn tách thành ba nhóm', '20.000.000 đồng', false, '20 000 000 đồng'],
    ['số thập phân tách thành hai nhóm', '1,5 triệu', false, '1 5 triệu'],
    ['ngày dạng 7/10/2026', '7/10/2026', false, '7 10 2026'],
    ['ngoặc', '(xin chào)', false, 'xin chào'],
    ['nháy kép và chấm than', '"Dạ", chị ạ!', false, 'dạ chị ạ'],
    ['gạch dưới', 'a_b', false, 'a b'],
    ['rỗng', '', false, ''],
    ['toàn khoảng trắng', '   ', false, ''],
    ['toàn dấu câu', '!!!', false, ''],
    ['ký hiệu &', 'MIHATO & VRG', false, 'mihato vrg'],
    ['tab và xuống dòng', 'tab\tand\nnewline', false, 'tab and newline'],
    ['phần trăm', '100%', false, '100'],
    ['thư điện tử', 'e-mail@abc.vn', false, 'e mail abc vn'],
    ['chữ thường giữ nguyên', 'hai chục triệu', false, 'hai chục triệu'],
    ['Nova-3', 'Nova-3', false, 'nova 3'],
    ['gạch ngang dài', 'số 5 – năm', false, 'số 5 năm'],
    ['dấu ba chấm', 'ừ... được', false, 'ừ được'],
    ['bỏ dấu: tình hình đón đoàn', 'Tình hình đón đoàn', true, 'tinh hinh don doan'],
    ['bỏ dấu: Đỗ Thị Đào', 'Đỗ Thị Đào', true, 'do thi dao'],
    ['bỏ dấu: Phượng', 'Phượng', true, 'phuong'],
    ['bỏ dấu: ước', 'ước', true, 'uoc'],
    ['bỏ dấu: Nguyễn Văn Ơn', 'Nguyễn Văn Ơn', true, 'nguyen van on'],
    ['bỏ dấu: ÂM LỊCH', 'ÂM LỊCH', true, 'am lich'],
    ['bỏ dấu: ba biến thể của Tuấn thành một', 'tuân tuấn tuần', true, 'tuan tuan tuan'],
    ['bỏ dấu và dấu câu', 'xin chào, Hà Nội!', true, 'xin chao ha noi'],
    ['bỏ dấu từ dạng tổ hợp', 'Phương'.normalize('NFD'), true, 'phuong'],
    ['bỏ dấu: đ và Đ thành d', 'đ Đ', true, 'd d'],
    ['bỏ dấu: Tiếng Việt', 'Tiếng Việt: dễ học', true, 'tieng viet de hoc'],
    ['không bỏ dấu khi stripMarks tắt', 'Tiếng Việt', undefined, 'tiếng việt'],
  ];
  it.each(cases)('%s', (_name, input, strip, expected) => {
    expect(normalizeForWer(input, strip === undefined ? {} : { stripMarks: strip })).toBe(expected);
  });

  it('wordsOf tách tiếng, rỗng cho chuỗi rỗng', () => {
    expect(wordsOf('Hai  chục, triệu!')).toEqual(['hai', 'chục', 'triệu']);
    expect(wordsOf('   ')).toEqual([]);
  });
});

describe('wer', () => {
  // [câu chuẩn, kết quả, thay, xoá, chèn]; chỉ chọn ca có đường căn chỉnh tối ưu duy nhất nên cách chia S/D/I không mơ hồ
  const cases: [string, string, number, number, number][] = [
    ['a b c', 'a b c', 0, 0, 0],
    ['a b c', 'x b c', 1, 0, 0],
    ['a b c', 'a x c', 1, 0, 0],
    ['a b c', 'a b x', 1, 0, 0],
    ['a b c', 'x y z', 3, 0, 0],
    ['a b c', 'b c', 0, 1, 0],
    ['a b c', 'a c', 0, 1, 0],
    ['a b c', 'a b', 0, 1, 0],
    ['a b c', 'c', 0, 2, 0],
    ['a b c', 'b', 0, 2, 0],
    ['a b c', '', 0, 3, 0],
    ['a b c', 'x a b c', 0, 0, 1],
    ['a b c', 'a x b c', 0, 0, 1],
    ['a b c', 'a b c x', 0, 0, 1],
    ['a b c', 'a b c x y', 0, 0, 2],
    ['', 'a', 0, 0, 1],
    ['', '', 0, 0, 0],
    ['a', 'b', 1, 0, 0],
    ['a', 'a a', 0, 0, 1],
    ['a a', 'a', 0, 1, 0],
    ['a b a b', 'a b', 0, 2, 0],
    ['a b', 'a b a b', 0, 0, 2],
    ['một hai ba bốn', 'một hai ba bốn', 0, 0, 0],
    ['tình hình đón đoàn', 'tinh hình đón đoàn', 1, 0, 0],
    ['a b c d e', 'a x c y e', 2, 0, 0],
    ['a b c d e', 'a c e', 0, 2, 0],
    ['A, b. C!', 'a b c', 0, 0, 0],
    ['duyệt hai chục triệu', 'duyệt hai chục nghìn', 1, 0, 0],
    ['a b c d', 'a x b c y d', 0, 0, 2],
    ['a b c d', 'x b c', 1, 1, 0],
    ['a b c', 'c b a', 2, 0, 0],
    ['a b c d e f', 'a b x y e f', 2, 0, 0],
    ['x', '', 0, 1, 0],
    ['hà nội', 'ha noi', 2, 0, 0],
    ['a b c d', 'b c', 0, 2, 0],
    ['đi thúc anh Tuấn việc kiểm tra tuyến tham quan', 'đi thúc anh Tú việc kiểm tra tuyến tham quan', 1, 0, 0],
    ['tình hình đón đoàn Nhật thế nào', 'tình hình đón đoàn Nhật', 0, 2, 0],
  ];
  it.each(cases)('%j → %j: %i thay, %i xoá, %i chèn', (ref, hyp, s, d, i) => {
    const r = wer(ref, hyp);
    expect([r.substitutions, r.deletions, r.insertions]).toEqual([s, d, i]);
    expect(r.errors).toBe(s + d + i);
    expect(r.refWords).toBe(wordsOf(ref).length);
    expect(r.hypWords).toBe(wordsOf(hyp).length);
    expect(r.rate).toBeCloseTo(r.refWords === 0 ? (r.hypWords === 0 ? 0 : 1) : (s + d + i) / r.refWords, 12);
  });

  it('hoà thì ưu tiên thay thế hơn xoá cộng chèn', () => {
    // "a b" so với "b a": hai đường cùng 2 lỗi (thay 2) hoặc (xoá a, chèn a): chọn thay thế
    const r = wordErrors(['a', 'b'], ['b', 'a']);
    expect(r).toMatchObject({ substitutions: 2, deletions: 0, insertions: 0, errors: 2 });
  });

  it('tổng lỗi không phụ thuộc cách chia: đối xứng khi đổi chiều', () => {
    for (const [a, b] of [
      ['a b c d', 'd c b a'],
      ['x y z', 'z x y'],
      ['một hai ba', 'hai ba bốn năm'],
    ] as const) {
      expect(wer(a, b).errors).toBe(wer(b, a).errors);
    }
  });

  it('câu chuẩn rỗng: tỉ lệ 0 nếu kết quả rỗng, 1 nếu có chữ', () => {
    expect(wer('', '').rate).toBe(0);
    expect(wer('', 'xin chào').rate).toBe(1);
  });

  it('bản không dấu tách lỗi dấu khỏi lỗi từ', () => {
    expect(wer('tình hình đón đoàn', 'tinh hinh don doan').errors).toBe(4);
    expect(wer('tình hình đón đoàn', 'tinh hinh don doan', { stripMarks: true }).errors).toBe(0);
    expect(wer('đi thúc anh Tuấn', 'đi thúc anh Tú', { stripMarks: true }).errors).toBe(1);
  });

  it('WER có thể vượt 100% khi chèn nhiều', () => {
    expect(wer('a', 'a b c d').rate).toBe(3);
  });

  it('sumWordErrors: tổng lỗi chia tổng số từ, không lấy trung bình tỉ lệ', () => {
    const total = sumWordErrors([wer('a b c', 'a x c'), wer('d e', 'd')]);
    expect(total).toMatchObject({ substitutions: 1, deletions: 1, insertions: 0, errors: 2, refWords: 5, hypWords: 4 });
    expect(total.rate).toBeCloseTo(0.4, 12);
    // trung bình tỉ lệ sẽ là (1/3 + 1/2) / 2 = 0,4167: khác
    expect(total.rate).not.toBeCloseTo(0.4167, 3);
  });

  it('sumWordErrors của danh sách rỗng', () => {
    expect(sumWordErrors([])).toMatchObject({ errors: 0, refWords: 0, rate: 0 });
  });
});

// ───────────────────────── (b) Tên ─────────────────────────

describe('matchName', () => {
  const cases: [string, string, string, 'exact' | 'diacritic' | 'missing'][] = [
    ['đúng cả dấu', 'đi thúc anh Tuấn việc', 'Tuấn', 'exact'],
    ['khác hoa thường', 'đi thúc anh tuấn', 'Tuấn', 'exact'],
    ['sai dấu thanh', 'đi thúc anh Tuân', 'Tuấn', 'diacritic'],
    ['không dấu', 'đi thúc anh Tuan', 'Tuấn', 'diacritic'],
    ['nghe thành tên khác', 'đi thúc anh Tú', 'Tuấn', 'missing'],
    ['không có tên', 'đi thúc anh', 'Tuấn', 'missing'],
    ['kết quả rỗng', '', 'Tuấn', 'missing'],
    ['Phương đúng', 'chị Phương duyệt', 'Phương', 'exact'],
    ['Phượng thay cho Phương', 'chị Phượng duyệt', 'Phương', 'diacritic'],
    ['họ tên đủ mà chỉ nghe tên gọi', 'chị Phương', 'Nguyễn Thị Phương', 'missing'],
    ['nghe đủ họ tên, kiểm tên gọi', 'chị Nguyễn Thị Phương', 'Phương', 'exact'],
    ['họ tên đủ đúng', 'chị Nguyễn Thị Phương', 'Nguyễn Thị Phương', 'exact'],
    ['họ tên đủ sai dấu ở tên đệm', 'chị nguyễn thi phương', 'Nguyễn Thị Phương', 'diacritic'],
    ['tên phòng đúng', 'phòng Kinh doanh', 'Kinh doanh', 'exact'],
    ['tên phòng viết thường', 'phòng Kinh doanh', 'kinh doanh', 'exact'],
    ['tên phòng sai dấu', 'phòng kinh doạnh', 'Kinh doanh', 'diacritic'],
    ['tên phòng thiếu tiếng', 'phòng kinh', 'Kinh doanh', 'missing'],
    ['tên phòng đảo thứ tự', 'phòng doanh kinh', 'Kinh doanh', 'missing'],
    ['tên phòng bốn tiếng', 'phòng Hành chính nhân sự', 'Hành chính nhân sự', 'exact'],
    ['gạch ngang trong tên bị bỏ', 'phòng hành chính nhân sự', 'Hành chính - nhân sự', 'exact'],
    ['Hùng nghe thành Hưng chỉ khác dấu', 'anh Hùng', 'Hưng', 'diacritic'],
    ['Hùng đúng', 'anh Hùng', 'Hùng', 'exact'],
    ['Lân thay cho Lan', 'anh Lân', 'Lan', 'diacritic'],
    ['Lang không phải Lan', 'anh Lang', 'Lan', 'missing'],
    ['tên trùng chữ trong từ khác (giới hạn đã biết)', 'Hải Phòng', 'Hải', 'exact'],
    ['dính liền không tách tiếng', 'hảiphòng', 'Hải', 'missing'],
    ['tên một chữ', 'Mai', 'Mai', 'exact'],
    ['dấu phẩy giữa các tên', 'anh Tuấn, chị Phương', 'Phương', 'exact'],
    ['hai tên trong câu', 'anh tuấn chị phương', 'Tuấn', 'exact'],
    ['CHỮ HOA', 'ANH TUẤN', 'tuấn', 'exact'],
    ['tên rỗng', 'anh Tuấn', '', 'missing'],
    ['tên toàn khoảng trắng', 'anh Tuấn', '   ', 'missing'],
    ['tên toàn dấu câu', 'anh Tuấn', '...', 'missing'],
    ['Đào đúng', 'đồng chí Đào', 'Đào', 'exact'],
    ['Đào nghe thành Dao', 'đồng chí Dao', 'Đào', 'diacritic'],
    ['Đào nghe thành Đảo', 'đồng chí Đảo', 'Đào', 'diacritic'],
    ['nghe không dấu hoàn toàn', 'tuan', 'Tuấn', 'diacritic'],
    ['kết quả dạng tổ hợp Unicode', 'anh Tuấn'.normalize('NFD'), 'Tuấn', 'exact'],
    ['tên dạng tổ hợp Unicode', 'anh Tuấn', 'Tuấn'.normalize('NFD'), 'exact'],
  ];
  it.each(cases)('%s', (_name, hyp, name, expected) => {
    expect(matchName(hyp, name)).toBe(expected);
  });
});

describe('checkNames', () => {
  it('tên người trước, tên đơn vị sau, kèm loại', () => {
    expect(checkNames('chị Phương phòng Kinh doanh', { people: ['Phương'], units: ['Kinh doanh'] })).toEqual([
      { name: 'Phương', kind: 'person', verdict: 'exact' },
      { name: 'Kinh doanh', kind: 'unit', verdict: 'exact' },
    ]);
  });

  it('tên trùng trong cùng loại chỉ tính một lần', () => {
    expect(checkNames('anh Tuấn', { people: ['Tuấn', 'tuấn', ' TUẤN '] })).toHaveLength(1);
  });

  it('cùng tên ở hai loại thì tính ở cả hai', () => {
    expect(checkNames('Hà', { people: ['Hà'], units: ['Hà'] })).toHaveLength(2);
  });

  it('không có tên nào thì rỗng, units không khai báo cũng được', () => {
    expect(checkNames('xin chào', { people: [] })).toEqual([]);
  });

  it('bỏ qua tên không còn chữ nào sau chuẩn hoá', () => {
    expect(checkNames('xin chào', { people: ['...'], units: ['  '] })).toEqual([]);
  });

  it('nêu rõ từng tên sai kiểu gì', () => {
    const r = checkNames('đi thúc anh Tuân gặp chị Phuong ở phòng Kinh', { people: ['Tuấn', 'Phương', 'Lan'], units: ['Kinh doanh'] });
    expect(r.map((x) => x.verdict)).toEqual(['diacritic', 'diacritic', 'missing', 'missing']);
  });
});

// ───────────────────────── (c) Tiền và ngày ─────────────────────────

describe('compareMultiset', () => {
  const cases: [string, (string | number)[], (string | number)[], boolean, (string | number)[], (string | number)[]][] = [
    ['hai bên rỗng', [], [], true, [], []],
    ['một phần tử giống nhau', [1], [1], true, [], []],
    ['một phần tử khác nhau', [1], [2], false, [1], [2]],
    ['khác thứ tự vẫn bằng', [1, 2], [2, 1], true, [], []],
    ['thiếu một bản lặp', [1, 1], [1], false, [1], []],
    ['thừa một bản lặp', [1], [1, 1], false, [], [1]],
    ['thiếu hai', [1, 2, 3], [3], false, [1, 2], []],
    ['thừa hai', [3], [1, 2, 3], false, [], [1, 2]],
    ['kỳ vọng rỗng, có thừa', [], [5], false, [], [5]],
    ['có kỳ vọng, không có gì', [5], [], false, [5], []],
    ['chuỗi giống nhau', ['a'], ['a'], true, [], []],
    ['ngày giống nhau', ['2026-10-07'], ['2026-10-07'], true, [], []],
    ['ngày lệch một', ['2026-10-07'], ['2026-10-08'], false, ['2026-10-07'], ['2026-10-08']],
    ['hai ngày khác thứ tự', ['2026-10-15', '2026-10-20'], ['2026-10-20', '2026-10-15'], true, [], []],
    ['một trong hai ngày đúng', ['2026-10-15', '2026-10-20'], ['2026-10-15'], false, ['2026-10-20'], []],
    ['số tiền giống nhau', [20_000_000], [20_000_000], true, [], []],
    ['số tiền lệch ba số không', [20_000_000], [20_000], false, [20_000_000], [20_000]],
    ['hai khoản, đúng cả hai', [300_000, 2_000_000], [2_000_000, 300_000], true, [], []],
    ['hai khoản gộp thành một', [2_000_000, 300_000], [2_300_000], false, [300_000, 2_000_000], [2_300_000]],
    ['ba phần tử, hai trùng', [5, 5, 7], [5, 7, 7], false, [5], [7]],
    ['đầu ra xếp tăng dần', [9, 3, 5], [], false, [3, 5, 9], []],
    ['đầu ra thừa xếp tăng dần', [], [9, 3, 5], false, [], [3, 5, 9]],
    ['số không', [0], [0], true, [], []],
    ['âm', [-1], [-1], true, [], []],
    ['số lớn', [2_500_000_000], [2_500_000_000], true, [], []],
    ['chuỗi so theo thứ tự chữ', ['b', 'a'], ['a', 'b'], true, [], []],
    ['chuỗi lệch hoa thường là khác', ['A'], ['a'], false, ['A'], ['a']],
    ['một phần tử lặp ba lần, nhận hai', [4, 4, 4], [4, 4], false, [4], []],
    ['hai bên lặp như nhau', [4, 4, 4], [4, 4, 4], true, [], []],
    ['thừa một phần tử khác', [1, 2], [1, 2, 3], false, [], [3]],
    ['thiếu một phần tử khác', [1, 2, 3], [1, 2], false, [3], []],
    ['đổi chỗ hai giá trị khác nhau', [1, 2], [3, 4], false, [1, 2], [3, 4]],
    ['dãy dài bằng nhau', [1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, 1], true, [], []],
  ];
  it.each(cases)('%s', (_name, expected, got, ok, missing, extra) => {
    expect(compareMultiset(expected, got)).toEqual({ ok, missing, extra });
  });
});

describe('checkMoney', () => {
  const cases: [string, string, number[], boolean, number[]][] = [
    ['hai chục triệu', 'duyệt hai chục triệu', [20_000_000], true, [20_000_000]],
    ['nghe thành hai chục nghìn: sai tiền', 'duyệt hai chục nghìn', [20_000_000], false, [20_000]],
    ['chữ số kèm triệu', 'duyệt 20 triệu', [20_000_000], true, [20_000_000]],
    ['kèm đồng', 'duyệt hai mươi triệu đồng', [20_000_000], true, [20_000_000]],
    ['viết tắt tr', 'duyệt hai mươi tr', [20_000_000], true, [20_000_000]],
    ['20tr', 'duyệt 20tr', [20_000_000], true, [20_000_000]],
    ['500k', 'chuyển 500k', [500_000], true, [500_000]],
    ['năm trăm nghìn', 'chuyển năm trăm nghìn', [500_000], true, [500_000]],
    ['năm trăm không đơn vị: không đọc được', 'chuyển năm trăm', [500_000], false, []],
    ['một triệu hai', 'chuyển một triệu hai', [1_200_000], true, [1_200_000]],
    ['hai triệu ba trăm nghìn', 'chuyển hai triệu ba trăm nghìn', [2_300_000], true, [2_300_000]],
    ['hai khoản', 'chuyển hai triệu và ba trăm nghìn', [2_000_000, 300_000], true, [2_000_000, 300_000]],
    ['hai khoản, kỳ vọng khác thứ tự', 'chuyển hai triệu và ba trăm nghìn', [300_000, 2_000_000], true, [2_000_000, 300_000]],
    ['hai khoản mà kỳ vọng một', 'chuyển hai triệu và ba trăm nghìn', [2_300_000], false, [2_000_000, 300_000]],
    ['không có tiền, không kỳ vọng', 'không có tiền', [], true, []],
    ['không có tiền mà kỳ vọng có', 'không có tiền', [1_000_000], false, []],
    ['có tiền mà không kỳ vọng: thừa', 'duyệt hai chục triệu', [], false, [20_000_000]],
    ['hai đồng chí không phải tiền', 'hai đồng chí', [], true, []],
    ['năm 2026 không phải tiền', 'năm 2026 hai chục triệu', [20_000_000], true, [20_000_000]],
    ['số lớn có dấu ngăn nghìn', 'tạm ứng 20.000.000 đồng', [20_000_000], true, [20_000_000]],
    ['số liền', 'tạm ứng 20000000', [20_000_000], true, [20_000_000]],
    ['1,5 triệu', 'tạm ứng 1,5 triệu', [1_500_000], true, [1_500_000]],
    ['một tỷ', 'tạm ứng một tỷ', [1_000_000_000], true, [1_000_000_000]],
    ['hai tỷ rưỡi', 'tạm ứng hai tỷ rưỡi', [2_500_000_000], true, [2_500_000_000]],
    ['tiền rồi tới ngày', 'tạm ứng hai chục triệu ngày mười lăm tháng mười', [20_000_000], true, [20_000_000]],
    ['tiền kèm tên người', 'duyệt hai chục triệu cho chị Phương', [20_000_000], true, [20_000_000]],
    ['chữ hoa', 'Duyệt Hai Chục Triệu', [20_000_000], true, [20_000_000]],
    ['hai triệu rưỡi đúng', 'duyệt hai triệu rưỡi', [2_500_000], true, [2_500_000]],
    ['hai triệu rưỡi mà kỳ vọng hai triệu', 'duyệt hai triệu rưỡi', [2_000_000], false, [2_500_000]],
    ['hai khoản bằng nhau', 'hai chục triệu và hai chục triệu', [20_000_000, 20_000_000], true, [20_000_000, 20_000_000]],
    ['hai khoản bằng nhau mà kỳ vọng một', 'hai chục triệu và hai chục triệu', [20_000_000], false, [20_000_000, 20_000_000]],
    ['ứng rồi hoàn', 'tạm ứng hai chục triệu hoàn ứng năm trăm nghìn', [20_000_000, 500_000], true, [20_000_000, 500_000]],
    ['ba mươi nghìn đồng', 'tạm ứng ba mươi nghìn đồng', [30_000], true, [30_000]],
    ['mười nghìn', 'mười nghìn', [10_000], true, [10_000]],
    ['500 nghìn', '500 nghìn', [500_000], true, [500_000]],
    ['kết quả rỗng', '', [20_000_000], false, []],
  ];
  it.each(cases)('%s', (_name, hyp, expected, ok, got) => {
    expect(checkMoney(hyp, expected)).toEqual({ expected, got, ok });
  });
});

describe('checkDates', () => {
  const cases: [string, string, string[], boolean, string[]][] = [
    ['thứ Tư ngày bảy tháng mười', 'trước thứ Tư ngày bảy tháng mười', ['2026-10-07'], true, ['2026-10-07']],
    ['nghe thành ngày sáu: sai thứ nên không đọc được', 'trước thứ Tư ngày sáu tháng mười', ['2026-10-07'], false, []],
    ['nghe thành thứ Năm', 'thứ Năm ngày bảy tháng mười', ['2026-10-07'], false, []],
    ['ngày bảy tháng mười', 'ngày bảy tháng mười', ['2026-10-07'], true, ['2026-10-07']],
    ['ngày 7 tháng 10', 'ngày 7 tháng 10', ['2026-10-07'], true, ['2026-10-07']],
    ['ngày 7/10', 'ngày 7/10', ['2026-10-07'], true, ['2026-10-07']],
    ['ngày mai', 'ngày mai', ['2026-10-04'], true, ['2026-10-04']],
    ['ngày mai mà kỳ vọng ngày kia', 'ngày mai', ['2026-10-05'], false, ['2026-10-04']],
    ['ngày kia', 'ngày kia', ['2026-10-05'], true, ['2026-10-05']],
    ['hôm nay', 'hôm nay', ['2026-10-03'], true, ['2026-10-03']],
    ['thứ Năm tuần sau', 'thứ Năm tuần sau', ['2026-10-08'], true, ['2026-10-08']],
    ['thứ Tư tuần sau', 'thứ Tư tuần sau', ['2026-10-07'], true, ['2026-10-07']],
    ['chủ nhật', 'chủ nhật', ['2026-10-04'], true, ['2026-10-04']],
    ['mười lăm tháng mười', 'mười lăm tháng mười', ['2026-10-15'], true, ['2026-10-15']],
    ['hai mươi tháng mười', 'hai mươi tháng mười', ['2026-10-20'], true, ['2026-10-20']],
    ['ngày hai mươi tháng sau', 'ngày hai mươi tháng sau', ['2026-11-20'], true, ['2026-11-20']],
    ['ba ngày nữa', 'ba ngày nữa', ['2026-10-06'], true, ['2026-10-06']],
    ['hai ngày', 'từ ngày mười lăm tháng mười đến ngày hai mươi tháng mười', ['2026-10-15', '2026-10-20'], true, ['2026-10-15', '2026-10-20']],
    ['hai ngày, kỳ vọng khác thứ tự', 'từ ngày mười lăm tháng mười đến ngày hai mươi tháng mười', ['2026-10-20', '2026-10-15'], true, ['2026-10-15', '2026-10-20']],
    ['hai ngày mà kỳ vọng một', 'từ ngày mười lăm tháng mười đến ngày hai mươi tháng mười', ['2026-10-15'], false, ['2026-10-15', '2026-10-20']],
    ['không có ngày, không kỳ vọng', 'không có ngày', [], true, []],
    ['không có ngày mà kỳ vọng có', 'không có ngày', ['2026-10-07'], false, []],
    ['có ngày mà không kỳ vọng: thừa', 'ngày mai', [], false, ['2026-10-04']],
    ['tên Mai không phải ngày mai', 'chị Mai họp', [], true, []],
    ['tên Mai rồi ngày mai', 'chị Mai hẹn ngày mai', ['2026-10-04'], true, ['2026-10-04']],
    ['sáng mai', 'sáng mai chị Hà gọi', ['2026-10-04'], true, ['2026-10-04']],
    ['tháng mười hai', 'ngày mười lăm tháng mười hai', ['2026-12-15'], true, ['2026-12-15']],
    ['có năm', 'ngày 15 tháng 10 năm 2026', ['2026-10-15'], true, ['2026-10-15']],
    ['thứ Năm đúng với 15/10', 'thứ năm ngày mười lăm tháng mười', ['2026-10-15'], true, ['2026-10-15']],
    ['thứ Sáu sai với 15/10', 'thứ sáu ngày mười lăm tháng mười', ['2026-10-15'], false, []],
    ['ngày rồi tiền', 'ngày 7/10 chuyển 20 triệu', ['2026-10-07'], true, ['2026-10-07']],
    ['tiền rồi ngày', 'hai mươi triệu mười lăm tháng mười', ['2026-10-15'], true, ['2026-10-15']],
    ['đầu tháng sau', 'đầu tháng sau', ['2026-11-02'], true, ['2026-11-02']],
    ['mùng năm tháng mười một', 'mùng năm tháng mười một', ['2026-11-05'], true, ['2026-11-05']],
    ['kết quả rỗng', '', ['2026-10-07'], false, []],
    ['ngày không có thật', 'ngày 31 tháng 2', ['2026-03-03'], false, []],
  ];
  it.each(cases)('%s', (_name, hyp, expected, ok, got) => {
    expect(checkDates(hyp, expected, NOW)).toEqual({ expected, got, ok });
  });
});

describe('scoreItem', () => {
  const full = makeItem({
    reference: 'duyệt hai chục triệu cho chị Phương trước thứ Tư ngày bảy tháng mười',
    entities: { people: ['Phương'], units: ['Kinh doanh'], amountsVnd: [20_000_000], dates: ['2026-10-07'] },
  });

  it('nghe đúng hoàn toàn: mọi số đo sạch', () => {
    const s = scoreItem({ reference: full.reference, entities: { ...full.entities, units: [] } }, full.reference, { now: NOW });
    expect(s.wer.errors).toBe(0);
    expect(s.werPlain.errors).toBe(0);
    expect(s.names.every((n) => n.verdict === 'exact')).toBe(true);
    expect(s.money?.ok).toBe(true);
    expect(s.dates?.ok).toBe(true);
    expect(s.spuriousMoney).toBe(0);
  });

  it('bắt từng loại lỗi một cách độc lập', () => {
    const s = scoreItem(full, 'duyệt hai chục nghìn cho chị Phuong trước thứ Tư ngày sáu tháng mười', { now: NOW });
    expect(s.names).toEqual([
      { name: 'Phương', kind: 'person', verdict: 'diacritic' },
      { name: 'Kinh doanh', kind: 'unit', verdict: 'missing' },
    ]);
    expect(s.money).toEqual({ expected: [20_000_000], got: [20_000], ok: false });
    expect(s.dates).toEqual({ expected: ['2026-10-07'], got: [], ok: false });
    expect(s.wer.errors).toBe(3);
    expect(s.werPlain.errors).toBe(2);
  });

  it('câu không kỳ vọng tiền hay ngày thì money và dates là null', () => {
    const s = scoreItem(makeItem(), 'đi thúc anh Tuấn', { now: null });
    expect(s.money).toBeNull();
    expect(s.dates).toBeNull();
  });

  it('câu không kỳ vọng tiền mà kết quả có tiền: đếm báo động giả', () => {
    expect(scoreItem(makeItem(), 'đi thúc anh Tuấn hai chục triệu', { now: null }).spuriousMoney).toBe(1);
  });

  it('thiếu mốc now khi có câu mong đợi ngày thì ném lỗi', () => {
    expect(() => scoreItem(full, 'x', { now: null })).toThrowError(/Thiếu mốc now/);
  });

  it('không cần now khi không có ngày kỳ vọng', () => {
    expect(() => scoreItem(makeItem(), 'x', { now: null })).not.toThrow();
  });

  it('kết quả rỗng: mọi thứ sai', () => {
    const s = scoreItem(full, '', { now: NOW });
    expect(s.wer).toMatchObject({ deletions: 14, errors: 14 });
    expect(s.names.every((n) => n.verdict === 'missing')).toBe(true);
    expect(s.money?.ok).toBe(false);
    expect(s.dates?.ok).toBe(false);
  });
});

describe('lintEntities', () => {
  const ctx = { now: NOW };
  it('manifest khớp với câu chuẩn thì sạch', () => {
    const item = makeItem({ reference: 'duyệt hai chục triệu cho chị Phương trước thứ Tư ngày bảy tháng mười', entities: { people: ['Phương'], amountsVnd: [20_000_000], dates: ['2026-10-07'] } });
    expect(lintEntities([item], ctx)).toEqual([]);
  });

  it('tên không có trong câu chuẩn', () => {
    expect(lintEntities([makeItem({ entities: { people: ['Hùng'], amountsVnd: [], dates: [] } })], ctx)).toEqual([{ id: 't1', problem: 'name', count: 1 }]);
  });

  it('số tiền ghi sai trong manifest', () => {
    const item = makeItem({ reference: 'duyệt hai chục triệu', entities: { people: [], amountsVnd: [2_000_000], dates: [] } });
    expect(lintEntities([item], ctx)).toEqual([{ id: 't1', problem: 'money', count: 2 }]);
  });

  it('ngày ghi sai trong manifest', () => {
    const item = makeItem({ reference: 'ngày bảy tháng mười', entities: { people: [], amountsVnd: [], dates: ['2026-10-08'] } });
    expect(lintEntities([item], ctx)).toEqual([{ id: 't1', problem: 'date', count: 2 }]);
  });

  it('bộ tách không đọc nổi cách nói thì cũng báo', () => {
    const item = makeItem({ reference: 'trả năm trăm', entities: { people: [], amountsVnd: [500], dates: [] } });
    expect(lintEntities([item], ctx)).toEqual([{ id: 't1', problem: 'money', count: 1 }]);
  });

  it('kết quả lint không chứa tên hay số tiền', () => {
    const issues = lintEntities([makeItem({ entities: { people: ['Quyết'], amountsVnd: [123456789], dates: [] } })], ctx);
    expect(JSON.stringify(issues)).not.toMatch(/Quyết|123456789/);
  });

  it('nhiều lỗi trên nhiều câu', () => {
    const items = [
      makeItem({ id: 'a', entities: { people: ['Hùng'], amountsVnd: [], dates: [] } }),
      makeItem({ id: 'b', reference: 'ngày mai', entities: { people: [], amountsVnd: [], dates: ['2026-10-04'] } }),
      makeItem({ id: 'c', entities: { people: ['Tuấn'], amountsVnd: [], dates: [] } }),
    ];
    expect(lintEntities(items, ctx).map((i) => i.id)).toEqual(['a']);
  });
});

// ───────────────────────── (d) Độ trễ ─────────────────────────

describe('percentile (hạng gần nhất)', () => {
  const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const cases: [string, number[], number, number | null][] = [
    ['rỗng', [], 50, null],
    ['một phần tử p50', [7], 50, 7],
    ['một phần tử p95', [7], 95, 7],
    ['một phần tử p0', [7], 0, 7],
    ['một phần tử p100', [7], 100, 7],
    ['hai phần tử p50', [1, 2], 50, 1],
    ['hai phần tử p51', [1, 2], 51, 2],
    ['hai phần tử p95', [1, 2], 95, 2],
    ['ba phần tử p50', [1, 2, 3], 50, 2],
    ['ba phần tử p95', [1, 2, 3], 95, 3],
    ['bốn phần tử p50', [1, 2, 3, 4], 50, 2],
    ['bốn phần tử p75', [1, 2, 3, 4], 75, 3],
    ['bốn phần tử p76', [1, 2, 3, 4], 76, 4],
    ['năm phần tử p50', [1, 2, 3, 4, 5], 50, 3],
    ['mười phần tử p0', ten, 0, 10],
    ['mười phần tử p10', ten, 10, 10],
    ['mười phần tử p11', ten, 11, 20],
    ['mười phần tử p50', ten, 50, 50],
    ['mười phần tử p51', ten, 51, 60],
    ['mười phần tử p90', ten, 90, 90],
    ['mười phần tử p95', ten, 95, 100],
    ['mười phần tử p100', ten, 100, 100],
    ['chưa xếp', [30, 10, 20], 50, 20],
    ['chưa xếp p95', [30, 10, 20], 95, 30],
    ['trùng giá trị', [5, 5, 5, 5], 95, 5],
    ['trùng giá trị và một số lớn', [5, 5, 5, 100], 75, 5],
    ['trùng giá trị và một số lớn p76', [5, 5, 5, 100], 76, 100],
    ['số âm', [-3, -1, -2], 50, -2],
    ['số thập phân', [0.5, 1.5, 2.5], 95, 2.5],
    ['hai mươi phần tử p95 đúng hạng 19', Array.from({ length: 20 }, (_, i) => i + 1), 95, 19],
    ['hai mươi phần tử p96 lên hạng 20', Array.from({ length: 20 }, (_, i) => i + 1), 96, 20],
    ['một trăm phần tử p95', Array.from({ length: 100 }, (_, i) => i + 1), 95, 95],
    ['một trăm phần tử p50', Array.from({ length: 100 }, (_, i) => i + 1), 50, 50],
    ['một trăm lẻ một phần tử p95', Array.from({ length: 101 }, (_, i) => i + 1), 95, 96],
  ];
  it.each(cases)('%s', (_name, values, p, expected) => {
    expect(percentile(values, p)).toBe(expected);
  });

  it('không làm đổi mảng đầu vào', () => {
    const v = [3, 1, 2];
    percentile(v, 50);
    expect(v).toEqual([3, 1, 2]);
  });

  it.each([-1, 100.5, Number.NaN])('p = %s bị từ chối', (p) => {
    expect(() => percentile([1], p)).toThrowError(RangeError);
  });
});

describe('summarizeLatency', () => {
  it('bỏ giá trị null và không hữu hạn', () => {
    expect(summarizeLatency([100, null, 300, Number.NaN, 200])).toEqual({ n: 3, p50: 200, p95: 300, max: 300, mean: 200 });
  });
  it('toàn null', () => {
    expect(summarizeLatency([null, null])).toEqual({ n: 0, p50: null, p95: null, max: null, mean: null });
  });
  it('rỗng', () => {
    expect(summarizeLatency([])).toEqual({ n: 0, p50: null, p95: null, max: null, mean: null });
  });
  it('một giá trị', () => {
    expect(summarizeLatency([1300])).toEqual({ n: 1, p50: 1300, p95: 1300, max: 1300, mean: 1300 });
  });
  it('p95 của 20 giá trị là giá trị thứ 19', () => {
    const r = summarizeLatency(Array.from({ length: 20 }, (_, i) => (i + 1) * 100));
    expect(r.p50).toBe(1000);
    expect(r.p95).toBe(1900);
    expect(r.max).toBe(2000);
  });
});

const ev = (type: TimedEvent['type'], atMs: number, sentBytes = 0): TimedEvent => ({ type, atMs, sentBytes });

describe('computeLatencyMs', () => {
  const cases: [string, TimedEvent[], number | null, number | null][] = [
    ['không có sự kiện', [], 1000, null],
    ['không có sự kiện, không có mốc', [], null, null],
    ['có sự kiện nhưng chưa từng gửi tới hết tiếng', [ev('final', 1500)], null, null],
    ['một final', [ev('final', 1500)], 1000, 500],
    ['final rồi utteranceEnd: lấy cái cuối', [ev('final', 1500), ev('utteranceEnd', 2300)], 1000, 1300],
    ['utteranceEnd rồi final muộn hơn', [ev('utteranceEnd', 2300), ev('final', 2400)], 1000, 1400],
    ['chỉ có kết quả tạm', [ev('interim', 1100)], 1000, null],
    ['kết quả tạm rồi final', [ev('interim', 1100), ev('final', 1500)], 1000, 500],
    ['final trước mốc: kẹp về 0', [ev('final', 900)], 1000, 0],
    ['final đúng mốc', [ev('final', 1000)], 1000, 0],
    ['lẻ mili giây', [ev('final', 1000.5)], 1000, 0.5],
    ['mốc bằng 0', [ev('final', 5000)], 0, 5000],
    ['chỉ có utteranceEnd', [ev('utteranceEnd', 2300)], 1000, 1300],
    ['nhiều final lấy cái muộn nhất', [ev('final', 1200), ev('final', 1800), ev('final', 1500)], 1000, 800],
    ['sự kiện không theo thứ tự thời gian', [ev('final', 1800), ev('utteranceEnd', 1200)], 1000, 800],
    ['trễ đúng 1300 ms như utterance_end_ms', [ev('final', 2000), ev('utteranceEnd', 2300)], 1000, 1300],
    ['trễ dưới 1 mili giây', [ev('final', 1000.25)], 1000, 0.25],
    ['trễ lớn', [ev('final', 61_000)], 1000, 60_000],
    ['mốc là số lẻ', [ev('final', 1500)], 999.5, 500.5],
    ['mọi sự kiện đều là tạm', [ev('interim', 10), ev('interim', 20)], 5, null],
    ['final rồi tạm muộn hơn: tạm không tính', [ev('final', 1500), ev('interim', 9000)], 1000, 500],
    ['hai utteranceEnd', [ev('utteranceEnd', 1500), ev('utteranceEnd', 3000)], 1000, 2000],
    ['sự kiện ở mốc âm của đồng hồ', [ev('final', -5)], -10, 5],
    ['final đầu tiên đã sau mốc', [ev('final', 1001)], 1000, 1],
    ['final cùng lúc utteranceEnd', [ev('final', 2000), ev('utteranceEnd', 2000)], 1000, 1000],
    ['cả hai trước mốc', [ev('final', 100), ev('utteranceEnd', 200)], 1000, 0],
    ['chỉ interim sau mốc', [ev('interim', 5000)], 1000, null],
    ['bản giả: mọi thứ tại cùng mốc', [ev('final', 0), ev('utteranceEnd', 0)], 0, 0],
    ['mốc gửi sau cả hai sự kiện', [ev('final', 10), ev('utteranceEnd', 20)], 30, 0],
    ['nhiều interim và một final', [ev('interim', 1), ev('interim', 2), ev('interim', 3), ev('final', 4)], 0, 4],
    ['bốn sự kiện hỗn hợp', [ev('interim', 100), ev('final', 600), ev('interim', 700), ev('utteranceEnd', 1900)], 500, 1400],
  ];
  it.each(cases)('%s', (_name, events, sentAt, expected) => {
    expect(computeLatencyMs(events, sentAt)).toBe(expected);
  });
});

// ───────────────────────── (e) Cắt sớm ─────────────────────────

describe('countEarlyEvents', () => {
  const audio = 64_000;
  const speechEnd = 51_200;
  const cases: [string, TimedEvent[], number | null, [number, number]][] = [
    ['không có sự kiện', [], speechEnd, [0, 0]],
    ['final đúng lúc hết âm thanh', [ev('final', 0, 64_000)], speechEnd, [0, 0]],
    ['final trước hết âm thanh một byte', [ev('final', 0, 63_999)], speechEnd, [1, 0]],
    ['final lúc chưa gửi gì', [ev('final', 0, 0)], speechEnd, [1, 0]],
    ['final sau khi đã gửi đuôi im lặng', [ev('final', 0, 80_000)], speechEnd, [0, 0]],
    ['utteranceEnd đúng lúc hết tiếng nói', [ev('utteranceEnd', 0, 51_200)], speechEnd, [0, 0]],
    ['utteranceEnd trước hết tiếng nói một byte', [ev('utteranceEnd', 0, 51_199)], speechEnd, [0, 1]],
    ['utteranceEnd lúc đang im lặng cuối tệp', [ev('utteranceEnd', 0, 60_000)], speechEnd, [0, 0]],
    ['utteranceEnd đúng lúc hết âm thanh', [ev('utteranceEnd', 0, 64_000)], speechEnd, [0, 0]],
    ['utteranceEnd giữa câu', [ev('utteranceEnd', 0, 10_000)], speechEnd, [0, 1]],
    ['không có điểm hết tiếng: lấy hết âm thanh, sớm', [ev('utteranceEnd', 0, 63_999)], null, [0, 1]],
    ['không có điểm hết tiếng: đúng hết âm thanh', [ev('utteranceEnd', 0, 64_000)], null, [0, 0]],
    ['hai final sớm một final muộn', [ev('final', 0, 10_000), ev('final', 0, 30_000), ev('final', 0, 64_000)], speechEnd, [2, 0]],
    ['final sớm rồi utteranceEnd sớm', [ev('final', 0, 20_000), ev('utteranceEnd', 0, 20_000)], speechEnd, [1, 1]],
    ['kết quả tạm không tính', [ev('interim', 0, 100), ev('interim', 0, 200)], speechEnd, [0, 0]],
    ['hai utteranceEnd sớm', [ev('utteranceEnd', 0, 1000), ev('utteranceEnd', 0, 2000)], speechEnd, [0, 2]],
    ['một sớm một muộn', [ev('utteranceEnd', 0, 1000), ev('utteranceEnd', 0, 60_000)], speechEnd, [0, 1]],
    ['bản giả chốt ở khung cuối', [ev('final', 0, 64_000), ev('utteranceEnd', 0, 64_000)], speechEnd, [0, 0]],
    ['bản giả chốt ở khung thứ 8 trong 20', [ev('final', 0, 25_600), ev('utteranceEnd', 0, 25_600)], speechEnd, [1, 1]],
    ['chốt ngay sau khung chứa hết tiếng', [ev('final', 0, 51_200), ev('utteranceEnd', 0, 51_200)], speechEnd, [1, 0]],
    ['tệp không có im lặng cuối: hết tiếng bằng hết âm thanh', [ev('utteranceEnd', 0, 63_000)], 64_000, [0, 1]],
    ['tệp không có im lặng cuối: đúng hết', [ev('utteranceEnd', 0, 64_000)], 64_000, [0, 0]],
    ['final ở byte 0', [ev('final', 0, 0), ev('final', 0, 0)], speechEnd, [2, 0]],
    ['ba loại trộn', [ev('interim', 0, 1), ev('final', 0, 2), ev('utteranceEnd', 0, 3)], speechEnd, [1, 1]],
    ['final ngay trước mốc hết tiếng', [ev('final', 0, 51_199)], speechEnd, [1, 0]],
    ['utteranceEnd ngay sau mốc hết tiếng', [ev('utteranceEnd', 0, 51_201)], speechEnd, [0, 0]],
    ['nhiều final muộn', [ev('final', 0, 64_000), ev('final', 0, 70_000), ev('final', 0, 99_000)], speechEnd, [0, 0]],
    ['mốc hết tiếng bằng 0: không utteranceEnd nào sớm', [ev('utteranceEnd', 0, 0)], 0, [0, 0]],
    ['mốc hết tiếng bằng 1', [ev('utteranceEnd', 0, 0)], 1, [0, 1]],
    ['sáu sự kiện hỗn hợp', [ev('final', 0, 100), ev('final', 0, 64_000), ev('utteranceEnd', 0, 100), ev('utteranceEnd', 0, 51_200), ev('interim', 0, 5), ev('final', 0, 63_000)], speechEnd, [2, 1]],
    ['âm thanh rất ngắn', [ev('final', 0, 3199)], 3200, [1, 0]],
  ];
  it.each(cases)('%s', (_name, events, speechEndBytes, [earlyFinals, earlyUtteranceEnds]) => {
    const bounds = _name.includes('tệp không có im lặng cuối') ? { audioBytes: 64_000, speechEndBytes } : _name === 'âm thanh rất ngắn' ? { audioBytes: 3200, speechEndBytes } : { audioBytes: audio, speechEndBytes };
    expect(countEarlyEvents(events, bounds)).toEqual({ earlyFinals, earlyUtteranceEnds });
  });
});

// ───────────────────────── (f) Phút âm thanh và chi phí ─────────────────────────

describe('audioMinutes', () => {
  const MINUTE = 60 * 1000 * BYTES_PER_MS; // 1.920.000 byte
  const cases: [string, number, number][] = [
    ['không có gì', 0, 0],
    ['đúng một phút', MINUTE, 1],
    ['hai phút', 2 * MINUTE, 2],
    ['ba mươi phút', 30 * MINUTE, 30],
    ['nửa phút', MINUTE / 2, 0.5],
    ['một phần tư phút', MINUTE / 4, 0.25],
    ['mười giây', MINUTE / 6, 1 / 6],
    ['một giây', MINUTE / 60, 1 / 60],
    ['một khung 100 ms', 3200, 100 / 60_000],
    ['một khung 20 ms', 640, 20 / 60_000],
    ['ba tệp mẫu: 7,5 giây', 64_000 + 80_000 + 96_000, 0.125],
    ['tệp 2 giây', 64_000, 2 / 60],
    ['tệp 2,5 giây', 80_000, 2.5 / 60],
    ['tệp 3 giây', 96_000, 3 / 60],
    ['một tiếng', 60 * MINUTE, 60],
    ['120 phút', 120 * MINUTE, 120],
    ['1,5 phút', 1.5 * MINUTE, 1.5],
    ['0,1 phút', MINUTE / 10, 0.1],
    ['200 câu × 5 giây', 200 * 5 * 32_000, 200 * 5 / 60],
    ['200 câu × 7,8 giây', 200 * 7.8 * 32_000, (200 * 7.8) / 60],
    ['1 byte', 1, 1 / 1_920_000],
    ['32 byte (1 ms)', 32, 1 / 60_000],
    ['960 byte (30 ms)', 960, 30 / 60_000],
    ['5 phút', 5 * MINUTE, 5],
    ['10 phút', 10 * MINUTE, 10],
    ['15 phút', 15 * MINUTE, 15],
    ['45 phút', 45 * MINUTE, 45],
    ['90 giây', 90 * 32_000, 1.5],
    ['89,6 nghìn byte: đuôi 2,8 giây', 89_600, 2.8 / 60],
    ['ba lượt, mỗi lượt tệp 2 giây cộng đuôi 2,8 giây', 3 * (64_000 + 89_600), (3 * 4.8) / 60],
    ['0,5 giây', 16_000, 0.5 / 60],
    ['59 giây', 59 * 32_000, 59 / 60],
    ['61 giây', 61 * 32_000, 61 / 60],
    ['1000 phút', 1000 * MINUTE, 1000],
  ];
  it.each(cases)('%s', (_name, bytes, minutes) => {
    expect(audioMinutes(bytes)).toBeCloseTo(minutes, 9);
  });
});

describe('estimateCostUsd', () => {
  const cases: [string, number, number | null, number | null][] = [
    ['một phút Nova-3', 1, 0.0077, 0.0077],
    ['mười phút Nova-3', 10, 0.0077, 0.077],
    ['ba mươi phút Nova-3', 30, 0.0077, 0.231],
    ['trăm phút Nova-3', 100, 0.0077, 0.77],
    ['một nghìn phút', 1000, 0.0077, 7.7],
    ['không phút', 0, 0.0077, 0],
    ['giá bằng 0 (bản giả)', 12.5, 0, 0],
    ['không có giá trong SPEC', 10, null, null],
    ['không có giá, không có phút', 0, null, null],
    ['giá khuyến mãi 0,0048', 10, 0.0048, 0.048],
    ['hai phút giá khuyến mãi', 2, 0.0048, 0.0096],
    ['năm phút', 5, 0.0077, 0.0385],
    ['hai mươi phút', 20, 0.0077, 0.154],
    ['bốn mươi lăm phút', 45, 0.0077, 0.3465],
    ['90 phút', 90, 0.0077, 0.693],
    ['120 phút', 120, 0.0077, 0.924],
    ['0,2 phút', 0.2, 0.0077, 0.00154],
    ['0,4 phút', 0.4, 0.0077, 0.00308],
    ['0,8 phút', 0.8, 0.0077, 0.00616],
    ['1,5 phút', 1.5, 0.0077, 0.01155],
    ['2,5 phút', 2.5, 0.0077, 0.01925],
    ['3 phút', 3, 0.0077, 0.0231],
    ['7 phút', 7, 0.0077, 0.0539],
    ['8 phút', 8, 0.0077, 0.0616],
    ['9 phút', 9, 0.0077, 0.0693],
    ['50 phút', 50, 0.0077, 0.385],
    ['60 phút', 60, 0.0077, 0.462],
    ['rất ít: một giây', 1 / 60, 0.0077, 0.000128],
    ['rất ít: mười giây', 1 / 6, 0.0077, 0.001283],
    ['giá lớn', 10, 1, 10],
    ['giá lớn hơn', 10, 2.5, 25],
    ['giá nhỏ', 100, 0.001, 0.1],
    ['làm tròn xuống tới 6 chữ số', 0.12345678, 0.0077, 0.000951],
    ['làm tròn lên tới 6 chữ số', 0.987654321, 0.0077, 0.007605],
  ];
  it.each(cases)('%s', (_name, minutes, price, expected) => {
    const r = estimateCostUsd(minutes, price);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toBeCloseTo(expected, 6);
  });

  it('kết quả được làm tròn tới 6 chữ số thập phân', () => {
    const r = estimateCostUsd(0.123456789, 0.0077) as number;
    expect(Math.abs(r * 1e6 - Math.round(r * 1e6))).toBeLessThan(1e-6);
  });
});

// ───────────────────────── Gộp số liệu ─────────────────────────

function scored(over: {
  id: string;
  speaker?: string;
  reference: string;
  hypothesis: string;
  entities?: { people?: string[]; units?: string[]; amountsVnd?: number[]; dates?: string[] };
  status?: ScoredItem['status'];
  latencyMs?: number | null;
  cuts?: number;
  midFinals?: number;
  bytes?: number;
}): ScoredItem {
  const entities = { people: [], amountsVnd: [], dates: [], ...over.entities };
  const item = { id: over.id, reference: over.reference, entities };
  const score: ItemScore = scoreItem(item, over.hypothesis, { now: NOW });
  return {
    id: over.id,
    speaker: over.speaker ?? 'S01',
    groups: { name: entities.people.length + (entities.units?.length ?? 0) > 0, money: entities.amountsVnd.length > 0, date: entities.dates.length > 0 },
    status: over.status ?? 'ok',
    score,
    latencyMs: over.latencyMs ?? null,
    earlyUtteranceEnds: over.cuts ?? 0,
    earlyFinals: over.midFinals ?? 0,
    bytesSent: over.bytes ?? 192_000,
  };
}

describe('summarize', () => {
  const items: ScoredItem[] = [
    scored({ id: 'a', reference: 'đi thúc anh Tuấn', hypothesis: 'đi thúc anh Tuấn', entities: { people: ['Tuấn'] }, latencyMs: 100 }),
    scored({ id: 'b', reference: 'đi thúc anh Tuấn', hypothesis: 'đi thúc anh Tuân', entities: { people: ['Tuấn'] }, latencyMs: 200 }),
    scored({ id: 'c', speaker: 'S02', reference: 'duyệt hai chục triệu cho chị Phương', hypothesis: 'duyệt hai chục nghìn cho chị Phương', entities: { people: ['Phương'], amountsVnd: [20_000_000] }, latencyMs: null, cuts: 1, midFinals: 1 }),
    scored({ id: 'd', speaker: 'S02', reference: 'ngày mai họp phòng Kinh doanh', hypothesis: 'ngày mai họp phòng kinh doanh', entities: { units: ['Kinh doanh'], dates: ['2026-10-04'] }, latencyMs: 300, cuts: 2 }),
  ];
  const s = summarize(items, 0.0077);

  it('đếm câu và WER gộp', () => {
    expect(s.sentences).toBe(4);
    expect(s.wer).toMatchObject({ errors: 2, refWords: 21 });
    expect(s.wer.rate).toBeCloseTo(2 / 21, 12);
    expect(s.werPlain.errors).toBe(1);
  });

  it('tên: người, đơn vị, tổng và chỉ sai dấu', () => {
    expect(s.people).toEqual({ wrong: 1, total: 3, rate: 1 / 3 });
    expect(s.units).toEqual({ wrong: 0, total: 1, rate: 0 });
    expect(s.names).toEqual({ wrong: 1, total: 4, rate: 0.25 });
    expect(s.nameDiacriticOnly).toBe(1);
  });

  it('tiền và ngày tính theo câu có kỳ vọng', () => {
    expect(s.money).toEqual({ wrong: 1, total: 1, rate: 1 });
    expect(s.dates).toEqual({ wrong: 0, total: 1, rate: 0 });
  });

  it('độ trễ bỏ câu không có độ trễ', () => {
    expect(s.latencyMs).toEqual({ n: 3, p50: 200, p95: 300, max: 300, mean: 200 });
  });

  it('cắt sớm: số sự kiện và số câu', () => {
    expect(s.earlyCuts).toBe(3);
    expect(s.earlyCutSentences).toBe(2);
    expect(s.earlyFinals).toBe(1);
  });

  it('phút âm thanh và chi phí ước tính', () => {
    expect(s.audioMinutes).toBeCloseTo(0.4, 9);
    expect(s.costUsd).toBeCloseTo(0.00308, 6);
  });

  it('không có giá thì chi phí là null', () => {
    expect(summarize(items, null).costUsd).toBeNull();
  });

  it('đếm phiên lỗi và không có kết quả', () => {
    const r = summarize([scored({ id: 'x', reference: 'a', hypothesis: '', status: 'failed' }), scored({ id: 'y', reference: 'a', hypothesis: '', status: 'no_result' }), items[0]!], 0);
    expect(r.failed).toBe(1);
    expect(r.noResult).toBe(1);
  });

  it('tiền thừa ở câu không kỳ vọng tiền', () => {
    const r = summarize([scored({ id: 'z', reference: 'đi thúc anh Tuấn', hypothesis: 'đi thúc anh Tuấn hai chục triệu' })], 0);
    expect(r.spuriousMoney).toBe(1);
    expect(r.money.total).toBe(0);
    expect(r.money.rate).toBeNull();
  });

  it('danh sách rỗng', () => {
    const r = summarize([], 0.0077);
    expect(r.sentences).toBe(0);
    expect(r.wer.rate).toBe(0);
    expect(r.names.rate).toBeNull();
    expect(r.latencyMs.p50).toBeNull();
    expect(r.audioMinutes).toBe(0);
    expect(r.costUsd).toBe(0);
  });

  it('rateOf', () => {
    expect(rateOf(0, 0)).toEqual({ wrong: 0, total: 0, rate: null });
    expect(rateOf(1, 4)).toEqual({ wrong: 1, total: 4, rate: 0.25 });
  });
});

describe('judge (ngưỡng đề xuất 5%)', () => {
  const v = (people: [number, number], money: [number, number]) => judge({ people: rateOf(...people), money: rateOf(...money) } as unknown as Summary);
  const cases: [string, [number, number], [number, number], 'pass' | 'fail' | 'insufficient'][] = [
    ['cả hai 0%', [0, 40], [0, 40], 'pass'],
    ['đúng 5% là còn đạt (2/40)', [2, 40], [2, 40], 'pass'],
    ['đúng 5% (1/20)', [1, 20], [1, 20], 'pass'],
    ['5,26% (1/19) không đạt', [1, 19], [0, 19], 'fail'],
    ['tên 6% (3/50) không đạt', [3, 50], [0, 50], 'fail'],
    ['tiền 6% (3/50) không đạt', [0, 50], [3, 50], 'fail'],
    ['cả hai vượt', [10, 50], [10, 50], 'fail'],
    ['tên 4,9% (49/1000) đạt', [49, 1000], [0, 10], 'pass'],
    ['tên 5,1% (51/1000) không đạt', [51, 1000], [0, 10], 'fail'],
    ['không có tên người', [0, 0], [0, 40], 'insufficient'],
    ['không có số tiền', [0, 40], [0, 0], 'insufficient'],
    ['không có gì', [0, 0], [0, 0], 'insufficient'],
    ['một câu duy nhất sai', [1, 1], [0, 1], 'fail'],
    ['một câu duy nhất đúng', [0, 1], [0, 1], 'pass'],
    ['100 tên, 5 sai', [5, 100], [5, 100], 'pass'],
    ['100 tên, 6 sai', [6, 100], [0, 100], 'fail'],
    ['60 tên, 3 sai (đúng 5%)', [3, 60], [3, 60], 'pass'],
    ['60 tên, 4 sai', [4, 60], [0, 60], 'fail'],
    ['80 tên, 4 sai (đúng 5%)', [4, 80], [4, 80], 'pass'],
    ['80 tên, 5 sai', [5, 80], [0, 80], 'fail'],
    ['120 tiền, 6 sai (đúng 5%)', [0, 120], [6, 120], 'pass'],
    ['120 tiền, 7 sai', [0, 120], [7, 120], 'fail'],
    ['200 tên, 10 sai (đúng 5%)', [10, 200], [10, 200], 'pass'],
    ['200 tên, 11 sai', [11, 200], [0, 200], 'fail'],
    ['1000 tên, 50 sai (đúng 5%)', [50, 1000], [50, 1000], 'pass'],
    ['1000 tên, 51 sai', [51, 1000], [0, 1000], 'fail'],
    ['1000 tiền, 51 sai', [0, 1000], [51, 1000], 'fail'],
    ['10 tên, 1 sai là 10%', [1, 10], [0, 10], 'fail'],
    ['3 tên, 0 sai', [0, 3], [0, 3], 'pass'],
    ['tên đạt, tiền thiếu dữ liệu', [0, 30], [0, 0], 'insufficient'],
  ];
  it.each(cases)('%s', (_name, people, money, status) => {
    expect(v(people, money).status).toBe(status);
  });

  it('nêu rõ cái nào đạt cái nào không', () => {
    const r = v([0, 40], [5, 40]);
    expect(r.peopleOk).toBe(true);
    expect(r.moneyOk).toBe(false);
  });

  it('ngưỡng ghi đúng SPEC 6.2.1 điều 4', () => {
    expect(PROPOSED_THRESHOLDS).toEqual({ peopleErrorMax: 0.05, moneyErrorMax: 0.05 });
  });
});
