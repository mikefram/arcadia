import { Pressable, View } from 'react-native';
import { Glyph } from './Glyph';
import { SeniorText } from './SeniorText';
import { tapFeedback } from './haptics';
import { color, useSenior } from './theme';

export type Choice<T extends string> = { value: T; label: string };

/**
 * Nhóm nút chọn một (ba nút Lớn, Rất lớn, Cực lớn; Chậm, Vừa, Nhanh; Bật, Tắt). Không dùng thanh trượt (SPEC 7.3).
 * Mục đang chọn có dấu tích và nền xanh nhạt, không chỉ khác màu.
 */
export function ChoiceGroup<T extends string>({ options, value, onChange, label, vertical = false, testID }: { options: readonly Choice<T>[]; value: T | null; onChange: (value: T) => void; label: string; vertical?: boolean; testID?: string }) {
  const m = useSenior();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: vertical ? 'column' : 'row', flexWrap: vertical ? 'nowrap' : 'wrap', gap: m.space.md }} testID={testID}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, checked: selected }}
            onPress={() => {
              tapFeedback();
              if (!selected) onChange(option.value);
            }}
            style={({ pressed }) => ({
              flexGrow: 1,
              // Theo bề rộng chữ rồi mới chia đều chỗ thừa: chữ lớn thì nút xuống dòng, không bóp nhau chồng lên.
              flexBasis: 'auto',
              minWidth: vertical ? undefined : 96,
              minHeight: m.touch.choice,
              borderRadius: m.radius,
              borderWidth: m.borderWidth,
              borderColor: selected ? color.primary : color.border,
              backgroundColor: selected || pressed ? color.primaryTint : color.surface,
              paddingHorizontal: m.space.md,
              paddingVertical: m.space.sm,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: vertical ? 'flex-start' : 'center',
              gap: m.space.sm,
            })}
            testID={testID ? `${testID}-${option.value}` : undefined}
          >
            {selected ? <Glyph name="check" size={Math.round(m.font.caption)} tint={color.onPrimaryTint} /> : null}
            <SeniorText variant="emphasis" weight={selected ? 'bold' : 'medium'} tone={selected ? 'onPrimaryTint' : 'text'} style={{ flexShrink: 1 }}>
              {option.label}
            </SeniorText>
          </Pressable>
        );
      })}
    </View>
  );
}
