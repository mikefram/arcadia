import { vi } from '@mihato/i18n';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText } from '../ui/AppText';
import { color, space } from '../ui/theme';

const t = vi.staff.activation.notice;

const RECORDS = [t.records.assigned, t.records.due, t.records.completedAt, t.records.reminders, t.records.notes];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="heading" tone="gold" accessibilityRole="header">
        {title}
      </AppText>
      {children}
    </View>
  );
}

/**
 * Đoạn "Hệ thống ghi nhận gì về tôi" (SPEC 11.7 [QUYẾT ĐỊNH]): hiện ở màn kích hoạt S0 trước khi dùng,
 * và xem lại được ở S9. Câu chữ chờ pháp chế duyệt; mọi chữ nằm ở `vi.staff.activation.notice`.
 */
export function NoticeContent() {
  return (
    <View style={styles.box} testID="notice-content">
      <Section title={t.recordsTitle}>
        {RECORDS.map((line) => (
          <View key={line} style={styles.bullet}>
            <View style={styles.dot} />
            <AppText style={styles.grow}>{line}</AppText>
          </View>
        ))}
      </Section>
      <Section title={t.viewersTitle}>
        <AppText>{t.viewers}</AppText>
      </Section>
      <Section title={t.aiTitle}>
        <AppText>{t.ai}</AppText>
      </Section>
      <Section title={t.notRecordedTitle}>
        <AppText>{t.notRecorded}</AppText>
      </Section>
      <AppText tone="sub">{t.contact}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.lg },
  section: { gap: space.sm },
  bullet: { flexDirection: 'row', gap: space.sm + 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.gold, marginTop: 9 },
  grow: { flex: 1 },
});
