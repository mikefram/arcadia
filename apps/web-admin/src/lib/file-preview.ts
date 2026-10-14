import type { FileView } from '@mihato/domain';
import { fileExtension } from './files';

/**
 * Logic thuần của trình xem tài liệu ngay trên web. Quyết định xem được hay không CHỈ theo phần mở rộng (máy chủ đã kiểm nội dung khớp
 * phần mở rộng lúc tải lên và luôn trả `nosniff`). Không bao giờ dựng HTML từ nội dung tệp: loại tệp xem được hoặc đi qua canvas (PDF), thẻ
 * <img> (ảnh), bảng và chữ do React thoát ký tự (bảng tính, CSV, văn bản), hoặc trình dựng Word đã được rà liên kết (docx).
 */

export type PreviewKind = 'pdf' | 'image' | 'docx' | 'xlsx' | 'text' | 'csv';

const KIND_BY_EXTENSION: Readonly<Record<string, PreviewKind>> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  docx: 'docx',
  xlsx: 'xlsx',
  txt: 'text',
  csv: 'csv',
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

/** Giới hạn để một tệp lớn không làm treo trình duyệt. Tệp vượt giới hạn vẫn tải xuống được. */
export const PREVIEW_LIMITS = {
  /** số ký tự chữ thuần hiện tối đa */
  textChars: 500_000,
  tableRows: 1000,
  tableCols: 40,
  pdfPages: 100,
} as const;

/** Loại xem được của một tên tệp; null khi chưa xem trực tiếp được (doc, xls, ppt, pptx, odt, ods, rtf, zip). */
export function previewKind(name: string): PreviewKind | null {
  return KIND_BY_EXTENSION[fileExtension(name)] ?? null;
}

export const canPreview = (name: string): boolean => previewKind(name) !== null;

/** Loại nội dung để dựng Blob cho trình xem (máy chủ trả đúng loại, nhưng không dựa vào đó để chọn cách hiển thị). */
export function previewMime(name: string): string {
  return MIME_BY_EXTENSION[fileExtension(name)] ?? 'application/octet-stream';
}

/**
 * Tệp nên mở khi bấm "Xem". Tệp Word tổng hợp do máy chủ dựng có bản PDF dựng cùng lúc từ cùng nội dung: xem bản PDF thì đúng như bản
 * sẽ in và ký. Không có bản PDF thì xem chính tệp.
 */
export function viewableFor(file: FileView, all: readonly FileView[]): FileView {
  if (!file.compiled || file.renditionOf) return file;
  return all.find((f) => f.renditionOf === file.id) ?? file;
}

/** Bỏ dấu thứ tự byte (BOM) ở đầu văn bản UTF-8. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Đọc CSV theo RFC 4180: trường có nháy kép chứa được dấu phẩy, xuống dòng và nháy kép đôi (""). Tự nhận dấu phân cách `,` hoặc `;`
 * (Excel tiếng Việt thường xuất bằng `;`). Dừng ở `maxRows` dòng và báo đã cắt.
 */
export function parseCsv(input: string, maxRows: number = PREVIEW_LIMITS.tableRows): { rows: string[][]; truncated: boolean } {
  const text = stripBom(input);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  const endRow = () => {
    row.push(field);
    field = '';
    // Dòng trống hoàn toàn (một trường rỗng) thì bỏ.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    // Nháy kép chỉ mở trường có nháy khi đứng ĐẦU trường (RFC 4180); giữa trường là chữ thường.
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) {
        truncated = i < text.length - 1;
        return { rows, truncated };
      }
    } else field += ch;
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, truncated };
}

/** Cắt bảng về giới hạn dòng và cột. `truncated` cho giao diện hiện câu "chỉ hiện N dòng đầu". */
export function limitTable<T>(rows: readonly (readonly T[])[], maxRows: number = PREVIEW_LIMITS.tableRows, maxCols: number = PREVIEW_LIMITS.tableCols): { rows: T[][]; truncated: boolean } {
  const cut = rows.slice(0, maxRows).map((r) => r.slice(0, maxCols));
  return { rows: cut, truncated: rows.length > maxRows || rows.some((r) => r.length > maxCols) };
}

/**
 * Chỉ giữ liên kết tuyệt đối http, https, mailto. Mọi dạng khác bị bỏ: javascript:, data:, file:, đường dẫn tương đối và neo (#): liên kết
 * trong tệp do người dùng tải lên không được điều hướng ứng dụng.
 */
export function safeHref(href: string | null | undefined): string | null {
  const value = (href ?? '').trim();
  if (!/^(https?:|mailto:)/i.test(value)) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}
