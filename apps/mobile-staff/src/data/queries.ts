import type { RouteResponse } from '@mihato/api-client';
import type { StepDetail, StepView, WorkCalendar } from '@mihato/domain';
import { keepPreviousData, onlineManager, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { workCalendarOf } from '../features/calendar';
import { COMMENT_GC_MS, COMMENTS_KEY } from '../features/comments';
import { awaitingOthers } from '../features/steps';
import { api, queryClient } from '../services';

/** App không dùng SSE (SPEC 10.8): S1 tự làm mới mỗi 60 giây khi màn đang mở. */
export const LIST_REFRESH_MS = 60_000;
/**
 * Nhịp hỏi máy chủ khi app đang mở (số tin chưa đọc). Máy chủ nhớ trạng thái thiết bị tối đa 30 giây, nên hỏi mỗi
 * 30 giây thì thiết bị bị thu hồi sẽ về màn kích hoạt trong không quá 1 phút (SPEC 10.2 [MỤC TIÊU]).
 */
export const HEARTBEAT_MS = 30_000;
const DETAIL_PREFETCH_LIMIT = 20;
const DETAIL_PREFETCH_STALE_MS = 5 * 60_000;

export const keys = {
  me: ['me'] as const,
  mySteps: (tab: 'todo' | 'done') => ['steps', 'mine', tab] as const,
  teamSteps: ['steps', 'team'] as const,
  awaitingSteps: ['steps', 'awaiting'] as const,
  step: (id: string) => ['step', id] as const,
  run: (id: string) => ['run', id] as const,
  /** nội dung bình luận: chỉ ở bộ nhớ, không ghi xuống đĩa (xem `shouldPersistQuery`) */
  comments: (stepId: string) => [COMMENTS_KEY, stepId] as const,
  notifications: ['notifications'] as const,
  delegations: ['delegations'] as const,
  people: (q: string) => ['people', q] as const,
  assignees: (stepId: string) => ['assignees', stepId] as const,
  holidays: (year: number) => ['holidays', year] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api.call('me.get', {}), staleTime: 5 * 60_000 });
}

/** Làm mới khi quay lại màn (SPEC 10.8): các tab giữ nguyên màn đã dựng, nên phải tự tải lại lúc màn được mở lại. */
function useRefetchOnFocus(refetch: () => unknown): void {
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      // Lần dựng đầu đã có `refetchOnMount`; chỉ tải lại ở các lần quay lại sau đó, và chỉ khi có mạng.
      if (first.current) {
        first.current = false;
        return;
      }
      if (onlineManager.isOnline()) void refetch();
    }, [refetch]),
  );
}

/** Mọi việc trong các danh sách đã tải, để hiện ngay phần chung của một việc khi mở chi tiết lúc mất mạng. */
function findCachedStep(id: string): StepView | undefined {
  for (const [, data] of queryClient.getQueriesData<{ items: StepView[] }>({ queryKey: ['steps'] })) {
    const hit = data?.items.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

const fetchStep = (id: string) => api.call('steps.get', { params: { id } });
const fetchRun = (id: string) => api.call('runs.get', { params: { id } });

/**
 * S1 Việc của tôi: `GET /v1/steps?assignee=me`. Tab Cần làm lấy việc đang mở, sắp theo hạn;
 * tab Đã xong lấy việc đã xong, mới nhất trước. Tự làm mới khi vào màn và mỗi 60 giây khi màn đang mở.
 */
export function useMySteps(tab: 'todo' | 'done') {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.mySteps(tab),
    queryFn: () =>
      tab === 'todo'
        ? api.call('steps.list', { query: { assignee: 'me', open: 'true', sort: 'dueAt', limit: 200 } })
        : api.call('steps.list', { query: { assignee: 'me', bucket: 'done', sort: '-completedAt', limit: 50 } }),
    refetchInterval: focused ? LIST_REFRESH_MS : false,
    refetchOnMount: 'always',
  });
  useRefetchOnFocus(query.refetch);

  // Tải sẵn chi tiết các việc cần làm: chạm thông báo mở nhanh hơn, và mất mạng vẫn đọc được chi tiết.
  const items = tab === 'todo' ? query.data?.items : undefined;
  useEffect(() => {
    const runs = new Set<string>();
    for (const step of (items ?? []).slice(0, DETAIL_PREFETCH_LIMIT)) {
      void queryClient.prefetchQuery({ queryKey: keys.step(step.id), queryFn: () => fetchStep(step.id), staleTime: DETAIL_PREFETCH_STALE_MS });
      // Thông tin và tệp của lượt cũng tải sẵn (việc giao riêng không có gì ngoài chính việc đó), để mất mạng vẫn đọc được.
      if (!step.adhoc && !runs.has(step.runId)) {
        runs.add(step.runId);
        void queryClient.prefetchQuery({ queryKey: keys.run(step.runId), queryFn: () => fetchRun(step.runId), staleTime: DETAIL_PREFETCH_STALE_MS });
      }
    }
  }, [items]);

  return query;
}

