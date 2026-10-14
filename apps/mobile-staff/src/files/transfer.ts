import { newId } from '@mihato/domain';
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { FileOpenError, fetchFileContent } from '../features/file-download';
import { FormFilesController, type FormFilesDeps } from '../features/form-files';
import type { FormFiles } from '../features/files';
import { api, downloadDeps } from '../services';
import { deviceFiles } from './device';
import type { OpenableFile } from './device-types';

/** Phần nối với máy chủ và với máy: tải tệp lên, gỡ tệp chờ gắn, tải tệp về rồi mở. Logic nằm ở `features/`, có test. */

const formFilesDeps: FormFilesDeps = {
  upload: async (body, { idempotencyKey, signal }) => {
    const view = await api.call('files.upload', { body }, { idempotencyKey, signal });
    return { id: view.id, name: view.name, sizeBytes: view.sizeBytes };
  },
  discard: async (id) => {
    await api.call('files.remove', { params: { id } });
  },
  newId: () => newId(),
};

/** Bộ điều khiển các tệp của một biểu mẫu: sống cùng màn hình, dừng các lần tải dở khi rời màn. */
export function useFormFiles(): { controller: FormFilesController; files: FormFiles } {
  const ref = useRef<FormFilesController | null>(null);
  ref.current ??= new FormFilesController(formFilesDeps);
  const controller = ref.current;
  useEffect(() => () => controller.dispose(), [controller]);
  const files = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { controller, files };
}

/**
 * Mở một tệp đính kèm: lấy bản đã tải về nếu có, không thì tải bằng token của phiên rồi lưu vào bộ nhớ tạm của app,
 * rồi mở bằng hộp chia sẻ của hệ điều hành. Mất mạng mà chưa có bản tải về thì ném `FileOpenError('need_network')`.
 */
export async function openRunFile(file: OpenableFile): Promise<void> {
  const saved = deviceFiles.findSaved(file);
  if (saved) {
    await deviceFiles.open(saved, file);
    return;
  }
  if (!onlineManager.isOnline()) throw new FileOpenError('need_network');
  const bytes = await fetchFileContent(downloadDeps, file.id);
  const location = await deviceFiles.save(file, bytes);
  await deviceFiles.open(location, file);
}

export { deviceFiles };
