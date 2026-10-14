import { fmt, vi } from '@mihato/i18n';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { session } from '@/services';
import { isWeakPin } from '@/session/pin';
import { AppText } from '@/ui/AppText';
import { showFlash } from '@/ui/Flash';
import { PinDots, PinPad } from '@/ui/PinPad';
import { Screen } from '@/ui/Screen';
import { space } from '@/ui/theme';

const t = vi.staff;

type Stage = 'current' | 'new' | 'confirm';

/** Đổi mã PIN (S9): nhập mã hiện tại, mã mới, rồi nhập lại mã mới. PIN chỉ nằm trên máy. */
export default function PinChangeScreen() {
  const [stage, setStage] = useState<Stage>('current');
  const [pin, setPin] = useState('');
  const [firstEntry, setFirstEntry] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const complete = async (value: string) => {
    setPin('');
    if (stage === 'current') {
      setChecking(true);
      const result = await session.checkPin(value);
      setChecking(false);
      if (result.ok) {
        setMessage(null);
        setStage('new');
      } else if (!result.wiped) {
        setMessage(fmt(t.lock.wrongPin, { n: result.attemptsLeft }));
      }
      return;
    }
    if (stage === 'new') {
      if (isWeakPin(value)) {
        setMessage(t.activation.pin.tooSimple);
        return;
      }
      setFirstEntry(value);
      setMessage(null);
      setStage('confirm');
      return;
    }
    if (value !== firstEntry) {
      setMessage(t.activation.pin.mismatch);
      setStage('new');
      return;
    }
    await session.setPin(value);
    showFlash(t.me.pinChanged);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const title = stage === 'current' ? t.me.currentPin : stage === 'new' ? t.activation.pin.title : t.activation.pin.confirmTitle;

  return (
    <Screen title={t.me.changePin} back testID="screen-pin-change">
      <View style={styles.box}>
        <AppText variant="cardTitle" style={styles.center} accessibilityRole="header" accessibilityLiveRegion="polite">
          {title}
        </AppText>
        <PinDots length={pin.length} />
        <View style={styles.message}>
          {message ? (
            <AppText weight="medium" style={styles.center} accessibilityRole="alert" accessibilityLiveRegion="assertive">
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
          onComplete={(value) => void complete(value)}
          disabled={checking}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.md, paddingTop: space.lg },
  center: { textAlign: 'center' },
  message: { minHeight: 48, justifyContent: 'center' },
});
