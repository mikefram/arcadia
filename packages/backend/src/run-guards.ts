import { ApiError, type ProcessDefinition, type WorkCalendar } from '@mihato/domain';
import { addWorkingDays, toLocalDate } from '@mihato/domain/calendar';

/**
 * Luật khi khởi chạy riêng cho chỉ thị (docs/DECISIONS.md, 07/10/2026). Hàm thuần: giờ và lịch do người gọi đưa vào.
 *
 * 1. Hạn hoàn thành phải đủ xa: các việc của chỉ thị tính lùi từ hạn (thực hiện trước hạn 2 ngày làm việc, tổng hợp trước 1 ngày),
 *    hạn gần quá thì việc thực hiện đã quá hạn ngay khi tới lượt. Hạn tối thiểu = ngày làm việc thứ (số ngày lùi lớn nhất + 1) kể từ hôm nay.
 * 2. Mức khẩn của chỉ thị in thành nhãn lên tiêu đề lượt chạy ([KHẨN], [HỎA TỐC]) nên thấy ngay ở danh sách việc, thông báo, sổ.
 */

/** Nhãn mức khẩn in lên tiêu đề; mức thường không có nhãn. */
export const URGENCY_TITLE_LABELS: Record<string, string> = { khan: '[KHẨN]', hoa_toc: '[HỎA TỐC]' };

const GUARDED_CATEGORIES: readonly string[] = ['directive'];

export const isGuardedCategory = (category: string): boolean => GUARDED_CATEGORIES.includes(category);

/** Số ngày làm việc tối thiểu từ hôm nay tới hạn của lượt để mọi việc tính lùi từ hạn chưa quá hạn lúc tới lượt. 0 = không có việc nào tính lùi. */
export function minimumLeadWorkingDays(def: ProcessDefinition): number {
  let back = 0;
  for (const n of def.nodes) {
    if (n.type !== 'task' && n.type !== 'approval') continue;
    if (n.due.anchor !== 'run_target' || n.due.offset.value >= 0) continue;
    const v = -n.due.offset.value;
    back = Math.max(back, n.due.offset.unit === 'hour' ? Math.ceil(v / 24) : v);
  }
  return back > 0 ? back + 1 : 0;
}

/** Hạn của lượt (ngày `YYYY-MM-DD` ở ô `targetField`) quá gần thì 422 `target_too_soon` gắn vào ô đó. Giá trị không phải ngày thì bỏ qua (nơi khác báo). */
export function assertTargetFarEnough(def: ProcessDefinition, inputs: Record<string, unknown>, calendar: WorkCalendar, now: Date): void {
  const field = def.targetField;
  const lead = minimumLeadWorkingDays(def);
  if (!field || lead === 0) return;
  const target = inputs[field];
  if (typeof target !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return;
  const earliest = addWorkingDays(toLocalDate(now, calendar), lead, calendar);
  if (target < earliest) throw new ApiError('input_invalid', { errors: [{ path: `inputs.${field}`, code: 'target_too_soon' }] });
}

/** Tiêu đề lượt chạy của chỉ thị: thêm nhãn mức khẩn nếu chưa có. */
export function composeRunTitle(def: ProcessDefinition, title: string, inputs: Record<string, unknown>): string {
  const urgency = def.inputs.some((f) => f.key === 'mucKhan' && f.type === 'select') ? inputs['mucKhan'] : undefined;
  const label = typeof urgency === 'string' ? URGENCY_TITLE_LABELS[urgency] : undefined;
  if (!label || title.startsWith(label)) return title;
  return `${label} ${title}`.slice(0, 200);
}
