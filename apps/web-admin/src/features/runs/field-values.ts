import { FORM_FIELD_TYPES, FORM_LIMITS, type FileView, type FormField, type PersonRef } from '@mihato/domain';
import { fmt, formatDate, formatMoney, vi } from '@mihato/i18n';
import type { PickedPerson } from '@/components/person-picker';
import { filesByIds, isUploading, readyFileIds, type FileItem } from '@/lib/files';
import { personName } from '@/lib/person';

const t = vi.admin.runs.form;

/**
 * Logic thuần của biểu mẫu sinh từ `FormField[]` (SPEC 4.2): kiểm, đổi sang giá trị gửi lên máy chủ, và dựng chữ để hiện lại.
 * Phần vẽ ô nằm ở form-fields.tsx. Không có React ở đây nên kiểm thử bằng vitest được.
 *
 * Giá trị đang gõ: chữ cho text, longtext, date, number, money, select; hồ sơ người cho `user`; mảng hồ sơ người cho `users`;
 * mảng tệp (kèm trạng thái tải) cho `file`. `toPayload` đổi sang kiểu gửi đi: số, số nguyên đồng, 'YYYY-MM-DD', id người, mảng id.
 */
export type FieldValue = string | PickedPerson | PickedPerson[] | FileItem[] | null;
export type FieldValues = Record<string, FieldValue>;
export type FieldErrors = Record<string, string>;

const FIELD_TYPES: readonly string[] = FORM_FIELD_TYPES;
/** Số chữ số tối đa của số tiền nhập (an toàn trong số nguyên của JavaScript). */
export const MAX_MONEY_DIGITS = 15;

function isFieldType(v: unknown): v is FormField['type'] {
  return typeof v === 'string' && FIELD_TYPES.includes(v);
}

type RawField = { key: string; label: string; type: string; required?: unknown; options?: unknown; multiple?: unknown; hint?: unknown; register?: unknown };

/** Khai báo ô trong bản nháp có `type` là chuỗi tự do; ô có kiểu lạ được coi là ô chữ. */
export function asFormFields(raw: readonly RawField[]): FormField[] {
  return raw.map((f) => {
    const options = Array.isArray(f.options)
      ? f.options.flatMap((o: unknown) => {
          if (typeof o !== 'object' || o === null) return [];
          const { value, label } = o as { value?: unknown; label?: unknown };
          return typeof value === 'string' && typeof label === 'string' ? [{ value, label }] : [];
        })
      : undefined;
    return {
      key: f.key,
      label: f.label,
      type: isFieldType(f.type) ? f.type : 'text',
      required: f.required === true,
      ...(options ? { options } : {}),
      ...(f.multiple === true ? { multiple: true } : {}),
      ...(typeof f.hint === 'string' && f.hint !== '' ? { hint: f.hint } : {}),
      ...(typeof f.register === 'string' && f.register !== '' ? { register: f.register } : {}),
    };
  });
}

// ───────────────────────── Đọc giá trị đang gõ ─────────────────────────

function isFileItem(v: unknown): v is FileItem {
  return typeof v === 'object' && v !== null && 'localId' in v && 'status' in v;
}

function isPickedPerson(v: unknown): v is PickedPerson {
  return typeof v === 'object' && v !== null && typeof (v as { fullName?: unknown }).fullName === 'string' && typeof (v as { id?: unknown }).id === 'string';
}

