import { createRootRoute, createRoute, Link, Outlet, redirect, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { ApiError } from '@mihato/api-client';
import type { Action } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { toast, Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cachedMe, ensureMe, meCan } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { AppLayout } from './layout';

const t = vi.admin.shell;

function RootLayout() {
  return (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster />
    </TooltipProvider>
  );
}

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center">
      <EmptyState
        title={t.ui.notFoundTitle}
        description={t.ui.notFoundBody}
        action={
          <Button asChild variant="primary">
            <Link to="/">{t.ui.goHome}</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Lỗi khi tải một trang: nói bằng câu tiếng Việt theo mã lỗi, không hiện chi tiết kỹ thuật. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="flex min-h-[60dvh] items-center justify-center">
      <EmptyState
        title={t.ui.pageErrorTitle}
        description={errorMessage(error)}
        action={
          <Button
            variant="primary"
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            {t.ui.retry}
          </Button>
        }
      />
    </div>
  );
}

export function RoutePending() {
  return (
    <div className="flex min-h-[40dvh] items-center justify-center">
      <Spinner showLabel />
    </div>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteErrorPage,
});

/**
 * Bố cục đã đăng nhập (thanh bên, thanh trên). Mọi màn hình nghiệp vụ là con của route này:
 *   createRoute({ getParentRoute: () => shellRoute, path: '/luot-chay', … })
 * Chưa đăng nhập (401) thì về /dang-nhap và nhớ đường dẫn đang mở.
 */
export const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  beforeLoad: async ({ location }): Promise<void> => {
    try {
      await ensureMe();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw redirect({ to: '/dang-nhap', search: { redirect: location.href } });
      throw err;
    }
  },
  component: AppLayout,
});

/**
 * Bộ gác quyền cho `beforeLoad` của một route: thiếu quyền thì về "Việc của tôi".
 * Chỉ là tiện dụng trên giao diện; máy chủ vẫn kiểm quyền ở từng lời gọi (SPEC 9.1).
 *   beforeLoad: requireAny(['run.view_all'])
 */
export function requireAny(actions: readonly Action[], options: { silent?: boolean } = {}) {
  return (): void => {
    if (meCan(cachedMe(), actions)) return;
    if (!options.silent) toast.info(t.auth.noPermission);
    throw redirect({ to: '/viec-cua-toi' });
  };
}
