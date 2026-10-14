import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';

/** Lượt chạy: danh sách, khởi chạy mới, chi tiết. Agent "lượt chạy và công việc" chỉ sửa trong thư mục này. */
const runsListRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/luot-chay',
  beforeLoad: requireAny(['run.view_all']),
  component: lazyRouteComponent(() => import('./runs-page'), 'RunsPage'),
});

export type RunNewSearch = {
  /** chọn sẵn quy trình, ví dụ khi bấm "Khởi chạy" từ màn Quy trình */
  templateId?: string;
};

const runNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/luot-chay/moi',
  validateSearch: (search: Record<string, unknown>): RunNewSearch => (typeof search.templateId === 'string' && search.templateId ? { templateId: search.templateId } : {}),
  // Ai khởi chạy được quy trình nào do chính quy trình quy định (`canStart`); trang tự báo khi không có quy trình nào cho người này.
  component: lazyRouteComponent(() => import('./run-new-page'), 'RunNewPage'),
});

const runDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/luot-chay/$runId',
  beforeLoad: requireAny(['run.view_all']),
  component: lazyRouteComponent(() => import('./run-detail-page'), 'RunDetailPage'),
});

export const runsRoutes = [runsListRoute, runNewRoute, runDetailRoute] as const;
