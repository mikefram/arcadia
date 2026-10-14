import { ApiError, FILE_EXTENSIONS, FILE_MAX_BYTES, FILE_NAME_MAX, FORM_LIMITS, FileUploadSchema, type FileUpload, type FormField } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';

/**
 * Logic thuần của tệp đính kèm ở app nhân viên (docs/DECISIONS.md, 06/10/2026): kiểm trước khi tải lên, dựng thân yêu cầu,
 * lên kế hoạch khi người dùng chọn tệp, định dạng cỡ tệp, đổi lỗi thành câu tiếng Việt. Không phụ thuộc React Native; có test.
 * Hợp đồng lấy từ packages/domain/src/api/files.ts; máy chủ vẫn kiểm lại cỡ, loại và nội dung (kiểm ở đây chỉ để báo sớm).
 */

const t = vi.staff.files;

/** Một tệp trong ô `file` đang soạn: `id` chỉ có sau khi tải lên xong. */
export type FileItem = {
  /** khoá cục bộ (UUID v7) để vẽ danh sách; cũng là Idempotency-Key của lần tải đầu */
  localId: string;
  /** id tệp ở máy chủ; null khi đang tải hoặc tải lỗi */
  id: string | null;
  name: string;
  sizeBytes: number;
  status: 'uploading' | 'done' | 'error';
  /** mã lỗi (xem `fileProblemText`) khi status = 'error' */
  problem: string | null;
};

/** Các tệp theo khoá ô `file` của biểu mẫu. */
export type FormFiles = Record<string, FileItem[]>;

/** Mã lỗi kiểm ở máy khách; trùng mã con của máy chủ để dùng chung một bảng câu chữ. */
export type FileProblem = 'file_empty' | 'file_too_large' | 'file_type_not_allowed';

/** Lỗi mà thử lại y nguyên cũng không thành: tệp hoặc ô có vấn đề, người dùng phải gỡ hoặc chọn tệp khác. */
const NOT_RETRYABLE: ReadonlySet<string> = new Set(['file_empty', 'file_too_large', 'file_type_not_allowed', 'file_content_mismatch', 'invalid_base64', 'too_many']);

/** Phần mở rộng viết thường, không có dấu chấm; chuỗi rỗng khi tên không có đuôi. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isAllowedExtension(name: string): boolean {
  return (FILE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** Kiểm đuôi, tệp rỗng và cỡ trước khi đọc và tải lên. Trả null khi tệp hợp lệ. */
export function checkClientFile(file: { name: string; size: number }): FileProblem | null {
  if (!isAllowedExtension(file.name)) return 'file_type_not_allowed';
  if (file.size <= 0) return 'file_empty';
  if (file.size > FILE_MAX_BYTES) return 'file_too_large';
  return null;
}

/** Tên gửi lên máy chủ: bỏ đường dẫn, chuẩn hoá NFC, cắt phần đầu nếu quá 255 ký tự nhưng giữ nguyên đuôi. */
export function uploadName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).normalize('NFC');
  if (base.length <= FILE_NAME_MAX) return base;
  const ext = fileExtension(base);
  const suffix = ext ? `.${ext}` : '';
  return `${base.slice(0, FILE_NAME_MAX - suffix.length)}${suffix}`;
}

/**
 * Thân của `POST /v1/files`. Ném lỗi nếu dữ liệu sai hợp đồng (tên rỗng, nội dung rỗng), nên không bao giờ gửi một yêu cầu
 * mà máy chủ chắc chắn từ chối. Nội dung phải là base64 trơn, không kèm tiền tố data URL.
 */
export function buildUploadBody(name: string, base64: string): FileUpload {
  const comma = base64.startsWith('data:') ? base64.indexOf(',') : -1;
  return FileUploadSchema.parse({ name: uploadName(name), data: comma >= 0 ? base64.slice(comma + 1) : base64 });
}

/** Số lẻ viết theo kiểu Việt Nam, tối đa một chữ số thập phân: "12,5", "3". Tính bằng số học, không dùng Intl. */
function decimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace('.', ',');
}

/** "850 byte", "12,5 KB", "3,2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${t.units.byte}`;
  if (bytes < 1024 * 1024) return `${decimal(bytes / 1024)} ${t.units.kb}`;
  return `${decimal(bytes / (1024 * 1024))} ${t.units.mb}`;
}

/** Cỡ tệp tối đa tính bằng MB, để điền vào câu hướng dẫn. */
export const MAX_FILE_MB = FILE_MAX_BYTES / (1024 * 1024);

/** Số tệp tối đa của một ô `file`. */
export function maxFilesOf(field: Pick<FormField, 'multiple'>): number {
  return field.multiple ? FORM_LIMITS.files : 1;
}

/** Câu hướng dẫn dưới nút chọn tệp: cỡ tối đa và các loại nhận. */
export function fileRulesText(): string {
  return fmt(t.rules, { n: MAX_FILE_MB, tên: FILE_EXTENSIONS.join(', ') });
}

