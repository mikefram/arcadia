import * as SecureStore from 'expo-secure-store';
import type { SecureKV } from './kv';

/**
 * Kho an toàn trên iOS và Android (SPEC 11.2 điều 4): token và băm PIN nằm trong Keychain hoặc Keystore,
 * chỉ đọc được khi máy đã mở khoá, và không theo bản sao lưu sang máy khác.
 * Bản web (chỉ để phát triển và kiểm thử) nằm ở `secure-kv.web.ts`.
 */
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureKV: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: (key) => SecureStore.deleteItemAsync(key, options),
};
