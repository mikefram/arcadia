import { formatDate, formatDateTime, vi, vnParts } from '@mihato/i18n';

const t = vi.admin.documents;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Khoá chữ thường thấy trong giá trị dạng đối tượng (người, tệp, lựa chọn): lấy chữ đầu tiên có. */
const OBJECT_TEXT_KEYS = ['fullName', 'name', 'label', 'title', 'fileName'] as const;

/** 1234567 → "1.234.567"; số thập phân giữ dấu phẩy: 1234.5 → "1.234,5". */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  const [int = '', frac] = String(n).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac ? `${grouped},${frac}` : grouped;
}

/**
 * Giá trị của một ô trong dòng sổ → chữ hiện ở bảng; `null` khi không có gì để hiện.
 * Sổ lưu "ảnh chụp" các ô biểu mẫu nên kiểu giá trị không cố định: chữ, số, đúng/sai, ngày, danh sách, đối tượng.
 * Đối tượng không có trường chữ quen thuộc thì bỏ qua, không đổ JSON ra màn hình.
 */
export function formatRegisterValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? t.yes : t.no;
  if (typeof value === 'number') return formatNumber(value) || null;
  if (typeof value === 'bigint') return formatNumber(Number(value));
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    const day = ISO_DATE.exec(text);
    // Ngày không kèm giờ: đổi chữ, không qua múi giờ (tránh lệch ngày).
    if (day) return `${day[3]}/${day[2]}/${day[1]}`;
    if (ISO_INSTANT.test(text) && !Number.isNaN(Date.parse(text))) {
      const p = vnParts(text);
      return p.hour === 0 && p.minute === 0 ? formatDate(text) : formatDateTime(text);
    }
    return text;
  }
  if (Array.isArray(value)) {
    const parts = value.map(formatRegisterValue).filter((x): x is string => x !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of OBJECT_TEXT_KEYS) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
  }
  return null;
}

/** Các năm để chọn ở bộ lọc: năm hiện tại (giờ Việt Nam) rồi lùi dần, tối đa `count` năm. */
export function yearOptions(now: number, count = 6): number[] {
  const current = vnParts(now).year;
  return Array.from({ length: count }, (_, i) => current - i);
}

/**
 * Lớp độ rộng tối thiểu của bảng theo số cột cấu hình thêm: năm cột cố định chiếm khoảng 560px, cột trích yếu cần thêm ít nhất
 * 300px, mỗi cột thêm 150px. Tailwind không sinh được lớp từ chuỗi ghép nên các giá trị được liệt kê sẵn.
 */
export function tableMinWidth(extraColumns: number): string {
  if (extraColumns <= 0) return 'min-w-[860px]';
  if (extraColumns === 1) return 'min-w-[1010px]';
  if (extraColumns === 2) return 'min-w-[1160px]';
  if (extraColumns === 3) return 'min-w-[1310px]';
  if (extraColumns === 4) return 'min-w-[1460px]';
  if (extraColumns <= 6) return 'min-w-[1760px]';
  if (extraColumns <= 8) return 'min-w-[2060px]';
  return 'min-w-[2660px]';
}
