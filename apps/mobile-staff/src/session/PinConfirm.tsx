import { fmt, vi } from '@mihato/i18n';
import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { session } from '../services';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { PinDots, PinPad } from '../ui/PinPad';
import { color, profile, space } from '../ui/theme';

/**
 * Hỏi lại PIN ngay trên máy trước một việc quan trọng (duyệt việc có số tiền, đổi PIN). PIN kiểm trên máy,
 * dùng chung bộ đếm với màn khoá: sai lần thứ 5 thì phiên trên máy bị xoá.
 */
export function PinConfirm({ visible, title, onConfirmed, onClose }: { visible: boolean; title: string; onConfirmed: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (value: string) => {
    setChecking(true);
    const result = await session.checkPin(value);
    setChecking(false);
    setPin('');
    if (result.ok) {
      setMessage(null);
      onConfirmed();
    } else if (!result.wiped) {
      setMessage(fmt(vi.staff.lock.wrongPin, { n: result.attemptsLeft }));
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={styles.root} testID="pin-confirm">
        <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl }]}>
          <AppText variant="screenTitle" accessibilityRole="header" style={styles.center}>
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
            onComplete={(value) => void submit(value)}
            disabled={checking}
          />
          <Button variant="quiet" label={vi.common.actions.close} onPress={onClose} style={styles.close} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { flexGrow: 1, paddingHorizontal: profile.space.screen, gap: space.md },
  center: { textAlign: 'center' },
  message: { minHeight: 48, justifyContent: 'center' },
  close: { marginTop: space.md, alignSelf: 'center' },
});
