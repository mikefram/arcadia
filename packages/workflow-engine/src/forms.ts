import { EngineError, FORM_LIMITS, type FormField } from '@mihato/domain';

/** Lỗi của một ô biểu mẫu: `path` là khoá của ô, `code` để giao diện tra chuỗi tiếng Việt. */
export type FieldError = { path: string; code: 'required' | 'invalid_type' | 'invalid_option' | 'too_long' | 'too_many' };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' và là ngày có thật. */
export function isLocalDateString(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE_ONLY.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

function isInstantString(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(new Date(v).getTime());
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

const ID_LIKE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && ID_LIKE.test(x));

/**
 * Kiểm giá trị theo biểu mẫu (biểu mẫu khởi chạy và biểu mẫu kết quả của một việc):
 * ô bắt buộc phải có; `money` là số nguyên đồng không âm; `date` là 'YYYY-MM-DD' (hoặc thời điểm ISO);
 * `select` phải thuộc danh sách lựa chọn; `longtext` là chuỗi tới 50.000 ký tự; `users` và `file` là danh sách id (tối đa 50 và 20,
 * `file` không `multiple` chỉ một); `autonumber` do máy chủ cấp nên không bao giờ bắt buộc nhập.
 * Khoá ngoài biểu mẫu được giữ nguyên, không kiểm. Engine chỉ kiểm hình dạng của id tệp và id người;
 * tệp có thật và có quyền đính hay không do tầng lưu trữ kiểm trước khi gửi sự kiện.
 */
export function checkFormValues(fields: readonly FormField[], values: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  for (const f of fields) {
    const v = Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : undefined;
    if (isMissing(v)) {
      if (f.required && f.type !== 'autonumber') errors.push({ path: f.key, code: 'required' });
      continue;
    }
    let ok: boolean;
    switch (f.type) {
      case 'text':
        ok = typeof v === 'string';
        if (ok && (v as string).length > FORM_LIMITS.text) {
          errors.push({ path: f.key, code: 'too_long' });
          continue;
        }
        break;
      case 'longtext':
        ok = typeof v === 'string';
        if (ok && (v as string).length > FORM_LIMITS.longtext) {
          errors.push({ path: f.key, code: 'too_long' });
          continue;
        }
        break;
      case 'user':
        ok = typeof v === 'string';
        break;
      case 'autonumber':
        ok = typeof v === 'string' && v.length <= 100;
        break;
      case 'users':
        ok = isIdList(v);
        if (ok && (v as string[]).length > FORM_LIMITS.users) {
          errors.push({ path: f.key, code: 'too_many' });
          continue;
        }
        break;
      case 'file':
        ok = isIdList(v);
        if (ok && (v as string[]).length > (f.multiple ? FORM_LIMITS.files : 1)) {
          errors.push({ path: f.key, code: 'too_many' });
          continue;
        }
        break;
      case 'date':
        ok = isLocalDateString(v) || isInstantString(v);
        break;
      case 'number':
        ok = typeof v === 'number' && Number.isFinite(v);
        break;
      case 'money':
        ok = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
        break;
      case 'select':
        ok = typeof v === 'string';
        if (ok && f.options && f.options.length > 0 && !f.options.some((o) => o.value === v)) {
          errors.push({ path: f.key, code: 'invalid_option' });
          continue;
        }
        break;
    }
    if (!ok) errors.push({ path: f.key, code: 'invalid_type' });
  }
  return errors;
}

/** Ném `invalid_input` khi biểu mẫu có lỗi. Thông điệp không chứa giá trị người dùng nhập. */
export function assertFormValues(fields: readonly FormField[], values: Record<string, unknown>, what: string): void {
  const errors = checkFormValues(fields, values);
  if (errors.length > 0) throw new EngineError('invalid_input', `${what}: có ô chưa hợp lệ`, { errors });
}
