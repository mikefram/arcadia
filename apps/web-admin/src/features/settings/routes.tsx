import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/cai-dat',
  beforeLoad: requireAny(['org.settings']),
  component: lazyRouteComponent(() => import('./settings-page'), 'SettingsPage'),
});

export const settingsRoutes = [settingsRoute] as const;
