import { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner, type BannerTone } from './Banner';
import { profile, space } from './theme';

/**
 * Lời xác nhận ngắn sau một thao tác ("Đã báo hoàn thành."). Hiện ở đáy màn hình vài giây, và được
 * trình đọc màn hình tự đọc. Chỉ dùng cho điều đã xong; lỗi thì hiện ngay tại chỗ nhập, không tự biến mất.
 */
type FlashMessage = { id: number; text: string; tone: BannerTone };

const VISIBLE_MS = 5000;

let current: FlashMessage | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function showFlash(text: string, tone: BannerTone = 'done'): void {
  current = { id: ++counter, text, tone };
  emit();
}

function clearFlash(id: number): void {
  if (current?.id === id) {
    current = null;
    emit();
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => current;

export function FlashHost() {
  const message = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => clearFlash(message.id), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.host, { bottom: insets.bottom + 72 }]}>
      {/* Lời báo "đã lưu trên máy, chờ gửi" dùng hình mũi tên gửi như chip Chờ gửi. */}
      <Banner tone={message.tone} glyph={message.tone === 'waiting' ? 'send' : undefined} live testID="flash">
        {message.text}
      </Banner>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: profile.space.screen, right: profile.space.screen, zIndex: 5, gap: space.sm },
});
