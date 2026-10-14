import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  addDuration,
  addWorkingDays,
  atLocalTime,
  computeDue,
  endOfWorkday,
  isWorkingDay,
  isoWeekday,
  lateWorkingDays,
  nextWorkingDay,
  previousWorkingDay,
  startOfWorkday,
  toLocalDate,
  workingDaysBetween,
} from '../src/calendar';
import { DEFAULT_CALENDAR, type WorkCalendar } from '../src/engine';

/** Lịch của kịch bản vàng: Thứ Hai đến Thứ Sáu, 08:00–17:00, giờ Việt Nam, không có ngày lễ. */
const VN: WorkCalendar = DEFAULT_CALENDAR;
const TARGET = '2026-10-15'; // Thứ Năm

describe('ngày và giờ địa phương', () => {
  it('đổi thời điểm UTC sang ngày lịch giờ Việt Nam', () => {
    expect(toLocalDate('2026-10-05T16:59:59.000Z', VN)).toBe('2026-10-05');
    expect(toLocalDate('2026-10-05T17:00:00.000Z', VN)).toBe('2026-10-06'); // 00:00 ngày 06 giờ VN
    expect(toLocalDate(new Date('2026-12-31T20:00:00.000Z'), VN)).toBe('2027-01-01');
  });

  it('đổi giờ địa phương sang thời điểm UTC', () => {
    expect(atLocalTime('2026-10-06', '08:30', VN).toISOString()).toBe('2026-10-06T01:30:00.000Z');
    expect(atLocalTime('2026-10-06', '00:00', VN).toISOString()).toBe('2026-10-05T17:00:00.000Z');
  });

  it('hạn 17:00 giờ Việt Nam lưu thành 10:00 UTC', () => {
    expect(endOfWorkday('2026-10-06', VN).toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(startOfWorkday('2026-10-06', VN).toISOString()).toBe('2026-10-06T01:00:00.000Z');
  });

  it('thứ trong tuần theo ISO', () => {
    expect(isoWeekday('2026-10-15')).toBe(4);
    expect(isoWeekday('2026-10-17')).toBe(6);
    expect(isoWeekday('2026-10-18')).toBe(7);
    expect(isoWeekday('2026-10-19')).toBe(1);
    expect(isoWeekday('1970-01-01')).toBe(4);
    expect(isoWeekday('1969-12-28')).toBe(7);
  });

  it('từ chối ngày và giờ sai dạng', () => {
    expect(() => isWorkingDay('15/10/2026', VN)).toThrow(RangeError);
    expect(() => isWorkingDay('2026-02-30', VN)).toThrow(RangeError);
    expect(() => atLocalTime('2026-10-06', '25:00', VN)).toThrow(RangeError);
    expect(() => toLocalDate('không phải ngày', VN)).toThrow(RangeError);
  });

  it('lệch múi giờ khác Việt Nam vẫn tính bằng số học', () => {
    const utc: WorkCalendar = { ...VN, utcOffsetMinutes: 0 };
    const tokyo: WorkCalendar = { ...VN, utcOffsetMinutes: 540 };
    expect(toLocalDate('2026-10-05T17:00:00.000Z', utc)).toBe('2026-10-05');
    expect(toLocalDate('2026-10-05T15:00:00.000Z', tokyo)).toBe('2026-10-06');
    expect(endOfWorkday('2026-10-06', tokyo).toISOString()).toBe('2026-10-06T08:00:00.000Z');
  });
});

describe('isWorkingDay', () => {
  it('Thứ Hai đến Thứ Sáu là ngày làm việc, cuối tuần là ngày nghỉ', () => {
    expect(isWorkingDay('2026-10-16', VN)).toBe(true); // Thứ Sáu
    expect(isWorkingDay('2026-10-17', VN)).toBe(false); // Thứ Bảy
    expect(isWorkingDay('2026-10-18', VN)).toBe(false); // Chủ Nhật
    expect(isWorkingDay('2026-10-19', VN)).toBe(true); // Thứ Hai
  });

  it('ngày lễ public và company là ngày nghỉ; makeup_workday là ngày làm bù', () => {
    const cal: WorkCalendar = {
      ...VN,
      holidays: [
        { day: '2026-10-12', kind: 'company' },
        { day: '2026-09-02', kind: 'public' },
        { day: '2026-10-10', kind: 'makeup_workday' },
      ],
    };
    expect(isWorkingDay('2026-10-12', cal)).toBe(false);
    expect(isWorkingDay('2026-09-02', cal)).toBe(false);
    expect(isWorkingDay('2026-10-10', cal)).toBe(true); // Thứ Bảy làm bù
    expect(isWorkingDay('2026-10-11', cal)).toBe(false);
  });

  it('nhập cả nghỉ lẫn làm bù cho một ngày thì ngày nghỉ thắng', () => {
    const cal: WorkCalendar = {
      ...VN,
      holidays: [
        { day: '2026-10-10', kind: 'makeup_workday' },
        { day: '2026-10-10', kind: 'public' },
      ],
    };
    expect(isWorkingDay('2026-10-10', cal)).toBe(false);
  });

  it('tuần làm việc có Thứ Bảy', () => {
    const cal: WorkCalendar = { ...VN, workdays: [1, 2, 3, 4, 5, 6] };
    expect(isWorkingDay('2026-10-17', cal)).toBe(true);
    expect(isWorkingDay('2026-10-18', cal)).toBe(false);
  });
});

describe('addWorkingDays', () => {
  // Bảng vector bắt buộc ở SPEC 4.5: mốc đích Thứ Năm 15/10/2026, lịch Thứ Hai đến Thứ Sáu, không ngày lễ.
  it.each([
    [-4, '2026-10-09', 5], // Thứ Sáu: đếm 14, 13, 12, 09, nhảy qua cuối tuần
    [-5, '2026-10-08', 4], // Thứ Năm
    [-6, '2026-10-07', 3], // Thứ Tư
    [-7, '2026-10-06', 2], // Thứ Ba
    [1, '2026-10-16', 5], // Thứ Sáu
    [2, '2026-10-19', 1], // Thứ Hai: nhảy qua cuối tuần
  ])('vector SPEC 4.5: offset %i → %s', (offset, expected, weekday) => {
    const got = addWorkingDays(TARGET, offset, VN);
    expect(got).toBe(expected);
    expect(isoWeekday(got)).toBe(weekday);
  });

  it('n = 0 với ngày làm việc trả chính ngày đó', () => {
    expect(addWorkingDays(TARGET, 0, VN)).toBe(TARGET);
  });

  it('mốc đích rơi vào Thứ Bảy: đếm lùi bắt đầu từ ngày làm việc liền trước (Thứ Sáu)', () => {
    expect(addWorkingDays('2026-10-17', -1, VN)).toBe('2026-10-15');
    expect(addWorkingDays('2026-10-17', -2, VN)).toBe('2026-10-14');
    expect(addWorkingDays('2026-10-17', -5, VN)).toBe('2026-10-09');
  });

  it('mốc đích rơi vào Chủ Nhật: cũng bắt đầu từ Thứ Sáu', () => {
    expect(addWorkingDays('2026-10-18', -1, VN)).toBe('2026-10-15');
    expect(addWorkingDays('2026-10-18', -6, VN)).toBe('2026-10-08');
  });

  it('quy ước n = 0 và ngày nghỉ: trả ngày làm việc liền trước', () => {
    expect(addWorkingDays('2026-10-17', 0, VN)).toBe('2026-10-16');
    expect(addWorkingDays('2026-10-18', 0, VN)).toBe('2026-10-16');
  });

  it('n dương từ ngày nghỉ: ngày làm việc đầu tiên sau đó là ngày thứ nhất', () => {
    expect(addWorkingDays('2026-10-17', 1, VN)).toBe('2026-10-19');
    expect(addWorkingDays('2026-10-18', 2, VN)).toBe('2026-10-20');
  });

  it('ngày lễ do Văn phòng nhập nằm giữa khoảng đếm', () => {
    const cal: WorkCalendar = { ...VN, holidays: [{ day: '2026-10-12', kind: 'company' }] };
    // đếm 14, 13, (12 nghỉ), 09, 08
    expect(addWorkingDays(TARGET, -4, cal)).toBe('2026-10-08');
    expect(addWorkingDays('2026-10-09', 1, cal)).toBe('2026-10-13');
    // mốc rơi đúng ngày lễ: bắt đầu từ Thứ Sáu 09/10
    expect(addWorkingDays('2026-10-12', -1, cal)).toBe('2026-10-08');
    expect(addWorkingDays('2026-10-12', 0, cal)).toBe('2026-10-09');
  });

  it('kỳ nghỉ dài nhiều ngày liên tiếp', () => {
    const cal: WorkCalendar = {
      ...VN,
      holidays: ['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11'].map((day) => ({ day, kind: 'public' as const })),
    };
    expect(addWorkingDays('2027-02-04', 1, cal)).toBe('2027-02-12');
    expect(addWorkingDays('2027-02-12', -1, cal)).toBe('2027-02-04');
  });

  it('tuần làm việc có Thứ Bảy', () => {
    const cal: WorkCalendar = { ...VN, workdays: [1, 2, 3, 4, 5, 6] };
    // đếm 14, 13, 12, 10 (Thứ Bảy)
    expect(addWorkingDays(TARGET, -4, cal)).toBe('2026-10-10');
    expect(addWorkingDays(TARGET, 2, cal)).toBe('2026-10-17');
    expect(addWorkingDays(TARGET, 3, cal)).toBe('2026-10-19');
  });

  it('ngày làm bù được đếm như ngày làm việc', () => {
    const cal: WorkCalendar = { ...VN, holidays: [{ day: '2026-10-10', kind: 'makeup_workday' }] };
    expect(addWorkingDays(TARGET, -4, cal)).toBe('2026-10-10');
  });

  it('báo lỗi khi n không nguyên hoặc lịch không có ngày làm việc', () => {
    expect(() => addWorkingDays(TARGET, 1.5, VN)).toThrow(RangeError);
    expect(() => addWorkingDays(TARGET, 1, { ...VN, workdays: [] })).toThrow(RangeError);
  });

  it('ngày làm việc liền trước và liền sau', () => {
    expect(previousWorkingDay('2026-10-19', VN)).toBe('2026-10-16');
    expect(previousWorkingDay('2026-10-18', VN)).toBe('2026-10-16');
    expect(nextWorkingDay('2026-10-16', VN)).toBe('2026-10-19');
    expect(nextWorkingDay('2026-10-17', VN)).toBe('2026-10-19');
    expect(addCalendarDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('workingDaysBetween và lateWorkingDays', () => {
  const due = '2026-10-07T10:00:00.000Z'; // Thứ Tư 07/10 17:00 giờ VN

  it('hạn Thứ Tư 17:00: sáng Thứ Năm trễ 1, Thứ Sáu trễ 2, Thứ Hai tuần sau trễ 3', () => {
    expect(lateWorkingDays(due, atLocalTime('2026-10-08', '08:30', VN), VN)).toBe(1);
    expect(lateWorkingDays(due, atLocalTime('2026-10-09', '08:30', VN), VN)).toBe(2);
    expect(lateWorkingDays(due, atLocalTime('2026-10-10', '08:30', VN), VN)).toBe(2); // Thứ Bảy không tính
    expect(lateWorkingDays(due, atLocalTime('2026-10-12', '08:30', VN), VN)).toBe(3);
  });

  it('chưa quá hạn hoặc mới quá hạn trong cùng ngày thì trễ 0 ngày', () => {
    expect(lateWorkingDays(due, '2026-10-07T09:59:59.000Z', VN)).toBe(0);
    expect(lateWorkingDays(due, due, VN)).toBe(0);
    expect(lateWorkingDays(due, '2026-10-07T12:00:00.000Z', VN)).toBe(0);
  });

  it('workingDaysBetween đếm ngày làm việc d với ngày(from) < d <= ngày(to)', () => {
    expect(workingDaysBetween('2026-10-02T02:00:00.000Z', '2026-10-06T10:00:00.000Z', VN)).toBe(2); // T6 → T3: T2, T3
    expect(workingDaysBetween('2026-10-09T02:00:00.000Z', '2026-10-11T02:00:00.000Z', VN)).toBe(0); // T6 → CN
    expect(workingDaysBetween('2026-10-06T10:00:00.000Z', '2026-10-02T02:00:00.000Z', VN)).toBe(0); // to trước from
    expect(workingDaysBetween('2026-10-06T01:00:00.000Z', '2026-10-06T09:00:00.000Z', VN)).toBe(0); // cùng ngày
  });

  it('ngày lễ nằm giữa không được đếm', () => {
    const cal: WorkCalendar = { ...VN, holidays: [{ day: '2026-10-08', kind: 'public' }] };
    expect(lateWorkingDays(due, atLocalTime('2026-10-09', '08:30', cal), cal)).toBe(1);
  });
});

describe('computeDue', () => {
  const runTarget = atLocalTime(TARGET, '00:00', VN);
  const runStart = atLocalTime('2026-10-02', '09:00', VN);
  const anchors = { activation: runStart, runStart, runTarget };
  const wd = (value: number) => ({ value, unit: 'working_day' as const });

  it('các hạn của kịch bản vàng: tính lùi từ mốc đích, 17:00 giờ Việt Nam = 10:00 UTC', () => {
    const due = (v: number) => computeDue({ anchor: 'run_target', offset: wd(v) }, anchors, VN)?.toISOString();
    expect(due(-7)).toBe('2026-10-06T10:00:00.000Z'); // s1, s4: Thứ Ba
    expect(due(-6)).toBe('2026-10-07T10:00:00.000Z'); // s3, s6: Thứ Tư
    expect(due(-5)).toBe('2026-10-08T10:00:00.000Z'); // s2: Thứ Năm
    expect(due(-4)).toBe('2026-10-09T10:00:00.000Z'); // s5: Thứ Sáu
  });

  it('trả null khi mốc là run_target mà không có mốc đích', () => {
    expect(computeDue({ anchor: 'run_target', offset: wd(-1) }, { ...anchors, runTarget: null }, VN)).toBeNull();
  });

  it('atTime ghi rõ thì dùng giờ đó; end_of_workday là mặc định', () => {
    expect(computeDue({ anchor: 'run_target', offset: wd(-1), atTime: '11:30' }, anchors, VN)?.toISOString()).toBe('2026-10-14T04:30:00.000Z');
    expect(computeDue({ anchor: 'run_target', offset: wd(-1), atTime: 'end_of_workday' }, anchors, VN)?.toISOString()).toBe(
      '2026-10-14T10:00:00.000Z',
    );
  });

  it('mốc đích rơi vào Thứ Bảy hoặc Chủ Nhật', () => {
    const sat = { ...anchors, runTarget: atLocalTime('2026-10-17', '00:00', VN) };
    const sun = { ...anchors, runTarget: atLocalTime('2026-10-18', '00:00', VN) };
    expect(computeDue({ anchor: 'run_target', offset: wd(-1) }, sat, VN)?.toISOString()).toBe('2026-10-15T10:00:00.000Z');
    expect(computeDue({ anchor: 'run_target', offset: wd(-1) }, sun, VN)?.toISOString()).toBe('2026-10-15T10:00:00.000Z');
    // offset 0 từ mốc đích: lùi về Thứ Sáu, không dời sang sau sự việc
    expect(computeDue({ anchor: 'run_target', offset: wd(0) }, sat, VN)?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
  });

  it('mốc activation và run_start', () => {
    const act = { ...anchors, activation: atLocalTime('2026-10-05', '11:00', VN) };
    expect(computeDue({ anchor: 'activation', offset: wd(2) }, act, VN)?.toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(computeDue({ anchor: 'run_start', offset: wd(1) }, act, VN)?.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(computeDue({ anchor: 'activation', offset: wd(0) }, act, VN)?.toISOString()).toBe('2026-10-05T10:00:00.000Z');
  });

  it('việc tới lượt vào Thứ Bảy: offset 0 dời tới Thứ Hai, không lùi về quá khứ', () => {
    const sat = { ...anchors, activation: atLocalTime('2026-10-10', '10:00', VN) };
    expect(computeDue({ anchor: 'activation', offset: wd(0) }, sat, VN)?.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(computeDue({ anchor: 'activation', offset: wd(1) }, sat, VN)?.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(computeDue({ anchor: 'activation', offset: wd(2) }, sat, VN)?.toISOString()).toBe('2026-10-13T10:00:00.000Z');
  });

  it('calendar_day rơi vào ngày nghỉ được dời về ngày làm việc', () => {
    const act = { ...anchors, activation: atLocalTime('2026-10-08', '09:00', VN) };
    const cd = (value: number) => ({ value, unit: 'calendar_day' as const });
    // Thứ Năm + 2 ngày lịch = Thứ Bảy → dời tới Thứ Hai
    expect(computeDue({ anchor: 'activation', offset: cd(2) }, act, VN)?.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(computeDue({ anchor: 'activation', offset: cd(1) }, act, VN)?.toISOString()).toBe('2026-10-09T10:00:00.000Z');
    // 15/10 − 4 ngày lịch = Chủ Nhật 11/10 → lùi về Thứ Sáu 09/10
    expect(computeDue({ anchor: 'run_target', offset: cd(-4) }, act, VN)?.toISOString()).toBe('2026-10-09T10:00:00.000Z');
  });

  it('đơn vị giờ: cộng từ đúng thời điểm mốc, rơi vào ngày nghỉ thì dời ngày và giữ giờ', () => {
    const act = { ...anchors, activation: atLocalTime('2026-10-09', '15:00', VN) };
    const h = (value: number) => ({ value, unit: 'hour' as const });
    expect(computeDue({ anchor: 'activation', offset: h(4) }, act, VN)?.toISOString()).toBe(atLocalTime('2026-10-09', '19:00', VN).toISOString());
    // Thứ Sáu 15:00 + 24 giờ = Thứ Bảy 15:00 → Thứ Hai 15:00
    expect(computeDue({ anchor: 'activation', offset: h(24) }, act, VN)?.toISOString()).toBe(atLocalTime('2026-10-12', '15:00', VN).toISOString());
  });

  it('ngày lễ nằm giữa khoảng đếm làm hạn sớm hơn', () => {
    const cal: WorkCalendar = { ...VN, holidays: [{ day: '2026-10-12', kind: 'company' }] };
    expect(computeDue({ anchor: 'run_target', offset: wd(-4) }, anchors, cal)?.toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });
});

describe('addDuration', () => {
  const due = new Date('2026-10-07T10:00:00.000Z'); // Thứ Tư 17:00 giờ VN
  const wd = (value: number) => ({ value, unit: 'working_day' as const });

  it('mốc nhắc theo hạn, lúc 08:30', () => {
    expect(addDuration(due, wd(-1), VN, '08:30').toISOString()).toBe('2026-10-06T01:30:00.000Z');
    expect(addDuration(due, wd(0), VN, '08:30').toISOString()).toBe('2026-10-07T01:30:00.000Z');
    expect(addDuration(due, wd(1), VN, '08:30').toISOString()).toBe('2026-10-08T01:30:00.000Z');
    expect(addDuration(due, wd(2), VN, '08:30').toISOString()).toBe('2026-10-09T01:30:00.000Z');
    expect(addDuration(due, wd(3), VN, '08:30').toISOString()).toBe('2026-10-12T01:30:00.000Z'); // nhảy qua cuối tuần
  });

  it('bỏ trống atTime thì giữ giờ của mốc', () => {
    expect(addDuration(due, wd(1), VN).toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(addDuration(due, { value: 3, unit: 'calendar_day' }, VN).toISOString()).toBe('2026-10-10T10:00:00.000Z'); // Thứ Bảy, không dời
  });

  it('đơn vị giờ cộng thẳng và bỏ qua atTime', () => {
    expect(addDuration(due, { value: 4, unit: 'hour' }, VN, '08:30').toISOString()).toBe('2026-10-07T14:00:00.000Z');
    expect(addDuration(due, { value: -2, unit: 'hour' }, VN).toISOString()).toBe('2026-10-07T08:00:00.000Z');
  });
});

describe('thuộc tính của lịch làm việc', () => {
  const calArb: fc.Arbitrary<WorkCalendar> = fc
    .record({
      workdays: fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }),
      holidays: fc.array(
        fc.record({
          day: fc.integer({ min: 0, max: 120 }).map((n) => addCalendarDays('2026-09-01', n)),
          kind: fc.constantFrom('public' as const, 'company' as const, 'makeup_workday' as const),
        }),
        { maxLength: 12 },
      ),
    })
    .map(({ workdays, holidays }) => ({ ...VN, workdays, holidays }));
  const dayArb = fc.integer({ min: 0, max: 120 }).map((n) => addCalendarDays('2026-09-01', n));
  const numRuns = 300;

  it('addWorkingDays luôn trả ngày làm việc và không giảm khi n tăng', () => {
    fc.assert(
      fc.property(calArb, dayArb, fc.integer({ min: -30, max: 30 }), (cal, day, n) => {
        const a = addWorkingDays(day, n, cal);
        const b = addWorkingDays(day, n + 1, cal);
        expect(isWorkingDay(a, cal)).toBe(true);
        expect(b > a).toBe(true);
      }),
      { numRuns },
    );
  });

  it('đếm tới rồi đếm lùi trở về ngày xuất phát (đã chuẩn hoá về ngày làm việc)', () => {
    fc.assert(
      fc.property(calArb, dayArb, fc.integer({ min: -30, max: 30 }), (cal, day, n) => {
        const base = addWorkingDays(day, 0, cal);
        expect(addWorkingDays(addWorkingDays(day, n, cal), -n, cal)).toBe(base);
      }),
      { numRuns },
    );
  });

  it('workingDaysBetween khớp với addWorkingDays', () => {
    fc.assert(
      fc.property(calArb, dayArb, fc.integer({ min: 0, max: 30 }), (cal, day, n) => {
        const base = addWorkingDays(day, 0, cal);
        const later = addWorkingDays(base, n, cal);
        expect(workingDaysBetween(endOfWorkday(base, cal), endOfWorkday(later, cal), cal)).toBe(n);
      }),
      { numRuns },
    );
  });

  it('mọi hạn do computeDue tính ra đều rơi vào ngày làm việc', () => {
    const ruleArb = fc.record({
      anchor: fc.constantFrom('activation' as const, 'run_start' as const, 'run_target' as const),
      offset: fc.record({
        value: fc.integer({ min: -20, max: 20 }),
        unit: fc.constantFrom('working_day' as const, 'calendar_day' as const, 'hour' as const),
      }),
      atTime: fc.constantFrom(undefined, 'end_of_workday' as const, '09:15'),
    });
    fc.assert(
      fc.property(calArb, ruleArb, dayArb, dayArb, fc.integer({ min: 0, max: 1439 }), (cal, rule, startDay, targetDay, minute) => {
        const activation = new Date(atLocalTime(startDay, '00:00', cal).getTime() + minute * 60_000);
        const due = computeDue(rule, { activation, runStart: activation, runTarget: atLocalTime(targetDay, '00:00', cal) }, cal);
        expect(due).not.toBeNull();
        expect(isWorkingDay(toLocalDate(due as Date, cal), cal)).toBe(true);
      }),
      { numRuns },
    );
  });
});
