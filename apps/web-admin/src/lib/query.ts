import {
  QueryClient,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { ApiError, type CallOptions, type RouteArgs, type RouteKey, type RouteResponse } from '@mihato/api-client';
import { toast } from '@/components/ui/toast';
import { api } from './api';
import { errorMessage } from './errors';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Lỗi 4xx là câu trả lời dứt khoát của máy chủ: không thử lại. Lỗi mạng và 5xx thử thêm hai lần.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
    },
    mutations: { retry: false },
  },
});

/** Khoá truy vấn của mọi lời gọi API: [khoá route, tham số]. Làm mới theo tiền tố [khoá route]. */
export type ApiQueryKey<K extends RouteKey = RouteKey> = readonly [K, RouteArgs<K>];

export function apiKey<K extends RouteKey>(key: K, args: RouteArgs<K>): ApiQueryKey<K> {
  return [key, args] as const;
}

/** Hàm lấy dữ liệu cho queryClient.fetchQuery / ensureQueryData ở ngoài React (ví dụ trong beforeLoad). */
export function apiQueryOptions<K extends RouteKey>(key: K, args: RouteArgs<K>) {
  return {
    queryKey: apiKey(key, args),
    queryFn: ({ signal }: { signal: AbortSignal }) => api.call(key, args, { signal }),
  };
}

export type ApiQueryOptions<K extends RouteKey, TData = RouteResponse<K>> = Omit<
  UseQueryOptions<RouteResponse<K>, Error, TData, ApiQueryKey<K>>,
  'queryKey' | 'queryFn'
>;

/**
 * Đọc một route theo khoá trong bảng hợp đồng. Kiểu của `args` và của dữ liệu trả về suy từ khoá.
 *   const { data } = useApiQuery('runs.list', { query: { state: 'running' } });
 */
export function useApiQuery<K extends RouteKey, TData = RouteResponse<K>>(
  key: K,
  args: RouteArgs<K>,
  options?: ApiQueryOptions<K, TData>,
): UseQueryResult<TData, Error> {
  return useQuery({
    ...options,
    queryKey: apiKey(key, args),
    queryFn: ({ signal }) => api.call(key, args, { signal }),
  });
}

/** Các route trả `{ items, nextCursor }` và nhận `cursor` ở query (SPEC 10.1). */
export type PagedRouteKey = {
  [K in RouteKey]: RouteResponse<K> extends { items: readonly unknown[]; nextCursor: string | null } ? K : never;
}[RouteKey];

type PageItem<K extends PagedRouteKey> = RouteResponse<K> extends { items: readonly (infer I)[] } ? I : never;
/** Một trang: giữ cả các trường riêng của route (ví dụ `canComment` của bình luận), không chỉ items và nextCursor. */
type Page<K extends PagedRouteKey> = RouteResponse<K> & { items: PageItem<K>[]; nextCursor: string | null };

export type ApiInfiniteResult<K extends PagedRouteKey> = UseInfiniteQueryResult<InfiniteData<Page<K>, string | undefined>, Error> & {
  /** mọi dòng của các trang đã tải, nối lại */
  items: PageItem<K>[];
};

/**
 * Danh sách phân trang bằng con trỏ, dùng với nút "Tải thêm" của DataTable:
 *   const q = useApiInfiniteQuery('steps.list', { query: { late: true } });
 *   <DataTable data={q.items} hasMore={q.hasNextPage} onLoadMore={() => q.fetchNextPage()} isLoadingMore={q.isFetchingNextPage} />
 * Khoá truy vấn là [khoá route, tham số, 'pages'] nên vẫn được làm mới theo tiền tố [khoá route].
 * Đổi bộ lọc thì giữ danh sách cũ trên màn hình cho tới khi trang đầu mới về (không nháy khung chờ).
 */
export function useApiInfiniteQuery<K extends PagedRouteKey>(
  key: K,
  args: RouteArgs<K>,
  options?: { enabled?: boolean; staleTime?: number },
): ApiInfiniteResult<K> {
  const result = useInfiniteQuery<Page<K>, Error, InfiniteData<Page<K>, string | undefined>, readonly [K, RouteArgs<K>, 'pages'], string | undefined>({
    ...options,
    queryKey: [key, args, 'pages'] as const,
    placeholderData: keepPreviousData,
    initialPageParam: undefined,
    queryFn: async ({ pageParam, signal }) => {
      const base = args as { query?: Record<string, unknown> };
      const paged = { ...args, query: { ...base.query, cursor: pageParam } } as RouteArgs<K>;
      // Mọi route trong PagedRouteKey trả đúng dạng { items, nextCursor }; TypeScript không thu hẹp được kiểu có điều kiện theo K.
      const page: unknown = await api.call(key, paged, { signal });
      return page as Page<K>;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = (result.data?.pages ?? []).flatMap((page) => page.items);
  return Object.assign(result, { items });
}

export type ApiMutationOptions<K extends RouteKey> = Omit<UseMutationOptions<RouteResponse<K>, Error, RouteArgs<K>>, 'mutationFn'> & {
  /** Các khoá route cần làm mới sau khi ghi xong, ví dụ ['steps.list', 'overview.get']. */
  invalidate?: readonly RouteKey[];
  /** Mặc định true: lỗi hiện thành thông báo nổi bằng câu tiếng Việt. Đặt false khi màn hình tự hiện lỗi tại chỗ. */
  toastError?: boolean;
  /** Header kèm theo từng lần gọi, ví dụ `ifMatch` khi lưu nháp mẫu quy trình. */
  callOptions?: (args: RouteArgs<K>) => CallOptions;
};

/**
 * Ghi qua một route. Biến của `mutate` chính là tham số của route:
 *   const reassign = useApiMutation('steps.reassign', { invalidate: ['steps.list', 'overview.get'] });
 *   reassign.mutate({ params: { id }, body: { toUserId, reason } });
 */
export function useApiMutation<K extends RouteKey>(
  key: K,
  options: ApiMutationOptions<K> = {},
): UseMutationResult<RouteResponse<K>, Error, RouteArgs<K>> {
  const client = useQueryClient();
  const { invalidate, toastError = true, callOptions, onSuccess, onError, ...rest } = options;
  return useMutation<RouteResponse<K>, Error, RouteArgs<K>>({
    ...rest,
    mutationFn: (args) => api.call(key, args, callOptions?.(args)),
    onSuccess: (...params) => {
      for (const routeKey of invalidate ?? []) void client.invalidateQueries({ queryKey: [routeKey] });
      return onSuccess?.(...params);
    },
    onError: (...params) => {
      if (toastError) toast.error(errorMessage(params[0]));
      return onError?.(...params);
    },
  });
}

/** Làm mới mọi truy vấn của các route đã cho (dùng sau thao tác ghi tự viết, hoặc khi nhận 409). */
export function invalidateRoutes(keys: readonly RouteKey[]): void {
  for (const routeKey of keys) void queryClient.invalidateQueries({ queryKey: [routeKey] });
}
