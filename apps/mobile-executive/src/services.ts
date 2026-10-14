import { createApiClient, type ApiClient, type ApiClientOptions } from '@mihato/api-client';
import { ApiError } from '@mihato/domain';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { APP_VERSION } from './config';
import { LocalProfileStore } from './features/local-profile';
import { SessionController } from './session/controller';
import type { PinHasher } from './session/pin';
import { secureKV } from './session/secure-kv';
import { createStepUpSigner } from './session/step-up';

/**
 * Các dịch vụ dùng chung của app, tạo một lần: phiên, client API, bộ nhớ đệm.
 * React chỉ đăng ký nghe (useSyncExternalStore); logic nằm ở các lớp thuần đã có test.
 */

const defaultHeaders = (): Record<string, string> => ({ 'X-App-Version': APP_VERSION, 'X-Platform': Platform.OS });

/** Client chưa đăng nhập: dùng cho devices.activate và auth.refresh. */
export function createPublicApi(baseUrl: string): ApiClient {
  return createApiClient({ baseUrl, defaultHeaders });
}

const hasher: PinHasher = {
  randomSalt: () => [...Crypto.getRandomBytes(16)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  sha256Hex: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
};

const CACHE_KEY = 'mihato.exec.progress-cache.v1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: WEEK_MS,
      retry: (failures, err) => !(err instanceof ApiError && err.status < 500) && failures < 2,
    },
    mutations: { retry: false },
  },
});

/** Chỉ bản tiến độ gần nhất được ghi xuống máy: xem `shouldPersistQuery` ở data/persist.ts. */
export const queryPersister = createAsyncStoragePersister({ storage: AsyncStorage, key: CACHE_KEY, throttleTime: 1000 });
export const QUERY_CACHE_MAX_AGE = WEEK_MS;

export const localProfile = new LocalProfileStore(secureKV);

export const session = new SessionController({
  kv: secureKV,
  hasher,
  now: () => Date.now(),
  refreshCall: async (apiBaseUrl, refreshToken) => {
    const pair = await createPublicApi(apiBaseUrl).call('auth.refresh', { body: { refreshToken } });
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  },
  // Phiên trên máy kết thúc: không để lại dữ liệu của người dùng cũ.
  onEnded: async () => {
    queryClient.clear();
    localProfile.reset();
    await AsyncStorage.removeItem(CACHE_KEY).catch(() => undefined);
  },
});

const apiOptions: ApiClientOptions = {
  // Địa chỉ máy chủ đến từ đường dẫn kích hoạt và nằm trong kho an toàn; đọc lại ở mỗi lời gọi.
  get baseUrl() {
    return session.getSnapshot().apiBaseUrl ?? '';
  },
  getAccessToken: session.getAccessToken,
  onTokenExpired: session.refresh,
  onUnauthenticated: session.handleUnauthenticated,
  defaultHeaders,
};

export const api: ApiClient = createApiClient(apiOptions);

/** iOS và Android ký bằng @noble/curves với số ngẫu nhiên của expo-crypto; bản web ký bằng crypto.subtle. */
export const stepUpSigner = createStepUpSigner(secureKV, { platform: Platform.OS, randomBytes: (byteCount) => Crypto.getRandomBytes(byteCount) });
