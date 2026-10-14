import { Link } from '@tanstack/react-router';
import type { ActivityItem } from '@mihato/domain';
import { formatDate, formatTime, vi } from '@mihato/i18n';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/lib/auth';
import { vnDayDiff } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { useApiQuery } from '@/lib/query';
import { describeEvent } from '@/lib/timeline';

const t = vi.admin.shell.overview.activity;

function when(at: string): string {
  const diff = vnDayDiff(at);
  if (diff === 0) return formatTime(at);
  if (diff === -1) return `${vi.admin.shell.due.yesterday} ${formatTime(at)}`;
  return `${formatDate(at)} ${formatTime(at)}`;
}

function ActivityRow({ item, linkRun }: { item: ActivityItem; linkRun: boolean }) {
  const text = describeEvent(item);
  return (
    <li className="px-5 py-2.5">
      <p>
        <span className="font-semibold">{text.actor}</span> {text.action}
        {text.stepTitle ? <span className="font-medium"> {text.stepTitle}</span> : null}
        {text.tail ? ` ${text.tail}` : null}
      </p>
      <p className="mt-0.5 flex items-baseline justify-between gap-3 text-sm text-ink-sub">
        {linkRun ? (
          <Link to="/luot-chay/$runId" params={{ runId: item.runId }} className="min-w-0 truncate rounded-sm underline decoration-hairline underline-offset-4 hover:text-primary hover:decoration-primary">
            {item.runTitle}
          </Link>
        ) : (
          <span className="min-w-0 truncate">{item.runTitle}</span>
        )}
        <time dateTime={item.at} className="tabular shrink-0">
          {when(item.at)}
        </time>
      </p>
    </li>
  );
}

/** Hoạt động gần đây (`activity.list`): câu chữ dựng từ `type` và `payload` của sự kiện. Tự làm mới qua SSE. */
export function RecentActivity() {
  const can = useCan();
  const activity = useApiQuery('activity.list', { query: { limit: 30 } });
  const items = activity.data?.items ?? [];
  return (
    <Card aria-labelledby="hoat-dong-gan-day" className="min-w-0 self-start overflow-hidden">
      <CardHeader className="border-b border-hairline pb-3">
        <CardTitle id="hoat-dong-gan-day">{t.title}</CardTitle>
      </CardHeader>
      {activity.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-4 px-5 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton className="h-5 w-full" />
              <Skeleton className="mt-1.5 h-4 w-2/3" />
            </div>
          ))}
        </div>
      ) : activity.isError ? (
        <p className="px-5 py-4 text-ink-sub">{errorMessage(activity.error)}</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-4 text-ink-sub">{t.empty}</p>
      ) : (
        <ul className="max-h-[38rem] divide-y divide-hairline overflow-y-auto">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} linkRun={can('run.view_all')} />
          ))}
        </ul>
      )}
    </Card>
  );
}
