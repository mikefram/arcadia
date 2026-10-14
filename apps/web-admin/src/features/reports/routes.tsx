import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';

const reportsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/bao-cao',
  beforeLoad: requireAny(['report.view']),
  component: lazyRouteComponent(() => import('./reports-page'), 'ReportsPage'),
});

export const reportsRoutes = [reportsRoute] as const;
