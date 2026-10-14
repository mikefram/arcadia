import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Glyph, type GlyphName } from './Glyph';
import { SeniorText } from './SeniorText';
import { tapFeedback } from './haptics';
import { color, useSenior } from './theme';

export type SeniorButtonProps = {
  label: string;
  onPress: () => void;
  /**
   * primary: nút chính duy nhất của màn hình, nền xanh đặc, cao 64dp, chữ 22sp đậm.
   * secondary: nút phụ, viền 2dp, không nền đặc (SPEC 7.6).
   */
  variant?: 'primary' | 'secondary';
  /** hình đi kèm chữ; không có nút chỉ có hình */
  icon?: GlyphName;
  disabled?: boolean;
  /** đang gửi: khoá nút và đổi chữ, không dùng vòng quay không chữ */
  busyLabel?: string | null;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Nút của app Chủ tịch. Một chạm, có rung nhẹ, đổi màu ngay khi chạm. */
export function SeniorButton({ label, onPress, variant = 'primary', icon, disabled = false, busyLabel = null, accessibilityLabel, accessibilityHint, style, testID }: SeniorButtonProps) {
  const m = useSenior();
  const primary = variant === 'primary';
  const busy = busyLabel !== null;
  const inactive = disabled || busy;
  const tint = primary ? color.onPrimary : color.primary;
  const text = busy ? busyLabel : label;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? text}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={() => {
        tapFeedback(primary ? 'firm' : 'light');
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: primary ? m.touch.primaryButton : m.touch.secondaryButton,
          borderRadius: m.radius,
          borderWidth: m.borderWidth,
          paddingHorizontal: m.space.cardPadding,
          paddingVertical: m.space.sm,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: m.space.md,
          backgroundColor: primary ? (pressed ? color.primaryPressed : color.primary) : pressed ? color.primaryTint : color.surface,
          borderColor: primary ? (pressed ? color.primaryPressed : color.primary) : color.primary,
        },
        inactive && { opacity: 0.55 },
        style,
      ]}
      testID={testID}
    >
      {icon ? <Glyph name={icon} size={Math.round(m.font.button)} tint={tint} /> : null}
      <View style={{ flexShrink: 1 }}>
        <SeniorText variant="button" tone={primary ? 'onPrimary' : 'primary'} center>
          {text}
        </SeniorText>
      </View>
    </Pressable>
  );
}
