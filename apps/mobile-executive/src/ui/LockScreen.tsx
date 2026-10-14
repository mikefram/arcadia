import { fmtExecutive, vi } from '@mihato/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { PinDots, PinPad } from '@senior/PinPad';
import { ScreenFrame } from '@senior/ScreenFrame';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorText } from '@senior/SeniorText';
import { color, useSenior } from '@senior/theme';
import { useDisplayPrefs, useSession } from '../hooks';
import { biometricsAvailable, promptBiometrics } from '../session/biometrics';
import { session } from '../services';
import { OfficeCall } from './OfficeCall';

const t = vi.executive.unlock;

/**
 * M0 Mở khoá: phủ lên toàn bộ app mỗi lần mở, sau 2 phút ở nền và sau 2 phút không dùng (SPEC 7.4, 11.2).
 * Mở bằng sinh trắc học nếu đã bật, hoặc bằng PIN 6 số. PIN kiểm ngay trên máy, không gửi lên máy chủ.
 * Sai lần thứ 5 thì phiên trên máy bị xoá và app về màn kích hoạt. Nút Nhờ Văn phòng vẫn có ở đây.
 */
export function LockScreen() {
  const m = useSenior();
  const { biometricsEnabled, pinFailures } = useSession();
  const { address, officePhone } = useDisplayPrefs();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const [office, setOffice] = useState(false);
  const asked = useRef(false);

  const askBiometrics = useCallback(async () => {
    if (await promptBiometrics(address)) session.unlockWithBiometrics();
  }, [address]);

  // Máy có vân tay hoặc khuôn mặt và người dùng đã bật: tự hỏi một lần khi màn khoá hiện ra.
  useEffect(() => {
    if (!biometricsEnabled) return;
    void biometricsAvailable().then((available) => {
      setCanUseBiometrics(available);
      if (available && !asked.current) {
        asked.current = true;
        void askBiometrics();
      }
    });
  }, [biometricsEnabled, askBiometrics]);

  const submit = async (value: string) => {
    setChecking(true);
    const result = await session.unlockWithPin(value);
    setChecking(false);
    setPin('');
    if (!result.ok && !result.wiped) {
      // Lỗi nhận về phía hệ thống: "mã PIN chưa khớp", không nói người dùng sai (SPEC 7.2 điều 8).
      const base = fmtExecutive(result.attemptsLeft <= 2 ? t.wrongWithHelp : t.wrong, {}, address);
      setMessage(`${base} ${fmtExecutive(t.attemptsLeft, { n: result.attemptsLeft })}`);
    }
  };

  if (office) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal testID="lock-office">
        <ScreenFrame title={vi.executive.office.title} onBack={() => setOffice(false)}>
          <OfficeCall phone={officePhone} address={address} onClose={() => setOffice(false)} />
        </ScreenFrame>
      </View>
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal testID="lock-screen">
      <ScreenFrame title={fmtExecutive(t.title, {}, address)} onOffice={() => setOffice(true)}>
        <SeniorText tone="sub">{t.hint}</SeniorText>
        <PinDots length={pin.length} />
        <View style={{ minHeight: m.touch.min, justifyContent: 'center' }}>
          {message ? (
            <SeniorText weight="semibold" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="lock-message">
              {message}
            </SeniorText>
          ) : checking ? (
            <SeniorText tone="sub" accessibilityLiveRegion="polite">
              {fmtExecutive(t.opening, {}, address)}
            </SeniorText>
          ) : pinFailures > 0 ? (
            <SeniorText tone="sub">{fmtExecutive(t.attemptsLeft, { n: 5 - pinFailures })}</SeniorText>
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
        />
        {canUseBiometrics ? <SeniorButton variant="secondary" label={t.useBiometric} onPress={() => void askBiometrics()} testID="lock-biometric" /> : null}
      </ScreenFrame>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: color.bg, zIndex: 10 },
});
