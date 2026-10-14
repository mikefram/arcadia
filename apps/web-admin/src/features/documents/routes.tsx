import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';

/** Sổ văn bản: số, ngày, trích yếu của văn bản đến, văn bản đi và chỉ thị. Xem nội dung cần `document.view`; người chỉ có `org.settings` vào để cấu hình sổ. */
const documentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/so-van-ban',
  beforeLoad: requireAny(['document.view', 'org.settings']),
  component: lazyRouteComponent(() => import('./documents-page'), 'DocumentsPage'),
});

export const documentsRoutes = [documentsRoute] as const;
