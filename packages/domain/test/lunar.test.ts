import { describe, expect, it } from 'vitest';
import {
  fixedHolidaySuggestions,
  formatLunar,
  formatLunarDate,
  lunarToSolar,
  solarDateKey,
  solarToLunar,
  tetDate,
  tetDateInTimeZone,
} from '../src/lunar';

/**
 * SPEC 13.4: KHÔNG tự điền bảng ngày Tết từ trí nhớ làm chuẩn. Điểm kiểm chứng duy nhất đã xác minh
 * trong SPEC là mùng 1 Tết Đinh Mùi: Thứ Bảy 06/02/2027. Phần còn lại kiểm bằng tính chất.
 * Bảng do mã tính nằm ở docs/benchmarks/lunar-tet-table.md, chờ Văn phòng đối chiếu.
 */

const DAY_MS = 86_400_000;
const FROM_YEAR = 2020;
const TO_YEAR = 2035;

function* eachDay(fromYear: number, toYear: number): Generator<{ year: number; month: number; day: number }> {
  const end = Date.UTC(toYear, 11, 31);
  for (let t = Date.UTC(fromYear, 0, 1); t <= end; t += DAY_MS) {
    const d = new Date(t);
    yield { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
}

const weekdayOf = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

describe('điểm kiểm chứng đã xác minh trong SPEC', () => {
  it('mùng 1 Tết Đinh Mùi là Thứ Bảy 06/02/2027', () => {
    expect(tetDate(2027)).toEqual({ year: 2027, month: 2, day: 6 });
    expect(weekdayOf(solarDateKey(tetDate(2027)))).toBe(6);
    expect(solarToLunar(2027, 2, 6)).toEqual({ day: 1, month: 1, year: 2027, leap: false });
    expect(lunarToSolar(1, 1, 2027, false)).toEqual({ year: 2027, month: 2, day: 6 });
  });

  it('ngày liền trước mùng 1 Tết Đinh Mùi là ngày cuối tháng Chạp năm âm 2026', () => {
    const eve = solarToLunar(2027, 2, 5);
    expect(eve.month).toBe(12);
    expect(eve.year).toBe(2026);
    expect(eve.leap).toBe(false);
    expect([29, 30]).toContain(eve.day);
  });
});

describe('tính chất khứ hồi 2020–2035', () => {
  it('dương → âm → dương trả về đúng ngày ban đầu với mọi ngày', () => {
    let count = 0;
    for (const s of eachDay(FROM_YEAR, TO_YEAR)) {
      const l = solarToLunar(s.year, s.month, s.day);
      const back = lunarToSolar(l.day, l.month, l.year, l.leap);
      if (back.year !== s.year || back.month !== s.month || back.day !== s.day) {
        throw new Error(`Khứ hồi sai tại ${solarDateKey(s)}: âm ${JSON.stringify(l)} → ${solarDateKey(back)}`);
      }
      count += 1;
    }
    expect(count).toBe(5844); // 16 năm, trong đó 4 năm nhuận dương lịch
  });

  it('ngày âm luôn trong 1..30, tháng trong 1..12', () => {
    for (const s of eachDay(FROM_YEAR, TO_YEAR)) {
      const l = solarToLunar(s.year, s.month, s.day);
      expect(l.day).toBeGreaterThanOrEqual(1);
      expect(l.day).toBeLessThanOrEqual(30);
      expect(l.month).toBeGreaterThanOrEqual(1);
      expect(l.month).toBeLessThanOrEqual(12);
    }
  });
});

describe('cấu trúc tháng và năm âm 2020–2035', () => {
  type Month = { year: number; month: number; leap: boolean; length: number };

  /** Gom mọi ngày thành các tháng âm liên tiếp; kiểm ngày âm tăng dần từng ngày một. */
  function collectMonths(): Month[] {
    const months: Month[] = [];
    let prev: { day: number; month: number; year: number; leap: boolean } | null = null;
    for (const s of eachDay(FROM_YEAR - 1, TO_YEAR + 1)) {
      const l = solarToLunar(s.year, s.month, s.day);
      const sameMonth = prev !== null && prev.month === l.month && prev.year === l.year && prev.leap === l.leap;
      if (sameMonth && prev) {
        if (l.day !== prev.day + 1) throw new Error(`Ngày âm không liên tục tại ${solarDateKey(s)}`);
        const last = months[months.length - 1];
        if (last) last.length = l.day;
      } else {
        if (prev !== null && l.day !== 1) throw new Error(`Tháng âm không bắt đầu từ mùng 1 tại ${solarDateKey(s)}`);
        months.push({ year: l.year, month: l.month, leap: l.leap, length: l.day });
      }
      prev = l;
    }
    // Bỏ tháng đầu và tháng cuối vì có thể bị cắt ở biên khoảng quét.
    return months.slice(1, -1);
  }

  const months = collectMonths();

  it('mỗi tháng âm có 29 hoặc 30 ngày', () => {
    for (const m of months) {
      expect([29, 30], `tháng ${m.month}${m.leap ? ' nhuận' : ''} năm ${m.year}`).toContain(m.length);
    }
  });

  it('mỗi năm âm có 12 hoặc 13 tháng, nhiều nhất một tháng nhuận, dài 353 đến 385 ngày', () => {
    for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
      const ofYear = months.filter((m) => m.year === y);
      const leaps = ofYear.filter((m) => m.leap);
      expect([12, 13], `năm âm ${y}`).toContain(ofYear.length);
      expect(leaps.length).toBe(ofYear.length - 12);
      const days = ofYear.reduce((sum, m) => sum + m.length, 0);
      expect(days).toBeGreaterThanOrEqual(353);
      expect(days).toBeLessThanOrEqual(385);
    }
  });

  it('thứ tự tháng trong năm là 1..12, tháng nhuận đứng ngay sau tháng cùng số', () => {
    for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
      const ofYear = months.filter((m) => m.year === y);
      const regular = ofYear.filter((m) => !m.leap).map((m) => m.month);
      expect(regular).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      ofYear.forEach((m, i) => {
        if (m.leap) {
          const before = ofYear[i - 1];
          expect(before?.month).toBe(m.month);
          expect(before?.leap).toBe(false);
        }
      });
    }
  });

  it('tháng nhuận khứ hồi được, và hỏi tháng nhuận không tồn tại thì báo lỗi', () => {
    const leap = months.find((m) => m.leap);
    expect(leap).toBeDefined();
    if (!leap) return;
    const solar = lunarToSolar(1, leap.month, leap.year, true);
    expect(solarToLunar(solar.year, solar.month, solar.day)).toEqual({ day: 1, month: leap.month, year: leap.year, leap: true });
    const wrongMonth = leap.month === 1 ? 2 : leap.month - 1;
    expect(() => lunarToSolar(1, wrongMonth, leap.year, true)).toThrow(RangeError);
  });

  it('ngày 30 của tháng chỉ có 29 ngày thì báo lỗi', () => {
    const short = months.find((m) => m.length === 29 && m.year >= FROM_YEAR);
    expect(short).toBeDefined();
    if (!short) return;
    expect(() => lunarToSolar(30, short.month, short.year, short.leap)).toThrow(RangeError);
  });
});

