import { z } from 'zod';
import { IdSchema, InstantSchema } from '../enums';
import { PersonRefSchema } from './common';

/** Tệp đính kèm (docs/DECISIONS.md, 06/10/2026). Tải lên bằng JSON base64 cho tới khi có kho đối tượng và đường dẫn có chữ ký (SPEC E19). */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Cỡ chuỗi base64 tối đa của một tệp 20 MB, cộng chỗ cho phần còn lại của thân yêu cầu. */
export const FILE_UPLOAD_BODY_LIMIT = Math.ceil((FILE_MAX_BYTES * 4) / 3) + 4096;
export const FILE_NAME_MAX = 255;
/** Phần mở rộng được nhận: văn bản, bảng tính, trình chiếu, PDF, ảnh, nén. Không nhận tệp chạy được. */
export const FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf', 'txt', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'zip'] as const;

export const FileUploadSchema = z.object({
  name: z.string().min(1).max(FILE_NAME_MAX),
  /** nội dung tệp mã hoá base64 */
  data: z.string().min(1),
});
export type FileUpload = z.infer<typeof FileUploadSchema>;

export const FileViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  uploadedBy: PersonRefSchema.nullable(),
  uploadedAt: InstantSchema,
  /** ô biểu mẫu mà tệp được đính kèm; '__compiled' là tệp tổng hợp do máy chủ dựng */
  fieldKey: z.string().nullable(),
  runId: IdSchema.nullable(),
  stepId: IdSchema.nullable(),
  stepTitle: z.string().nullable(),
  /** tệp tổng hợp do máy chủ dựng từ dữ liệu của lượt chạy (khác tệp người dùng tải lên) */
  compiled: z.boolean(),
  /** bản PDF của tệp Word tổng hợp có id này (dựng cùng lúc); null với mọi tệp khác */
  renditionOf: IdSchema.nullable(),
  /** 'pending' = mới tải lên, chưa gắn vào việc nào */
  status: z.enum(['pending', 'attached']),
});
export type FileView = z.infer<typeof FileViewSchema>;

/** Kết quả xuất tệp tổng hợp: tệp Word (các trường như FileView) kèm bản PDF dựng cùng lúc từ cùng nội dung. */
export const StepCompileResponseSchema = FileViewSchema.extend({ pdf: FileViewSchema.nullable() });
export type StepCompileResponse = z.infer<typeof StepCompileResponseSchema>;

export const FileListSchema = z.object({ items: z.array(FileViewSchema) });

/** Tên trường đánh dấu tài liệu đính THÊM vào lượt chạy sau khi khởi chạy (không thuộc ô biểu mẫu nào). */
export const EXTRA_FILES_FIELD = '__extra';
/** Đính thêm tài liệu vào lượt chạy đang chạy: các tệp đã tải lên (`files.upload`) và còn chờ gắn. */
export const RunFilesAttachSchema = z.object({ fileIds: z.array(IdSchema).min(1).max(20) });
export type RunFilesAttach = z.infer<typeof RunFilesAttachSchema>;
