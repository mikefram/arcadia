import type { ReactNode } from 'react';
import { formatDateFull, vi } from '@mihato/i18n';

const t = vi.admin.shell.auth;

/** Khung của các trang chưa đăng nhập: mảng xanh đậm mang tên hệ thống, bên cạnh là biểu mẫu. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-1">
      <aside data-on-dark className="flex flex-col justify-between gap-10 bg-primary-pressed px-6 py-5 text-canvas lg:px-14 lg:py-12">
        <div>
          <p className="text-xl font-semibold text-white">{vi.common.appName}</p>
          <div aria-hidden="true" className="mt-3 h-px w-9 bg-gold-tint" />
        </div>
        <div className="hidden lg:block">
          <p className="max-w-[13ch] text-[2.625rem] leading-[1.22] font-semibold text-balance text-white">{t.brandLine}</p>
          <p className="mt-6 max-w-[32ch] text-lg text-canvas/85">{t.brandNote}</p>
        </div>
        <p className="hidden text-base text-gold-tint lg:block">{formatDateFull(Date.now())}</p>
      </aside>
      <main className="flex items-start justify-center px-5 py-10 sm:items-center">
        <div className="w-full max-w-[380px]">{children}</div>
      </main>
    </div>
  );
}
