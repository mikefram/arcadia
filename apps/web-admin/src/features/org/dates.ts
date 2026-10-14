import { vnDateKey } from '@mihato/i18n';

/**
 * Ngày lịch 'YYYY-MM-DD' theo giờ Việt Nam (UTC+7, không đổi giờ mùa) ↔ thời điểm UTC để gửi lên API.
 * Dùng cho các ô lọc "từ ngày, đến ngày" và khoảng ngày của ủy quyền.
 */
export const startOfVnDay = (date: string): string => new Date(`${date}T00:00:00+07:00`).toISOString();
/** Giây cuối cùng của ngày: khoảng "đến hết ngày" tính cả ngày đó. */
export const endOfVnDay = (date: string): string => new Date(`${date}T23:59:59+07:00`).toISOString();
/** Giữa trưa giờ Việt Nam của một ngày lịch, để các hàm định dạng ngày không lệch sang ngày bên cạnh. */
export const vnNoon = (date: string): string => `${date}T12:00:00+07:00`;

/** Cộng (hoặc trừ) số ngày lịch vào một ngày 'YYYY-MM-DD'. */
export function addDays(date: string, days: number): string {
  return vnDateKey(Date.parse(vnNoon(date)) + days * 86_400_000);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isLocalDate = (value: string): boolean => DATE_RE.test(value) && !Number.isNaN(Date.parse(vnNoon(value)));
