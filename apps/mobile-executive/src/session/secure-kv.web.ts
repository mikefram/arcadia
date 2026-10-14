import { createMemoryKV, type SecureKV } from './kv';

/**
 * CHỈ ĐỂ PHÁT TRIỂN VÀ KIỂM THỬ. Trình duyệt không có kho an toàn của hệ điều hành, nên bản web lưu vào
 * `localStorage`, nơi mọi mã chạy trong trang đều đọc được. App Chủ tịch phát hành là bản iOS và Android
 * (dùng expo-secure-store ở `secure-kv.ts`); bản web tồn tại để chụp màn hình và chạy kiểm thử giao diện.
 * Không đưa bản web này cho người dùng thật.
 */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

const memory = createMemoryKV();

export const secureKV: SecureKV = {
  get: async (key) => {
    const s = storage();
    return s ? s.getItem(key) : memory.get(key);
  },
  set: async (key, value) => {
    const s = storage();
    if (s) s.setItem(key, value);
    else await memory.set(key, value);
  },
  remove: async (key) => {
    const s = storage();
    if (s) s.removeItem(key);
    else await memory.remove(key);
  },
};
