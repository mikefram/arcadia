import { vnParts } from '@mihato/i18n';
import { addDays, isLocalDate } from '@/features/org/dates';
import { vnToday } from '@/lib/datetime';

/** Kỳ báo cáo chọn sẵn (SPEC 9.6): tuần này, tháng này, 30 ngày qua, hoặc khoảng ngày tuỳ chọn. */
export const PERIOD_PRESETS = ['week', 'month', 'last30', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export function isPeriodPreset(value: string | null): value is PeriodPreset {
  return value !== null && (PERIOD_PRESETS as readonly string[]).includes(value);
}

export type DateRange = { from: string; to: string };

/**
 * Khoảng ngày lịch (giờ Việt Nam, tính cả hai đầu) của một kỳ. Tuần bắt đầu từ Thứ Hai.
 * Kỳ tuỳ chọn chưa đủ ngày hoặc ngược thứ tự thì trả null: chưa gọi máy chủ.
 */
export function rangeOf(preset: PeriodPreset, custom: DateRange, now: number = Date.now()): DateRange | null {
  const today = vnToday();
  switch (preset) {
    case 'week': {
      const sinceMonday = (vnParts(now).weekday + 6) % 7;
      return { from: addDays(today, -sinceMonday), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'last30':
      return { from: addDays(today, -29), to: today };
    case 'custom':
      return isLocalDate(custom.from) && isLocalDate(custom.to) && custom.from <= custom.to ? custom : null;
  }
}