/**
 * Tab Đã xong: việc duyệt hoặc đóng góp mà mình đã gửi phần nhưng còn mở vì người khác chưa gửi. Máy chủ không trả loại việc này
 * ở `assignee=me`, nên lấy các việc duyệt đang mở mà mình thấy được rồi lọc những việc có phần của mình đã gửi (xem `awaitingOthers`).
 */
export function useAwaitingSteps(enabled: boolean) {
  const me = useMe();
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.awaitingSteps,
    queryFn: () => api.call('steps.list', { query: { kind: 'approval', open: 'true', sort: 'dueAt', limit: 200 } }),
    enabled,
    refetchInterval: focused && enabled ? LIST_REFRESH_MS : false,
    refetchOnMount: 'always',
  });
  const items = query.data?.items;
  const myId = me.data?.id;
  const waiting = useMemo(() => (items ? awaitingOthers(items, myId) : []), [items, myId]);
  return { query, items: waiting };
}

/** S8 Nhóm của tôi: việc đang mở của người dưới quyền. */
export function useTeamSteps(enabled: boolean) {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.teamSteps,
    queryFn: () => api.call('steps.list', { query: { scope: 'team', open: 'true', sort: 'dueAt', limit: 200 } }),
    enabled,
    refetchInterval: focused && enabled ? LIST_REFRESH_MS : false,
    refetchOnMount: 'always',
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** S2 Chi tiết việc. Khi chưa có bản chi tiết, hiện tạm phần chung lấy từ danh sách đã tải. */
export function useStep(id: string | undefined) {
  const query = useQuery({
    queryKey: keys.step(id ?? ''),
    queryFn: () => fetchStep(id ?? ''),
    enabled: !!id,
    refetchOnMount: 'always',
    placeholderData: (): StepDetail | undefined => {
      const cached = id ? findCachedStep(id) : undefined;
      return cached ? { ...cached, history: [], openNudge: null, nudges: [] } : undefined;
    },
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/**
 * Lượt chạy của một việc (`GET /v1/runs/:id`): dữ liệu khởi chạy, kết quả các việc đã xong và mọi tệp đính kèm của lượt.
 * Máy chủ chỉ trả lượt mà người này thấy được. Việc giao riêng không cần gọi (`enabled = false`).
 */
export function useRun(runId: string | undefined, enabled = true) {
  return useQuery({ queryKey: keys.run(runId ?? ''), queryFn: () => fetchRun(runId ?? ''), enabled: !!runId && enabled });
}

/** Số lượng bình luận mỗi trang tải. */
const COMMENT_PAGE = 50;

/**
 * Thảo luận của một việc: `GET /v1/steps/:id/comments`, cũ nhất trước, tải thêm bằng `nextCursor`. Không ghi xuống đĩa và chỉ giữ vài phút
 * trong bộ nhớ (bình luận có thể thuộc lượt mật); luôn hỏi lại khi mở màn, và tự làm mới mỗi 60 giây khi màn đang mở.
 */
export function useStepComments(stepId: string) {
  const focused = useIsFocused();
  return useInfiniteQuery({
    queryKey: keys.comments(stepId),
    queryFn: ({ pageParam }) => api.call('steps.comments.list', { params: { id: stepId }, query: { limit: COMMENT_PAGE, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    gcTime: COMMENT_GC_MS,
    refetchOnMount: 'always',
    refetchInterval: focused ? LIST_REFRESH_MS : false,
  });
}

/**
 * Mức mật của lượt, CHỈ đọc từ bộ nhớ đệm (không gọi mạng, không tạo truy vấn): danh sách việc không tải thêm gì, lượt nào đã tải sẵn
 * (chi tiết việc, tải sẵn của "Cần làm") thì hiện huy hiệu "Mật". Đăng ký nghe bộ nhớ đệm nên huy hiệu hiện ngay khi lượt vừa tải xong.
 */
export function useCachedRunConfidentiality(runId: string | undefined, adhoc: boolean): 'normal' | 'restricted' | undefined {
  const read = () => (runId && !adhoc ? queryClient.getQueryData<RouteResponse<'runs.get'>>(keys.run(runId))?.confidentiality : undefined);
  return useSyncExternalStore((onChange) => queryClient.getQueryCache().subscribe(onChange), read, read);
}

export type NotificationPage = RouteResponse<'notifications.list'>;

/** S7 Thông báo: phân trang bằng `cursor`. */
export function useNotifications() {
  const focused = useIsFocused();
  const query = useInfiniteQuery({
    queryKey: keys.notifications,
    queryFn: ({ pageParam }) => api.call('notifications.list', { query: { limit: 30, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: focused ? LIST_REFRESH_MS : false,
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** Số tin chưa đọc cho huy hiệu trên thanh điều hướng. */
export function useUnreadCount(): number {
  const query = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.call('notifications.list', { query: { limit: 1, unread: 'true' } }),
    refetchInterval: HEARTBEAT_MS,
  });
  return query.data?.unreadCount ?? 0;
}

/** Ngày nghỉ của một năm (`GET /v1/holidays?year=`, mọi người dùng gọi được). Ít đổi nên giữ lâu. */
function useHolidays(year: number) {
  return useQuery({ queryKey: keys.holidays(year), queryFn: () => api.call('holidays.list', { query: { year } }), staleTime: 6 * 60 * 60_000 });
}

/**
 * Lịch làm việc để lưới ngày làm mờ ngày nghỉ: ngày làm việc trong tuần từ `me.calendar`, ngày lễ và ngày làm bù
 * của năm nay và năm sau. Chưa tải được (hoặc bản lưu `me` còn theo dạng cũ) thì trả null: lưới ngày không làm mờ gì,
 * máy chủ vẫn là nơi quyết định cuối cùng.
 */
export function useWorkCalendar(year: number): WorkCalendar | null {
  const me = useMe();
  const thisYear = useHolidays(year);
  const nextYear = useHolidays(year + 1);
  const calendar = me.data?.calendar;
  const a = thisYear.data?.items;
  const b = nextYear.data?.items;
  return useMemo(() => (calendar ? workCalendarOf(calendar, [...(a ?? []), ...(b ?? [])]) : null), [calendar, a, b]);
}

export function useDelegations(enabled: boolean) {
  return useQuery({ queryKey: keys.delegations, queryFn: () => api.call('delegations.list', {}), enabled });
}

/** Những người nhận được việc này khi giao lại: việc trong quy trình chỉ về người được bổ nhiệm (`POST /v1/steps/assignees`). */
export function useStepAssignees(stepId: string) {
  return useQuery({
    queryKey: keys.assignees(stepId),
    queryFn: () => api.call('steps.assignees', { body: { stepIds: [stepId] } }),
    // Ủy quyền vừa tạo hay vừa gỡ phải có hiệu lực ngay ở lần mở sau: không giữ kết quả cũ.
    staleTime: 0,
    gcTime: 0,
  });
}

/** Tìm người theo tên, không phân biệt dấu (`GET /v1/people`). */
export function usePeopleSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.people(q),
    queryFn: () => api.call('people.search', { query: { q, limit: 20 } }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
