import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { shellRoute } from '@/app/root';

export type MyTasksTab = 'todo' | 'done' | 'team';
export type MyTasksSearch = { tab?: Exclude<MyTasksTab, 'todo'> };

/** Việc của tôi: mọi người đã đăng nhập đều vào được; màn này phải dùng được trên điện thoại. */
const myTasksRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/viec-cua-toi',
  validateSearch: (search: Record<string, unknown>): MyTasksSearch => (search.tab === 'done' || search.tab === 'team' ? { tab: search.tab } : {}),
  component: lazyRouteComponent(() => import('./my-tasks-page'), 'MyTasksPage'),
});

/** Trang một việc: mô tả, danh sách kiểm, lịch sử và các nút theo `allowedActions`. Mở được từ đường dẫn trong thông báo. */
const myStepRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/viec-cua-toi/$stepId',
  component: lazyRouteComponent(() => import('./my-step-page'), 'MyStepPage'),
});

export const myTasksRoutes = [myTasksRoute, myStepRoute] as const;
