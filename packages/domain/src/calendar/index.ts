import type { WorkCalendar } from '../engine';
import type { DueRule, Duration } from '../process';

/**
 * Lịch làm việc và hạn (SPEC 4.5). Mọi hàm ở đây là hàm thuần: không đọc đồng hồ,
 * không dùng Intl. Giờ địa phương tính bằng số học từ `cal.utcOffsetMinutes`
 * (Việt Nam không đổi giờ mùa nên lệch UTC là hằng số).
 *
 * Quy ước chung:
 * - `LocalDate` là ngày lịch 'YYYY-MM-DD' theo giờ địa phương của lịch.
 * - Ngày nghỉ = không thuộc `cal.workdays`, hoặc có trong `cal.holidays` với kind `public`/`company`.
 *   `makeup_workday` biến một ngày cuối tuần thành ngày làm việc. Nếu Văn phòng nhập cả hai loại
 *   cho cùng một ngày thì ngày nghỉ thắng [GIẢ ĐỊNH].
 */

/** 'YYYY-MM-DD' theo giờ địa phương của lịch. */
export type LocalDate = string;

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

/** Số ngày nghỉ liên tiếp tối đa được dò trước khi coi lịch là hỏng (không có ngày làm việc nào). */
const MAX_GAP_DAYS = 3660;

function toMs(instant: Date | string): number {
  const ms = typeof instant === 'string' ? new Date(instant).getTime() : instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError('Thời điểm không hợp lệ');
  return ms;
}

