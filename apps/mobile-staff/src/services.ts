import { createApiClient, type ApiClient, type ApiClientOptions } from '@mihato/api-client';
import { ApiError, type StepResult } from '@mihato/domain';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { APP_VERSION } from './config';
import { resetChecklist } from './features/checklist';
import type { DownloadDeps } from './features/file-download';
import { deviceFiles } from './files/device';
import { OfflineQueue, type QueueItem } from './offline/queue';
import { SessionController } from './session/controller';
import type { PinHasher } from './session/pin';
import { secureKV } from './session/secure-kv';
import { createStepUpSigner } from './session/step-up';

/**
 * Các dịch vụ dùng chung của app, tạo một lần: phiên, client API, bộ nhớ đệm, hàng đợi ngoại tuyến.
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

const CACHE_KEY = 'mihato.staff.query-cache.v1';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Giữ bản lưu một tuần để mở app khi mất mạng vẫn đọc được danh sách và chi tiết đã tải (SPEC 8.4).
      gcTime: WEEK_MS,
      retry: (failures, err) => !(err instanceof ApiError && err.status < 500) && failures < 2,
    },
    mutations: { retry: false },
  },
});

/** Bộ nhớ đệm lưu bền (AsyncStorage) để mở nhanh và đọc ngoại tuyến (SPEC 8.5). */
export const queryPersister = createAsyncStoragePersister({ storage: AsyncStorage, key: CACHE_KEY, throttleTime: 1000 });
export const QUERY_CACHE_MAX_AGE = WEEK_MS;

export const session = new SessionController({
  kv: secureKV,
  hasher,
  now: () => Date.now(),
  refreshCall: async (apiBaseUrl, refreshToken) => {
    const pair = await createPublicApi(apiBaseUrl).call('auth.refresh', { body: { refreshToken } });
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  },
  // Phiên trên máy kết thúc: không để lại dữ liệu việc, ghi chú hay thao tác chờ của người dùng cũ.
  onEnded: async () => {
    queryClient.clear();
    // Tệp đính kèm đã tải về máy (có thể là văn bản mật) cũng xoá theo.
    await Promise.all([queue.clear(), resetChecklist(), deviceFiles.clear(), AsyncStorage.removeItem(CACHE_KEY).catch(() => undefined)]);
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

/** Tải nội dung tệp đính kèm (route trả nhị phân nên không đi qua `api.call`): cùng token, cùng cách làm mới token. */
export const downloadDeps: DownloadDeps = {
  baseUrl: () => session.getSnapshot().apiBaseUrl ?? '',
  getAccessToken: session.getAccessToken,
  refresh: session.refresh,
  onUnauthenticated: session.handleUnauthenticated,
  defaultHeaders,
};

/** iOS và Android ký bằng @noble/curves với số ngẫu nhiên của expo-crypto; bản web ký bằng crypto.subtle. */
export const stepUpSigner = createStepUpSigner(secureKV, { platform: Platform.OS, randomBytes: (byteCount) => Crypto.getRandomBytes(byteCount) });

/** Đưa kết quả của một thao tác trên việc vào bộ nhớ đệm, rồi tải lại danh sách và lịch sử. */
export function applyStepResult(result: StepResult): void {
  queryClient.setQueryData(['step', result.step.id], (old: unknown) =>
    typeof old === 'object' && old !== null ? { ...old, ...result.step } : undefined,
  );
  void queryClient.invalidateQueries({ queryKey: ['step', result.step.id] });
  // Tệp vừa gắn và kết quả vừa gửi nằm trong lượt chạy.
  void queryClient.invalidateQueries({ queryKey: ['run', result.run.id] });
  void queryClient.invalidateQueries({ queryKey: ['steps'] });
  void queryClient.invalidateQueries({ queryKey: ['notifications'] });
}

/** Gửi một thao tác trong hàng đợi. `eventId` sinh trên máy là Idempotency-Key, nên gửi lại không tạo thêm sự kiện. */
async function sendQueued(item: QueueItem): Promise<void> {
  const params = { id: item.stepId };
  const options = { idempotencyKey: item.eventId };
  const action = item.action;
  let result: StepResult;
  switch (action.kind) {
    case 'accept':
      result = await api.call('steps.accept', { params }, options);
      break;
    case 'complete':
      result = await api.call('steps.complete', { params, body: { note: action.note, result: action.result, nudgeId: action.nudgeId } }, options);
      break;
    case 'requestExtension':
      result = await api.call('steps.requestExtension', { params, body: { proposedDueAt: action.proposedDueAt, reason: action.reason, nudgeId: action.nudgeId } }, options);
      break;
    case 'block':
      result = await api.call('steps.block', { params, body: { reasonCode: action.reasonCode, note: action.note, nudgeId: action.nudgeId } }, options);
      break;
  }
  applyStepResult(result);
}

export const queue = new OfflineQueue({
  storage: AsyncStorage,
  send: sendQueued,
  isOnline: () => onlineManager.isOnline(),
});
