/**
 * Đăng ký thông báo đẩy, tách khỏi React Native để test được (rà soát 07/10/2026, exec-2). Kết quả nói rõ vì sao chưa
 * có thông báo, để màn kích hoạt không báo "xong" khi thực ra chưa đăng ký được:
 * - `granted`: đã có token và máy chủ đã nhận;
 * - `denied`: người dùng không cho phép thông báo ở hệ điều hành;
 * - `unavailable`: máy hoặc bản dựng không hỗ trợ (web, máy ảo, bản thử dựng bằng Apple ID miễn phí);
 * - `no_project`: bản dựng thiếu `extra.eas.projectId`, nên không thể lấy Expo push token. Là lỗi dựng bản, không sửa được trên máy;
 * - `failed`: có quyền và có projectId nhưng lấy token hoặc ghi lên máy chủ lỗi (mất mạng, dịch vụ đẩy chưa sẵn sàng); thử lại được.
 */
export type PushPermission = 'granted' | 'denied' | 'unavailable';
export type PushSyncResult = PushPermission | 'no_project' | 'failed';

export type PushSyncDeps = {
  permission: (request: boolean) => Promise<PushPermission>;
  projectId: () => string | null;
  /** tạo kênh thông báo Android trước khi xin token */
  prepare: () => Promise<void>;
  getToken: (projectId: string) => Promise<string>;
  getStoredToken: () => Promise<string | null>;
  setStoredToken: (token: string) => Promise<void>;
  putToken: (token: string) => Promise<void>;
};

export async function syncPushTokenWith(deps: PushSyncDeps, request: boolean): Promise<PushSyncResult> {
  const permission = await deps.permission(request);
  if (permission !== 'granted') return permission;
  const projectId = deps.projectId();
  // Không gọi getExpoPushTokenAsync khi thiếu projectId: nó chỉ ném lỗi và lỗi đó từng bị nuốt thành "đã xong".
  if (!projectId) return 'no_project';
  try {
    await deps.prepare();
    const token = await deps.getToken(projectId);
    if ((await deps.getStoredToken()) !== token) {
      await deps.putToken(token);
      await deps.setStoredToken(token);
    }
    return 'granted';
  } catch {
    // Lần mở app sau thử lại (usePushNotifications); ở màn kích hoạt người dùng thấy câu báo và nút thử lại.
    return 'failed';
  }
}
