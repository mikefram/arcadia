import { EXTRA_FILES_FIELD, FILE_EXTENSIONS, FILE_MAX_BYTES, FILE_NAME_MAX, type FileView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';

/**
 * Logic thuần của tệp đính kèm (kiểm ở máy khách, định dạng, gom nhóm hồ sơ). Phần gọi mạng ở lib/file-transfer.ts.
 * Máy chủ vẫn kiểm lại cỡ, loại và nội dung: kiểm ở đây chỉ để báo lỗi sớm, trước khi tốn công tải lên.
 */

const t = vi.admin.runs.files;

/** Một tệp trong ô `file` đang soạn: id chỉ có sau khi tải lên xong. */
export type FileItem = {
  /** khoá cục bộ để vẽ danh sách, không gửi lên máy chủ */
  localId: string;
  /** id tệp ở máy chủ; null khi đang tải hoặc tải lỗi */
  id: string | null;
  name: string;
  sizeBytes: number;
  status: 'uploading' | 'done' | 'error';
  /** câu tiếng Việt báo vì sao tệp này chưa dùng được, khi status = 'error' */
  error?: string;
};

/** Mã lỗi kiểm ở máy khách; trùng mã máy chủ trả để dùng chung một bảng câu chữ. */
export type FileProblem = 'file_empty' | 'file_too_large' | 'file_type_not_allowed';

/** Phần mở rộng viết thường, không có dấu chấm; chuỗi rỗng khi tên không có đuôi. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isAllowedExtension(name: string): boolean {
  return (FILE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** Kiểm cỡ và loại trước khi tải lên. Trả null khi tệp hợp lệ. */
export function checkClientFile(file: { name: string; size: number }): FileProblem | null {
  if (!isAllowedExtension(file.name)) return 'file_type_not_allowed';
  if (file.size <= 0) return 'file_empty';
  if (file.size > FILE_MAX_BYTES) return 'file_too_large';
  return null;
}

/** Tên gửi lên máy chủ: cắt bớt phần đầu nếu quá 255 ký tự nhưng giữ nguyên đuôi. */
export function uploadName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).normalize('NFC');
  if (base.length <= FILE_NAME_MAX) return base;
  const ext = fileExtension(base);
  const suffix = ext ? `.${ext}` : '';
  return `${base.slice(0, FILE_NAME_MAX - suffix.length)}${suffix}`;
}

const numberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

/** "850 byte", "12,5 KB", "3,2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${numberFormat.format(bytes)} ${t.units.byte}`;
  if (bytes < 1024 * 1024) return `${numberFormat.format(bytes / 1024)} ${t.units.kb}`;
  return `${numberFormat.format(bytes / (1024 * 1024))} ${t.units.mb}`;
}

/** "tối đa 20 MB" dùng trong câu hướng dẫn. */
export function maxFileSizeText(): string {
  return formatBytes(FILE_MAX_BYTES);
}

/** Câu hướng dẫn dưới vùng chọn tệp: cỡ tối đa và các loại nhận. */
export function fileRulesText(): string {
  return fmt(t.rules, { cỡ: maxFileSizeText(), loại: FILE_EXTENSIONS.join(', ') });
}

/** Giá trị `accept` của <input type="file">. */
export const FILE_ACCEPT = FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export function isUploading(items: readonly FileItem[]): boolean {
  return items.some((item) => item.status === 'uploading');
}

/** Id các tệp đã tải lên xong, theo thứ tự trong danh sách. */
export function readyFileIds(items: readonly FileItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) if (item.status === 'done' && item.id) ids.push(item.id);
  return ids;
}

// ───────────────────────── Gom hồ sơ của lượt chạy ─────────────────────────

