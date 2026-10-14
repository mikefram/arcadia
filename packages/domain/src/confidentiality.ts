/**
 * Mức mật của lượt chạy và chia sẻ kiểu Google Drive (docs/DECISIONS.md, 07/10/2026 điểm b).
 *
 * Quy ước một nơi, không đoán chữ: biểu mẫu khởi chạy có ô tên `mucMat` (ba quy trình mẫu Chỉ thị, Văn bản đến, Văn bản đi
 * đều đặt ô này, loại chọn) với giá trị `mat`, `toi_mat` hoặc `tuyet_mat` thì lượt chạy là `restricted`. Mọi giá trị khác
 * (kể cả `thuong`, trống, ô không có) là `normal`. Giá trị được tính MỘT LẦN lúc khởi chạy ở máy chủ (services/runs.ts), không ở engine,
 * và không đổi sau đó.
 *
 * `restricted`: chỉ chủ sở hữu (người khởi chạy), người tham gia lượt (đang hoặc đã giữ, duyệt, góp một việc) và người được chia sẻ
 * mới thấy lượt, việc, tệp, dòng thời gian, bình luận và dòng trong Sổ văn bản. `run.view_all` không đủ, kể cả Chủ tịch.
 */
export const CONFIDENTIALITY_FIELD_KEY = 'mucMat';
export const RESTRICTED_CONFIDENTIAL_VALUES = ['mat', 'toi_mat', 'tuyet_mat'] as const;

export const CONFIDENTIALITIES = ['normal', 'restricted'] as const;
export type Confidentiality = (typeof CONFIDENTIALITIES)[number];

export const RUN_SHARE_ROLES = ['viewer', 'commenter'] as const;
export type RunShareRole = (typeof RUN_SHARE_ROLES)[number];

/** Tính mức mật từ biểu mẫu khởi chạy và các giá trị đã chuẩn hoá. Hàm thuần. */
export function confidentialityOf(fields: readonly { key: string; type: string }[], inputs: Record<string, unknown>): Confidentiality {
  const declared = fields.some((f) => f.key === CONFIDENTIALITY_FIELD_KEY && f.type === 'select');
  if (!declared) return 'normal';
  const v = inputs[CONFIDENTIALITY_FIELD_KEY];
  return typeof v === 'string' && (RESTRICTED_CONFIDENTIAL_VALUES as readonly string[]).includes(v) ? 'restricted' : 'normal';
}
