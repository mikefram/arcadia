import { useId, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { CirclePlay, Download, Plus, Search } from 'lucide-react';
import { RUN_STATES, TEMPLATE_VIEW_ACTIONS, type RunStateName, type RunSummary } from '@mihato/domain';
import { fmt, formatDate, formatProgress, formatTime, vi, vnParts, WEEKDAYS } from '@mihato/i18n';
import { ConfidentialBadge } from '@/components/confidential-badge';
import { PersonName } from '@/components/person-name';
import { RunProgress } from '@/components/run-progress';
import { RunStatusChip } from '@/components/status-chip';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DataTable } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { UnitSelect } from '@/components/unit-select';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/csv';
import { vnToday } from '@/lib/datetime';
import { sortByVi } from '@/lib/collator';
import { errorMessage } from '@/lib/errors';
import { useDebouncedValue } from '@/lib/hooks';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/query';
import { fetchAllRuns, RUN_CSV_COLUMNS, type RunExportQuery } from './run-export';

const t = vi.admin.runs.list;
const runId = (r: RunSummary) => r.id;

type RunSort = '-startedAt' | 'startedAt' | 'targetAt' | '-targetAt';

/** Trạng thái sắp xếp của bảng → tham số `sort` của `runs.list`. Bỏ sắp xếp thì về mới bắt đầu trước. */
function toSort(sorting: SortingState): RunSort {
  const first = sorting[0];
  if (first?.id === 'targetAt') return first.desc ? '-targetAt' : 'targetAt';
  if (first?.id === 'startedAt') return first.desc ? '-startedAt' : 'startedAt';
  return '-startedAt';
}

/** Dòng "Đúng tiến độ" hoặc "Chậm n ngày làm việc" dưới thanh tiến độ (SPEC 10.5). */
export function ScheduleLine({ run, className }: { run: Pick<RunSummary, 'state' | 'schedule'>; className?: string }) {
  if (run.state !== 'running') return null;
  const { status, lateWorkingDays } = run.schedule;
  if (status === 'late') {
    return (
      <span className={cn('text-sm font-medium text-late', className)}>
        {lateWorkingDays > 0 ? fmt(vi.common.schedule.late, { n: lateWorkingDays }) : vi.common.schedule.lateToday}
      </span>
    );
  }
  return <span className={cn('text-sm text-ink-sub', className)}>{status === 'done' ? vi.common.schedule.done : vi.common.schedule.on_track}</span>;
}

/**
 * Tiến độ của một lượt chạy. Lượt đã huỷ chỉ ghi số việc đã xong bằng chữ: máy chủ không còn tính các việc bị huỷ
 * vào tổng, nên thanh tiến độ đầy sẽ dễ bị hiểu là lượt chạy hoàn tất.
 */
export function RunProgressCell({ run, className }: { run: Pick<RunSummary, 'state' | 'progress' | 'schedule'>; className?: string }) {
  if (run.state === 'cancelled') return <span className={cn('tabular text-sm text-ink-sub', className)}>{formatProgress(run.progress.done, run.progress.total)}</span>;
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <RunProgress done={run.progress.done} total={run.progress.total} late={run.state === 'running' && run.schedule.status === 'late'} />
      <ScheduleLine run={run} />
    </div>
  );
}

