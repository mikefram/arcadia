import type { FileView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { fileExtension, formatBytes } from './files';
import { dateTimeText, personName } from './steps';

/**
 * Dựng danh sách tệp đính kèm để XEM ở chi tiết việc (docs/DECISIONS.md, 06/10/2026): loại tệp, dòng "cỡ", dòng "ai tải lên",
 * và gom tệp của lượt chạy theo việc. Dữ liệu là `FileView` do máy chủ trả (máy chủ đã chọn tệp người này được xem).
 * Hàm thuần, có test.
 */
const t = vi.staff.files;

export type FileKind = keyof typeof vi.staff.files.kinds;

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  csv: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  txt: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  zip: 'archive',
};

/** Loại tệp theo phần mở rộng của tên tệp. */
export function fileKind(name: string): FileKind {
  return KIND_BY_EXTENSION[fileExtension(name)] ?? 'other';
}

/** "PDF, 1,2 MB": loại và cỡ tệp. */
export function fileMetaText(file: Pick<FileView, 'name' | 'sizeBytes'>): string {
  return fmt(t.meta, { tên: t.kinds[fileKind(file.name)], n: formatBytes(file.sizeBytes) });
}

/**
 * "chị Nguyễn Thu Lan tải lên, Thứ Năm 15/10/2026, 17:00"; tệp tổng hợp do máy chủ dựng thì chỉ có nhãn và giờ,
 * và bản PDF dựng cùng tệp Word tổng hợp (đọc được trên mọi máy) có nhãn riêng.
 */
export function fileOriginText(file: Pick<FileView, 'uploadedBy' | 'uploadedAt' | 'compiled' | 'renditionOf'>): string {
  if (file.renditionOf) return `${t.pdfCopy}, ${dateTimeText(file.uploadedAt)}`;
  if (file.compiled) return `${t.compiled}, ${dateTimeText(file.uploadedAt)}`;
  const who = personName(file.uploadedBy);
  return who ? fmt(t.uploadedBy, { người: who, giờ: dateTimeText(file.uploadedAt) }) : dateTimeText(file.uploadedAt);
}

/** Tên tệp để dùng ở tên tệp tạm trên máy: bỏ đường dẫn và ký tự điều khiển hay ký tự hệ điều hành không nhận, không để rỗng. */
export function localFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f"<>|:*?#%]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'tep';
  if (cleaned.length <= 120) return cleaned;
  const ext = fileExtension(cleaned);
  const suffix = ext ? `.${ext}` : '';
  return `${cleaned.slice(0, 120 - suffix.length)}${suffix}`;
}

/** Loại nội dung gọn cho hộp chia sẻ của Android: bỏ phần tham số như `; charset=utf-8`. */
export function shareMimeType(mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : 'application/octet-stream';
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Id tệp có đúng dạng UUID không; dùng trước khi ghép vào đường dẫn tệp tạm. */
export const isFileId = (id: string): boolean => ID_RE.test(id);

/** Mới nhất trước: theo thời điểm tải lên, hòa thì theo id (UUID v7 tăng dần theo thời gian). */
function newestFirst(a: FileView, b: FileView): number {
  const byTime = Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export type StepFileGroups = {
  /** tệp gắn vào chính việc này (khi báo xong, khi gửi phần, tệp tổng hợp) */
  own: FileView[];
  /** tài liệu đính kèm lúc khởi chạy lượt (không thuộc việc nào) */
  initial: FileView[];
  /** tệp của các việc khác trong cùng lượt, theo từng việc, việc có tệp mới nhất ở trên */
  other: { stepId: string; stepTitle: string | null; files: FileView[] }[];
  total: number;
};

/**
 * Gom tệp của lượt chạy quanh một việc. `stepFiles` là tệp trong chi tiết việc (có ngay cả khi mất mạng), `runFiles` là mọi tệp
 * của lượt chạy; hai danh sách được gộp không trùng id.
 */
export function groupFilesForStep(stepId: string, stepFiles: readonly FileView[] | undefined, runFiles: readonly FileView[] | undefined): StepFileGroups {
  const byId = new Map<string, FileView>();
  for (const f of [...(runFiles ?? []), ...(stepFiles ?? [])]) byId.set(f.id, f);
  const all = [...byId.values()].sort(newestFirst);
  const own = all.filter((f) => f.stepId === stepId);
  const initial = all.filter((f) => f.stepId === null);
  const steps = new Map<string, { stepId: string; stepTitle: string | null; files: FileView[] }>();
  for (const f of all) {
    if (f.stepId === null || f.stepId === stepId) continue;
    const group = steps.get(f.stepId);
    if (group) group.files.push(f);
    else steps.set(f.stepId, { stepId: f.stepId, stepTitle: f.stepTitle, files: [f] });
  }
  return { own, initial, other: [...steps.values()], total: all.length };
}
