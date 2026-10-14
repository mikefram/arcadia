import { vnDateKey, vnParts, type DateInput } from '@mihato/i18n';

/** Giờ Việt Nam luôn lệch UTC +7, không đổi giờ mùa (SPEC 3.5). */
const VN_OFFSET = '+07:00';

const p2 = (n: number) => String(n).padStart(2, '0');

/** Ngày 'YYYY-MM-DD' và giờ 'HH:mm' theo giờ Việt Nam → thời điểm ISO 8601 UTC để gửi lên API. */
export function vnLocalToInstant(date: string, time: string): string | null {
  const ms = Date.parse(`${date}T${time}:00${VN_OFFSET}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Thời điểm → giá trị cho <input type="date"> và <input type="time"> theo giờ Việt Nam. */
export function instantToVnLocal(input: DateInput): { date: string; time: string } {
  const p = vnParts(input);
  return { date: vnDateKey(input), time: `${p2(p.hour)}:${p2(p.minute)}` };
}

/** Hôm nay theo giờ Việt Nam, dạng 'YYYY-MM-DD'. */
export function vnToday(): string {
  return vnDateKey(Date.now());
}

/** Số ngày lịch từ `now` tới `input` theo giờ Việt Nam (âm = đã qua). */
export function vnDayDiff(input: DateInput, now: DateInput = Date.now()): number {
  const a = Date.parse(`${vnDateKey(input)}T00:00:00Z`);
  const b = Date.parse(`${vnDateKey(now)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}
