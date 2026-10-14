import { ApiError, COMMENT_MAX, type StepComment, type StepCommentList } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';
import { IdempotencyKeys, type SendOutcome } from './idempotency';

/**
 * Thảo luận theo việc (docs/DECISIONS.md, 07/10/2026 điểm a). Phần logic thuần của app nhân viên, có test ở
 * test/comments.test.ts: ánh xạ lỗi, đếm ký tự, khoá nút gửi, ghép trang, chọn khoá chống lặp, lọc bộ nhớ đệm.
 *
 * Bình luận KHÔNG phải sự kiện của engine nên không đi qua hàng đợi ngoại tuyến: không có mạng thì không gửi,
 * nội dung đã gõ vẫn giữ trong ô nhập.
 */

const t = vi.staff.comments;

export { COMMENT_MAX };

// ───────────────────────── Đếm ký tự và khoá nút gửi ─────────────────────────

/** Máy chủ cắt khoảng trắng hai đầu rồi mới kiểm 1..4000 (tính theo đơn vị UTF-16 như `String.length`). */
export function commentLength(draft: string): number {
  return draft.trim().length;
}

export type ComposerState = {
  /** số ký tự sẽ gửi (sau khi bỏ khoảng trắng hai đầu) */
  length: number;
  overLimit: boolean;
  /** khoá nút Gửi: ô trống, đang gửi hoặc quá dài; mất mạng KHÔNG khoá (bấm thì báo cần có mạng, nội dung vẫn giữ) */
  disabled: boolean;
  /** chữ đếm dưới ô nhập: "12 trên 4000 ký tự" */
  counter: string;
  offline: boolean;
};

export function composerState(input: { draft: string; sending: boolean; online: boolean }): ComposerState {
  const length = commentLength(input.draft);
  const overLimit = length > COMMENT_MAX;
  return {
    length,
    overLimit,
    disabled: length === 0 || overLimit || input.sending,
    counter: fmt(t.counter, { n: length, tổng: COMMENT_MAX }),
    offline: !input.online,
  };
}

// ───────────────────────── Ánh xạ lỗi ─────────────────────────

/**
 * Câu báo khi gửi hoặc xoá bình luận không được. Chỉ tra mã lỗi, không bao giờ hiện chữ do máy chủ gửi:
 * lỗi không tới được máy chủ nói cần có mạng; 429 nói gửi nhanh quá; 403, 404 nói đúng việc; còn lại dùng bảng lỗi chung.
 */
export function commentErrorMessage(err: unknown, fallback: (err: unknown) => string): string {
  if (err instanceof TypeError) return t.needNetworkKept;
  if (err instanceof ApiError) {
    if (err.code === 'rate_limited' || err.status === 429) return t.rateLimited;
    if (err.code === 'forbidden' || err.status === 403) return t.forbidden;
    if (err.code === 'not_found' || err.status === 404) return t.notFound;
  }
  return fallback(err);
}

// ───────────────────────── Khoá chống lặp ─────────────────────────

/**
 * Khoá `Idempotency-Key` của việc gửi bình luận. Luật chung ở idempotency.ts (giữ khi chưa có phản hồi, đổi sau mọi phản hồi 4xx),
 * thêm một điều: người dùng sửa nội dung sau lần gửi lỗi mạng thì lần gửi tiếp mang NỘI DUNG KHÁC, dùng lại khoá cũ sẽ bị máy chủ
 * trả `idempotency_key_reuse`; nên nội dung khác thì khoá khác.
 */
export class CommentKeyRing {
  private readonly keys: IdempotencyKeys<'add'>;
  private lastBody: string | null = null;

  constructor(private readonly makeId: () => string) {
    this.keys = new IdempotencyKeys<'add'>(makeId);
  }

  /** Khoá cho lần gửi `body` này (đã bỏ khoảng trắng hai đầu). */
  keyFor(body: string): string {
    if (this.lastBody !== null && this.lastBody !== body) this.keys.settle('add', { ok: true });
    this.lastBody = body;
    return this.keys.get('add');
  }

  /** Ghi nhận kết quả; trả true nếu khoá đã đổi. */
  settle(outcome: SendOutcome): boolean {
    const rotated = this.keys.settle('add', outcome);
    if (rotated) this.lastBody = null;
    return rotated;
  }
}

