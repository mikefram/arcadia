import type { FormField } from '@mihato/domain';
import { readyFileIds, type FormFiles } from './files';

/**
 * Biểu mẫu kết quả của một việc (S3). Giá trị đang nhập giữ ở dạng chuỗi; khi gửi mới đổi sang kiểu của từng ô:
 * `number` thành số, `money` thành số nguyên đồng VND (CLAUDE.md luật 4), còn lại là chuỗi. Hàm thuần, có test.
 */
export type FormValues = Record<string, string>;

export type BuiltResult = {
  /** chỉ gồm các ô đã điền; undefined khi biểu mẫu trống */
  result: Record<string, unknown> | undefined;
  /** khoá của các ô bắt buộc còn trống */
  missing: string[];
  /** khoá của các ô số nhập chưa đúng */
  invalid: string[];
};

/** "20.000.000" hoặc "20 000 000" → 20000000. Trả null khi không phải số nguyên không âm. */
export function parseMoney(text: string): number | null {
  const digits = text.replace(/[.\s,]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** Số thường: nhận cả dấu phẩy thập phân kiểu Việt Nam ("2,5"). */
export function parseNumber(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Ô chỉ nhập được trên web quản trị (docs/DECISIONS.md, 06/10/2026): chọn nhiều người (app chưa có bộ chọn nhiều người).
 * Ô tệp đã nhập được trên app (chọn tệp từ máy, tải lên ngay); ô cấp số do máy chủ tự cấp nên không phải nhập.
 */
export const WEB_ONLY_FIELD_TYPES = ['users'] as const;
export const isWebOnlyField = (field: FormField): boolean => (WEB_ONLY_FIELD_TYPES as readonly string[]).includes(field.type);

/** Khoá của các ô BẮT BUỘC mà app không nhập được: người dùng phải làm việc này trên web. */
export function webOnlyRequired(fields: readonly FormField[]): string[] {
  return fields.filter((f) => isWebOnlyField(f) && f.required).map((f) => f.key);
}

/**
 * Dựng kết quả gửi lên từ các ô đã nhập. Ô tệp lấy id của các tệp đã tải lên xong (`files`, theo khoá ô): đang tải hoặc tải lỗi
 * chưa tính là có tệp, nên ô tệp bắt buộc mà chưa có tệp nào xong thì báo thiếu như mọi ô khác.
 */
export function buildResult(fields: readonly FormField[], values: FormValues, files: FormFiles = {}): BuiltResult {
  const result: Record<string, unknown> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const field of fields) {
    if (isWebOnlyField(field) || field.type === 'autonumber') continue;
    if (field.type === 'file') {
      const ids = readyFileIds(files[field.key] ?? []);
      if (ids.length > 0) result[field.key] = ids;
      else if (field.required) missing.push(field.key);
      continue;
    }
    const raw = (values[field.key] ?? '').trim();
    if (raw === '') {
      if (field.required) missing.push(field.key);
      continue;
    }
    if (field.type === 'money' || field.type === 'number') {
      const parsed = field.type === 'money' ? parseMoney(raw) : parseNumber(raw);
      if (parsed === null) invalid.push(field.key);
      else result[field.key] = parsed;
    } else {
      result[field.key] = raw;
    }
  }
  return { result: Object.keys(result).length > 0 ? result : undefined, missing, invalid };
}
