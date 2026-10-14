const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Liên kết sâu của thông báo (SPEC 8.3): `mihato://step/{stepRunId}` → id của việc. Hàm thuần, có test. */
export function stepIdFromLink(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/step\/([^/?#]+)/i.exec(link.trim());
  const id = m?.[1];
  return id && UUID_RE.test(id) ? id : null;
}

/** Đoạn của màn chi tiết việc mà một thông báo muốn mở tới. */
export type StepFocus = 'comments';

export type NotificationTarget = { stepId: string; focus: StepFocus | null };

/**
 * Nơi một thông báo dẫn tới: việc từ `link` (hoặc `stepId` đã biết), và đoạn cần cuộn tới. Loại `comment_new` (bình luận mới,
 * docs/DECISIONS.md 07/10/2026 điểm a) mở đúng mục Thảo luận của việc; các loại khác mở đầu trang. `type` là loại trong dữ liệu
 * của tin đẩy hoặc `kind` của tin trong danh sách. Hàm thuần, có test.
 */
export function notificationTarget(input: { type?: unknown; link?: unknown; stepId?: string | null }): NotificationTarget | null {
  const stepId = input.stepId ?? stepIdFromLink(input.link);
  if (!stepId) return null;
  return { stepId, focus: input.type === 'comment_new' ? 'comments' : null };
}

/** Tham số của đường dẫn `/step/[id]` cho một đích; `focus` chỉ có khi cần cuộn tới một đoạn. */
export function stepRouteParams(target: NotificationTarget): { id: string; focus?: StepFocus } {
  return target.focus ? { id: target.stepId, focus: target.focus } : { id: target.stepId };
}

/** Đọc `focus` từ tham số đường dẫn (chỉ nhận giá trị đã biết). */
export function focusFromParam(value: unknown): StepFocus | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v === 'comments' ? 'comments' : null;
}