/** Chữ của ô; ô không phải chữ thì rỗng. */
export function textOf(value: FieldValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Một người của ô `user`. */
export function personOf(value: FieldValue | undefined): PickedPerson | null {
  return isPickedPerson(value) ? value : null;
}

/** Những người của ô `users`. */
export function peopleOf(value: FieldValue | undefined): PickedPerson[] {
  const out: PickedPerson[] = [];
  if (Array.isArray(value)) for (const v of value) if (isPickedPerson(v)) out.push(v);
  return out;
}

/** Các tệp của ô `file`. */
export function filesOf(value: FieldValue | undefined): FileItem[] {
  const out: FileItem[] = [];
  if (Array.isArray(value)) for (const v of value) if (isFileItem(v)) out.push(v);
  return out;
}

/** Ô còn trống (chưa điền gì để gửi). Tệp lỗi hoặc đang tải chưa tính là có tệp. */
function isEmpty(field: FormField, value: FieldValue | undefined): boolean {
  if (field.type === 'file') return readyFileIds(filesOf(value)).length === 0;
  if (field.type === 'users') return peopleOf(value).length === 0;
  if (field.type === 'user') return personOf(value) === null;
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Ô đã có người gõ hoặc chọn gì đó (để báo lỗi sai kiểu ngay, còn ô trống bắt buộc thì chờ bấm gửi). */
export function hasInput(field: FormField, value: FieldValue | undefined): boolean {
  if (field.type === 'file') return filesOf(value).length > 0;
  return !isEmpty(field, value);
}

export function parseNumber(raw: string): number | null {
  const n = Number(raw.trim().replace(',', '.'));
  return raw.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Số nguyên đồng (không âm) từ chữ đang gõ; null khi chưa phải số nguyên hợp lệ. */
export function parseMoney(raw: string): number | null {
  const digits = raw.trim();
  if (!/^\d{1,15}$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

// ───────────────────────── Kiểm và đổi sang giá trị gửi đi ─────────────────────────

/** Số tệp tối đa của một ô `file`. */
export function maxFilesOf(field: Pick<FormField, 'multiple'>): number {
  return field.multiple ? FORM_LIMITS.files : 1;
}

/** Lỗi từng ô, theo khoá. Ô bắt buộc phải có giá trị; ô có giá trị phải đúng kiểu và không vượt giới hạn. Ô số văn bản do máy chủ cấp nên không kiểm. */
export function validateFields(fields: readonly FormField[], values: FieldValues): FieldErrors {
  const errors: FieldErrors = {};
  for (const f of fields) {
    if (f.type === 'autonumber') continue;
    const value = values[f.key];

    if (f.type === 'file') {
      const items = filesOf(value);
      const ready = readyFileIds(items).length;
      if (isUploading(items)) errors[f.key] = t.fileUploading;
      else if (ready === 0) {
        if (f.required) errors[f.key] = t.required;
      } else if (ready > maxFilesOf(f)) errors[f.key] = fmt(t.filesTooMany, { n: maxFilesOf(f) });
      continue;
    }

    if (isEmpty(f, value)) {
      if (f.required) errors[f.key] = t.required;
      continue;
    }
    if (f.type === 'users') {
      if (peopleOf(value).length > FORM_LIMITS.users) errors[f.key] = fmt(t.usersTooMany, { n: FORM_LIMITS.users });
    } else if (f.type === 'number') {
      if (parseNumber(textOf(value)) === null) errors[f.key] = t.numberInvalid;
    } else if (f.type === 'money') {
      if (parseMoney(textOf(value)) === null) errors[f.key] = t.moneyInvalid;
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(textOf(value))) errors[f.key] = t.dateInvalid;
    } else if (f.type === 'longtext') {
      if (textOf(value).trim().length > FORM_LIMITS.longtext) errors[f.key] = fmt(t.longtextTooLong, { n: FORM_LIMITS.longtext });
    } else if (f.type === 'text') {
      if (textOf(value).trim().length > FORM_LIMITS.text) errors[f.key] = fmt(t.textTooLong, { n: FORM_LIMITS.text });
    }
  }
  return errors;
}

/** Còn tệp nào của biểu mẫu đang tải lên không (để khoá nút gửi). */
export function hasUploading(fields: readonly FormField[], values: FieldValues): boolean {
  return fields.some((f) => f.type === 'file' && isUploading(filesOf(values[f.key])));
}

/** Giá trị gửi lên máy chủ; ô để trống thì không gửi. Chỉ gọi khi `validateFields` không còn lỗi. */
export function toPayload(fields: readonly FormField[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'autonumber') continue;
    const value = values[f.key];
    if (isEmpty(f, value)) continue;
    if (f.type === 'user') {
      const person = personOf(value);
      if (person) out[f.key] = person.id;
    } else if (f.type === 'users') {
      out[f.key] = peopleOf(value).map((p) => p.id);
    } else if (f.type === 'file') {
      out[f.key] = readyFileIds(filesOf(value));
    } else if (f.type === 'number') {
      const n = parseNumber(textOf(value));
      if (n !== null) out[f.key] = n;
    } else if (f.type === 'money') {
      const n = parseMoney(textOf(value));
      if (n !== null) out[f.key] = n;
    } else {
      out[f.key] = textOf(value).trim();
    }
  }
  return out;
}

/** Id mọi tệp đã tải xong ở các ô `file`, không trùng: gửi kèm ở `fileIds` khi báo xong hoặc gửi phần. */
export function attachedFileIds(fields: readonly FormField[], values: FieldValues): string[] {
  const ids: string[] = [];
  for (const f of fields) if (f.type === 'file') ids.push(...readyFileIds(filesOf(values[f.key])));
  return [...new Set(ids)];
}

/**
 * Đầu vào cho đề xuất "Trình" (cặp khoá và chuỗi, SPEC 6.5): bỏ ô tệp và ô số văn bản (đề xuất không điền được hai loại này),
 * ô nhiều người nối bằng dấu phẩy.
 */
export function proposalInputs(fields: readonly FormField[], payload: Record<string, unknown>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const f of fields) {
    if (f.type === 'file' || f.type === 'autonumber') continue;
    const value = payload[f.key];
    if (value === undefined || value === null) continue;
    out.push({ key: f.key, value: Array.isArray(value) ? value.map(String).join(',') : String(value) });
  }
  return out;
}

/** Mẫu có ô tệp bắt buộc thì không trình qua đề xuất được (đề xuất không đính tệp). */
export function needsFileUpload(fields: readonly FormField[]): boolean {
  return fields.some((f) => f.type === 'file' && f.required === true);
}

/**
 * Lỗi 422 từng ô của máy chủ (`errors[].path/code`) đổi thành câu theo ô. `path` có thể là khoá ô trần hoặc có tiền tố
 * (ví dụ `body.inputs.visitDate`, `inputs.visitDate`): khớp theo đoạn cuối. Lỗi không gắn được vào ô nào thì bỏ qua ở đây.
 */
export function fieldErrorsFromProblem(
  fields: readonly FormField[],
  problems: readonly { path: string; code: string }[],
  message: (code: string) => string,
): FieldErrors {
  const keys = new Set(fields.map((f) => f.key));
  const out: FieldErrors = {};
  for (const p of problems) {
    const last = p.path.split('.').pop() ?? p.path;
    const key = keys.has(p.path) ? p.path : keys.has(last) ? last : null;
    if (key && out[key] === undefined) out[key] = message(p.code);
  }
  return out;
}

/** Câu của mã lỗi từng ô; mã chưa có câu riêng thì dùng câu chung cho dữ liệu chưa hợp lệ. */
export function fieldCodeText(code: string, fallback: (code: string) => string): string {
  const table: Record<string, string> = t.codes;
  return table[code] ?? fallback(code);
}

// ───────────────────────── Dựng chữ để hiện lại giá trị đã lưu ─────────────────────────

type PersonLike = Pick<PersonRef, 'fullName' | 'givenName' | 'honorific'>;

export type DisplayContext = {
  /** tệp có thể tra theo id (tệp của lượt chạy hoặc của việc) */
  files?: readonly FileView[] | undefined;
  /** người có thể tra theo id */
  people?: ReadonlyMap<string, PersonLike> | undefined;
};

export type DescribedValue =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; multiline: boolean }
  | { kind: 'list'; items: string[] }
  | { kind: 'files'; files: FileView[]; missing: number };

function isPersonRef(v: unknown): v is PersonRef {
  return typeof v === 'object' && v !== null && typeof (v as { fullName?: unknown }).fullName === 'string' && typeof (v as { givenName?: unknown }).givenName === 'string';
}

function idList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v: unknown) => (typeof v === 'string' ? [v] : isPickedPerson(v) ? [v.id] : []));
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function nameOfPerson(value: unknown, ctx: DisplayContext): string {
  if (isPersonRef(value)) return personName(value, 'full');
  if (typeof value === 'string') {
    const person = ctx.people?.get(value);
    if (person) return personName(person, 'full');
  }
  return t.unknownPerson;
}