// ───────────────────────── Ghép trang ─────────────────────────

export type CommentPages = { pages: readonly StepCommentList[] };

/** Gộp các trang đã tải thành một danh sách, cũ nhất trước, bỏ bản trùng (trang tải lại có thể chồng nhau). */
export function mergeCommentPages(pages: readonly StepCommentList[] | undefined): StepComment[] {
  const seen = new Set<string>();
  const out: StepComment[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** Người xem có được viết không: lấy theo trang mới nhất đã tải (trang đầu tải lại sau mỗi lần làm mới). */
export function canCommentOf(pages: readonly StepCommentList[] | undefined): boolean {
  const first = pages?.[0];
  return first ? first.canComment : false;
}

/**
 * Đưa bình luận vừa gửi vào cuối danh sách đã tải. Chỉ khi trang cuối đã là trang cuối thật (`nextCursor` null):
 * còn trang chưa tải thì bình luận mới nằm ở trang sau, để lần tải lại đưa vào đúng chỗ.
 */
export function appendComment<T extends CommentPages>(data: T, comment: StepComment): T {
  const pages = data.pages;
  const last = pages[pages.length - 1];
  if (!last || last.nextCursor !== null) return data;
  if (pages.some((p) => p.items.some((i) => i.id === comment.id))) return data;
  return { ...data, pages: [...pages.slice(0, -1), { ...last, items: [...last.items, comment] }] };
}

/** Bỏ một bình luận khỏi các trang đã tải (sau khi xoá thành công). */
export function removeComment<T extends CommentPages>(data: T, commentId: string): T {
  return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== commentId) })) };
}

// ───────────────────────── Bộ nhớ đệm: không lưu bền ─────────────────────────

/** Khoá gốc của truy vấn bình luận. */
export const COMMENTS_KEY = 'comments';

/** Bình luận chỉ giữ trong bộ nhớ chừng này: rời màn xong vài phút là bỏ. */
export const COMMENT_GC_MS = 5 * 60_000;

/**
 * Truy vấn nào được ghi xuống đĩa (bộ nhớ đệm bền của app). Nội dung bình luận (có thể là của lượt mật) KHÔNG BAO GIỜ ghi xuống đĩa:
 * chỉ ở bộ nhớ, và bị xoá cùng phiên khi đăng xuất (`queryClient.clear()` ở services.ts), nên không lọt sang người dùng sau.
 * Số bình luận (`commentCount` trong `StepView`) thì ghi bình thường, vì không mang nội dung.
 */
export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] !== COMMENTS_KEY;
}

/** Bộ lọc của bộ nhớ đệm bền (`dehydrateOptions.shouldDehydrateQuery`): như mặc định của thư viện, trừ bình luận. */
export function shouldDehydrateQuery(query: Query): boolean {
  return defaultShouldDehydrateQuery(query) && shouldPersistQuery(query.queryKey);
}

// ───────────────────────── Số bình luận và huy hiệu "Mật" ─────────────────────────

export function commentCountText(count: number | undefined): string | null {
  return count && count > 0 ? fmt(t.count, { n: count }) : null;
}

export type StepBadge = { key: 'comments' | 'restricted'; label: string; a11y: string };

/**
 * Huy hiệu ở thẻ việc và chi tiết: số bình luận (chỉ khi có) và "Mật" khi lượt là văn bản mật. `restricted` lấy từ lượt đã tải sẵn
 * (`RunSummary.confidentiality`), không thêm lời gọi mạng; chưa có dữ liệu lượt thì không hiện, máy chủ vẫn là nơi quyết định quyền xem.
 */
export function stepBadges(step: { commentCount?: number }, confidentiality: 'normal' | 'restricted' | undefined): StepBadge[] {
  const out: StepBadge[] = [];
  const count = commentCountText(step.commentCount);
  if (count) out.push({ key: 'comments', label: count, a11y: fmt(t.countLabel, { n: step.commentCount ?? 0 }) });
  if (confidentiality === 'restricted') out.push({ key: 'restricted', label: t.restricted, a11y: t.restrictedLabel });
  return out;
}
