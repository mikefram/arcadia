import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { FileOpenError } from '../features/file-download';
import { isFileId, localFileName, shareMimeType } from '../features/file-list';
import type { PickedFile } from '../features/form-files';
import type { DeviceFiles, OpenableFile } from './device-types';

/**
 * Bản cho iOS và Android. Tệp chọn từ máy được hệ điều hành chép vào bộ nhớ tạm của app (`copyToCacheDirectory`), đọc thành
 * base64 để tải lên rồi xoá. Tệp tải về lưu ở `<bộ nhớ tạm>/tep/<id tệp>/<tên tệp>` và mở bằng hộp chia sẻ của hệ điều hành.
 * Bộ nhớ tạm của app là nơi riêng của app; hệ điều hành tự dọn khi thiếu chỗ, và app xoá hết khi phiên kết thúc (`clear`).
 */
const SAVED_DIR = 'tep';
/** Thư mục mà expo-document-picker chép tệp đã chọn vào, trong bộ nhớ tạm. */
const PICKER_DIR = 'DocumentPicker';

function pickedFrom(asset: DocumentPicker.DocumentPickerAsset): PickedFile {
  let disposed = false;
  let sizeBytes = asset.size ?? 0;
  if (!asset.size) {
    try {
      sizeBytes = new File(asset.uri).size;
    } catch {
      sizeBytes = 0;
    }
  }
  return {
    name: asset.name,
    sizeBytes,
    readBase64: () => new File(asset.uri).base64(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        const copy = new File(asset.uri);
        if (copy.exists) copy.delete();
      } catch {
        // bản sao tạm không xoá được thì hệ điều hành sẽ dọn sau
      }
    },
  };
}

function savedFile(file: OpenableFile): File {
  return new File(Paths.cache, SAVED_DIR, file.id, localFileName(file.name));
}

export const deviceFiles: DeviceFiles = {
  async pick({ multiple }) {
    // Không lọc theo loại ở hộp chọn (mỗi nhà cung cấp tệp trên Android khai loại một kiểu): đuôi tệp được kiểm sau khi chọn.
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple, copyToCacheDirectory: true });
    if (result.canceled) return [];
    return result.assets.map(pickedFrom);
  },

  findSaved(file) {
    if (!isFileId(file.id)) return null;
    try {
      const target = savedFile(file);
      return target.exists && target.size === file.sizeBytes ? target.uri : null;
    } catch {
      return null;
    }
  },

  async save(file, bytes) {
    if (!isFileId(file.id)) throw new FileOpenError('save_failed');
    try {
      new Directory(Paths.cache, SAVED_DIR, file.id).create({ intermediates: true, idempotent: true });
      const target = savedFile(file);
      target.create({ overwrite: true });
      target.write(new Uint8Array(bytes));
      return target.uri;
    } catch {
      throw new FileOpenError('save_failed');
    }
  },

  async open(location, file) {
    if (!(await Sharing.isAvailableAsync())) throw new FileOpenError('share_unavailable');
    try {
      await Sharing.shareAsync(location, { mimeType: shareMimeType(file.mime), dialogTitle: file.name });
    } catch {
      throw new FileOpenError('share_unavailable');
    }
  },

  async clear() {
    for (const name of [SAVED_DIR, PICKER_DIR]) {
      try {
        const dir = new Directory(Paths.cache, name);
        if (dir.exists) dir.delete();
      } catch {
        // dọn không được thì hệ điều hành sẽ dọn sau
      }
    }
  },
};