/** Số ngày kể từ 1970-01-01 của một ngày lịch. */
function dayNumber(day: LocalDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`Ngày không hợp lệ: ${day}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`Ngày không có thật: ${day}`);
  }
  return Math.round(ms / MS_DAY);
}

function fromDayNumber(n: number): LocalDate {
  return new Date(n * MS_DAY).toISOString().slice(0, 10);
}

/** 'HH:mm' → số phút từ đầu ngày. */
function parseTime(time: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new RangeError(`Giờ không hợp lệ: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function isWorkingDayNumber(n: number, cal: WorkCalendar): boolean {
  const day = fromDayNumber(n);
  let makeup = false;
  for (const h of cal.holidays) {
    if (h.day !== day) continue;
    if (h.kind === 'makeup_workday') makeup = true;
    else return false;
  }
  if (makeup) return true;
  // 1970-01-01 là Thứ Năm (ISO 4)
  const weekday = ((((n + 3) % 7) + 7) % 7) + 1;
  return cal.workdays.includes(weekday);
}

/** Ngày làm việc gần nhất theo hướng `step` (−1 lùi, +1 tiến), tính cả chính ngày `n`. */
function rollToWorkingDay(n: number, step: 1 | -1, cal: WorkCalendar): number {
  let cur = n;
  let guard = 0;
  while (!isWorkingDayNumber(cur, cal)) {
    cur += step;
    if (++guard > MAX_GAP_DAYS) throw new RangeError('Lịch làm việc không có ngày làm việc nào');
  }
  return cur;
}

/** Thứ trong tuần theo ISO: 1 = Thứ Hai … 7 = Chủ Nhật. */
export function isoWeekday(day: LocalDate): number {
  return ((((dayNumber(day) + 3) % 7) + 7) % 7) + 1;
}

/** Cộng ngày lịch (không xét ngày nghỉ). */
export function addCalendarDays(day: LocalDate, n: number): LocalDate {
  return fromDayNumber(dayNumber(day) + n);
}

/** Ngày lịch (giờ địa phương) của một thời điểm. */
export function toLocalDate(instant: Date | string, cal: WorkCalendar): LocalDate {
  return new Date(toMs(instant) + cal.utcOffsetMinutes * MS_MINUTE).toISOString().slice(0, 10);
}

/** Thời điểm UTC ứng với `time` ('HH:mm') giờ địa phương của ngày `day`. */
export function atLocalTime(day: LocalDate, time: string, cal: WorkCalendar): Date {
  return new Date(dayNumber(day) * MS_DAY + parseTime(time) * MS_MINUTE - cal.utcOffsetMinutes * MS_MINUTE);
}

/**
 * Ngày làm việc hay không. Ngày lễ `public`/`company` là ngày nghỉ;
 * `makeup_workday` là ngày làm bù dù rơi vào cuối tuần.
 */
export function isWorkingDay(day: LocalDate, cal: WorkCalendar): boolean {
  return isWorkingDayNumber(dayNumber(day), cal);
}

/** Ngày làm việc liền trước (không tính chính ngày `day`). */
export function previousWorkingDay(day: LocalDate, cal: WorkCalendar): LocalDate {
  return fromDayNumber(rollToWorkingDay(dayNumber(day) - 1, -1, cal));
}

/** Ngày làm việc liền sau (không tính chính ngày `day`). */
export function nextWorkingDay(day: LocalDate, cal: WorkCalendar): LocalDate {
  return fromDayNumber(rollToWorkingDay(dayNumber(day) + 1, 1, cal));
}

/**
 * Cộng `n` ngày làm việc (n âm = đếm lùi), bỏ qua cuối tuần và ngày nghỉ.
 *
 * Quy ước khi `day` là ngày nghỉ: trước khi đếm, `day` được coi như ngày làm việc liền trước nó
 * (SPEC 4.5: "đếm bắt đầu từ ngày làm việc liền trước đó"). Hệ quả, với Thứ Bảy 17/10 và lịch T2–T6:
 *   n = −1 → Thứ Năm 15/10;  n = 0 → Thứ Sáu 16/10;  n = +1 → Thứ Hai 19/10.
 * Kết quả luôn là ngày làm việc và không giảm khi n tăng.
 */
export function addWorkingDays(day: LocalDate, n: number, cal: WorkCalendar): LocalDate {
  if (!Number.isInteger(n)) throw new RangeError('Số ngày làm việc phải là số nguyên');
  let cur = rollToWorkingDay(dayNumber(day), -1, cal);
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  let guard = 0;
  while (left > 0) {
    cur += step;
    if (isWorkingDayNumber(cur, cal)) {
      left--;
      guard = 0;
    } else if (++guard > MAX_GAP_DAYS) {
      throw new RangeError('Lịch làm việc không có ngày làm việc nào');
    }
  }
  return fromDayNumber(cur);
}

/**
 * Số ngày làm việc d thoả ngày(from) < d <= ngày(to). Trả 0 khi `to` không sau `from`.
 * Ví dụ: Thứ Tư 17:00 → Thứ Năm 08:30 là 1; → Thứ Hai tuần sau là 3.
 */
export function workingDaysBetween(from: Date | string, to: Date | string, cal: WorkCalendar): number {
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  if (toMsValue <= fromMs) return 0;
  const start = dayNumber(toLocalDate(new Date(fromMs), cal));
  const end = dayNumber(toLocalDate(new Date(toMsValue), cal));
  let count = 0;
  for (let d = start + 1; d <= end; d++) if (isWorkingDayNumber(d, cal)) count++;
  return count;
}

/** Số ngày làm việc đã trễ so với hạn; 0 khi chưa quá hạn hoặc mới quá hạn trong cùng ngày. */
export function lateWorkingDays(dueAt: Date | string, now: Date | string, cal: WorkCalendar): number {
  return toMs(now) > toMs(dueAt) ? workingDaysBetween(dueAt, now, cal) : 0;
}

/** Hết giờ làm việc của ngày `day` (mặc định 17:00 giờ Việt Nam = 10:00 UTC). */
export function endOfWorkday(day: LocalDate, cal: WorkCalendar): Date {
  return atLocalTime(day, cal.workEnd, cal);
}

/** Đầu giờ làm việc của ngày `day`. */
export function startOfWorkday(day: LocalDate, cal: WorkCalendar): Date {
  return atLocalTime(day, cal.workStart, cal);
}

/**
 * Tính hạn của một việc theo `DueRule` (SPEC 4.2, 4.5). Trả null khi mốc là `run_target`
 * mà lượt chạy không có mốc đích.
 *
 * Hạn tính ra luôn rơi vào ngày làm việc (SPEC 4.10 thuộc tính 5):
 * - `working_day`: `addWorkingDays`. Riêng offset 0 với mốc `activation`/`run_start` rơi vào ngày nghỉ
 *   thì lấy ngày làm việc liền SAU (hạn không được nằm trước lúc việc tới lượt) [GIẢ ĐỊNH].
 * - `calendar_day`: cộng ngày lịch; rơi vào ngày nghỉ thì lùi về ngày làm việc liền trước khi đếm lùi
 *   (offset âm, hoặc offset 0 từ mốc đích), ngược lại dời tới ngày làm việc liền sau [GIẢ ĐỊNH].
 * - `hour`: cộng giờ từ đúng thời điểm mốc, bỏ qua `atTime`; rơi vào ngày nghỉ thì dời cả ngày
 *   theo cùng quy tắc và giữ nguyên giờ địa phương [GIẢ ĐỊNH].
 * Giờ hạn mặc định là hết giờ làm việc của ngày hạn.
 */
export function computeDue(
  rule: DueRule,
  anchors: { activation: Date; runStart: Date; runTarget: Date | null },
  cal: WorkCalendar,
): Date | null {
  const anchor = rule.anchor === 'activation' ? anchors.activation : rule.anchor === 'run_start' ? anchors.runStart : anchors.runTarget;
  if (anchor === null) return null;
  const { value, unit } = rule.offset;
  const backward = value < 0 || (value === 0 && rule.anchor === 'run_target');

  if (unit === 'hour') {
    const raw = anchor.getTime() + value * MS_HOUR;
    const rawDay = dayNumber(toLocalDate(new Date(raw), cal));
    const rolled = rollToWorkingDay(rawDay, backward ? -1 : 1, cal);
    return new Date(raw + (rolled - rawDay) * MS_DAY);
  }

  const anchorDay = dayNumber(toLocalDate(anchor, cal));
  let dueDay: number;
  if (unit === 'working_day') {
    dueDay =
      value === 0 && !backward
        ? rollToWorkingDay(anchorDay, 1, cal)
        : dayNumber(addWorkingDays(fromDayNumber(anchorDay), value, cal));
  } else {
    dueDay = rollToWorkingDay(anchorDay + value, backward ? -1 : 1, cal);
  }
  const time = rule.atTime === undefined || rule.atTime === 'end_of_workday' ? cal.workEnd : rule.atTime;
  return atLocalTime(fromDayNumber(dueDay), time, cal);
}

/**
 * Cộng một khoảng `Duration` vào một thời điểm; dùng cho mốc nhắc (SPEC 4.6) và nút timer.
 * - `working_day`: theo `addWorkingDays` (mốc rơi vào ngày nghỉ được coi như ngày làm việc liền trước).
 * - `calendar_day`: cộng ngày lịch, không dời khỏi ngày nghỉ.
 * - `hour`: cộng giờ, bỏ qua `atTime`.
 * Có `atTime` ('HH:mm') thì kết quả đặt vào giờ đó của ngày tính ra; bỏ trống thì giữ giờ địa phương của mốc.
 */
export function addDuration(from: Date, d: Duration, cal: WorkCalendar, atTime?: string): Date {
  const fromMs = toMs(from);
  if (d.unit === 'hour') return new Date(fromMs + d.value * MS_HOUR);
  const offsetMs = cal.utcOffsetMinutes * MS_MINUTE;
  const fromDay = dayNumber(toLocalDate(from, cal));
  const targetDay =
    d.unit === 'working_day' ? dayNumber(addWorkingDays(fromDayNumber(fromDay), d.value, cal)) : fromDay + d.value;
  if (atTime !== undefined) return atLocalTime(fromDayNumber(targetDay), atTime, cal);
  const msInDay = fromMs + offsetMs - fromDay * MS_DAY;
  return new Date(targetDay * MS_DAY + msInDay - offsetMs);
}
