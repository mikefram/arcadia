import { vi } from '@mihato/i18n';
import { Linking, StyleSheet, View } from 'react-native';
import { PRIVACY_POLICY_URL } from '@/config';
import { AppText } from '@/ui/AppText';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';
import { space } from '@/ui/theme';

const t = vi.staff.me.dataRequest;

/**
 * S9, mục "Yêu cầu xoá dữ liệu hoặc thu hồi thiết bị" (App Store 5.1.1: cách yêu cầu xoá dữ liệu phải rõ ràng trong app).
 * App này không tạo tài khoản: tài khoản do Văn phòng cấp. Nên màn chỉ giải thích: đăng xuất xoá dữ liệu trên máy và thu hồi
 * thiết bị; dữ liệu trên máy chủ xoá qua Văn phòng. Nút chính sách chỉ hiện khi bản dựng có địa chỉ (`extra.privacyPolicyUrl`).
 */
export default function DataRequestScreen() {
  const policyUrl = PRIVACY_POLICY_URL;
  return (
    <Screen
      title={t.title}
      back
      footer={
        policyUrl ? (
          <Button
            variant="secondary"
            label={t.policy}
            onPress={() => {
              void Linking.openURL(policyUrl).catch(() => undefined);
            }}
            testID="privacy-policy"
          />
        ) : undefined
      }
      testID="screen-data-request"
    >
      <View style={styles.section}>
        <AppText variant="heading" tone="gold" accessibilityRole="header">
          {t.onDeviceTitle}
        </AppText>
        <AppText>{t.onDevice}</AppText>
      </View>
      <View style={styles.section}>
        <AppText variant="heading" tone="gold" accessibilityRole="header">
          {t.onServerTitle}
        </AppText>
        <AppText>{t.onServer}</AppText>
      </View>
      <View style={styles.section}>
        <AppText variant="heading" tone="gold" accessibilityRole="header">
          {t.lostTitle}
        </AppText>
        <AppText>{t.lost}</AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
});
