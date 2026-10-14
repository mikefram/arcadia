import type { PersonRef } from '@mihato/domain';
import { normalizeText, stripDiacritics } from '@mihato/domain/vi-normalize';
import { vi } from '@mihato/i18n';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { usePeopleSearch } from '../data/queries';
import { AppText, AppTextInput } from '../ui/AppText';
import { Field } from '../ui/Field';
import { color, profile, space } from '../ui/theme';
import { personName } from './steps';

const t = vi.staff.people;

export type PickedPerson = PersonRef & { unitName: string | null; roleTitle: string | null };

/** Chọn một người bằng cách gõ tên (`GET /v1/people`, tìm không phân biệt dấu). */
const plain = (s: string) => stripDiacritics(normalizeText(s));

/**
 * Chọn một người bằng cách gõ tên (`GET /v1/people`, tìm không phân biệt dấu).
 * `candidates` có thì danh sách bị giới hạn đúng những người đó (việc trong quy trình chỉ giao lại cho người được bổ nhiệm) và
 * việc gõ chỉ lọc trong danh sách, không hỏi máy chủ.
 */
export function PersonPicker({
  label,
  value,
  onChange,
  excludeId,
  error,
  candidates,
}: {
  label: string;
  value: PickedPerson | null;
  onChange: (person: PickedPerson | null) => void;
  excludeId?: string | null;
  error?: string | null;
  candidates?: PickedPerson[] | null;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');

  // Chờ người dùng ngừng gõ rồi mới tìm, để không gọi máy chủ theo từng phím.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const search = usePeopleSearch(q, value === null && !candidates);
  const needle = plain(q);
  const found = candidates ? candidates.filter((p) => !needle || plain(p.fullName).includes(needle)) : (search.data?.items ?? []);
  const people = found.filter((p) => p.id !== excludeId);

  if (value) {
    return (
      <Field label={label} error={error}>
        <View style={styles.picked} testID="person-picked">
          <View style={styles.grow}>
            <AppText weight="semibold">{personName(value)}</AppText>
            {value.unitName || value.roleTitle ? (
              <AppText variant="caption" tone="sub">
                {[value.roleTitle, value.unitName].filter(Boolean).join(', ')}
              </AppText>
            ) : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t.change} onPress={() => onChange(null)} style={({ pressed }) => [styles.change, pressed && styles.pressed]} hitSlop={6}>
            <AppText weight="semibold" tone="primary">
              {t.change}
            </AppText>
          </Pressable>
        </View>
      </Field>
    );
  }

  return (
    <Field label={label} error={error}>
      <AppTextInput
        accessibilityLabel={label}
        value={text}
        onChangeText={setText}
        placeholder={t.searchPlaceholder}
        autoCorrect={false}
        style={styles.input}
        testID="person-search"
      />
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.list}>
        {people.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: false }}
            accessibilityLabel={[personName(p), p.roleTitle, p.unitName].filter(Boolean).join(', ')}
            onPress={() => onChange(p)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID={`person-${p.id}`}
          >
            <AppText weight="medium">{personName(p)}</AppText>
            {p.unitName || p.roleTitle ? (
              <AppText variant="caption" tone="sub">
                {[p.roleTitle, p.unitName].filter(Boolean).join(', ')}
              </AppText>
            ) : null}
          </Pressable>
        ))}
        {!candidates && search.isFetching && people.length === 0 ? <AppText tone="sub">{vi.common.loading}</AppText> : null}
        {(candidates ? true : !search.isFetching && search.isSuccess) && people.length === 0 ? <AppText tone="sub">{t.none}</AppText> : null}
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: profile.touch.min,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    backgroundColor: color.surface,
  },
  list: { gap: space.sm },
  row: {
    minHeight: profile.touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    backgroundColor: color.surface,
  },
  picked: {
    minHeight: profile.touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 2,
    borderColor: color.primary,
    borderRadius: profile.radius,
    backgroundColor: color.primaryTint,
  },
  change: { minHeight: profile.touch.min, minWidth: profile.touch.min, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: color.primaryTint },
  grow: { flex: 1 },
});
