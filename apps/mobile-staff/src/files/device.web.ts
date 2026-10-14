import * as DocumentPicker from 'expo-document-picker';
import { FileOpenError } from '../features/file-download';
import type { PickedFile } from '../features/form-files';
import type { DeviceFiles } from './device-types';

/**
 * CHỈ ĐỂ PHÁT TRIỂN VÀ KIỂM THỬ (như `secure-kv.web.ts`): bản web chọn tệp bằng hộp chọn của trình duyệt và "mở" tệp bằng cách
 * tải về qua thẻ <a download>. App phát hành là bản iOS và Android (xem `device.ts`).
 */
function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('read_failed'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export const deviceFiles: DeviceFiles = {
  async pick({ multiple }) {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple, base64: false });
    if (result.canceled) return [];
    return result.assets.map((asset): PickedFile => {
      const file = asset.file;
      return {
        name: asset.name,
        sizeBytes: asset.size ?? file?.size ?? 0,
        readBase64: () => (file ? readBase64(file) : Promise.reject(new Error('read_failed'))),
        dispose: () => {
          try {
            URL.revokeObjectURL(asset.uri);
          } catch {
            // địa chỉ tạm đã được thu hồi
          }
        },
      };
    });
  },

  findSaved: () => null,

  async save(file, bytes) {
    try {
      return URL.createObjectURL(new Blob([bytes], { type: file.mime }));
    } catch {
      throw new FileOpenError('save_failed');
    }
  },

  async open(location, file) {
    if (typeof document === 'undefined') throw new FileOpenError('share_unavailable');
    const anchor = document.createElement('a');
    anchor.href = location;
    anchor.download = file.name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Trình duyệt cần một nhịp để bắt đầu lưu trước khi thu hồi địa chỉ tạm.
    setTimeout(() => URL.revokeObjectURL(location), 30_000);
  },

  clear: async () => undefined,
};
