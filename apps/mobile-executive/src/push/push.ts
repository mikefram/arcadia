import { vi } from '@mihato/i18n';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { IS_DEV_VARIANT, easProjectId } from '../config';
import { KV_KEYS } from '../session/kv';
import { secureKV } from '../session/secure-kv';
import { api, queryClient } from '../services';
import { notificationIdOf, targetForNotification } from './route';
import { syncPushTokenWith, type PushPermission, type PushSyncResult } from './sync';

/**
 * Thông báo đẩy của app Chủ tịch (SPEC 10.9, 7.6): chữ ngắn, không có nút hành động, chạm là mở đúng màn hình.
 * Trên web, máy ảo và máy không hỗ trợ thì mọi hàm ở đây bỏ qua êm: tin không tới thì việc vẫn hiện khi mở app.
 */
const supported = Platform.OS !== 'web' && !IS_DEV_VARIANT;
const t = vi.executive.push;

/** Kênh Android trùng tên với kênh máy chủ gửi (`work`, `nudge`). */
export async function setupNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('work', { name: t.channelWork, description: t.channelWorkDescription, importance: Notifications.AndroidImportance.DEFAULT });
    await Notifications.setNotificationChannelAsync('nudge', { name: t.channelNudge, description: t.channelNudgeDescription, importance: Notifications.AndroidImportance.HIGH });
  } catch {}
}

export type { PushPermission, PushSyncResult } from './sync';

export async function pushPermission(request: boolean): Promise<PushPermission> {
  if (!supported || !Device.isDevice) return 'unavailable';
  try {
    let status = await Notifications.getPermissionsAsync();
    if (!status.granted && request && status.canAskAgain) status = await Notifications.requestPermissionsAsync();
    return status.granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Lấy Expo push token và ghi lên máy chủ (`PUT /v1/me/push-token`). Gọi mỗi lần mở app; chỉ gọi máy chủ
 * khi token khác token đã ghi lần trước (SPEC 10.2). Trả kết quả cụ thể (`sync.ts`) để màn kích hoạt báo đúng.
 */
export function syncPushToken(request: boolean): Promise<PushSyncResult> {
  return syncPushTokenWith(
    {
      permission: pushPermission,
      projectId: easProjectId,
      prepare: setupNotificationChannels,
      getToken: async (projectId) => (await Notifications.getExpoPushTokenAsync({ projectId })).data,
      getStoredToken: () => secureKV.get(KV_KEYS.pushToken),
      setStoredToken: (token) => secureKV.set(KV_KEYS.pushToken, token),
      putToken: async (pushToken) => {
        await api.call('me.pushTokenPut', { body: { pushToken } });
      },
    },
    request,
  );
}

/** Đăng xuất: xoá push token trên máy chủ để máy này không nhận tin của người dùng cũ. */
export async function removePushToken(): Promise<void> {
  try {
    await api.call('me.pushTokenDelete', {});
  } catch {}
}

/** Mỗi lần chạm thông báo chỉ xử lý một lần, dù đến từ bộ nghe hay từ lần mở app. */
const handledResponses = new Set<string>();

function openFromResponse(response: Notifications.NotificationResponse): void {
  const id = response.notification.request.identifier;
  if (handledResponses.has(id)) return;
  handledResponses.add(id);
  openFromData(response.notification.request.content.data);
  try {
    Notifications.clearLastNotificationResponse();
  } catch {}
}

/** Mở đúng màn hình theo loại thông báo. Màn khoá phủ lên trên; mở khoá xong là tới đúng màn. */
export function openFromData(data: unknown): void {
  const notificationId = notificationIdOf(data);
  if (notificationId) void api.call('notifications.opened', { params: { id: notificationId } }).catch(() => undefined);
  void queryClient.invalidateQueries();
  const target = targetForNotification(data);
  if (!target) return;
  switch (target.screen) {
    case 'home':
      router.dismissTo('/');
      return;
    case 'decisions':
      router.push('/decisions');
      return;
    case 'review':
      router.push({ pathname: '/review/[id]', params: { id: target.proposalId } });
      return;
  }
}

if (supported) {
  // App đang mở vẫn hiện thông báo, để người dùng thấy ngay.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/**
 * Nghe thông báo khi app đã kích hoạt: nhận tin lúc đang mở thì làm mới dữ liệu (SPEC 10.8);
 * chạm thông báo (kể cả lúc app đang đóng) thì mở đúng màn hình và ghi `opened`.
 */
export function usePushNotifications(active: boolean): void {
  useEffect(() => {
    if (!supported || !active) return;
    void syncPushToken(false);

    const received = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries();
    });
    const responded = Notifications.addNotificationResponseReceivedListener(openFromResponse);

    // App được mở bằng cách chạm thông báo lúc đang đóng.
    try {
      const last = Notifications.getLastNotificationResponse();
      if (last) openFromResponse(last);
    } catch {}

    return () => {
      received.remove();
      responded.remove();
    };
  }, [active]);
}
