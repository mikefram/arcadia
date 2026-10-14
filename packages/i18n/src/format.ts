/**
 * Định dạng ngày, giờ, tiền theo chuẩn lời văn ở SPEC 7.5. Giờ hiển thị luôn là giờ Việt Nam (UTC+7,
 * không đổi giờ mùa), tính bằng số học để chạy giống nhau trên Node, trình duyệt và React Native.
 */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'] as const;

export type DateInput = string | number | Date;

/** Các thành phần ngày giờ theo giờ Việt Nam. */
export function vnParts(input: DateInput) {
  const ms = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  const d = new Date(ms + VN_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' theo giờ Việt Nam. */
export function vnDateKey(input: DateInput): string {
  const p = vnParts(input);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

/** "Thứ Năm, ngày 15 tháng 10 năm 2026": dạng viết đủ cho app Chủ tịch. */
export function formatDateFull(input: DateInput): string {
  const p = vnParts(input);
  return `${WEEKDAYS[p.weekday]}, ngày ${p.day} tháng ${p.month} năm ${p.year}`;
}

/** "Thứ Năm 15/10/2026": gọn cho bảng trên web và app nhân viên. */
export function formatDateWeekday(input: DateInput): string {
  const p = vnParts(input);
  return `${WEEKDAYS[p.weekday]} ${p2(p.day)}/${p2(p.month)}/${p.year}`;
}

/** "15/10/2026" */
export function formatDate(input: DateInput): string {
  const p = vnParts(input);
  return `${p2(p.day)}/${p2(p.month)}/${p.year}`;
}

/** "17:00" (giờ 24 giờ, hồ sơ standard) */
export function formatTime(input: DateInput): string {
  const p = vnParts(input);
  return `${p2(p.hour)}:${p2(p.minute)}`;
}

/** "15/10/2026 17:00" */
export function formatDateTime(input: DateInput): string {
  return `${formatDate(input)} ${formatTime(input)}`;
}

/** "7 giờ 30 sáng", "5 giờ chiều": cách nói giờ cho app Chủ tịch. */
export function formatTimeSpoken(input: DateInput): string {
  const { hour, minute } = vnParts(input);
  const part = hour < 11 ? 'sáng' : hour < 13 ? 'trưa' : hour < 18 ? 'chiều' : 'tối';
  const h12 = hour > 12 ? hour - 12 : hour;
  return minute === 0 ? `${h12} giờ ${part}` : `${h12} giờ ${p2(minute)} ${part}`;
}

/** Buổi trong ngày để chào: sáng, trưa, chiều, tối. */
export function dayPart(input: DateInput): 'sáng' | 'trưa' | 'chiều' | 'tối' {
  const { hour } = vnParts(input);
  return hour < 11 ? 'sáng' : hour < 13 ? 'trưa' : hour < 18 ? 'chiều' : 'tối';
}

/** "20.000.000 đồng": số nguyên VND, dấu chấm ngăn nghìn. */
export function formatMoney(vnd: number | bigint): string {
  const s = String(vnd).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${s} đồng`;
}

/** "4 trên 6 việc đã xong" */
export function formatProgress(done: number, total: number): string {
  return `${done} trên ${total} việc đã xong`;
}

/** "Đã quá hạn 2 ngày làm việc" (0 ngày: vừa quá hạn hôm nay). */
export function formatLate(lateWorkingDays: number): string {
  return lateWorkingDays <= 0 ? 'Đã quá hạn' : `Đã quá hạn ${lateWorkingDays} ngày làm việc`;
}

/** Hạn so với hôm nay: "hôm nay", "ngày mai", "hôm qua", hoặc ngày đầy đủ. */
export function formatRelativeDay(input: DateInput, now: DateInput): string {
  const a = Date.parse(`${vnDateKey(input)}T00:00:00Z`);
  const b = Date.parse(`${vnDateKey(now)}T00:00:00Z`);
  const diff = Math.round((a - b) / 86_400_000);
  if (diff === 0) return 'hôm nay';
  if (diff === 1) return 'ngày mai';
  if (diff === -1) return 'hôm qua';
  return formatDateWeekday(input);
}
