import type { FormField } from '@mihato/domain';
import type { FieldValues } from './field-values';

/** Ô nào của biểu mẫu khởi chạy thay cho tên lượt chạy khi người dùng để trống: trích yếu (văn bản), rồi tiêu đề (chỉ thị). */
const TITLE_KEYS = ['trichYeu', 'tieuDe'] as const;

/**
 * Tên lượt chạy tự trộn từ trích yếu hoặc tiêu đề của biểu mẫu, để văn thư khỏi gõ hai lần (docs/DECISIONS.md, 07/10/2026).
 * Trả chuỗi rỗng khi biểu mẫu không có ô đó hoặc ô còn trống.
 */
export function deriveRunTitle(fields: readonly FormField[], values: FieldValues): string {
  for (const key of TITLE_KEYS) {
    if (!fields.some((f) => f.key === key && (f.type === 'text' || f.type === 'longtext'))) continue;
    const v = values[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim().replace(/\s+/g, ' ');
  }
  return '';
}

/** Tên lượt chạy sẽ gửi: ô tên nếu có gõ, không thì trích yếu của biểu mẫu. */
export function effectiveRunTitle(typed: string, fields: readonly FormField[], values: FieldValues): string {
  return typed.trim() !== '' ? typed.trim() : deriveRunTitle(fields, values);
}