describe('tetDate', () => {
  it('mùng 1 Tết luôn rơi vào khoảng 21/01 đến 21/02 và là mùng 1 tháng Giêng', () => {
    for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
      const t = tetDate(y);
      expect(t.year).toBe(y);
      const key = solarDateKey(t);
      expect(key >= `${y}-01-21` && key <= `${y}-02-21`, key).toBe(true);
      expect(solarToLunar(t.year, t.month, t.day)).toEqual({ day: 1, month: 1, year: y, leap: false });
    }
  });

  it('hai Tết liên tiếp cách nhau đúng một năm âm (353 đến 385 ngày)', () => {
    for (let y = FROM_YEAR; y < TO_YEAR; y += 1) {
      const gap = (Date.parse(`${solarDateKey(tetDate(y + 1))}T00:00:00Z`) - Date.parse(`${solarDateKey(tetDate(y))}T00:00:00Z`)) / DAY_MS;
      expect(gap).toBeGreaterThanOrEqual(353);
      expect(gap).toBeLessThanOrEqual(385);
    }
  });

  /**
   * SPEC 13.4: năm nào tính theo UTC+7 và UTC+8 cho ngày khác nhau thì có test riêng.
   * Trong 2020–2035 mã tính ra đúng một năm lệch là 2030. Test này ghim rằng hàm công khai
   * dùng UTC+7 (lịch Việt Nam), không phải UTC+8. Ngày cụ thể vẫn chờ Văn phòng đối chiếu.
   */
  it('năm UTC+7 và UTC+8 lệch nhau: hàm công khai theo UTC+7', () => {
    const differing: number[] = [];
    for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
      const vn = solarDateKey(tetDateInTimeZone(y, 7));
      expect(solarDateKey(tetDate(y))).toBe(vn);
      if (vn !== solarDateKey(tetDateInTimeZone(y, 8))) differing.push(y);
    }
    expect(differing).toEqual([2030]);
    const vn2030 = tetDateInTimeZone(2030, 7);
    const cn2030 = tetDateInTimeZone(2030, 8);
    expect(tetDate(2030)).toEqual(vn2030);
    expect(tetDate(2030)).not.toEqual(cn2030);
    // Lệch đúng một ngày: điểm Sóc rơi giữa 23:00 và 24:00 giờ Việt Nam.
    const gap = (Date.parse(`${solarDateKey(cn2030)}T00:00:00Z`) - Date.parse(`${solarDateKey(vn2030)}T00:00:00Z`)) / DAY_MS;
    expect(gap).toBe(1);
  });
});