const columns: ColumnDef<RunSummary>[] = [
  {
    id: 'title',
    header: t.colTitle,
    enableSorting: false,
    cell: ({ row }) => (
      <>
        <Link
          to="/luot-chay/$runId"
          params={{ runId: row.original.id }}
          className="rounded-sm font-medium text-ink underline decoration-transparent underline-offset-4 transition-colors hover:text-primary hover:decoration-primary"
        >
          {row.original.title}
        </Link>
        <ConfidentialBadge confidentiality={row.original.confidentiality} className="ml-2 align-middle" />
        <p className="truncate text-sm text-ink-sub" title={row.original.adhoc ? t.adhoc : row.original.templateName}>
          {row.original.adhoc ? t.adhoc : row.original.templateName}
        </p>
      </>
    ),
  },
  {
    id: 'state',
    header: t.colState,
    enableSorting: false,
    meta: { className: 'w-[128px]' },
    cell: ({ row }) => <RunStatusChip run={row.original} />,
  },
  {
    id: 'progress',
    header: t.colProgress,
    enableSorting: false,
    meta: { className: 'w-[180px]' },
    cell: ({ row }) => <RunProgressCell run={row.original} />,
  },
  {
    id: 'targetAt',
    accessorFn: (r) => r.targetAt ?? '',
    header: t.colTarget,
    meta: { className: 'w-[116px]' },
    cell: ({ row }) =>
      row.original.targetAt ? (
        // Mốc đích là một ngày (đầu ngày theo giờ Việt Nam), không kèm giờ.
        <time dateTime={row.original.targetAt} className="tabular flex flex-col">
          <span>{formatDate(row.original.targetAt)}</span>
          <span className="text-sm text-ink-sub">{WEEKDAYS[vnParts(row.original.targetAt).weekday]}</span>
        </time>
      ) : (
        <span className="text-ink-sub">{t.noTarget}</span>
      ),
  },
  {
    id: 'initiator',
    header: t.colInitiator,
    enableSorting: false,
    meta: { className: 'w-[164px]' },
    cell: ({ row }) => <PersonName person={row.original.initiator} />,
  },
  {
    id: 'startedAt',
    accessorFn: (r) => r.startedAt ?? '',
    header: t.colStarted,
    meta: { className: 'w-[132px]' },
    cell: ({ row }) =>
      row.original.startedAt ? (
        <time dateTime={row.original.startedAt} className="tabular flex flex-col">
          <span>{formatDate(row.original.startedAt)}</span>
          <span className="text-sm text-ink-sub">{formatTime(row.original.startedAt)}</span>
        </time>
      ) : (
        <span className="text-ink-sub">{t.notStarted}</span>
      ),
  },
];

const STATE_OPTIONS = RUN_STATES.map((state) => ({ value: state, label: vi.common.runState[state] }));

function isRunState(v: string | null): v is RunStateName {
  return v !== null && (RUN_STATES as readonly string[]).includes(v);
}

/**
 * Lượt chạy (SPEC 9.2): bảng `runs.list` với lọc trạng thái, quy trình, đơn vị, chỉ lượt đang chậm, tìm theo tên;
 * sắp theo mốc đích hoặc ngày bắt đầu (máy chủ sắp); "Tải thêm". Tự làm mới khi có sự kiện SSE.
 */
