/**
 * Mẫu số văn bản (docs/DECISIONS.md, 06/10/2026). Hàm thuần dùng chung cho máy chủ (cấp số), trình thiết kế sổ (xem trước)
 * và test. Mẫu có {seq} (số thứ tự), {seq:N} (đệm số 0 cho đủ N chữ số), {yyyy} (năm 4 chữ số), {yy} (hai chữ số cuối).
 * Phần còn lại của mẫu giữ nguyên, ví dụ "{seq}/VRG-VP" cho văn bản đi, "{seq:4}" cho số đến.
 */
const TOKEN = /\{(seq(?::(\d{1,2}))?|yyyy|yy)\}/g;

export const DOC_NUMBER_PATTERN_MAX = 100;

/** Mẫu hợp lệ: không quá dài, có {seq}, và mọi cặp ngoặc nhọn là một dấu hiệu đã biết. */
export function isValidNumberPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > DOC_NUMBER_PATTERN_MAX) return false;
  if (!/\{seq(?::\d{1,2})?\}/.test(pattern)) return false;
  const rest = pattern.replace(TOKEN, '');
  return !/[{}]/.test(rest);
}

export function formatDocumentNumber(pattern: string, seq: number, year: number): string {
  return pattern.replace(TOKEN, (_all, token: string, width: string | undefined) => {
    if (token === 'yyyy') return String(year).padStart(4, '0');
    if (token === 'yy') return String(year % 100).padStart(2, '0');
    return String(seq).padStart(width ? Number(width) : 0, '0');
  });
}
