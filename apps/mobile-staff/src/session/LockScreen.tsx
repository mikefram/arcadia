import { fmt, vi } from '@mihato/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../hooks';
import { session } from '../services';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { PinDots, PinPad } from '../ui/PinPad';
import { color, profile, space } from '../ui/theme';
import { promptBiometrics } from './biometrics';

const t = vi.staff.lock;

/**
 * Màn khoá: phủ lên toàn bộ app mỗi lần mở và sau 2 phút ở nền (SPEC 11.2). Mở bằng sinh trắc học nếu đã bật,
 * hoặc bằng PIN 6 số. PIN kiểm ngay trên máy. Sai lần thứ 5 thì phiên trên máy bị xoá và app về màn kích hoạt.
 */
export function LockScreen() {
  const insets = useSafeAreaInsets();
  const { biometricsEnabled } = useSession();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const asked = useRef(false);

  const askBiometrics = useCallback(async () => {
    if (await promptBiometrics()) session.unlockWithBiometrics();
  }, []);

  // Tự hỏi sinh trắc học một lần khi màn khoá hiện ra.
  useEffect(() => {
    if (biometricsEnabled && !asked.current) {
      asked.current = true;
      void askBiometrics();
    }
  }, [biometricsEnabled, askBiometrics]);

  const submit = async (value: string) => {
    setChecking(true);
    const result = await session.unlockWithPin(value);
    setChecking(false);
    setPin('');
    if (!result.ok && !result.wiped) setMessage(fmt(t.wrongPin, { n: result.attemptsLeft }));
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal testID="lock-screen">
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl }]}>
        <AppText variant="screenTitle" accessibilityRole="header" style={styles.center}>
          {t.title}
        </AppText>
        <PinDots length={pin.length} />
        <View style={styles.message}>
          {message ? (
            <AppText weight="medium" style={styles.center} accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="lock-message">
              {message}
            </AppText>
          ) : null}
        </View>
        <PinPad
          value={pin}
          onChange={(next) => {
            setPin(next);
            if (next.length > 0) setMessage(null);
          }}
          onComplete={(value) => void submit(value)}
          disabled={checking}
          onBiometric={biometricsEnabled ? () => void askBiometrics() : undefined}
        />
        <View style={styles.forgot}>
          <Button variant="quiet" label={t.forgot} onPress={() => setShowForgot((v) => !v)} />
          {showForgot ? (
            <AppText tone="sub" style={styles.center}>
              {t.forgotHint}
            </AppText>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: color.bg, zIndex: 10 },
  content: { flexGrow: 1, paddingHorizontal: profile.space.screen, gap: space.md, alignItems: 'stretch' },
  center: { textAlign: 'center' },
  message: { minHeight: 48, justifyContent: 'center' },
  forgot: { marginTop: space.md, gap: space.sm, alignItems: 'center' },
});