/** Mới nhất trước: theo thời điểm tải lên, hòa thì theo id (UUID v7 tăng dần theo thời gian). */
function newestFirst(a: FileView, b: FileView): number {
  const byTime = Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Tệp tổng hợp theo từng lần xuất, lần mới nhất trước; trong mỗi lần, tệp Word đứng trước rồi tới bản PDF của nó.
 * Bản PDF mà tệp Word của nó không còn trong danh sách (ngoài tầm nhìn) được coi như một tệp riêng.
 */
export function orderCompiled(files: readonly FileView[]): FileView[] {
  const compiled = files.filter((f) => f.compiled);
  const ids = new Set(compiled.map((f) => f.id));
  const masters = compiled.filter((f) => !f.renditionOf || !ids.has(f.renditionOf)).sort(newestFirst);
  return masters.flatMap((m) => [m, ...compiled.filter((f) => f.renditionOf === m.id).sort(newestFirst)]);
}

export type RunFileGroups = {
  /** tệp tổng hợp mới nhất của lượt chạy: bản trình duyệt (tệp Word) */
  presented: FileView | null;
  /** bản PDF (và các bản dựng kèm khác) của bản trình duyệt */
  presentedExtras: FileView[];
  /** các bản tổng hợp cũ hơn, mới nhất trước, mỗi lần xuất gồm Word rồi PDF */
  earlierCompiled: FileView[];
  /** tệp đính kèm lúc khởi chạy (không thuộc việc nào) */
  initial: FileView[];
  /** tài liệu đính THÊM sau khi khởi chạy (ngoài biểu mẫu), mới nhất trước */
  extra: FileView[];
  /** tệp theo từng việc (không tính tệp tổng hợp), việc có tệp mới nhất ở trên */
  byStep: { stepId: string; stepTitle: string | null; files: FileView[] }[];
};

/** Chia tệp của lượt chạy thành: bản trình duyệt, bản tổng hợp cũ, tài liệu khởi chạy, và tệp theo từng việc. */
export function groupRunFiles(files: readonly FileView[]): RunFileGroups {
  const sorted = [...files].sort(newestFirst);
  const compiled = orderCompiled(sorted);
  const rest = sorted.filter((f) => !f.compiled);
  const extra = rest.filter((f) => f.stepId === null && f.fieldKey === EXTRA_FILES_FIELD);
  const initial = rest.filter((f) => f.stepId === null && f.fieldKey !== EXTRA_FILES_FIELD);
  const steps = new Map<string, { stepId: string; stepTitle: string | null; files: FileView[] }>();
  for (const f of rest) {
    if (f.stepId === null) continue;
    const group = steps.get(f.stepId);
    if (group) group.files.push(f);
    else steps.set(f.stepId, { stepId: f.stepId, stepTitle: f.stepTitle, files: [f] });
  }
  // `sorted` đã mới nhất trước nên nhóm nào được thêm vào Map trước là nhóm có tệp mới nhất.
  const presented = compiled[0] ?? null;
  const extras = presented ? compiled.slice(1).filter((f) => f.renditionOf === presented.id) : [];
  return { presented, presentedExtras: extras, earlierCompiled: compiled.slice(1).filter((f) => !extras.includes(f)), initial, extra, byStep: [...steps.values()] };
}

/** Bản trình duyệt: tệp tổng hợp mới nhất trong danh sách tệp của lượt chạy; null khi chưa có. */
export function presentedFile(files: readonly FileView[]): FileView | null {
  return groupRunFiles(files).presented;
}

/** Bản trình duyệt kèm bản PDF của nó (tệp Word trước, PDF sau); rỗng khi chưa có tệp tổng hợp. */
export function presentedFiles(files: readonly FileView[]): FileView[] {
  const g = groupRunFiles(files);
  return g.presented ? [g.presented, ...g.presentedExtras] : [];
}

/** Tra tệp theo id; giữ thứ tự id đã cho, bỏ id không tìm thấy (tệp ngoài tầm nhìn). */
export function filesByIds(files: readonly FileView[], ids: readonly string[]): { found: FileView[]; missing: number } {
  const byId = new Map(files.map((f) => [f.id, f]));
  const found: FileView[] = [];
  let missing = 0;
  for (const id of ids) {
    const file = byId.get(id);
    if (file) found.push(file);
    else missing += 1;
  }
  return { found, missing };
}
