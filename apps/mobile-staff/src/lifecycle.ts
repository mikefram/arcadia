import { vi } from '@mihato/i18n';
import { focusManager, onlineManager } from '@tanstack/react-query';
import * as Network from 'expo-network';
import * as ScreenCapture from 'expo-screen-capture';
import { useEffect, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { LIST_REFRESH_MS } from './data/queries';
import { queue, session } from './services';
import { showFlash } from './ui/Flash';

/**
 * Nguồn "đang có mạng" dùng chung cho TanStack Query và hàng đợi ngoại tuyến.
 * Trên web TanStack Query tự nghe sự kiện online/offline của trình duyệt; trên máy thì nghe expo-network.
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

/**
 * Vòng đời của app, gắn một lần ở lớp gốc:
 * - đọc phiên từ kho an toàn khi mở app;
 * - xuống nền thì ghi giờ, trở lại sau 2 phút thì khoá (SPEC 11.2);
 * - trở lại nền trước thì làm mới dữ liệu (SPEC 10.8) và gửi hàng đợi;
 * - có mạng lại thì gửi hàng đợi theo thứ tự (SPEC 8.4); còn thao tác chờ thì thử lại mỗi phút.
 */
export function useAppLifecycle(): void {
  useEffect(() => {
    void session.load();
    if (Platform.OS === 'ios') void ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
    void queue.load().then(() => queue.flush());

    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'background') session.noteBackground();
      if (state === 'active') {
        session.noteForeground();
        void queue.flush();
      }
      if (Platform.OS !== 'web') focusManager.setFocused(state === 'active');
    });

    const offOnline = onlineManager.subscribe((online) => {
      if (!online) return;
      const waiting = queue.pendingCount();
      void queue.flush().then(() => {
        // Có mạng lại và mọi thao tác chờ đã tới máy chủ: báo một câu. Thao tác bị từ chối có lời báo riêng.
        if (waiting > 0 && queue.pendingCount() === 0) showFlash(vi.staff.offline.synced);
      });
    });

    const timer = setInterval(() => {
      if (queue.pendingCount() > 0) void queue.flush();
    }, LIST_REFRESH_MS);

    return () => {
      appState.remove();
      offOnline();
      clearInterval(timer);
    };
  }, []);
}

/**
 * App đang không ở nền trước (đang chuyển app, đang ở màn đa nhiệm): lớp gốc phủ một tấm che để việc, số tiền và ghi chú
 * không lộ trong ảnh thu nhỏ trong 2 phút trước khi khoá (rà soát 07/10/2026, staff-8; SPEC 11.2 điều 5). iOS còn có lớp che
 * của hệ điều hành (`enableAppSwitcherProtectionAsync`, gắn ở `useAppLifecycle`).
 */
export function useAppCovered(): boolean {
  const [state, setState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState);
    return () => subscription.remove();
  }, []);
  return Platform.OS !== 'web' && state !== 'active';
}
