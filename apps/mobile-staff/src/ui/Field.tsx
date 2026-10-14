import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type TextInputProps } from 'react-native';
import { AppText, AppTextInput } from './AppText';
import { Glyph } from './Glyph';
import { color, profile, space } from './theme';

/** Nhãn nằm trên ô nhập, luôn hiện (không dùng chữ gợi ý thay nhãn). Lỗi viết bằng chữ ngay dưới ô. */
export function Field({ label, labelHidden = false, error, hint, children }: { label: string; labelHidden?: boolean; error?: string | null; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      {labelHidden ? null : <AppText weight="medium">{label}</AppText>}
      {children}
      {hint && !error ? (
        <AppText variant="caption" tone="sub">
          {hint}
        </AppText>
      ) : null}
      {error ? (
        // Lỗi không dùng màu đỏ (đỏ nâu chỉ dành cho quá hạn): có dấu cảnh báo, chữ đậm, và ô nhập viền đậm.
        <View style={styles.errorRow} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <View style={styles.errorGlyph}>
            <Glyph name="alert" size={14} tint={color.text} />
          </View>
          <AppText variant="caption" weight="semibold" style={styles.choiceLabel}>
            {error}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

export function TextField({ label, error, hint, multiline, style, ...input }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <Field label={label} error={error} hint={hint}>
      <AppTextInput
        accessibilityLabel={label}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        {...input}
        style={[styles.input, multiline && styles.multiline, error ? styles.inputError : null, style]}
      />
    </Field>
  );
}

export type Choice<T extends string> = { value: T; label: string };

/** Danh sách chọn một: mỗi dòng cao từ 48dp, có vòng tròn chọn và chữ; không chỉ dựa vào màu. */
export function ChoiceList<T extends string>({ label, labelHidden, options, value, onChange, error }: { label: string; labelHidden?: boolean; options: readonly Choice<T>[]; value: T | null; onChange: (v: T) => void; error?: string | null }) {
  return (
    <Field label={label} labelHidden={labelHidden} error={error}>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.value)}
              style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, pressed && styles.choicePressed]}
              testID={`choice-${o.value}`}
            >
              <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
              <AppText weight={selected ? 'semibold' : 'regular'} style={styles.choiceLabel}>
                {o.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.sm },
  errorRow: { flexDirection: 'row', gap: space.sm },
  errorGlyph: { paddingTop: 3 },
  input: {
    minHeight: profile.touch.min,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    backgroundColor: color.surface,
  },
  multiline: { minHeight: 112 },
  inputError: { borderWidth: 2, borderColor: color.text },
  choices: { gap: space.sm },
  choice: {
    minHeight: profile.touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    backgroundColor: color.surface,
  },
  choiceSelected: { borderColor: color.primary, borderWidth: 2, backgroundColor: color.primaryTint },
  choicePressed: { backgroundColor: color.primaryTint },
  choiceLabel: { flex: 1 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.border, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: color.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.primary },
});
