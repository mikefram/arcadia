import { createRouter } from '@tanstack/react-router';
import { authRoutes } from '@/features/auth/routes';
import { documentsRoutes } from '@/features/documents/routes';
import { logsRoutes } from '@/features/logs/routes';
import { myTasksRoutes } from '@/features/my-tasks/routes';
import { orgRoutes } from '@/features/org/routes';
import { overviewRoutes } from '@/features/overview/routes';
import { reportsRoutes } from '@/features/reports/routes';
import { runsRoutes } from '@/features/runs/routes';
import { settingsRoutes } from '@/features/settings/routes';
import { tasksRoutes } from '@/features/tasks/routes';
import { templatesRoutes } from '@/features/templates/routes';
import { setUnauthenticatedHandler } from '@/lib/api';
import { markSignedOut } from '@/lib/auth';
import { queryClient } from '@/lib/query';
import { NotFoundPage, rootRoute, RouteErrorPage, RoutePending, shellRoute } from './root';

/**
 * Tệp này chỉ ghép cây route. Mỗi tính năng tự khai route trong `src/features/<tên>/routes.tsx`
 * và xuất một mảng; thêm màn hình mới thì sửa mảng đó, không sửa tệp này.
 */
const routeTree = rootRoute.addChildren([
  ...authRoutes,
  shellRoute.addChildren([
    ...overviewRoutes,
    ...myTasksRoutes,
    ...runsRoutes,
    ...tasksRoutes,
    ...templatesRoutes,
    ...documentsRoutes,
    ...reportsRoutes,
    ...orgRoutes,
    ...logsRoutes,
    ...settingsRoutes,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteErrorPage,
  defaultNotFoundComponent: NotFoundPage,
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const PUBLIC_PATHS = ['/dang-nhap', '/dat-mat-khau'];
let leaving = false;

/** 401 ở bất kỳ lời gọi nào: về /dang-nhap, nhớ đường dẫn đang mở, rồi xoá dữ liệu đã tải của phiên cũ. */
setUnauthenticatedHandler(() => {
  const { pathname, href } = router.state.location;
  if (leaving || PUBLIC_PATHS.includes(pathname)) return;
  leaving = true;
  markSignedOut();
  void router
    .navigate({ to: '/dang-nhap', search: { redirect: href } })
    .then(() => queryClient.clear())
    .finally(() => {
      leaving = false;
    });
});
