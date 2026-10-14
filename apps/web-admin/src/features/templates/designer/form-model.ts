import type { DocSection, FormField, RegisterView, StarterRule } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';

/**
 * Các hàm thuần của bộ sửa biểu mẫu, sổ văn bản, tệp Word tổng hợp và người khởi chạy. Tách khỏi các thành phần giao diện
 * để kiểm bằng test đơn vị mà không cần dựng màn hình.
 */

const f = vi.admin.designer.editor.fields;

// ───────────────────────── Ô của biểu mẫu ─────────────────────────

export type FieldType = FormField['type'];

/** Sửa một ô sang loại mới: bỏ những thuộc tính chỉ có nghĩa với loại cũ (lựa chọn, nhiều tệp, sổ văn bản). */
export function retypeField(field: FormField, type: FieldType): FormField {
  const next: FormField = { ...field, type };
  if (type === 'select') next.options = field.options ?? [];
  else delete next.options;
  if (type !== 'file') delete next.multiple;
  if (type !== 'autonumber') delete next.register;
  // Số văn bản do hệ thống cấp, không ai điền nên không có "Bắt buộc".
  if (type === 'autonumber') delete next.required;
  return next;
}

/** Bỏ các khoá không có giá trị (chú thích để trống, công tắc đã tắt), để JSON lưu đi không còn khoá thừa. */
export function tidyField(field: FormField): FormField {
  const next: Record<string, unknown> = { ...field };
  for (const [key, value] of Object.entries(next)) if (value === undefined || (key === 'hint' && value === '')) delete next[key];
  return next as FormField;
}

/** Ô mới thêm từ tên và loại. Mặc định bắt buộc, trừ số văn bản tự cấp. */
export function newField(key: string, label: string, type: FieldType): FormField {
  return retypeField({ key, label, type, required: true }, type);
}

// ───────────────────────── Sổ văn bản ─────────────────────────

/** Mã sổ hợp lệ (khớp RegisterCodeSchema): bắt đầu bằng chữ cái, tối đa 32 ký tự gồm chữ, số, gạch dưới, gạch ngang. */
export function cleanRegisterCode(raw: string): string | undefined {
  const code = raw.replace(/[^A-Za-z0-9_-]/g, '').replace(/^[^A-Za-z]+/, '').slice(0, 32);
  return code === '' ? undefined : code;
}

/** Các sổ chọn được: sổ chưa lưu trữ, cộng sổ đang được chọn dù đã lưu trữ hoặc không còn (để ô không trống). */
export function registerChoices(registers: readonly RegisterView[], current: string | undefined): { value: string; label: string }[] {
  const out = registers
    .filter((r) => r.archivedAt === null || r.code === current)
    .map((r) => {
      const label = fmt(f.registerOption, { tên: r.name, mã: r.code });
      return { value: r.code, label: r.archivedAt === null ? label : fmt(f.registerArchived, { tên: label }) };
    });
  if (current !== undefined && !out.some((o) => o.value === current)) out.push({ value: current, label: current });
  return out;
}

// ───────────────────────── Tệp Word tổng hợp ─────────────────────────

/** Một mục lấy dữ liệu từ `ref` hoặc in chữ nhập tay `text`; không giữ khoá rỗng. */
export function sectionOf(heading: string, source: { ref: string } | { text: string }): DocSection {
  if ('ref' in source) return { heading, ref: source.ref };
  return source.text === '' ? { heading } : { heading, text: source.text };
}

// ───────────────────────── Người khởi chạy ─────────────────────────

/** Thêm một dòng vào danh sách người được khởi chạy, bỏ dòng trùng. */
export function addStarter(starters: readonly StarterRule[] | undefined, rule: StarterRule): StarterRule[] {
  const list = starters ?? [];
  return list.some((r) => JSON.stringify(r) === JSON.stringify(rule)) ? [...list] : [...list, rule];
}

/** Bỏ các dòng khớp điều kiện. */
export function removeStarters(starters: readonly StarterRule[] | undefined, match: (rule: StarterRule) => boolean): StarterRule[] {
  return (starters ?? []).filter((r) => !match(r));
}
