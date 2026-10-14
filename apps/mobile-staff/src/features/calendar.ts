import { VN_UTC_OFFSET_MINUTES, type Holiday, type WorkCalendar } from '@mihato/domain';
import { isWorkingDay } from '@mihato/domain/calendar';

/**
 * Phép tính cho lưới ngày tự viết (S4 Xin thêm thời gian, ô ngày trong biểu mẫu). Ngày lịch là `YYYY-MM-DD`
 * theo giờ Việt Nam (SPEC 10.1); mọi phép tính dùng UTC thuần nên không lệch theo múi giờ của máy. Có test.
 */
const p2 = (n: number) => String(n).padStart(2, '0');

/** Lịch làm việc của tổ chức (`me.calendar`) ghép với ngày nghỉ (`GET /v1/holidays`), theo đúng kiểu của engine. */
export function workCalendarOf(calendar: { workdays: number[]; workStart: string; workEnd: string }, holidays: readonly Holiday[]): WorkCalendar {
  return { utcOffsetMinutes: VN_UTC_OFFSET_MINUTES, workdays: calendar.workdays, workStart: calendar.workStart, workEnd: calendar.workEnd, holidays: holidays.map((h) => ({ day: h.day, kind: h.kind })) };
}

/**
 * Ngày nghỉ: không thuộc ngày làm việc trong tuần hoặc là ngày lễ, trừ ngày làm bù (`makeup_workday`).
 * Dùng chính `isWorkingDay` của engine (SPEC 4.5), nên app và máy chủ luôn tính giống nhau.
 */
export function isDayOff(day: string, calendar: WorkCalendar | null): boolean {
  return calendar ? !isWorkingDay(day, calendar) : false;
}

export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${p2(month)}-${p2(day)}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Các tuần của một tháng, tuần bắt đầu từ Thứ Hai. Ô ngoài tháng là null. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  // getUTCDay: 0 = Chủ Nhật. Đổi sang 0 = Thứ Hai.
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysInMonth(year, month); day++) cells.push(dateKey(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Thời điểm giữa trưa giờ Việt Nam của một ngày lịch: dùng để định dạng ngày mà không lo lệch ngày. */
export function noonOf(key: string): string {
  return `${key}T12:00:00+07:00`;
}
