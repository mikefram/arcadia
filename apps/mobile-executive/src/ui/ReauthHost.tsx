import { fmtExecutive, vi } from '@mihato/i18n';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { PinDots, PinPad } from '@senior/PinPad';
import { ScreenFrame } from '@senior/ScreenFrame';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorText } from '@senior/SeniorText';
import { color, useSenior } from '@senior/theme';
import { useDisplayPrefs, useSession } from '../hooks';
import { biometricsAvailable, promptBiometrics } from '../session/biometrics';
import { reauthStore } from '../session/reauth';
import { session } from '../services';

const t = vi.executive.unlock;

/**
 * Hỏi lại vân tay, khuôn mặt hoặc PIN ngay trên máy trước một việc quan trọng (duyệt có số tiền, dừng hẳn một lượt,
 * ủy quyền). Là một màn hình đầy đủ phủ lên trên, không phải cửa sổ nổi (SPEC 7.6). PIN dùng chung bộ đếm với màn
 * khoá: sai lần thứ 5 thì phiên trên máy bị xoá.
 */
export function ReauthHost() {
  const m = useSenior();
  const request = useSyncExternalStore(reauthStore.subscribe, reauthStore.getSnapshot, reauthStore.getSnapshot);
  const { biometricsEnabled, status } = useSession();
  const { address } = useDisplayPrefs();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const handled = useRef<number | null>(null);

  // App bị khoá hoặc phiên kết thúc giữa chừng: coi như chưa xác thực.
  useEffect(() => {
    if (request && status !== 'unlocked') reauthStore.settle(false);
  }, [request, status]);

  // Mỗi lần hỏi: thử sinh trắc học trước nếu đã bật; không được thì hiện bàn phím PIN.
  useEffect(() => {
    if (!request || handled.current === request.id) return;
    handled.current = request.id;
    setPin('');
    setMessage(null);
    setShowPin(false);
    void (async () => {
      if (biometricsEnabled && (await biometricsAvailable()) && (await promptBiometrics(address, request.title))) {
        reauthStore.settle(true);
        return;
      }
      setShowPin(true);
    })();
  }, [request, biometricsEnabled, address]);

  if (!request || !showPin) return null;

  const submit = async (value: string) => {
    setChecking(true);
    const result = await session.checkPin(value);
    setChecking(false);
    setPin('');
    if (result.ok) reauthStore.settle(true);
    else if (result.wiped) reauthStore.settle(false);
    else setMessage(`${fmtExecutive(t.wrong, {}, address)} ${fmtExecutive(t.attemptsLeft, { n: result.attemptsLeft })}`);
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal testID="reauth-screen">
      <ScreenFrame title={fmtExecutive(t.confirmTitle, {}, address)} footer={<SeniorButton variant="secondary" label={t.confirmSkip} onPress={() => reauthStore.settle(false)} testID="reauth-skip" />}>
        <SeniorText>{request.title}</SeniorText>
        <PinDots length={pin.length} />
        <View style={{ minHeight: m.touch.min, justifyContent: 'center' }}>
          {message ? (
            <SeniorText weight="semibold" accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="reauth-message">
              {message}
            </SeniorText>
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
      </ScreenFrame>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: color.bg, zIndex: 9 },
});
