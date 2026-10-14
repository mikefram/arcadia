import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';

/** Tổng quan ở `/`. Người không có quyền `overview.view` được chuyển thẳng tới "Việc của tôi". */
const overviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  beforeLoad: requireAny(['overview.view'], { silent: true }),
  component: lazyRouteComponent(() => import('./overview-page'), 'OverviewPage'),
});

export const overviewRoutes = [overviewRoute] as const;
