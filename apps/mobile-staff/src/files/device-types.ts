import type { FileView } from '@mihato/domain';
import type { PickedFile } from '../features/form-files';

/** Phần của một tệp đính kèm mà việc mở tệp cần. */
export type OpenableFile = Pick<FileView, 'id' | 'name' | 'mime' | 'sizeBytes'>;

/**
 * Phần phụ thuộc vào máy: chọn tệp, lưu tệp tải về và mở bằng hộp chia sẻ của hệ điều hành.
 * Có hai bản cùng giao diện này: `device.ts` cho iOS và Android (expo-document-picker, expo-file-system, expo-sharing)
 * và `device.web.ts` cho bản web dùng để phát triển, kiểm thử (Metro tự chọn theo nền tảng, như `secure-kv`).
 */
export interface DeviceFiles {
  /** Mở hộp chọn tệp của hệ điều hành. Người dùng bỏ qua thì trả danh sách rỗng. */
  pick(options: { multiple: boolean }): Promise<PickedFile[]>;
  /** Nơi lưu tệp đã tải về trước đó (đúng cỡ), hoặc null: mở lại không phải tải lại và đọc được cả khi mất mạng. */
  findSaved(file: OpenableFile): string | null;
  /** Lưu nội dung tệp vào bộ nhớ tạm của app, trả về nơi lưu. Ném `FileOpenError('save_failed')` khi không lưu được. */
  save(file: OpenableFile, bytes: ArrayBuffer): Promise<string>;
  /** Mở tệp đã lưu bằng hộp chia sẻ hay xem của hệ điều hành. Ném `FileOpenError('share_unavailable')` khi máy không mở được. */
  open(location: string, file: OpenableFile): Promise<void>;
  /** Xoá mọi tệp đã tải về và bản sao tạm khi chọn tệp (khi phiên trên máy kết thúc). */
  clear(): Promise<void>;
}
