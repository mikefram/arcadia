import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CircleCheck, RotateCw } from 'lucide-react';
import type { EffectView } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { LoadError } from '@/features/org/shared';
import { useCan } from '@/lib/auth';
import { errorMessage, isApiError } from '@/lib/errors';
import { invalidateRoutes, useApiInfiniteQuery, useApiMutation } from '@/lib/query';

const t = vi.admin.org.logs.effects;
const effectId = (e: EffectView) => e.id;

const KIND_TEXT: Record<string, string> = t.kinds;
/** Tên tác vụ: loại con như `notify.nudge_reply` dùng tên của loại gốc `notify`. */
function kindLabel(kind: string): string {
  return KIND_TEXT[kind] ?? KIND_TEXT[kind.split('.')[0] ?? ''] ?? t.kindUnknown;
}

/**
 * Hàng effect ở trạng thái `dead` (`admin.effects`, SPEC 9.2): tác vụ nền đã thử đủ số lần mà chưa xong.
 * "Thử lại" (`admin.effectRetry`) đưa tác vụ về hàng chờ; khoá chống trùng giữ nguyên nên không gửi hai lần.
 */
export function EffectsTab() {
  const can = useCan();
  const canOpenRun = can('run.view_all');
  const [retrying, setRetrying] = useState<string | null>(null);
  const effects = useApiInfiniteQuery('admin.effects', { query: { state: 'dead', limit: 50 } }, { staleTime: 0 });
  const retry = useApiMutation('admin.effectRetry', {
    toastError: false,
    invalidate: ['admin.effects', 'admin.audit'],
    onSuccess: () => toast.success(t.retried),
    onError: (err) => {
      if (isApiError(err, 'state_conflict')) {
        invalidateRoutes(['admin.effects']);
        toast.info(t.conflict);
      } else toast.error(errorMessage(err));
    },
    onSettled: () => setRetrying(null),
  });
  const { mutate } = retry;

  const columns = useMemo<ColumnDef<EffectView>[]>(
    () => [
      {
        id: 'kind',
        header: t.col.kind,
        enableSorting: false,
        cell: ({ row: { original: e } }) => (
          <>
            <p className="font-medium">{kindLabel(e.kind)}</p>
            <p className="tabular truncate text-sm text-ink-sub" title={e.kind}>
              {e.kind}
            </p>
          </>
        ),
      },
      {
        id: 'attempts',
        header: t.col.attempts,
        enableSorting: false,
        meta: { align: 'right', className: 'w-[104px]' },
        cell: ({ row }) => <span className="tabular">{row.original.attempts}</span>,
      },
      {
        id: 'error',
        header: t.col.error,
        enableSorting: false,
        cell: ({ row: { original: e } }) =>
          e.lastError ? (
            <span className="tabular line-clamp-2 text-sm break-words" title={e.lastError}>
              {e.lastError}
            </span>
          ) : (
            <span className="text-ink-sub">{t.noError}</span>
          ),
      },
      {
        id: 'created',
        header: t.col.created,
        enableSorting: false,
        meta: { className: 'w-[148px]' },
        cell: ({ row }) => (
          <time dateTime={row.original.createdAt} className="tabular whitespace-nowrap">
            {formatDateTime(row.original.createdAt)}
          </time>
        ),
      },
      {
        id: 'run',
        header: t.col.run,
        enableSorting: false,
        meta: { className: 'w-[148px]' },
        cell: ({ row: { original: e } }) =>
          !e.runId ? (
            <span className="text-ink-sub">{t.noRun}</span>
          ) : canOpenRun ? (
            <Button asChild variant="link">
              <Link to="/luot-chay/$runId" params={{ runId: e.runId }}>
                {t.openRun}
              </Link>
            </Button>
          ) : (
            t.hasRun
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>,
        enableSorting: false,
        meta: { align: 'right', className: 'w-[116px]' },
        cell: ({ row: { original: e } }) => (
          <Button
            size="sm"
            loading={retrying === e.id}
            disabled={retrying !== null && retrying !== e.id}
            aria-label={fmt(t.retryFor, { tên: kindLabel(e.kind), giờ: formatDateTime(e.createdAt) })}
            onClick={() => {
              setRetrying(e.id);
              mutate({ params: { id: e.id } });
            }}
          >
            <RotateCw aria-hidden="true" />
            {t.retry}
          </Button>
        ),
      },
    ],
    [canOpenRun, retrying, mutate],
  );

  return (
    <section aria-labelledby="tab-tac-vu-loi" className="flex min-w-0 flex-col gap-3">
      <h2 id="tab-tac-vu-loi" className="sr-only">
        {vi.admin.org.logs.page.tabs.effects}
      </h2>
      <p className="max-w-[80ch] text-ink-sub">{t.intro}</p>
      {effects.isError ? (
        <LoadError error={effects.error} onRetry={() => void effects.refetch()} />
      ) : (
        <DataTable
          caption={t.caption}
          tableClassName="min-w-[900px] table-fixed"
          columns={columns}
          data={effects.items}
          getRowId={effectId}
          isLoading={effects.isPending}
          hasMore={effects.hasNextPage}
          onLoadMore={() => void effects.fetchNextPage()}
          isLoadingMore={effects.isFetchingNextPage}
          empty={<EmptyState icon={CircleCheck} title={t.empty.title} description={t.empty.body} />}
        />
      )}
    </section>
  );
}
