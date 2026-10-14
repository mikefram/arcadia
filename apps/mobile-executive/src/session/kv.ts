/**
 * Kho khoá-giá trị an toàn của máy. Bản thật là expo-secure-store (Keychain trên iOS, Keystore trên Android);
 * xem `secure-kv.ts`. Tách thành giao diện để logic phiên test được bằng Vitest với kho trong bộ nhớ.
 */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Tên khoá chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới (giới hạn của expo-secure-store). */
export const KV_KEYS = {
  accessToken: 'mihato.exec.accessToken',
  refreshToken: 'mihato.exec.refreshToken',
  apiBaseUrl: 'mihato.exec.apiBaseUrl',
  deviceId: 'mihato.exec.deviceId',
  /** JSON { v, salt, hash }: băm có muối của PIN. PIN không bao giờ gửi lên máy chủ (SPEC 11.2). */
  pin: 'mihato.exec.pin',
  pinFailures: 'mihato.exec.pinFailures',
  biometrics: 'mihato.exec.biometrics',
  /** push token đã ghi lên máy chủ lần gần nhất, để chỉ gọi lại khi token đổi */
  pushToken: 'mihato.exec.pushToken',
  /** khoá riêng ES256 để ký thử thách nâng quyền [GIẢ ĐỊNH, Q16] */
  stepUpKey: 'mihato.exec.stepUpKey',
  /** đã đồng ý ở màn "Trước khi dùng trợ lý" (SPEC 6.8); máy chủ ghi `conversations.transcript_consent` */
  assistantConsent: 'mihato.exec.assistantConsent',
  /**
   * Vài điều app cần trước khi tải được hồ sơ (màn khoá, lúc mất mạng): cách gọi, hồ sơ giao diện, cỡ chữ,
   * số Văn phòng. Không chứa dữ liệu công việc.
   */
  localProfile: 'mihato.exec.localProfile',
  /** người dùng tự chọn hồ sơ giao diện trên máy này ('senior' hoặc 'standard') */
  uiProfile: 'mihato.exec.uiProfile',
} as const;

export const ALL_KV_KEYS: readonly string[] = Object.values(KV_KEYS);

/** Kho trong bộ nhớ: dùng cho test, và làm phương án cuối khi máy không có kho an toàn. */
export function createMemoryKV(initial: Record<string, string> = {}): SecureKV & { dump(): Record<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
    dump: () => Object.fromEntries(data),
  };
}
