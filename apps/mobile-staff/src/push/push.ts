import { vi } from '@mihato/i18n';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { easProjectId } from '../config';
import { KV_KEYS } from '../session/kv';
import { secureKV } from '../session/secure-kv';
import { api, queryClient } from '../services';
import { notificationTarget, stepRouteParams } from './link';
import { syncPushTokenWith, type PushPermission, type PushSyncResult } from './sync';

/**
 * Thông báo đẩy (SPEC 8.3, 10.9). Trên web, máy ảo và máy không hỗ trợ thì mọi hàm ở đây bỏ qua êm:
 * tin đẩy không tới thì người nhận vẫn thấy việc khi mở app.
 */
const supported = Platform.OS !== 'web';

/** Hai kênh Android (SPEC 8.3): Công việc (mức thường) và Đi thúc (mức cao). */
export async function setupNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('work', {
      name: vi.staff.notifications.channels.work,
      description: vi.staff.notifications.channelWorkDescription,
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    await Notifications.setNotificationChannelAsync('nudge', {
      name: vi.staff.notifications.channels.nudge,
      description: vi.staff.notifications.channelNudgeDescription,
      importance: Notifications.AndroidImportance.HIGH,
    });
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

function openFromData(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const record = data as Record<string, unknown>;
  const target = notificationTarget({ type: record.type, link: record.link });
  if (typeof record.notificationId === 'string') {
    void api.call('notifications.opened', { params: { id: record.notificationId } }).catch(() => undefined);
  }
  void queryClient.invalidateQueries();
  // Từ thông báo đến việc cần làm không quá một chạm (SPEC 8.1): mở thẳng màn chi tiết việc.
  // Bình luận mới thì mở thẳng mục Thảo luận của việc.
  if (target) router.push({ pathname: '/step/[id]', params: stepRouteParams(target) });
}

if (supported) {
  // App đang mở vẫn hiện thông báo, để người dùng thấy lời nhắc ngay.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/**
 * Nghe thông báo khi app đã kích hoạt: nhận tin lúc đang mở thì làm mới dữ liệu (SPEC 10.8);
 * chạm thông báo (kể cả lúc app đang đóng) thì mở đúng việc và ghi `opened`.
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
