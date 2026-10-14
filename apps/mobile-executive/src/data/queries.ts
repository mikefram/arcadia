import type { ProposalView } from '@mihato/domain';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { api, localProfile } from '../services';
import { PROGRESS_KEY } from './persist';

/** App không dùng SSE (SPEC 10.8): M1, M4, M5, M6 tự làm mới mỗi 60 giây khi màn đang mở. */
export const REFRESH_MS = 60_000;

export const keys = {
  me: ['me'] as const,
  overview: [PROGRESS_KEY, 'overview'] as const,
  runs: [PROGRESS_KEY, 'runs'] as const,
  run: (id: string) => [PROGRESS_KEY, 'run', id] as const,
  approvals: ['decisions', 'approvals'] as const,
  pendingProposals: ['decisions', 'proposals'] as const,
  proposalGroup: (id: string) => ['proposal', id] as const,
  briefing: ['briefing'] as const,
  delegations: ['delegations'] as const,
  people: ['people'] as const,
  templates: ['templates'] as const,
};

/** Làm mới khi quay lại màn (SPEC 10.8): màn đã dựng nằm yên trong chồng điều hướng nên phải tự tải lại lúc được mở lại. */
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

/** Hồ sơ của tôi. Mỗi lần tải được thì nhớ lại cách gọi, cỡ chữ, số Văn phòng để dùng ở màn khoá và lúc mất mạng. */
export function useMe(enabled = true) {
  const query = useQuery({ queryKey: keys.me, queryFn: () => api.call('me.get', {}), staleTime: 60_000, enabled });
  const me = query.data;
  useEffect(() => {
    if (me) void localProfile.rememberMe(me);
  }, [me]);
  return query;
}

/** Thẻ số tổng quan: số việc chờ quyết (M1) và mục "Cần Chủ tịch biết" (M4). */
export function useOverview() {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.overview,
    queryFn: () => api.call('overview.get', {}),
    refetchInterval: focused ? REFRESH_MS : false,
    refetchOnMount: 'always',
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** M4 Tiến độ: các lượt đang chạy, lượt chậm nhất và mới nhất trước. */
export function useRunningRuns() {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.runs,
    queryFn: () => api.call('runs.list', { query: { state: 'running', limit: 100 } }),
    refetchInterval: focused ? REFRESH_MS : false,
    refetchOnMount: 'always',
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** M5 Chi tiết lượt chạy. */
export function useRun(id: string | undefined) {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.run(id ?? ''),
    queryFn: () => api.call('runs.get', { params: { id: id ?? '' } }),
    enabled: !!id,
    refetchInterval: focused ? REFRESH_MS : false,
    refetchOnMount: 'always',
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** M6: việc loại duyệt đang chờ chính người dùng quyết. */
export function useApprovals() {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.approvals,
    queryFn: () => api.call('steps.list', { query: { assignee: 'me', kind: 'approval', open: 'true', sort: 'dueAt', limit: 100 } }),
    refetchInterval: focused ? REFRESH_MS : false,
    refetchOnMount: 'always',
    gcTime: 5 * 60_000,
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** M1 và M6: đề xuất đang chờ (của trợ lý và của Văn phòng trình). */
export function usePendingProposals() {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: keys.pendingProposals,
    queryFn: () => api.call('proposals.list', { query: { state: 'pending', limit: 100 } }),
    refetchInterval: focused ? REFRESH_MS : false,
    refetchOnMount: 'always',
    gcTime: 5 * 60_000,
  });
  useRefetchOnFocus(query.refetch);
  return query;
}

/**
 * M3: một đề xuất, hoặc cả lô của nó. Câu xác nhận lấy từ `summary` và `items[].text` do MÁY CHỦ dựng
 * (`GET /v1/proposals/:id`; lô: `proposals.list` với `batchId`), không lấy chữ từ `assistant.*`.
 */
export async function fetchProposalGroup(id: string): Promise<ProposalView[]> {
  const first = await api.call('proposals.get', { params: { id } });
  if (!first.batchId) return [first];
  const batch = await api.call('proposals.list', { query: { batchId: first.batchId, limit: 200 } });
  const items = batch.items.length > 0 ? batch.items : [first];
  // Thứ tự ổn định theo lúc tạo để màn hình không nhảy mục giữa hai lần tải.
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function useProposalGroup(id: string | undefined) {
  return useQuery({
    queryKey: keys.proposalGroup(id ?? ''),
    queryFn: () => fetchProposalGroup(id ?? ''),
    enabled: !!id,
    refetchOnMount: 'always',
    staleTime: 0,
    gcTime: 60_000,
  });
}

/** M1: bản tin sáng mới nhất; `null` khi chưa có. */
export function useBriefing() {
  const query = useQuery({ queryKey: keys.briefing, queryFn: () => api.call('briefings.latest', {}), refetchOnMount: 'always', gcTime: 5 * 60_000 });
  useRefetchOnFocus(query.refetch);
  return query;
}

/** Ủy quyền: người có thể nhận ủy quyền (tìm trong danh bạ). */
export function usePeople(enabled: boolean) {
  return useQuery({ queryKey: keys.people, queryFn: () => api.call('people.search', { query: { q: '', limit: 100 } }), enabled, staleTime: 5 * 60_000 });
}

/** Ủy quyền theo một quy trình: danh sách mẫu đang dùng. */
export function useTemplates(enabled: boolean) {
  return useQuery({ queryKey: keys.templates, queryFn: () => api.call('templates.list', { query: { archived: 'false' } }), enabled, staleTime: 5 * 60_000 });
}
