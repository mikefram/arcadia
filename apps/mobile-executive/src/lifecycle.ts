import { focusManager, onlineManager } from '@tanstack/react-query';
import * as Network from 'expo-network';
import * as ScreenCapture from 'expo-screen-capture';
import { useEffect, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { briefingPlayer } from './features/briefing-player';
import { assistant } from './scribe/assistant';
import { configurePlaybackAudioMode } from './scribe/audio-mode';
import { localProfile, session } from './services';

/**
 * Nguồn "đang có mạng" dùng chung cho TanStack Query. Trên web TanStack Query tự nghe sự kiện online/offline
 * của trình duyệt; trên máy thì nghe expo-network.
 */
if (Platform.OS !== 'web') {
  onlineManager.setEventListener((setOnline) => {
    const apply = (state: Network.NetworkState) => setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    void Network.getNetworkStateAsync()
      .then(apply)
      .catch(() => undefined);
    const subscription = Network.addNetworkStateListener(apply);
    return () => subscription.remove();
  });
}

/** Khoá chặn chụp màn hình của cả app trên Android (màn M6 có khoá riêng, xem decisions.tsx). */
const APP_CAPTURE_KEY = 'mihato-app';

/** Nhịp kiểm "2 phút không dùng thì khoá" (SPEC 7.8). */
const IDLE_CHECK_MS = 15_000;

/**
 * Vòng đời của app, gắn một lần ở lớp gốc:
 * - đọc phiên và bản nhớ trên máy khi mở app;
 * - đặt chế độ âm thanh để trợ lý đọc được cả khi máy gạt im lặng;
 * - xuống nền: đóng micro, dừng đọc, ghi giờ; trở lại sau 2 phút thì khoá (SPEC 11.2);
 * - đang mở mà 2 phút không chạm: khoá;
 * - trở lại nền trước thì làm mới dữ liệu (SPEC 10.8);
 * - iOS: che nội dung ở màn đa nhiệm; Android: chặn chụp màn hình và ảnh thu nhỏ ở màn đa nhiệm cho cả app (FLAG_SECURE).
 */
export function useAppLifecycle(): void {
  useEffect(() => {
    void localProfile.load().finally(() => session.load());
    void configurePlaybackAudioMode();
    if (Platform.OS === 'ios') void ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
    // Android không có lớp che của hệ điều hành như iOS, còn tấm che vẽ bằng React (`useAppCovered`) chỉ hiện SAU khi JS nhận sự kiện
    // 'background', có thể sau lúc hệ điều hành chụp ảnh thu nhỏ. FLAG_SECURE cho cả app làm ảnh đó đen ở mọi màn hình, không chỉ M6
    // (rà soát 07/10/2026, exec-5). Mỗi màn có khoá riêng nên M6 bật rồi tắt khoá của nó không làm mất khoá này.
    if (Platform.OS === 'android') void ScreenCapture.preventScreenCaptureAsync(APP_CAPTURE_KEY).catch(() => undefined);

    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        session.noteBackground();
        // Micro không bao giờ mở khi app ở nền; tiếng đang đọc cũng dừng.
        assistant.shutdown();
        briefingPlayer.stop();
      }
      if (state === 'active') session.noteForeground();
      if (Platform.OS !== 'web') focusManager.setFocused(state === 'active');
    });

    const timer = setInterval(() => session.lockIfIdle(), IDLE_CHECK_MS);

    return () => {
      appState.remove();
      clearInterval(timer);
      if (Platform.OS === 'android') void ScreenCapture.allowScreenCaptureAsync(APP_CAPTURE_KEY).catch(() => undefined);
    };
  }, []);
}

/**
 * App đang không ở nền trước (đang chuyển app, đang ở màn đa nhiệm): lớp gốc phủ một tấm che để nội dung không
 * lộ trong ảnh thu nhỏ. iOS còn có lớp che của hệ điều hành (`enableAppSwitcherProtectionAsync`).
 */
export function useAppCovered(): boolean {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState);
    return () => subscription.remove();
  }, []);
  return Platform.OS !== 'web' && state !== 'active';
}
