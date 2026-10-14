import { useEffect, useId, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDownUp, Bot, Cog } from 'lucide-react';
import type { RunEventView } from '@mihato/domain';
import { fmt, formatDateTime, formatDateWeekday, formatTime, vi, vnDateKey } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { vnDayDiff } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { describeChanges, describeEvent, eventNote } from '@/lib/timeline';

const t = vi.admin.runs.detail.timeline;
const PAGE_SIZE = 100;

type EventsPage = { items: RunEventView[]; nextSeq: number | null };

/**
 * `runs.events` phân trang theo `seq` tăng dần (`afterSeq`). Khoá truy vấn bắt đầu bằng 'runs.events'
 * nên được làm mới cùng các truy vấn khác khi có sự kiện SSE.
 */
function useRunEvents(runId: string) {
  return useInfiniteQuery<EventsPage, Error, { pages: EventsPage[] }, readonly ['runs.events', { runId: string }, 'pages'], number | undefined>({
    queryKey: ['runs.events', { runId }, 'pages'] as const,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => api.call('runs.events', { params: { id: runId }, query: { limit: PAGE_SIZE, afterSeq: pageParam } }, { signal }),
    getNextPageParam: (last) => last.nextSeq ?? undefined,
  });
}

function dayLabel(at: string): string {
  const diff = vnDayDiff(at);
  if (diff === 0) return vi.admin.shell.due.today;
  if (diff === -1) return vi.admin.shell.due.yesterday;
  return formatDateWeekday(at);
}

function EventRow({ event }: { event: RunEventView }) {
  const text = describeEvent(event);
  const changes = describeChanges(event);
  const note = eventNote(event);
  const system = event.actorType === 'system';
  return (
    <li className="relative grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-5 py-2.5">
      <time dateTime={event.at} title={formatDateTime(event.at)} className="tabular pt-px text-sm text-ink-sub">
        {formatTime(event.at)}
      </time>
      <div className="min-w-0">
        <p className={cn(system && 'text-ink-sub')}>
          {/* Sự kiện do Trợ lý AI thực hiện: câu đã ghi "qua Trợ lý AI", thêm hình để dễ nhận ra khi lướt. */}
          {event.actorType === 'ai' ? <Bot aria-hidden="true" className="mr-1.5 inline size-4 align-[-3px] text-gold" /> : null}
          <span className={cn('font-semibold', system ? 'font-medium' : 'text-ink')}>{text.actor}</span> {text.action}
          {text.stepTitle ? <span className={cn('font-medium', !system && 'text-ink')}> {text.stepTitle}</span> : null}
          {text.tail ? ` ${text.tail}` : null}
        </p>
        {note ? <blockquote className="mt-1.5 border-l-2 border-line pl-3 whitespace-pre-line text-ink">{note}</blockquote> : null}
        {changes.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-sm text-ink-sub">
            {changes.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Dòng thời gian của lượt chạy từ `runs.events` (SPEC 9.2). Câu chính dựng bằng `describeEvent`,
 * các thay đổi kéo theo (giao việc kế, đổi hạn, kết thúc lượt chạy) bằng `vi.timeline`.
 * Sự kiện do Trợ lý AI thực hiện ghi rõ "qua Trợ lý AI". Trang sau được tải nối tiếp theo `seq`.
 */
export function RunTimeline({ runId }: { runId: string }) {
  const events = useRunEvents(runId);
  const [newestFirst, setNewestFirst] = useState(true);
  const [hideReminders, setHideReminders] = useState(false);
  const switchId = useId();

  // Xem "mới nhất ở trên" cần đủ mọi trang: tải nối tiếp các trang còn lại (mỗi trang 100 sự kiện).
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = events;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const all = useMemo(() => (events.data?.pages ?? []).flatMap((p) => p.items), [events.data]);
  const reminderCount = all.filter((e) => e.type === 'TimerFired').length;

  const days = useMemo(() => {
    const shown = hideReminders ? all.filter((e) => e.type !== 'TimerFired') : all;
    const ordered = newestFirst ? [...shown].reverse() : shown;
    const groups: { key: string; at: string; items: RunEventView[] }[] = [];
    for (const event of ordered) {
      const key = vnDateKey(event.at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(event);
      else groups.push({ key, at: event.at, items: [event] });
    }
    return groups;
  }, [all, newestFirst, hideReminders]);

  return (
    <Card aria-labelledby="luot-chay-dong-thoi-gian" className="min-w-0 overflow-hidden">
      <CardHeader className="items-center border-b border-hairline">
        <div className="flex items-baseline gap-3">
          <CardTitle id="luot-chay-dong-thoi-gian">{t.title}</CardTitle>
          {events.isSuccess ? <span className="text-sm text-ink-sub">{fmt(t.count, { n: all.length })}</span> : null}
        </div>
        <Button variant="ghost" size="sm" aria-label={`${t.order}: ${newestFirst ? t.newestFirst : t.oldestFirst}`} onClick={() => setNewestFirst((v) => !v)}>
          <ArrowDownUp aria-hidden="true" />
          {newestFirst ? t.newestFirst : t.oldestFirst}
        </Button>
      </CardHeader>

      {reminderCount > 0 ? (
        <div className="flex items-center gap-2.5 border-b border-hairline bg-canvas px-5 py-2">
          <Switch id={switchId} checked={hideReminders} onCheckedChange={setHideReminders} />
          <label htmlFor={switchId} className="inline-flex items-center gap-1.5 text-sm">
            <Cog aria-hidden="true" className="size-3.5 text-ink-sub" />
            {t.hideReminders} ({reminderCount})
          </label>
        </div>
      ) : null}

      {events.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-4 px-5 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton className="h-5 w-full" />
              <Skeleton className="mt-1.5 h-4 w-2/3" />
            </div>
          ))}
        </div>
      ) : events.isError && all.length === 0 ? (
        <p className="px-5 py-4 text-ink-sub">{errorMessage(events.error)}</p>
      ) : all.length === 0 ? (
        <p className="px-5 py-4 text-ink-sub">{t.empty}</p>
      ) : (
        <div className="max-h-[44rem] overflow-y-auto">
          {days.map((day) => (
            <section key={`${day.key}-${day.items[0]?.id ?? ''}`} aria-label={formatDateWeekday(day.at)}>
              <h3 className="sticky top-0 z-10 border-b border-hairline bg-surface-alt px-5 py-1.5 text-sm font-semibold text-ink-sub">
                <time dateTime={day.key}>{dayLabel(day.at)}</time>
              </h3>
              <ol className="divide-y divide-hairline">
                {day.items.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ol>
            </section>
          ))}
          {hasNextPage || isFetchingNextPage ? (
            <div className="flex justify-center border-t border-hairline bg-canvas px-4 py-2.5">
              {isError ? (
                <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
                  {t.loadMore}
                </Button>
              ) : (
                <Spinner label={t.loadingMore} showLabel />
              )}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
