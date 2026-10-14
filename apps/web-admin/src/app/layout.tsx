import { lazy, Suspense, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { MfaGate } from '@/features/auth/mfa-gate';
import { useMe } from '@/lib/auth';
import { useLiveUpdates } from '@/lib/sse';
import { NotificationsBell } from './notifications-bell';
import { Sidebar } from './sidebar';
import { UserMenu } from './user-menu';

const t = vi.admin.shell;

// Hộp thoại bật xác thực hai bước kéo theo thư viện vẽ mã QR: chỉ tải khi cần.
const TotpDialog = lazy(() => import('@/features/auth/totp-dialog').then((m) => ({ default: m.TotpDialog })));

/**
 * Bố cục chính sau khi đăng nhập: thanh bên trái theo quyền, thanh trên (tên tổ chức, chuông, tài khoản),
 * vùng nội dung. Dưới 1024px thanh bên thu vào nút trình đơn để màn "Việc của tôi" dùng được trên điện thoại.
 */
export function AppLayout() {
  const me = useMe();
  const [navOpen, setNavOpen] = useState(false);
  const [totpOpen, setTotpOpen] = useState(false);
  // Máy chủ đang chặn phiên này cho tới khi bật xác thực hai bước (SPEC 11.2): không dựng ứng dụng, tránh một loạt lỗi 403.
  const blocked = me.mfaRequired && me.mfaEnforced;
  useLiveUpdates(!blocked);
  if (blocked) return <MfaGate me={me} />;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <a
        href="#noi-dung"
        className="sr-only z-[70] rounded-lg bg-primary px-4 py-2 font-semibold text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t.ui.skipToContent}
      </a>

      <aside className="sticky top-0 hidden h-dvh lg:block">
        <Sidebar />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-hairline bg-canvas/95 px-3 backdrop-blur-sm sm:px-5 lg:px-8">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t.nav.openMenu} className="lg:hidden">
                <Menu aria-hidden="true" className="size-5!" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" hideClose className="w-[272px] max-w-[85vw] border-r-0">
              <SheetTitle className="sr-only">{t.nav.label}</SheetTitle>
              <SheetDescription className="sr-only">{vi.common.appName}</SheetDescription>
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </SheetContent>
          </Sheet>
          <p className="min-w-0 flex-1 truncate text-lg font-semibold">{me.orgName}</p>
          <NotificationsBell />
          <UserMenu onEnableTotp={() => setTotpOpen(true)} />
        </header>

        <main id="noi-dung" tabIndex={-1} className="flex-1 px-4 pt-5 pb-12 outline-none sm:px-5 lg:px-8 lg:pt-6">
          {me.mfaRequired && !me.mfaEnabled ? (
            <Callout
              tone="warn"
              title={t.auth.mfaReminder.title}
              className="mb-5"
              action={
                <Button size="sm" variant="secondary" onClick={() => setTotpOpen(true)}>
                  {t.auth.mfaReminder.action}
                </Button>
              }
            >
              {t.auth.mfaReminder.body}
            </Callout>
          ) : null}
          <Outlet />
        </main>
      </div>

      {totpOpen ? (
        <Suspense fallback={null}>
          <TotpDialog open={totpOpen} onOpenChange={setTotpOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
