import { fmt, vi } from '@mihato/i18n';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { PIN_LENGTH } from '../session/pin';
import { AppText } from './AppText';
import { color, profile, space } from './theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Sáu ô của mã PIN: chỉ cho biết đã nhập mấy số, không hiện số. */
export function PinDots({ length }: { length: number }) {
  return (
    <View style={styles.dots} accessible accessibilityLabel={fmt(vi.staff.lock.entered, { n: length, tổng: PIN_LENGTH })} accessibilityLiveRegion="polite">
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <View key={i} style={[styles.dot, i < length && styles.dotFilled]} />
      ))}
    </View>
  );
}

type PinPadProps = {
  value: string;
  onChange: (next: string) => void;
  /** nhập đủ sáu số */
  onComplete: (pin: string) => void;
  disabled?: boolean;
  /** phím góc dưới trái: dùng vân tay hoặc khuôn mặt */
  onBiometric?: () => void;
};

/** Bàn phím số 3 nhân 4, mỗi phím 64dp (SPEC 7.3 hồ sơ standard). */
export function PinPad({ value, onChange, onComplete, disabled = false, onBiometric }: PinPadProps) {
  const press = (digit: string) => {
    if (disabled || value.length >= PIN_LENGTH) return;
    if (Platform.OS !== 'web') void Haptics.selectionAsync().catch(() => undefined);
    const next = value + digit;
    onChange(next);
    if (next.length === PIN_LENGTH) onComplete(next);
  };

  const key = (digit: string) => (
    <Pressable
      key={digit}
      accessibilityRole="button"
      accessibilityLabel={digit}
      disabled={disabled}
      onPress={() => press(digit)}
      style={({ pressed }) => [styles.key, pressed && styles.keyPressed, disabled && styles.keyDisabled]}
      testID={`pin-key-${digit}`}
    >
      <AppText variant="screenTitle" weight="medium" maxFontSizeMultiplier={1.4}>
        {digit}
      </AppText>
    </Pressable>
  );

  return (
    <View style={styles.pad}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={styles.row}>
          {KEYS.slice(row * 3, row * 3 + 3).map(key)}
        </View>
      ))}
      <View style={styles.row}>
        {onBiometric ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={vi.staff.lock.useBiometric}
            disabled={disabled}
            onPress={onBiometric}
            style={({ pressed }) => [styles.key, styles.keyQuiet, pressed && styles.keyPressed]}
            testID="pin-key-biometric"
          >
            <AppText variant="caption" weight="semibold" tone="primary" style={styles.center} maxFontSizeMultiplier={1.3}>
              {vi.staff.lock.biometricKey}
            </AppText>
          </Pressable>
        ) : (
          <View style={[styles.key, styles.keyQuiet]} />
        )}
        {key('0')}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={vi.staff.lock.deleteKey}
          disabled={disabled || value.length === 0}
          onPress={() => onChange(value.slice(0, -1))}
          style={({ pressed }) => [styles.key, styles.keyQuiet, pressed && styles.keyPressed]}
          testID="pin-key-delete"
        >
          <AppText variant="caption" weight="semibold" tone="primary" style={styles.center} maxFontSizeMultiplier={1.3}>
            {vi.staff.lock.deleteShort}
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.md, paddingVertical: space.md },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.border, backgroundColor: color.surface },
  dotFilled: { backgroundColor: color.primary, borderColor: color.primary },
  pad: { alignSelf: 'center', gap: space.md },
  row: { flexDirection: 'row', gap: space.lg, justifyContent: 'center' },
  key: {
    width: profile.touch.pinKey + 8,
    height: profile.touch.pinKey,
    borderRadius: profile.radius,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyQuiet: { borderWidth: 0, backgroundColor: 'transparent' },
  keyPressed: { backgroundColor: color.primaryTint },
  keyDisabled: { opacity: 0.55 },
  center: { textAlign: 'center' },
});