export function RunsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const lateId = useId();
  const [q, setQ] = useState('');
  const [state, setState] = useState<RunStateName | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [lateOnly, setLateOnly] = useState(false);
  const [kind, setKind] = useState<'process' | 'adhoc' | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'startedAt', desc: true }]);
  const search = useDebouncedValue(q.trim(), 300);

  const filterQuery: RunExportQuery = {
    sort: toSort(sorting),
    state: state ?? undefined,
    templateId: templateId ?? undefined,
    unitId: unitId ?? undefined,
    late: lateOnly ? true : undefined,
    adhoc: kind === null ? undefined : kind === 'adhoc',
    q: search || undefined,
  };
  const runs = useApiInfiniteQuery('runs.list', { query: { limit: 50, ...filterQuery } });

  // Xuất CSV: tải mọi trang theo bộ lọc đang chọn, không chỉ các dòng đã hiện (docs/DECISIONS.md, 07/10/2026).
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { items, capped } = await fetchAllRuns(filterQuery);
      if (items.length === 0) {
        toast.info(vi.admin.documents.runsExport.empty);
        return;
      }
      downloadCsv(`${vi.admin.documents.runsExport.fileName}-${vnToday()}`, items, RUN_CSV_COLUMNS);
      toast.success(fmt(vi.admin.documents.runsExport.done, { n: items.length }), capped ? { description: fmt(vi.admin.documents.runsExport.capped, { n: items.length }) } : undefined);
    } catch (err) {
      toast.error(vi.admin.documents.runsExport.failed, { description: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  const canSeeTemplates = can(TEMPLATE_VIEW_ACTIONS);
  const templates = useApiQuery('templates.list', { query: {} }, { enabled: canSeeTemplates, staleTime: 60_000 });
  const templateOptions = useMemo(() => sortByVi(templates.data?.items ?? [], (tpl) => tpl.name).map((tpl) => ({ value: tpl.id, label: tpl.name })), [templates.data]);

  const filtered = search !== '' || state !== null || templateId !== null || unitId !== null || lateOnly || kind !== null;
  const clearFilters = () => {
    setQ('');
    setState(null);
    setTemplateId(null);
    setUnitId(null);
    setLateOnly(false);
    setKind(null);
  };

  const startButton = can('run.start') ? (
    <Button asChild variant="primary">
      <Link to="/luot-chay/moi">
        <Plus aria-hidden="true" />
        {t.start}
      </Link>
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader className="mb-1" title={t.title} description={t.description} actions={startButton} />

      <div role="group" aria-label={t.filters} className="flex flex-col gap-2">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub" />
            <Input type="search" aria-label={t.search} placeholder={t.searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Select aria-label={t.filterState} value={state} onValueChange={(v) => setState(isRunState(v) ? v : null)} options={STATE_OPTIONS} emptyOption={t.allStates} />
          {canSeeTemplates ? <Select aria-label={t.filterTemplate} value={templateId} onValueChange={setTemplateId} options={templateOptions} emptyOption={t.allTemplates} /> : null}
          <Select
            aria-label={t.filterKind}
            value={kind}
            onValueChange={(v) => setKind(v === 'process' || v === 'adhoc' ? v : null)}
            options={[
              { value: 'process', label: t.kindProcess },
              { value: 'adhoc', label: t.kindAdhoc },
            ]}
            emptyOption={t.allKinds}
          />
          <UnitSelect allowAll aria-label={t.filterUnit} value={unitId} onValueChange={setUnitId} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5">
            <Switch id={lateId} checked={lateOnly} onCheckedChange={setLateOnly} />
            <label htmlFor={lateId} className="font-medium">
              {t.lateOnly}
            </label>
          </div>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t.clearFilters}
            </Button>
          ) : null}
          <Button size="sm" className="ml-auto" loading={exporting} onClick={() => void exportCsv()} data-testid="runs-export">
            {exporting ? null : <Download aria-hidden="true" />}
            {exporting ? vi.admin.documents.runsExport.exporting : vi.admin.documents.runsExport.button}
          </Button>
        </div>
      </div>

      {runs.isError ? (
        <Callout
          tone="error"
          title={vi.admin.shell.ui.loadFailedTitle}
          action={
            <Button size="sm" onClick={() => void runs.refetch()}>
              {vi.admin.shell.ui.retry}
            </Button>
          }
        >
          {errorMessage(runs.error)}
        </Callout>
      ) : (
        <DataTable
          caption={t.caption}
          tableClassName="min-w-[940px] table-fixed"
          columns={columns}
          data={runs.items}
          getRowId={runId}
          sorting={sorting}
          onSortingChange={setSorting}
          manualSorting
          isLoading={runs.isPending}
          hasMore={runs.hasNextPage}
          onLoadMore={() => void runs.fetchNextPage()}
          isLoadingMore={runs.isFetchingNextPage}
          onRowClick={(run) => void navigate({ to: '/luot-chay/$runId', params: { runId: run.id } })}
          empty={
            filtered ? (
              <EmptyState title={t.emptyFilteredTitle} description={t.emptyFilteredBody} action={<Button onClick={clearFilters}>{t.clearFilters}</Button>} />
            ) : (
              <EmptyState icon={CirclePlay} title={t.emptyTitle} description={can('run.start') ? t.emptyBody : undefined} action={startButton} />
            )
          }
        />
      )}
    </div>
  );
}
