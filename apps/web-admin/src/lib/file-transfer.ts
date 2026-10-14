import { useCallback, useState } from 'react';
import { ApiError, routes } from '@mihato/api-client';
import type { FileView, Problem } from '@mihato/domain';
import { toast } from '@/components/ui/toast';
import { api, notifyUnauthenticated } from './api';
import { errorMessage } from './errors';
import { uploadName } from './files';

/**
 * Tải tệp lên, gỡ tệp chờ gắn, và tải tệp xuống. Tên tệp không đi vào đường dẫn: chỉ có id.
 * Tệp lên bằng JSON base64 (docs/DECISIONS.md, 06/10/2026), nên không có tiến độ theo byte.
 */

/** Nội dung tệp dạng base64, không kèm tiền tố data URL. */
export function fileToBase64(file: Blob): Promise<string> {
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

/** Tải một tệp lên (`files.upload`); tệp ở trạng thái chờ gắn cho tới khi gửi biểu mẫu. */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<FileView> {
  const data = await fileToBase64(file);
  return api.call('files.upload', { body: { name: uploadName(file.name), data } }, signal ? { signal } : {});
}

/** Gỡ tệp mới tải lên mà chưa gắn (`files.remove`). Tệp đã bị xoá từ trước (404) coi như đã gỡ. */
export async function removeUploadedFile(id: string): Promise<void> {
  try {
    await api.call('files.remove', { params: { id } });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

function downloadPath(id: string): string {
  return routes['files.download'].path.replace(':id', encodeURIComponent(id));
}

async function problemOf(res: Response): Promise<ApiError> {
  let problem: Partial<Problem> = {};
  try {
    problem = (await res.json()) as Partial<Problem>;
  } catch {
    // phản hồi không phải JSON: dùng mã chung theo trạng thái
  }
  return new ApiError(problem.code ?? (res.status >= 500 ? 'internal_error' : res.status === 404 ? 'not_found' : 'forbidden'), { ...problem, status: res.status });
}

/**
 * Lấy nội dung tệp bằng fetch kèm cookie phiên (GET không cần X-CSRF-Token). Dùng chung cho tải xuống và cho trình xem trên web:
 * quyền xem do máy chủ quyết (người ngoài lượt chạy 404), không có đường nào lấy tệp mà không qua đó.
 */
export async function fetchFileBlob(id: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(downloadPath(id), { credentials: 'include', headers: { Accept: '*/*' }, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    const err = await problemOf(res);
    if (res.status === 401) notifyUnauthenticated(err.code);
    throw err;
  }
  return res.blob();
}

/**
 * Tải tệp về máy rồi lưu qua một thẻ <a download> với đúng tên tệp. Tên chỉ nằm trong thuộc tính download của thẻ,
 * không ra đường dẫn hay nhật ký.
 */
export async function downloadFile(file: Pick<FileView, 'id' | 'name'>): Promise<void> {
  const blob = await fetchFileBlob(file.id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Trình duyệt cần một nhịp để bắt đầu lưu trước khi thu hồi địa chỉ tạm.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Bấm tải xuống từ giao diện: nhớ tệp đang tải để khoá nút, lỗi hiện thành thông báo nổi. */
export function useFileDownload(): { pendingId: string | null; start: (file: Pick<FileView, 'id' | 'name'>) => Promise<void> } {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const start = useCallback(async (file: Pick<FileView, 'id' | 'name'>) => {
    setPendingId(file.id);
    try {
      await downloadFile(file);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPendingId((current) => (current === file.id ? null : current));
    }
  }, []);
  return { pendingId, start };
}