describe('formatLunar (SPEC 7.5)', () => {
  it('ngày 1 đến 10 viết "mùng", từ 11 viết "ngày"', () => {
    expect(formatLunarDate({ day: 5, month: 9, leap: false })).toBe('mùng 5 tháng 9 âm lịch');
    expect(formatLunarDate({ day: 10, month: 3, leap: false })).toBe('mùng 10 tháng 3 âm lịch');
    expect(formatLunarDate({ day: 11, month: 3, leap: false })).toBe('ngày 11 tháng 3 âm lịch');
    expect(formatLunarDate({ day: 15, month: 8, leap: false })).toBe('ngày 15 tháng 8 âm lịch');
  });

  it('tháng 1 là Giêng, tháng 12 là Chạp, tháng nhuận ghi "nhuận"', () => {
    expect(formatLunarDate({ day: 1, month: 1, leap: false })).toBe('mùng 1 tháng Giêng âm lịch');
    expect(formatLunarDate({ day: 23, month: 12, leap: false })).toBe('ngày 23 tháng Chạp âm lịch');
    expect(formatLunarDate({ day: 15, month: 6, leap: true })).toBe('ngày 15 tháng 6 nhuận âm lịch');
  });

  it('nhận chuỗi ngày, chuỗi thời điểm và Date; Date tính theo giờ Việt Nam', () => {
    expect(formatLunar('2027-02-06')).toBe('mùng 1 tháng Giêng âm lịch');
    // 17:00 UTC ngày 05/02 là 00:00 ngày 06/02 giờ Việt Nam.
    expect(formatLunar(new Date('2027-02-05T17:00:00Z'))).toBe('mùng 1 tháng Giêng âm lịch');
    expect(formatLunar('2027-02-05T17:00:00Z')).toBe('mùng 1 tháng Giêng âm lịch');
    expect(formatLunar(new Date('2027-02-05T16:59:59Z'))).toMatch(/^ngày (29|30) tháng Chạp âm lịch$/);
  });

  it('ngày không hợp lệ thì báo lỗi', () => {
    expect(() => formatLunar('không phải ngày')).toThrow(RangeError);
    expect(() => solarToLunar(2026, 2, 30)).toThrow(RangeError);
    expect(() => solarToLunar(2026, 13, 1)).toThrow(RangeError);
  });
});

describe('fixedHolidaySuggestions', () => {
  const list = fixedHolidaySuggestions(2027);
  const byDay = new Map(list.map((h) => [h.day, h]));

  it('gồm các ngày dương cố định', () => {
    expect(byDay.get('2027-01-01')?.name).toBe('Tết Dương lịch');
    expect(byDay.get('2027-04-30')).toBeDefined();
    expect(byDay.get('2027-05-01')).toBeDefined();
    expect(byDay.get('2027-09-02')?.name).toBe('Quốc khánh 2/9');
    for (const day of ['2027-01-01', '2027-04-30', '2027-05-01', '2027-09-02']) {
      expect(byDay.get(day)?.lunarLabel).toBeNull();
    }
  });

  it('Tết Nguyên đán: từ ngày cuối tháng Chạp tới mùng 5, sáu ngày liên tiếp', () => {
    const tet = list.filter((h) => h.name.startsWith('Tết Nguyên đán'));
    expect(tet.map((h) => h.day)).toEqual(['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10']);
    expect(tet[0]?.lunarLabel).toMatch(/^ngày (29|30) tháng Chạp âm lịch$/);
    expect(tet[1]?.lunarLabel).toBe('mùng 1 tháng Giêng âm lịch');
    expect(tet[5]?.lunarLabel).toBe('mùng 5 tháng Giêng âm lịch');
  });

  it('Giỗ Tổ Hùng Vương là mùng 10 tháng 3 âm lịch', () => {
    const hung = list.find((h) => h.name === 'Giỗ Tổ Hùng Vương');
    expect(hung).toBeDefined();
    if (!hung) return;
    expect(hung.lunarLabel).toBe('mùng 10 tháng 3 âm lịch');
    const [y, m, d] = hung.day.split('-').map(Number) as [number, number, number];
    expect(solarToLunar(y, m, d)).toEqual({ day: 10, month: 3, year: 2027, leap: false });
  });

  it('mọi năm 2020–2035: mọi dòng là kind public, ngày đúng dạng, xếp tăng dần, không trùng', () => {
    for (let y = FROM_YEAR; y <= TO_YEAR; y += 1) {
      const items = fixedHolidaySuggestions(y);
      expect(items.length).toBe(11);
      const days = items.map((h) => h.day);
      expect([...days].sort()).toEqual(days);
      expect(new Set(days).size).toBe(days.length);
      for (const h of items) {
        expect(h.kind).toBe('public');
        expect(h.day).toMatch(new RegExp(`^${y}-\\d{2}-\\d{2}$`));
        expect(h.name.length).toBeGreaterThan(0);
      }
    }
  });
});
