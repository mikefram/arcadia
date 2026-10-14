import { Link } from '@tanstack/react-router';
import { vi } from '@mihato/i18n';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useLiveStatus } from '@/lib/sse';
import { NAV_GROUPS } from './nav';

const t = vi.admin.shell;

function LiveIndicator() {
  const status = useLiveStatus();
  if (status === 'connecting') return <div className="h-11" />;
  const live = status === 'live';
  return (
    <p role="status" className="flex h-11 items-center gap-2 border-t border-white/12 px-5 text-sm text-canvas/85">
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', live ? 'bg-gold-tint' : 'border border-canvas/85')} />
      {live ? t.topbar.live : t.topbar.reconnecting}
    </p>
  );
}

/** Thanh bên trên nền xanh đậm. Dùng cho cả màn hình rộng (cố định) và điện thoại (trong bảng trượt). */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const can = useCan();
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((item) => !item.anyOf || can(item.anyOf)) })).filter((g) => g.items.length > 0);

  return (
    <div data-on-dark className="flex h-full flex-col bg-primary-pressed text-canvas">
      <div className="px-5 pt-5 pb-1">
        <p className="text-xl font-semibold text-white">{vi.common.appName}</p>
        <div aria-hidden="true" className="mt-3 h-px w-9 bg-gold-tint" />
      </div>
      <nav aria-label={t.nav.label} className="flex-1 overflow-y-auto px-3 pt-3 pb-4">
        {groups.map((group, gi) => (
          <div key={gi} role="group" aria-label={group.label}>
            {group.label ? <p className="px-3 pt-5 pb-1.5 text-sm text-gold-tint">{group.label}</p> : null}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    activeOptions={{ exact: item.to === '/' }}
                    onClick={onNavigate}
                    className="relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-base font-medium text-canvas/85 transition-colors hover:bg-white/8 hover:text-white data-[status=active]:bg-white/12 data-[status=active]:font-semibold data-[status=active]:text-white data-[status=active]:before:absolute data-[status=active]:before:inset-y-2 data-[status=active]:before:left-0 data-[status=active]:before:w-[3px] data-[status=active]:before:rounded-full data-[status=active]:before:bg-gold-tint"
                  >
                    <item.icon aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.75} />
                    <span className="leading-snug">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <LiveIndicator />
    </div>
  );
}