// ───────────────────────── Danh sách tệp đang soạn ─────────────────────────

export const isUploading = (items: readonly FileItem[]): boolean => items.some((i) => i.status === 'uploading');
export const hasFailed = (items: readonly FileItem[]): boolean => items.some((i) => i.status === 'error');

/** Id các tệp đã tải lên xong, theo thứ tự trong danh sách, không trùng. */
export function readyFileIds(items: readonly FileItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) if (item.status === 'done' && item.id && !ids.includes(item.id)) ids.push(item.id);
  return ids;
}

/** Ô `file` nào đang có tệp tải dở, hoặc tệp lỗi chưa gỡ: nút Gửi phải chờ. */
export function fileFieldState(fields: readonly FormField[], files: FormFiles): { uploading: string[]; failed: string[] } {
  const uploading: string[] = [];
  const failed: string[] = [];
  for (const field of fields) {
    if (field.type !== 'file') continue;
    const items = files[field.key] ?? [];
    if (isUploading(items)) uploading.push(field.key);
    else if (hasFailed(items)) failed.push(field.key);
  }
  return { uploading, failed };
}

/** Tệp lỗi này thử tải lại y nguyên có ích không (lỗi mạng, máy chủ bận) hay phải chọn tệp khác. */
export function isRetryable(item: FileItem): boolean {
  return item.status === 'error' && !(item.problem !== null && NOT_RETRYABLE.has(item.problem));
}

export type PickedInfo = { name: string; size: number };

export type PickPlan = {
  /** danh sách đầy đủ của ô sau khi chọn */
  items: FileItem[];
  /** tệp phải bắt đầu tải lên: chỉ số trong danh sách vừa chọn và khoá cục bộ */
  uploads: { index: number; localId: string }[];
  /** tệp cũ bị thay (ô chỉ nhận một tệp): đang tải thì dừng, đã tải thì gỡ khỏi máy chủ, lỗi thì bỏ */
  discard: FileItem[];
};

/**
 * Lên kế hoạch khi người dùng chọn tệp cho một ô. Ô `multiple` giữ các tệp đang có và thêm tệp mới tới tối đa 20;
 * ô một tệp thì tệp mới thay tệp cũ. Tệp sai đuôi, rỗng, quá cỡ hay vượt số lượng vào danh sách ở dạng lỗi
 * (người dùng thấy lý do và gỡ được) và không được tải lên.
 */
export function planPick(existing: readonly FileItem[], picked: readonly PickedInfo[], field: Pick<FormField, 'multiple'>, makeId: () => string): PickPlan {
  const limit = maxFilesOf(field);
  const multiple = limit > 1;
  const discard = multiple ? [] : [...existing];
  let items: FileItem[] = multiple ? [...existing] : [];
  let accepted = items.filter((i) => i.status !== 'error').length;
  const uploads: PickPlan['uploads'] = [];
  const candidates = multiple ? picked : picked.slice(0, 1);
  candidates.forEach((file, index) => {
    const base = { localId: makeId(), id: null, name: uploadName(file.name), sizeBytes: file.size };
    const problem = checkClientFile(file);
    if (problem) {
      items = [...items, { ...base, status: 'error', problem }];
    } else if (accepted >= limit) {
      items = [...items, { ...base, status: 'error', problem: 'too_many' }];
    } else {
      accepted += 1;
      items = [...items, { ...base, status: 'uploading', problem: null }];
      uploads.push({ index, localId: base.localId });
    }
  });
  return { items, uploads, discard };
}

export function patchItem(items: readonly FileItem[], localId: string, change: Partial<FileItem>): FileItem[] {
  return items.map((i) => (i.localId === localId ? { ...i, ...change } : i));
}

export function removeItem(items: readonly FileItem[], localId: string): FileItem[] {
  return items.filter((i) => i.localId !== localId);
}

// ───────────────────────── Lỗi bằng chữ ─────────────────────────

/** Mã lỗi để tra câu: mã con của máy chủ (`errors[].code`) nếu đã biết, không thì mã chung; không tới được máy chủ là `network`. */
export function problemCodeOf(err: unknown): string {
  if (err instanceof ApiError) {
    const known: Record<string, string> = t.problems;
    for (const item of err.extra.errors ?? []) if (item.code in known) return item.code;
    return err.code;
  }
  return 'network';
}

/** Câu tiếng Việt cho một mã lỗi của tệp. `limit` là số tệp tối đa của ô, dùng cho `too_many`. */
export function fileProblemText(code: string | null, limit: number = FORM_LIMITS.files): string {
  const problems: Record<string, string> = t.problems;
  const common: Record<string, string> = vi.errors.staff;
  const own = code ? problems[code] : undefined;
  if (own) return fmt(own, { n: code === 'too_many' ? limit : MAX_FILE_MB });
  // Các mã chung của API (mất phiên, quá tần suất, máy chủ lỗi…) đã có câu trong bảng lỗi của app.
  const shared = code ? common[code] : undefined;
  return shared ?? t.problems.other;
}
