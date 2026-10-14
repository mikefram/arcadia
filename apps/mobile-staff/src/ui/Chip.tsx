import { StyleSheet, View } from 'react-native';
import { AppText } from './AppText';
import { Glyph, type GlyphName } from './Glyph';
import { color, space } from './theme';

/**
 * Chip trạng thái. Trạng thái phân biệt bằng CHỮ, hình và nền, không chỉ bằng màu (SPEC 7.3):
 * - done: nền xanh nhạt, dấu tích;
 * - late: nền nâu đỏ nhạt, dấu cảnh báo (CHỈ cho quá hạn);
 * - warn: đến hạn hôm nay;
 * - waiting: đang chờ (chờ gửi, chờ duyệt), viền vàng đồng;
 * - neutral: nền trắng, viền xám, chỉ khác chữ.
 */
export type ChipTone = 'neutral' | 'done' | 'late' | 'warn' | 'waiting';

const TONES: Record<ChipTone, { bg: string; border: string; text: 'text' | 'onPrimaryTint' | 'late' | 'warn' | 'gold'; glyph?: GlyphName; tint: string }> = {
  neutral: { bg: color.surface, border: color.border, text: 'text', tint: color.text },
  done: { bg: color.primaryTint, border: color.primary, text: 'onPrimaryTint', glyph: 'check', tint: color.onPrimaryTint },
  late: { bg: color.lateBg, border: color.lateText, text: 'late', glyph: 'alert', tint: color.lateText },
  warn: { bg: color.warnBg, border: color.warnText, text: 'warn', glyph: 'clock', tint: color.warnText },
  waiting: { bg: color.goldTint, border: color.gold, text: 'gold', glyph: 'clock', tint: color.gold },
};

export function Chip({ label, tone = 'neutral', glyph, testID }: { label: string; tone?: ChipTone; glyph?: GlyphName | null; testID?: string }) {
  const t = TONES[tone];
  const shape = glyph === null ? undefined : (glyph ?? t.glyph);
  return (
    <View style={[styles.chip, { backgroundColor: t.bg, borderColor: t.border }]} testID={testID}>
      {shape ? <Glyph name={shape} size={14} tint={t.tint} /> : null}
      <AppText variant="caption" weight="medium" tone={t.text}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs + 2,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs,
    borderRadius: 999,
    borderWidth: 1,
  },
});
