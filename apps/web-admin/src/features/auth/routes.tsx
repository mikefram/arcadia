import { createRoute, redirect } from '@tanstack/react-router';
import { rootRoute } from '@/app/root';
import { cachedMe } from '@/lib/auth';
import { LoginPage } from './login-page';
import { PasswordSetPage } from './password-set-page';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** /dang-nhap?redirect=/duong-dan-cu&org=ma-to-chuc */
export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dang-nhap',
  validateSearch: (search: Record<string, unknown>): { redirect?: string; org?: string } => ({
    redirect: text(search.redirect),
    org: text(search.org),
  }),
  beforeLoad: (): void => {
    if (cachedMe()) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

/** /dat-mat-khau?token=… */
export const passwordSetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dat-mat-khau',
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({ token: text(search.token) }),
  component: PasswordSetPage,
});

export const authRoutes = [loginRoute, passwordSetRoute] as const;
