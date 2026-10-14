import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText } from './AppText';
import { Glyph, type GlyphName } from './Glyph';
import { color, profile, space } from './theme';

export type BannerTone = 'info' | 'done' | 'late' | 'warn' | 'waiting';

const TONES: Record<BannerTone, { bg: string; edge: string; text: 'text' | 'onPrimaryTint' | 'late' | 'warn'; glyph?: GlyphName; tint: string }> = {
  info: { bg: color.surfaceAlt, edge: color.border, text: 'text', tint: color.text },
  done: { bg: color.primaryTint, edge: color.primary, text: 'onPrimaryTint', glyph: 'check', tint: color.onPrimaryTint },
  late: { bg: color.lateBg, edge: color.lateText, text: 'late', glyph: 'alert', tint: color.lateText },
  warn: { bg: color.warnBg, edge: color.warnText, text: 'warn', glyph: 'clock', tint: color.warnText },
  waiting: { bg: color.goldTint, edge: color.gold, text: 'text', glyph: 'clock', tint: color.gold },
};

/** Dải báo trong trang: có vạch nhấn bên trái, chữ đầy đủ; `live` thì trình đọc màn hình tự đọc khi xuất hiện. */
export function Banner({ tone = 'info', title, children, live = false, glyph, testID }: { tone?: BannerTone; title?: string; children?: ReactNode; live?: boolean; glyph?: GlyphName; testID?: string }) {
  const t = TONES[tone];
  const shape = glyph ?? t.glyph;
  return (
    <View
      style={[styles.box, { backgroundColor: t.bg, borderLeftColor: t.edge }]}
      accessibilityRole={live ? 'alert' : undefined}
      accessibilityLiveRegion={live ? 'polite' : 'none'}
      testID={testID}
    >
      {shape ? (
        <View style={styles.glyph}>
          <Glyph name={shape} size={18} tint={t.tint} />
        </View>
      ) : null}
      <View style={styles.body}>
        {title ? (
          <AppText weight="semibold" tone={t.text}>
            {title}
          </AppText>
        ) : null}
        {typeof children === 'string' ? <AppText tone={t.text}>{children}</AppText> : children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    gap: space.sm + 2,
    padding: space.md,
    borderRadius: profile.radius,
    borderLeftWidth: 4,
  },
  glyph: { paddingTop: 3 },
  body: { flex: 1, gap: space.xs },
});
