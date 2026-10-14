import { fmt, formatDateFull, vi } from '@mihato/i18n';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { monthGrid, noonOf, parseDateKey, shiftMonth } from '../features/calendar';
import { AppText } from './AppText';
import { Glyph } from './Glyph';
import { color, profile, space } from './theme';

const t = vi.staff.calendar;

type DateGridProps = {
  /** ngày đang chọn, `YYYY-MM-DD` theo giờ Việt Nam */
  value: string | null;
  onChange: (dateKey: string) => void;
  /** ngày sớm nhất được chọn */
  min?: string;
  today: string;
  /** ngày nghỉ (cuối tuần, ngày lễ): làm mờ và không chọn được */
  isOff?: (dateKey: string) => boolean;
  /** người dùng chạm một ngày nghỉ: màn hình giải thích bằng chữ vì sao không chọn được */
  onOffPress?: (dateKey: string) => void;
};

/**
 * Lưới ngày theo tháng, tuần bắt đầu từ Thứ Hai. Mỗi ô ngày đọc được đầy đủ bằng trình đọc màn hình
 * ("Thứ Năm, ngày 15 tháng 10 năm 2026"). Ngày đang chọn có nền xanh và chữ đậm; hôm nay có viền;
 * ngày nghỉ và ngày trước mốc sớm nhất làm mờ.
 *
 * Vùng chạm của mỗi ô ngày từ 48×48dp cả trên màn rộng 360dp (SPEC 8.1): lưới lấn ra 8dp mỗi bên so với lề
 * màn hình 16dp và không có đệm ngang, nên bảy ô chia (360 − 16 − 2) dp, mỗi ô gần 49dp.
 */
export function DateGrid({ value, onChange, min, today, isOff, onOffPress }: DateGridProps) {
  const start = parseDateKey(value ?? min ?? today);
  const [view, setView] = useState({ year: start.year, month: start.month });
  const weeks = monthGrid(view.year, view.month);
  const minMonth = min ? parseDateKey(min) : null;
  const canGoBack = !minMonth || view.year > minMonth.year || (view.year === minMonth.year && view.month > minMonth.month);

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.prevMonth}
          accessibilityState={{ disabled: !canGoBack }}
          disabled={!canGoBack}
          onPress={() => setView((v) => shiftMonth(v.year, v.month, -1))}
          style={({ pressed }) => [styles.nav, pressed && styles.pressed, !canGoBack && styles.dim]}
          testID="calendar-prev"
        >
          <Glyph name="back" size={16} tint={color.primary} />
        </Pressable>
        <AppText variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite" testID="calendar-month">
          {fmt(t.monthTitle, { n: `${view.month}/${view.year}` })}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.nextMonth}
          onPress={() => setView((v) => shiftMonth(v.year, v.month, 1))}
          style={({ pressed }) => [styles.nav, pressed && styles.pressed]}
          testID="calendar-next"
        >
          <Glyph name="forward" size={16} tint={color.primary} />
        </Pressable>
      </View>

      <View style={styles.week} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {t.weekdays.map((name) => (
          <View key={name} style={styles.cell}>
            <AppText variant="caption" tone="sub" maxFontSizeMultiplier={1.3}>
              {name}
            </AppText>
          </View>
        ))}
      </View>

      {weeks.map((week, w) => (
        <View key={w} style={styles.week}>
          {week.map((day, d) => {
            if (!day) return <View key={d} style={styles.cell} />;
            const disabled = !!min && day < min;
            const off = !disabled && (isOff?.(day) ?? false);
            const selected = day === value;
            const isToday = day === today;
            return (
              <Pressable
                key={day}
                accessibilityRole="button"
                accessibilityLabel={`${formatDateFull(noonOf(day))}${selected ? `, ${t.selected}` : ''}${isToday ? `, ${t.today}` : ''}${off ? `, ${t.dayOff}` : ''}`}
                accessibilityState={{ selected, disabled }}
                disabled={disabled}
                // Ngày nghỉ vẫn nhận chạm (nhãn đọc đã có "ngày nghỉ"), để màn hình nói rõ vì sao không chọn được.
                onPress={() => (off ? onOffPress?.(day) : onChange(day))}
                style={({ pressed }) => [styles.cell, styles.day, isToday && styles.today, selected && styles.selected, pressed && !selected && !off && styles.pressed]}
                testID={`calendar-day-${day}`}
              >
                <AppText weight={selected ? 'bold' : 'regular'} tone={selected ? 'onPrimary' : 'text'} maxFontSizeMultiplier={1.3} style={disabled || off ? styles.dim : undefined}>
                  {String(parseDateKey(day).day)}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: color.surface,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    // Lấn ra ngoài lề màn hình 8dp mỗi bên, không đệm ngang: xem chú thích về vùng chạm ở trên.
    marginHorizontal: -space.sm,
    paddingVertical: space.xs,
    gap: 2,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nav: { width: profile.touch.min, height: profile.touch.min, alignItems: 'center', justifyContent: 'center', borderRadius: profile.touch.min / 2 },
  week: { flexDirection: 'row' },
  cell: { flex: 1, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  day: { minHeight: profile.touch.min, minWidth: profile.touch.min, borderRadius: profile.radius, borderWidth: 1, borderColor: 'transparent' },
  today: { borderColor: color.border },
  selected: { backgroundColor: color.primary, borderColor: color.primary },
  pressed: { backgroundColor: color.primaryTint },
  // Ngày không chọn được: làm nhạt, và trình đọc màn hình báo "không dùng được".
  dim: { opacity: 0.4 },
});
