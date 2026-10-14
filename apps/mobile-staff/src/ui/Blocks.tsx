import { vi } from '@mihato/i18n';
import { Children, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppText } from './AppText';
import { Button } from './Button';
import { color, profile, space } from './theme';

/** Thẻ: nền trắng, viền 1dp, góc bo 12dp. Không đổ bóng: giấy tờ hành chính phẳng, rõ nét. */
export function Card({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.card, style]} testID={testID}>
      {children}
    </View>
  );
}

/** Tiêu đề nhóm: chữ vàng đồng, có số lượng đi kèm bằng chữ. */
export function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.heading}>
      <AppText variant="heading" tone="gold" accessibilityRole="header">
        {title}
      </AppText>
      {detail ? (
        <AppText variant="caption" tone="sub">
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

/** Danh sách các dòng "nhãn: giá trị" như trên phiếu giao việc; kẻ mảnh chỉ nằm giữa các dòng. */
export function InfoList({ children }: { children: ReactNode }) {
  return (
    <View>
      {Children.toArray(children).map((row, index) => (
        <View key={index} style={index > 0 && styles.rowLine}>
          {row}
        </View>
      ))}
    </View>
  );
}

/** Một dòng "nhãn: giá trị": nhãn chữ phụ ở trên, giá trị chữ chính ở dưới. */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <AppText variant="caption" tone="sub">
        {label}
      </AppText>
      {typeof children === 'string' ? <AppText>{children}</AppText> : children}
    </View>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <AppText tone="sub" style={styles.center}>
        {text}
      </AppText>
    </View>
  );
}

/** Đang tải: luôn có chữ, không để vòng quay đứng một mình (SPEC 7.5). */
export function LoadingState() {
  return (
    <View style={styles.empty} accessibilityRole="progressbar" accessibilityLabel={vi.common.loading}>
      <ActivityIndicator color={color.primary} />
      <AppText tone="sub">{vi.common.loading}</AppText>
    </View>
  );
}

/** Tải hỏng: nói rõ bằng chữ và cho thử lại. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.empty}>
      <AppText style={styles.center} accessibilityRole="alert">
        {message}
      </AppText>
      {onRetry ? <Button variant="secondary" label={vi.common.actions.retry} onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    padding: profile.space.cardPadding,
    gap: space.sm,
  },
  heading: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.sm, marginTop: space.sm },
  row: { paddingVertical: space.sm + 2, gap: 2 },
  rowLine: { borderTopWidth: 1, borderTopColor: color.hairline },
  empty: { paddingVertical: space.xxl, alignItems: 'center', gap: space.md },
  center: { textAlign: 'center' },
});
