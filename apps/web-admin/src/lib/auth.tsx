import type { ReactNode } from 'react';
import { can as roleCan, type Action, type Me } from '@mihato/domain';
import { apiKey, apiQueryOptions, queryClient, useApiQuery } from './query';

/** Khoá truy vấn của hồ sơ người đang đăng nhập. */
export const ME_KEY = apiKey('me.get', {});
const ME_STALE_MS = 5 * 60_000;

/**
 * Phiên đã kết thúc (401 hoặc đăng xuất) nhưng dữ liệu cũ còn trong bộ nhớ đệm cho tới khi rời khỏi bố cục chính.
 * Khi cờ này bật, hồ sơ cũ không còn được tin: bộ gác route coi như chưa đăng nhập.
 */
let signedOut = false;

export function markSignedOut(): void {
  signedOut = true;
}

/** Tải hồ sơ nếu chưa có (dùng trong beforeLoad của bố cục chính). Ném ApiError 401 khi chưa đăng nhập. */
export async function ensureMe(): Promise<Me> {
  const options = { ...apiQueryOptions('me.get', {}), staleTime: ME_STALE_MS };
  const me = signedOut ? await queryClient.fetchQuery({ ...options, staleTime: 0 }) : await queryClient.ensureQueryData(options);
  signedOut = false;
  return me;
}

/** Hồ sơ đang nằm trong bộ nhớ đệm, cho mã chạy ngoài React (bộ gác route). */
export function cachedMe(): Me | undefined {
  return signedOut ? undefined : queryClient.getQueryData<Me>(ME_KEY);
}

export function setCachedMe(me: Me): void {
  signedOut = false;
  queryClient.setQueryData(ME_KEY, me);
}

/**
 * Một quyền, hoặc một trong nhiều quyền, theo quyền hiệu lực máy chủ đã tính cho người này: bảng quyền của vai trò, chỉnh của tổ chức
 * và chỉnh riêng (docs/DECISIONS.md, 05/10/2026). Máy chủ vẫn kiểm lại mọi yêu cầu.
 */
export function meCan(me: Pick<Me, 'permissions'> | undefined, action: Action | readonly Action[]): boolean {
  if (!me) return false;
  return typeof action === 'string' ? roleCan(me, action) : action.some((a) => roleCan(me, a));
}

/**
 * Hồ sơ người đang đăng nhập. Chỉ gọi bên trong bố cục chính: ở đó beforeLoad đã tải xong hồ sơ.
 */
export function useMe(): Me {
  const { data } = useApiQuery('me.get', {}, { staleTime: ME_STALE_MS });
  if (!data) throw new Error('useMe() chỉ dùng bên trong bố cục đã đăng nhập');
  return data;
}

/**
 * Kiểm quyền để ẩn hiện nút và mục (chỉ là tiện dụng; máy chủ vẫn kiểm lại):
 *   const can = useCan();
 *   can('run.start')                      một quyền
 *   can(['user.manage', 'holiday.manage']) một trong các quyền
 */
export function useCan(): (action: Action | readonly Action[]) => boolean {
  const me = useMe();
  return (action) => meCan(me, action);
}

/** Bọc phần giao diện chỉ hiện khi có quyền. */
export function Can({ action, children, fallback = null }: { action: Action | readonly Action[]; children: ReactNode; fallback?: ReactNode }) {
  const can = useCan();
  return <>{can(action) ? children : fallback}</>;
}
