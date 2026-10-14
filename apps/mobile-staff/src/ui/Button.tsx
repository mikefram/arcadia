import { vi } from '@mihato/i18n';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { color, profile, space } from './theme';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  /** primary: nút chính, mỗi màn hình một nút. secondary: viền. quiet: chỉ chữ. */
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  /** đang gửi: khoá nút và đọc "Đang tải…" cho trình đọc màn hình */
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/** Nút cao tối thiểu 48dp (SPEC 8.1), chữ nút 16sp đậm, tự xuống dòng khi cỡ chữ hệ thống lớn. */
export function Button({ label, onPress, variant = 'primary', disabled = false, busy = false, accessibilityLabel, accessibilityHint, testID, style }: ButtonProps) {
  const blocked = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: blocked, busy }}
      disabled={blocked}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'quiet' && styles.quiet,
        pressed && (variant === 'primary' ? styles.primaryPressed : styles.otherPressed),
        blocked && styles.blocked,
        style,
      ]}
    >
      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color={variant === 'primary' ? color.onPrimary : color.primary} />
          <AppText variant="button" tone={variant === 'primary' ? 'onPrimary' : 'primary'} style={styles.label}>
            {vi.common.loading}
          </AppText>
        </View>
      ) : (
        <AppText variant="button" tone={variant === 'primary' ? 'onPrimary' : 'primary'} style={styles.label}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: profile.touch.primaryButton,
    minWidth: profile.touch.min,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: profile.radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: color.primary },
  primaryPressed: { backgroundColor: color.primaryPressed },
  secondary: { backgroundColor: color.surface, borderWidth: profile.borderWidth, borderColor: color.border },
  quiet: { backgroundColor: 'transparent' },
  otherPressed: { backgroundColor: color.primaryTint },
  // Nút khoá vẫn giữ chữ đủ tương phản: làm nhạt nền thay vì làm mờ chữ.
  blocked: { opacity: 0.55 },
  label: { textAlign: 'center' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