/** 'YYYY-MM-DD' là ngày lịch, không phải thời điểm: ghép giờ trưa Việt Nam để không lệch ngày. */
function dateText(value: string): string | null {
  if (Number.isNaN(Date.parse(value))) return null;
  return formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+07:00` : value);
}

/** Cấu trúc để vẽ một giá trị đã lưu (thông tin khởi chạy, kết quả của việc, phần của người tham gia). */
export function describeValue(field: Pick<FormField, 'type' | 'options'>, value: unknown, ctx: DisplayContext = {}): DescribedValue {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return { kind: 'empty' };

  if (field.type === 'file') {
    const { found, missing } = filesByIds(ctx.files ?? [], idList(value));
    return { kind: 'files', files: found, missing };
  }
  if (field.type === 'users') return { kind: 'list', items: (Array.isArray(value) ? value : [value]).map((v) => nameOfPerson(v, ctx)) };
  if (field.type === 'user') return { kind: 'text', text: nameOfPerson(value, ctx), multiline: false };
  if (field.type === 'money' && typeof value === 'number') return { kind: 'text', text: formatMoney(value), multiline: false };
  if (field.type === 'date' && typeof value === 'string') {
    const text = dateText(value);
    if (text) return { kind: 'text', text, multiline: false };
  }
  if (field.type === 'select') return { kind: 'text', text: field.options?.find((o) => o.value === value)?.label ?? String(value), multiline: false };
  if (isPersonRef(value)) return { kind: 'text', text: personName(value, 'full'), multiline: false };
  if (typeof value === 'number') return { kind: 'text', text: String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.'), multiline: false };
  if (typeof value === 'string') return { kind: 'text', text: value, multiline: field.type === 'longtext' };
  return { kind: 'text', text: JSON.stringify(value), multiline: false };
}

/** Chữ hiện lại của một giá trị đã lưu (inputs của lượt chạy, kết quả của việc). Tiền hiện bằng formatMoney. */
export function displayValue(field: Pick<FormField, 'type' | 'options'>, value: unknown, ctx: DisplayContext = {}): string {
  const described = describeValue(field, value, ctx);
  switch (described.kind) {
    case 'empty':
      return t.empty;
    case 'text':
      return described.text;
    case 'list':
      return described.items.join(', ');
    case 'files':
      return [...described.files.map((f) => f.name), ...Array.from({ length: described.missing }, () => t.unknownFile)].join(', ');
  }
}

/** Id người cần tra tên trong các ô `user`, `users` của một bộ giá trị đã lưu. */
export function personIdsIn(fields: readonly Pick<FormField, 'key' | 'type'>[], values: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const f of fields) {
    if (f.type === 'user' || f.type === 'users') ids.push(...idList(values[f.key]));
  }
  return [...new Set(ids)];
}

/** Bảng id sang người, gom từ mọi nơi lượt chạy đã có hồ sơ người; bỏ qua mục rỗng. */
export function buildPersonIndex(sources: Iterable<PersonRef | null | undefined>): Map<string, PersonRef> {
  const index = new Map<string, PersonRef>();
  for (const person of sources) if (person && !index.has(person.id)) index.set(person.id, person);
  return index;
}
