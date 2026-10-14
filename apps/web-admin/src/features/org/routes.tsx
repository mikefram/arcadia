import { createRoute, lazyRouteComponent, redirect } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';
import { cachedMe, meCan } from '@/lib/auth';
import { ORG_ACTIONS, ORG_TABS } from './tabs';

/**
 * Người dùng và tổ chức (SPEC 9.2, 9.5). Mỗi tab là một route con, gác bằng đúng quyền của tab đó:
 *   /to-chuc/nguoi-dung  user.manage        /to-chuc/don-vi     unit.manage
 *   /to-chuc/uy-quyen    delegation.manage  /to-chuc/ngay-nghi  holiday.manage
 *   /to-chuc/phan-quyen  permission.manage
 */
const orgRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/to-chuc',
  beforeLoad: requireAny(ORG_ACTIONS),
  component: lazyRouteComponent(() => import('./org-layout'), 'OrgLayout'),
});

/** /to-chuc: chuyển tới tab đầu tiên mà người dùng có quyền. */
const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  beforeLoad: (): void => {
    const me = cachedMe();
    const first = ORG_TABS.find((tab) => meCan(me, tab.action));
    throw redirect({ to: first?.to ?? '/viec-cua-toi', replace: true });
  },
});

const usersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'nguoi-dung',
  beforeLoad: requireAny(['user.manage']),
  component: lazyRouteComponent(() => import('./users-tab'), 'UsersTab'),
});

const unitsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'don-vi',
  beforeLoad: requireAny(['unit.manage']),
  component: lazyRouteComponent(() => import('./units-tab'), 'UnitsTab'),
});

const delegationsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'uy-quyen',
  beforeLoad: requireAny(['delegation.manage']),
  component: lazyRouteComponent(() => import('./delegations-tab'), 'DelegationsTab'),
});

const holidaysRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'ngay-nghi',
  beforeLoad: requireAny(['holiday.manage']),
  component: lazyRouteComponent(() => import('./holidays-tab'), 'HolidaysTab'),
});

const permissionsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'phan-quyen',
  beforeLoad: requireAny(['permission.manage']),
  component: lazyRouteComponent(() => import('./permissions-tab'), 'PermissionsTab'),
});

export const orgRoutes = [orgRoute.addChildren([orgIndexRoute, usersRoute, unitsRoute, delegationsRoute, holidaysRoute, permissionsRoute])] as const;
