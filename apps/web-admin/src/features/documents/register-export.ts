import type { RegisterColumn, RegisterEntryView, RegisterView } from '@mihato/domain';
import { formatDate, vi, vnDateKey } from '@mihato/i18n';
import type { CsvColumn } from '@/lib/csv';
import { personName } from '@/lib/person';
import { formatRegisterValue } from './register-format';

const t = vi.admin.documents;

/**
 * Khoá trong `values` của dòng sổ chứa nhãn để hiển thị (máy chủ chụp lúc ghi; packages/backend/src/services/register-values.ts):
 * giá trị gốc (`khan`) ở `values[khoá]`, nhãn ("Khẩn", họ tên người) ở `values.__nhan[khoá]`.
 */
export const LABELS_KEY = '__nhan';

/** Ba cột có bộ lọc riêng và nơi gửi hoặc nơi nhận (khoá ô của biểu mẫu mẫu). */
export const FILTER_KEYS = { type: 'loaiVanBan', urgency: 'mucKhan', secrecy: 'mucMat' } as const;
export const PLACE_KEYS = ['noiGui', 'noiNhan'] as const;

/** Nhãn của một ô trong dòng sổ nếu có (ô chọn, ô chọn người), không thì `null`. */
function labelOf(entry: RegisterEntryView, key: string): string | null {
  const labels = entry.values[LABELS_KEY];
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
    const label = (labels as Record<string, unknown>)[key];
    if (typeof label === 'string' && label.trim() !== '') return label.trim();
  }
  return null;
}

/** Chữ hiện ở một ô của dòng sổ: nhãn nếu có, không thì giá trị đã định dạng; `null` khi không có gì. */
export function entryText(entry: RegisterEntryView, key: string): string | null {
  return labelOf(entry, key) ?? formatRegisterValue(entry.values[key]);
}

/** Giá trị gốc dạng chữ của một ô (để so sánh lọc). */
const rawText = (entry: RegisterEntryView, key: string): string => {
  const v = entry.values[key];
  return typeof v === 'string' ? v : '';
};

export type EntryFilters = {
  /** nơi gửi hoặc nơi nhận chứa chữ này (không phân biệt hoa thường, dấu) */
  place: string;
  type: string | null;
  urgency: string | null;
  secrecy: string | null;
  /** 'YYYY-MM-DD' theo giờ Việt Nam, ngày cấp số; rỗng = không giới hạn */
  from: string;
  to: string;
};

export const NO_FILTERS: EntryFilters = { place: '', type: null, urgency: null, secrecy: null, from: '', to: '' };

export const hasFilters = (f: EntryFilters): boolean => f.place.trim() !== '' || f.type !== null || f.urgency !== null || f.secrecy !== null || f.from !== '' || f.to !== '';

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/** Lọc các dòng đã tải theo giá trị gốc của cột và ngày cấp số. Cột không có trong dòng thì không khớp với điều kiện đặt lên cột đó. */
export function filterEntries(entries: readonly RegisterEntryView[], f: EntryFilters): RegisterEntryView[] {
  const place = fold(f.place.trim());
  return entries.filter((e) => {
    if (place !== '' && !PLACE_KEYS.some((k) => fold(rawText(e, k)).includes(place))) return false;
    if (f.type !== null && rawText(e, FILTER_KEYS.type) !== f.type) return false;
    if (f.urgency !== null && rawText(e, FILTER_KEYS.urgency) !== f.urgency) return false;
    if (f.secrecy !== null && rawText(e, FILTER_KEYS.secrecy) !== f.secrecy) return false;
    const day = vnDateKey(e.createdAt);
    if (f.from !== '' && day < f.from) return false;
    if (f.to !== '' && day > f.to) return false;
    return true;
  });
}

/** Các lựa chọn (giá trị gốc, nhãn) có trong các dòng đã tải ở một cột, xếp theo nhãn. */
export function choicesFor(entries: readonly RegisterEntryView[], key: string): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const e of entries) {
    const raw = rawText(e, key);
    if (raw !== '' && !seen.has(raw)) seen.set(raw, labelOf(e, key) ?? raw);
  }
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'vi'));
}

/** Cột có trong sổ hay không (để chỉ hiện bộ lọc cho cột sổ đó có). */
export const hasColumn = (columns: readonly RegisterColumn[], key: string): boolean => columns.some((c) => c.key === key);

/**
 * Cột của tệp CSV: số, ngày cấp, trích yếu, người tạo, tình trạng, rồi các cột cấu hình của sổ.
 * Chữ giống màn hình (nhãn, ngày dd/mm/yyyy). Chống chèn công thức do `lib/csv.ts` lo: ô bắt đầu bằng = + - @ được đặt dấu nháy.
 */
export function registerCsvColumns(register: Pick<RegisterView, 'columns'>): CsvColumn<RegisterEntryView>[] {
  return [
    { header: t.colNumber, value: (e) => e.number },
    { header: t.colDate, value: (e) => formatDate(e.createdAt) },
    { header: t.colSubject, value: (e) => e.subject },
    { header: t.colCreatedBy, value: (e) => (e.createdBy ? personName(e.createdBy, 'full') : '') },
    { header: t.colState, value: (e) => t.runState[e.run.state] },
    ...register.columns.map((c): CsvColumn<RegisterEntryView> => ({ header: c.label, value: (e) => entryText(e, c.key) ?? '' })),
  ];
}

/** Tên tệp CSV: `so-van-ban-<mã sổ>-<năm hoặc tat-ca>`. */
export function registerCsvFileName(register: Pick<RegisterView, 'code'>, year: number | null): string {
  return `${t.export.fileName}-${register.code.toLowerCase()}-${year ?? 'tat-ca'}`;
}
