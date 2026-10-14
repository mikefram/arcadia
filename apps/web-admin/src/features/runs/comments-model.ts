import { ApiError } from '@mihato/api-client';
import { COMMENT_FILES_MAX, COMMENT_MAX, type StepComment } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { errorMessage, isApiError } from '@/lib/errors';

/** Logic thuần của mục Thảo luận: cắt độ dài, khoá nút gửi, khoá chống gửi trùng, câu báo lỗi, giờ hiển thị. */

const t = vi.admin.runs.comments;

/** Cắt bình luận tối đa COMMENT_MAX ký tự (đơn vị UTF-16, như máy chủ đếm), không cắt đôi một cặp thay thế (ký tự ngoài BMP). */
export function clampComment(text: string, max: number = COMMENT_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export type ComposerState = {
  /** số ký tự đang gõ (kể cả khoảng trắng) */
  length: number;
  /** nội dung sẽ gửi: đã bỏ khoảng trắng hai đầu, như máy chủ làm */
  body: string;
  /** vượt mức (chỉ xảy ra khi nội dung chưa qua clampComment) */
  tooLong: boolean;
  /** nút gửi dùng được */
  canSend: boolean;
};

/** Trạng thái ô nhập: nút gửi dùng được khi có chữ thật hoặc có tệp, không vượt mức (chữ, số tệp), tệp đã tải xong, ô được phép viết và không đang gửi. */
export function composerState(text: string, opts: { sending: boolean; canComment: boolean; files?: number; filesBusy?: boolean }): ComposerState {
  const body = text.trim();
  const files = opts.files ?? 0;
  const tooLong = body.length > COMMENT_MAX;
  const filesOk = files <= COMMENT_FILES_MAX && !opts.filesBusy;
  return { length: text.length, body, tooLong, canSend: opts.canComment && !opts.sending && (body.length > 0 || files > 0) && !tooLong && filesOk };
}

/** Giờ của một bình luận theo múi giờ Asia/Ho_Chi_Minh: "07/10/2026 14:05". */
export function commentTime(createdAt: string): string {
  return formatDateTime(createdAt);
}

/** Tên hiện cho tác giả: bình luận của chính mình thêm "(bạn)". */
export function authorLabel(comment: Pick<StepComment, 'author' | 'mine'>, fullName: string): string {
  return comment.mine ? `${fullName} (${t.you})` : fullName;
}

export type SendAttempt = { key: string; body: string };

/**
 * Khoá chống gửi trùng (Idempotency-Key) của một lần gửi. Cùng nội dung thì giữ NGUYÊN khoá của lần trước, để gửi lại sau khi
 * mất mạng không tạo hai bình luận; nội dung khác thì khoá mới.
 */
export function nextAttempt(previous: SendAttempt | null, body: string, makeKey: () => string): SendAttempt {
  return previous !== null && previous.body === body ? previous : { key: makeKey(), body };
}

/**
 * Sau một lần gửi lỗi, lần gửi lại có dùng lại khoá cũ không. Máy chủ lưu cả phản hồi 4xx theo khoá, nên lỗi 4xx (hết quyền, quá
 * nhanh...) phải đổi khoá; lỗi mạng, lỗi 5xx và "đang xử lý" thì giữ khoá, vì lần trước có thể đã tới nơi.
 */
export function shouldReuseKey(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.code === 'request_in_progress';
  return err instanceof TypeError;
}

/** Câu báo lỗi khi gửi bình luận. */
export function sendErrorMessage(err: unknown): string {
  let reason: string;
  if (isApiError(err, 'forbidden')) reason = t.forbidden;
  else if (isApiError(err, 'rate_limited')) reason = t.rateLimited;
  else if (isApiError(err, 'not_found')) reason = t.notFound;
  else reason = errorMessage(err);
  return fmt(t.sendFailed, { 'lý do': reason });
}

/** Câu báo lỗi khi xoá bình luận. */
export function deleteErrorMessage(err: unknown): string {
  return fmt(t.deleteFailed, { 'lý do': errorMessage(err) });
}
