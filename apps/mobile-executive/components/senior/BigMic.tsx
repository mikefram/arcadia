import { Pressable, View } from 'react-native';
import { Glyph } from './Glyph';
import { SeniorText } from './SeniorText';
import { tapFeedback } from './haptics';
import { color, useSenior } from './theme';

export type BigMicProps = {
  /** đang nghe (hoặc đang trò chuyện ở M2): nút đổi thành nút dừng */
  listening: boolean;
  onPress: () => void;
  /** chữ dưới nút nói rõ nút làm gì lúc này: "Bấm để trò chuyện", "Bấm để dừng trò chuyện", "Nói để trả lời" */
  label: string;
  accessibilityLabel: string;
  disabled?: boolean;
  /** nút phụ trên màn xác nhận (M3): viền, không nền đặc, để màn hình chỉ có một nút chính */
  outlined?: boolean;
  testID?: string;
};

/**
 * Nút micro 96dp (SPEC 7.3). Một chạm để bắt đầu, một chạm để dừng, không nhấn giữ. Micro chỉ mở sau khi bấm; ở M2 nút này bật
 * chế độ trò chuyện (docs/DECISIONS.md 04/10/2026), lúc đó nó luôn là nút dừng cho tới khi bấm, và chữ dưới nút nói rõ điều đó.
 * Đĩa xanh đậm, vành trong màu vàng đồng: chi tiết gợi sơn mài duy nhất của màn hình.
 */
export function BigMic({ listening, onPress, label, accessibilityLabel, disabled = false, outlined = false, testID }: BigMicProps) {
  const m = useSenior();
  const size = m.touch.mic;
  const solid = !outlined && !listening;
  const glyphTint = solid ? color.onPrimary : color.primary;
  return (
    <View style={{ alignItems: 'center', gap: m.space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled, selected: listening }}
        disabled={disabled}
        onPress={() => {
          tapFeedback('firm');
          onPress();
        }}
        style={({ pressed }) => [
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: solid ? (pressed ? color.primaryPressed : color.primary) : pressed ? color.primaryTint : color.surface,
            borderWidth: solid ? 0 : Math.max(3, m.borderWidth + 1),
            borderColor: color.primary,
          },
          disabled && { opacity: 0.55 },
        ]}
        testID={testID}
      >
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 7,
            left: 7,
            right: 7,
            bottom: 7,
            borderRadius: size / 2,
            borderWidth: 2,
            borderColor: solid ? color.goldTint : color.gold,
            opacity: solid ? 0.9 : 0.6,
          }}
        />
        <Glyph name={listening ? 'stop' : 'mic'} size={Math.round(size * 0.42)} tint={glyphTint} />
      </Pressable>
      <SeniorText variant="emphasis" tone="primary" center accessibilityElementsHidden importantForAccessibility="no">
        {label}
      </SeniorText>
    </View>
  );
}
