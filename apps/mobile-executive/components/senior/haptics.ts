import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/** Rung nhẹ khi chạm (SPEC 7.6). Bản web và máy không có bộ rung thì bỏ qua êm. */
export function tapFeedback(strength: 'light' | 'firm' = 'light'): void {
  if (Platform.OS === 'web') return;
  const run = strength === 'firm' ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium) : Haptics.selectionAsync();
  void run.catch(() => undefined);
}

/** Rung báo xong (gửi xong, đồng ý xong). */
export function successFeedback(): void {
  if (Platform.OS === 'web') return;
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}
