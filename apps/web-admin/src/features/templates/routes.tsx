import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';
import { TEMPLATE_VIEW_ACTIONS } from '@mihato/domain';

/** Quy trình: danh sách mẫu và trình thiết kế. Agent "trình thiết kế quy trình" chỉ sửa trong thư mục này. */
const templatesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/quy-trinh',
  beforeLoad: requireAny(TEMPLATE_VIEW_ACTIONS),
  component: lazyRouteComponent(() => import('./templates-page'), 'TemplatesPage'),
});

/** `?phienBan=2`: xem phiên bản 2 đã xuất bản ở chế độ chỉ đọc. Bỏ trống: người vẽ mở bản đang sửa, người khác mở bản xuất bản mới nhất. */
export type TemplateDetailSearch = { phienBan?: number };

const templateDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/quy-trinh/$templateId',
  beforeLoad: requireAny(TEMPLATE_VIEW_ACTIONS),
  validateSearch: (search: Record<string, unknown>): TemplateDetailSearch => {
    const n = Number(search.phienBan);
    return Number.isInteger(n) && n > 0 ? { phienBan: n } : {};
  },
  component: lazyRouteComponent(() => import('./template-detail-page'), 'TemplateDetailPage'),
});

export const templatesRoutes = [templatesRoute, templateDetailRoute] as const;
