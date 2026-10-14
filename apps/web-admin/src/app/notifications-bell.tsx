import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Bell, CheckCheck } from 'lucide-react';
import type { NotificationView } from '@mihato/domain';
import { fmt, formatDateTime, formatTime, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { vnDayDiff } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { useApiMutation, useApiQuery } from '@/lib/query';

const t = vi.admin.shell.topbar;

function when(at: string): string {
  const diff = vnDayDiff(at);
  if (diff === 0) return `${vi.admin.shell.due.today} ${formatTime(at)}`;
  if (diff === -1) return `${vi.admin.shell.due.yesterday} ${formatTime(at)}`;
  return formatDateTime(at);
}

/** Chuông thông báo: tin của chính mình (`notifications.list`), số chưa đọc, đánh dấu đã đọc. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const can = useCan();
  const navigate = useNavigate();
  const list = useApiQuery('notifications.list', { query: { limit: 20 } }, { refetchInterval: 60_000 });
  const markRead = useApiMutation('notifications.read', { invalidate: ['notifications.list'], toastError: false });
  const markAll = useApiMutation('notifications.read', { invalidate: ['notifications.list'] });

  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.items ?? [];

  const openItem = (item: NotificationView) => {
    if (!item.readAt) markRead.mutate({ body: { ids: [item.id] } });
    setOpen(false);
    if (item.runId && can('run.view_all')) void navigate({ to: '/luot-chay/$runId', params: { runId: item.runId } });
    else void navigate({ to: '/viec-cua-toi' });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={unread > 0 ? fmt(t.notificationsUnread, { n: unread }) : t.notifications} className="relative">
          <Bell aria-hidden="true" className="size-5!" strokeWidth={1.75} />
          {unread > 0 ? (
            <Badge tone="count" aria-hidden="true" className="absolute top-1 right-0.5 h-[18px] min-w-[18px] px-1 text-[11px] leading-none ring-2 ring-canvas">
              {unread > 99 ? '99+' : unread}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[min(34rem,calc(100dvh-5rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-hairline py-2.5 pr-2.5 pl-4">
          <h2 className="text-lg font-semibold">{t.notifications}</h2>
          <Button variant="ghost" size="sm" disabled={unread === 0} loading={markAll.isPending} onClick={() => markAll.mutate({ body: { all: true } })}>
            <CheckCheck aria-hidden="true" />
            {t.markAllRead}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isPending ? (
            <div className="px-4 py-6">
              <Spinner showLabel />
            </div>
          ) : list.isError ? (
            <p className="px-4 py-6 text-ink-sub">{errorMessage(list.error)}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-ink-sub">{t.notificationsEmpty}</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id} className="border-b border-hairline last:border-b-0">
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left -outline-offset-2 transition-colors hover:bg-canvas"
                  >
                    <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', item.readAt ? 'bg-transparent' : 'bg-gold')} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block', item.readAt ? 'font-medium' : 'font-semibold')}>
                        {item.readAt ? null : <span className="sr-only">{t.unreadMark}: </span>}
                        {item.title}
                      </span>
                      {item.body ? <span className="mt-0.5 line-clamp-2 block text-sm text-ink-sub">{item.body}</span> : null}
                      <time dateTime={item.createdAt} className="tabular mt-1 block text-xs text-ink-sub">
                        {when(item.createdAt)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
