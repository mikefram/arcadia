import type { FormField } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import type { PersonOption } from '@/components/person-picker';

const t = vi.admin.designer.editor.simulate;

export type Values = Record<string, string>;
export type Errors = Record<string, string>;
/** Ô "Chọn nhiều người": danh sách người đã chọn theo mã ô. */
export type Groups = Record<string, PersonOption[]>;

/** Ô máy chủ tự lo hoặc chưa cần khi chạy thử: số văn bản tự cấp, tệp đính kèm. */
export const isSkippedInSimulation = (f: FormField): boolean => f.type === 'autonumber' || f.type === 'file';

/** Đổi chữ người dùng gõ thành giá trị gửi lên máy chủ theo loại ô; trả lỗi của từng ô nếu có. */
export function collect(fields: readonly FormField[], values: Values, groups: Groups = {}): { inputs: Record<string, unknown>; errors: Errors } {
  const inputs: Record<string, unknown> = {};
  const errors: Errors = {};
  for (const f of fields) {
    if (isSkippedInSimulation(f)) continue;
    if (f.type === 'users') {
      const ids = (groups[f.key] ?? []).map((p) => p.id);
      if (ids.length > 0) inputs[f.key] = ids;
      else if (f.required) errors[f.key] = t.required;
      continue;
    }
    const raw = (values[f.key] ?? '').trim();
    if (raw === '') {
      if (f.required) errors[f.key] = t.required;
      continue;
    }
    if (f.type === 'number' || f.type === 'money') {
      const n = Number(raw.replace(/[.\s]/g, '').replace(',', '.'));
      if (!Number.isFinite(n)) errors[f.key] = t.invalidNumber;
      else if (f.type === 'money' && (!Number.isSafeInteger(n) || n < 0)) errors[f.key] = t.invalidMoney;
      else inputs[f.key] = n;
    } else {
      inputs[f.key] = raw;
    }
  }
  return { inputs, errors };
}
