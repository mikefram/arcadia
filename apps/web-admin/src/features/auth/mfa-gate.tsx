import { lazy, Suspense, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import type { Me } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { markSignedOut } from '@/lib/auth';
import { personName } from '@/lib/person';
import { queryClient, useApiMutation } from '@/lib/query';
import { AuthLayout } from './auth-layout';

const t = vi.admin.shell.auth.mfaGate;

// Hộp thoại bật xác thực hai bước kéo theo thư viện vẽ mã QR: chỉ tải khi cần.
const TotpDialog = lazy(() => import('./totp-dialog').then((m) => ({ default: m.TotpDialog })));

/**
 * Màn thay cho cả ứng dụng khi máy chủ đang chặn phiên này (SPEC 11.2): vai trò bắt buộc xác thực hai bước mà
 * chưa bật. Chỉ có hai việc: bật xác thực hai bước, hoặc đăng xuất. Bật xong thì `me.get` được làm mới và
 * ứng dụng hiện ra.
 */
export function MfaGate({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const leave = async () => {
    markSignedOut();
    await navigate({ to: '/dang-nhap', search: {} });
    queryClient.clear();
  };
  const logout = useApiMutation('auth.logout', { toastError: false, onSettled: () => leave() });

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6" data-testid="mfa-gate">
        <span aria-hidden="true" className="inline-flex size-12 items-center justify-center rounded-full bg-primary-tint text-on-primary-tint">
          <ShieldCheck className="size-6" />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{t.title}</h1>
          <p className="text-ink-sub">{fmt(t.body, { tên: personName(me, 'short', true) })}</p>
          <p className="text-ink-sub">{t.hint}</p>
        </div>
        <div className="flex flex-col gap-3">
          <Button variant="primary" size="lg" onClick={() => setOpen(true)}>
            {t.enable}
          </Button>
          <Button variant="secondary" size="lg" loading={logout.isPending} onClick={() => logout.mutate({})}>
            {t.logout}
          </Button>
        </div>
      </div>
      {open ? (
        <Suspense fallback={null}>
          <TotpDialog open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </AuthLayout>
  );
}
