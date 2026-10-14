import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Glyph } from './Glyph';
import { tapFeedback } from './haptics';
import { color, useSenior } from './theme';

export type CardTone = 'plain' | 'primary' | 'gold' | 'late' | 'done' | 'quiet';

const TONES: Record<CardTone, { bg: string; border: string }> = {
  plain: { bg: color.surface, border: color.border },
  /** thẻ chính của màn hình: nền xanh đặc, chữ trắng */
  primary: { bg: color.primary, border: color.primary },
  gold: { bg: color.goldTint, border: color.gold },
  /** CHỈ cho việc quá hạn */
  late: { bg: color.lateBg, border: color.lateText },
  done: { bg: color.primaryTint, border: color.onPrimaryTint },
  /** khối thông tin không chạm được: viền mảnh màu nhạt */
  quiet: { bg: color.surface, border: color.hairline },
};

type CardBase = {
  children: ReactNode;
  tone?: CardTone;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Có `onPress` thì cả thẻ là một nút: một chạm, có mũi tên ở cuối, và BẮT BUỘC có nhãn đọc cho VoiceOver, TalkBack. */
export type SeniorCardProps = CardBase & ({ onPress: () => void; accessibilityLabel: string } | { onPress?: undefined; accessibilityLabel?: undefined });

/** Thẻ của app Chủ tịch: góc bo 16dp, viền 2dp, lề trong 20dp (SPEC 7.3). */
export function SeniorCard({ children, tone = 'plain', onPress, accessibilityLabel, accessibilityHint, style, testID }: SeniorCardProps) {
  const m = useSenior();
  const t = TONES[tone];
  const base: ViewStyle = {
    borderRadius: m.radius,
    borderWidth: m.borderWidth,
    borderColor: t.border,
    backgroundColor: t.bg,
    padding: m.space.cardPadding,
  };

  if (!onPress) {
    return (
      <View style={[base, style]} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={() => {
        tapFeedback(tone === 'primary' ? 'firm' : 'light');
        onPress();
      }}
      style={({ pressed }) => [
        base,
        { minHeight: m.touch.card, flexDirection: 'row', alignItems: 'center', gap: m.space.md },
        pressed && { backgroundColor: tone === 'primary' ? color.primaryPressed : tone === 'plain' || tone === 'quiet' ? color.primaryTint : t.bg, opacity: tone === 'plain' || tone === 'quiet' || tone === 'primary' ? 1 : 0.85 },
        style,
      ]}
      testID={testID}
    >
      <View style={{ flex: 1 }}>{children}</View>
      <Glyph name="forward" size={Math.round(m.font.body)} tint={tone === 'primary' ? color.onPrimary : tone === 'late' ? color.lateText : color.primary} />
    </Pressable>
  );
}
