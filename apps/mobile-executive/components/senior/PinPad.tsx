import { fmtExecutive, vi } from '@mihato/i18n';
import { Pressable, View } from 'react-native';
import { SeniorText } from './SeniorText';
import { tapFeedback } from './haptics';
import { color, useSenior } from './theme';

export const PIN_LENGTH = 6;

const t = vi.executive.unlock;
const ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;

/** Sáu ô của mã PIN: chỉ cho biết đã nhập mấy số, không hiện số. */
export function PinDots({ length }: { length: number }) {
  const m = useSenior();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={fmtExecutive(t.entered, { n: length })}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', justifyContent: 'center', gap: m.space.md, paddingVertical: m.space.sm }}
      testID="pin-dots"
    >
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <View
          key={i}
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: m.borderWidth,
            borderColor: i < length ? color.primary : color.border,
            backgroundColor: i < length ? color.primary : color.surface,
          }}
        />
      ))}
    </View>
  );
}

export type PinPadProps = {
  value: string;
  onChange: (next: string) => void;
  /** nhập đủ sáu số */
  onComplete: (pin: string) => void;
  disabled?: boolean;
};

/**
 * Bàn phím số 3 nhân 4 (SPEC 7.4 M0): mỗi phím từ 72dp, chữ số lớn, phím xoá có chữ "Xoá".
 * Phím lớn lên theo cỡ chữ (dùng minHeight), không cắt chữ ở cỡ chữ hệ thống 200%.
 */
export function PinPad({ value, onChange, onComplete, disabled = false }: PinPadProps) {
  const m = useSenior();

  const press = (digit: string) => {
    if (disabled || value.length >= PIN_LENGTH) return;
    tapFeedback();
    const next = value + digit;
    onChange(next);
    if (next.length === PIN_LENGTH) onComplete(next);
  };

  const keyStyle = (pressed: boolean, quiet: boolean) => [
    {
      flex: 1,
      minHeight: m.touch.pinKey,
      borderRadius: m.radius,
      borderWidth: m.borderWidth,
      borderColor: quiet ? 'transparent' : color.border,
      backgroundColor: pressed ? color.primaryTint : quiet ? 'transparent' : color.surface,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    disabled && { opacity: 0.55 },
  ];

  const key = (digit: string) => (
    <Pressable
      key={digit}
      accessibilityRole="button"
      accessibilityLabel={fmtExecutive(t.a11yDigit, { n: digit })}
      disabled={disabled}
      onPress={() => press(digit)}
      style={({ pressed }) => keyStyle(pressed, false)}
      testID={`pin-key-${digit}`}
    >
      <SeniorText variant="pinDigit">{digit}</SeniorText>
    </Pressable>
  );

  return (
    <View style={{ alignSelf: 'center', width: '100%', maxWidth: 380, gap: m.space.md }}>
      {ROWS.map((row) => (
        <View key={row[0]} style={{ flexDirection: 'row', gap: m.space.md }}>
          {row.map(key)}
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: m.space.md }}>
        {/* ô trống giữ cho phím 0 thẳng cột với phím 2, 5, 8 */}
        <View style={keyStyle(false, true)} />
        {key('0')}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.deleteKey}
          disabled={disabled || value.length === 0}
          onPress={() => {
            tapFeedback();
            onChange(value.slice(0, -1));
          }}
          style={({ pressed }) => [...keyStyle(pressed, true), value.length === 0 && { opacity: 0.55 }]}
          testID="pin-key-delete"
        >
          <SeniorText variant="button" tone="primary">
            {t.deleteShort}
          </SeniorText>
        </Pressable>
      </View>
    </View>
  );
}
