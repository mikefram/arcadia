import { createRoute, lazyRouteComponent, redirect } from '@tanstack/react-router';
import { requireAny, shellRoute } from '@/app/root';
import { cachedMe, meCan } from '@/lib/auth';
import { LOG_ACTIONS, LOG_TABS } from './tabs';

/**
 * Thông báo và nhật ký (SPEC 9.2). Mỗi tab là một route con, gác bằng đúng quyền của tab đó:
 *   /nhat-ky/hoat-dong   audit.view     /nhat-ky/thong-bao  notification.audit
 *   /nhat-ky/tac-vu-loi  effect.retry   /nhat-ky/tro-ly     ai_usage.view
 */
const logsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/nhat-ky',
  beforeLoad: requireAny(LOG_ACTIONS),
  component: lazyRouteComponent(() => import('./logs-layout'), 'LogsLayout'),
});

/** /nhat-ky: chuyển tới tab đầu tiên mà người dùng có quyền (Văn phòng chỉ có tab "Thông báo"). */
const logsIndexRoute = createRoute({
  getParentRoute: () => logsRoute,
  path: '/',
  beforeLoad: (): void => {
    const me = cachedMe();
    const first = LOG_TABS.find((tab) => meCan(me, tab.action));
    throw redirect({ to: first?.to ?? '/viec-cua-toi', replace: true });
  },
});

const auditRoute = createRoute({
  getParentRoute: () => logsRoute,
  path: 'hoat-dong',
  beforeLoad: requireAny(['audit.view']),
  component: lazyRouteComponent(() => import('./audit-tab'), 'AuditTab'),
});

const notificationsRoute = createRoute({
  getParentRoute: () => logsRoute,
  path: 'thong-bao',
  beforeLoad: requireAny(['notification.audit']),
  component: lazyRouteComponent(() => import('./notifications-tab'), 'NotificationsTab'),
});

const effectsRoute = createRoute({
  getParentRoute: () => logsRoute,
  path: 'tac-vu-loi',
  beforeLoad: requireAny(['effect.retry']),
  component: lazyRouteComponent(() => import('./effects-tab'), 'EffectsTab'),
});

const aiUsageRoute = createRoute({
  getParentRoute: () => logsRoute,
  path: 'tro-ly',
  beforeLoad: requireAny(['ai_usage.view']),
  component: lazyRouteComponent(() => import('./ai-usage-tab'), 'AiUsageTab'),
});

export const logsRoutes = [logsRoute.addChildren([logsIndexRoute, auditRoute, notificationsRoute, effectsRoute, aiUsageRoute])] as const;
