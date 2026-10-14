import Constants from 'expo-constants';

/** Phiên bản app, gửi ở header `X-App-Version` (SPEC 10.1). */
export const APP_VERSION: string = Constants.expoConfig?.version ?? '1.0.0';

function readExtraString(key: string): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra !== 'object' || extra === null) return null;
  const value = (extra as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Địa chỉ máy chủ ghim trong app.json (`expo.extra.apiBaseUrl`). Bản phát hành PHẢI ghim, để đường dẫn kích hoạt
 * không đổi được máy chủ (xem `resolveApiBaseUrl`). Bản phát triển để trống và nhận địa chỉ từ đường dẫn kích hoạt.
 */
export const PINNED_API_BASE_URL: string | null = readExtraString('apiBaseUrl');

/** Loại bản dựng do app.config.ts ghi vào `extra.appVariant`: `dev`, `preview`, `production`; Expo Go và bản local không có. */
export const BUILD_VARIANT: string | null = readExtraString('appVariant');

/**
 * Bản phân phối (`preview`, `production`): địa chỉ máy chủ BẮT BUỘC do bản dựng ghim và phải là https; app không bao giờ
 * nhận địa chỉ từ đường dẫn kích hoạt hay mã QR (`resolveApiBaseUrl`).
 */
export const IS_RELEASE_BUILD: boolean = BUILD_VARIANT === 'preview' || BUILD_VARIANT === 'production';

/** Chính sách quyền riêng tư công khai (`extra.privacyPolicyUrl`, đặt lúc dựng từ MIHATO_PRIVACY_POLICY_URL). Chỉ nhận https. */
export const PRIVACY_POLICY_URL: string | null = ((): string | null => {
  const value = readExtraString('privacyPolicyUrl');
  return value && /^https:\/\/[^\s]+$/i.test(value) ? value : null;
})();

/** projectId của EAS, cần để lấy Expo push token. Chưa cấu hình thì bỏ qua thông báo đẩy. */
export function easProjectId(): string | null {
  const fromEas = Constants.easConfig?.projectId;
  if (typeof fromEas === 'string' && fromEas) return fromEas;
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra === 'object' && extra !== null) {
    const eas = (extra as Record<string, unknown>).eas;
    if (typeof eas === 'object' && eas !== null) {
      const id = (eas as Record<string, unknown>).projectId;
      if (typeof id === 'string' && id) return id;
    }
  }
  return null;
}
