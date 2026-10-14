import { ApiError } from '@mihato/api-client';
import type { PersonRef, RunShareRole, RunShares } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { compareVi } from '@/lib/collator';
import { errorMessage, isApiError } from '@/lib/errors';

/** Logic thuần của hộp thoại Chia sẻ: sắp danh sách, câu báo lỗi, lỗi nào thử lại được. */

const t = vi.admin.runs.share;

type FixedRole = 'owner' | 'participant';
export type AccessRow =
  | { kind: 'fixed'; person: PersonRef; role: FixedRole }
  | { kind: 'shared'; person: PersonRef; role: RunShareRole; grantedBy: PersonRef | null; createdAt: string };

/** Người Việt xếp theo tên gọi (chữ cuối), rồi theo họ tên đầy đủ; so chữ có dấu theo tiếng Việt. */
function comparePeople(a: PersonRef, b: PersonRef): number {
  return compareVi(a.givenName, b.givenName) || compareVi(a.fullName, b.fullName);
}

const FIXED_ORDER: Record<FixedRole, number> = { owner: 0, participant: 1 };

/**
 * Danh sách "Người có quyền truy cập": chủ sở hữu, rồi người tham gia (cố định, không gỡ được), rồi người được chia sẻ.
 * Trong mỗi nhóm xếp theo tên; người được chia sẻ có mức Bình luận đứng trước mức Xem.
 */
export function orderAccess(data: Pick<RunShares, 'fixed' | 'shares'>): AccessRow[] {
  const fixed: AccessRow[] = [...data.fixed]
    .sort((a, b) => FIXED_ORDER[a.role] - FIXED_ORDER[b.role] || comparePeople(a.person, b.person))
    .map((f) => ({ kind: 'fixed', person: f.person, role: f.role }));
  const shared: AccessRow[] = [...data.shares]
    .sort((a, b) => (a.role === b.role ? 0 : a.role === 'commenter' ? -1 : 1) || comparePeople(a.person, b.person))
    .map((s) => ({ kind: 'shared', person: s.person, role: s.role, grantedBy: s.grantedBy, createdAt: s.createdAt }));
  return [...fixed, ...shared];
}

/** Mọi id đã có quyền: để ô tìm người không gợi ý lại những người này. */
export function accessIds(data: Pick<RunShares, 'fixed' | 'shares'>): string[] {
  return [...data.fixed.map((f) => f.person.id), ...data.shares.map((s) => s.person.id)];
}

/** Nhãn của một mức, kể cả mức cố định (chủ sở hữu, người tham gia). */
export function roleLabel(role: FixedRole | RunShareRole): string {
  return t.roles[role];
}

/** Câu báo lỗi khi thêm, đổi, gỡ người; mã con của 422 có câu riêng ở vi.admin.shell.errors.byCode. */
export function shareErrorMessage(err: unknown): string {
  let reason: string;
  if (isApiError(err, 'forbidden')) reason = t.forbidden;
  else if (isApiError(err, 'not_found')) reason = t.peopleNotFound;
  else reason = errorMessage(err);
  return fmt(t.saveFailed, { 'lý do': reason });
}

/** Lỗi nào đáng bấm "Thử lại": mạng, 5xx, quá nhanh. Còn lại (hết quyền, mã con 422, 404) thử lại cũng vậy. */
export function isRetryableShareError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.code === 'rate_limited' || err.code === 'request_in_progress';
  return err instanceof TypeError;
}

/** Lỗi cho biết danh sách phía sau đã đổi: làm mới lại để người dùng thấy đúng. */
export function shareErrorNeedsRefresh(err: unknown): boolean {
  return isApiError(err, 'not_found') || isApiError(err, 'forbidden') || (isApiError(err, 'input_invalid') && (err.extra.errors ?? []).length > 0);
}
