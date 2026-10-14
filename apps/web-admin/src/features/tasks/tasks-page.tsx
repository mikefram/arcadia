import { useId, useMemo, useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import { CalendarClock, Download, Hand, ListTodo, Plus, Search, Stamp, UserRoundPlus, UserRoundX } from 'lucide-react';
import { STEP_STATES, type Bucket, type StepStateName, type StepView } from '@mihato/domain';
import { fmt, formatDate, formatDateTime, formatTime, vi } from '@mihato/i18n';
import { DueLabel } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { StatusChip } from '@/components/status-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DataTable, selectedRows } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { UnitSelect } from '@/components/unit-select';
import { allows, BulkStepActions, GiveTaskDialog, ReassignDialog, StepActionsMenu, StepDispatchProvider } from '@/features/dispatch';
import { StepDetailSheet } from '@/features/runs/step-detail-sheet';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { sortByVi } from '@/lib/collator';
import { downloadCsv, type CsvColumn } from '@/lib/csv';
import { vnToday } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { useDebouncedValue } from '@/lib/hooks';
import { personName } from '@/lib/person';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/query';
import type { TasksSearch } from './routes';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.runs.tasks;
const route = getRouteApi('/shell/cong-viec');
const stepId = (s: StepView) => s.id;

/** Trần số dòng của một lần xuất CSV; nhiều hơn thì báo người dùng thu hẹp điều kiện lọc. */
const EXPORT_CAP = 5000;
const EXPORT_PAGE = 200;

const STATE_OPTIONS = STEP_STATES.map((state) => ({ value: state, label: vi.common.stepState[state] }));
const BUCKET_OPTIONS = (['overdue', 'today', 'upcoming', 'done'] as const satisfies readonly Bucket[]).map((bucket) => ({ value: bucket, label: vi.common.bucket[bucket] }));
const KIND_OPTIONS = [
  { value: 'task', label: t.kindTask },
  { value: 'approval', label: t.kindApproval },
];

type StepQuery = {
  state?: StepStateName;
  bucket?: Bucket;
  late?: boolean;
  kind?: 'task' | 'approval';
  runId?: string;
  unitId?: string;
  assignee?: string;
  q?: string;
  sort: 'dueAt' | '-dueAt';
};

/** Cột của tệp CSV (SPEC 9.2): ngày giờ theo giờ Việt Nam, trạng thái bằng chữ như trên màn hình. */
const CSV_COLUMNS: CsvColumn<StepView>[] = [
  { header: t.csv.run, value: (s) => s.runTitle },
  { header: t.csv.step, value: (s) => s.title },
  { header: t.csv.assignee, value: (s) => (s.assignee ? personName(s.assignee, 'full') : '') },
  { header: t.csv.unit, value: (s) => s.unitName },
  { header: t.csv.state, value: (s) => vi.common.stepState[s.state] },
  { header: t.csv.due, value: (s) => (s.dueAt ? formatDateTime(s.dueAt) : '') },
  { header: t.csv.dueOriginal, value: (s) => (s.dueOriginalAt ? formatDateTime(s.dueOriginalAt) : '') },
  { header: t.csv.lateDays, value: (s) => s.lateWorkingDays },
  { header: t.csv.completedAt, value: (s) => (s.completedAt ? formatDateTime(s.completedAt) : '') },
];

/** Tải mọi trang của `steps.list` theo điều kiện lọc đang dùng, để tệp xuất không chỉ gồm các dòng đã hiện. */
async function fetchAllSteps(query: StepQuery): Promise<{ items: StepView[]; capped: boolean }> {
  const items: StepView[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call('steps.list', { query: { ...query, limit: EXPORT_PAGE, cursor } });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < EXPORT_CAP);
  return { items: items.slice(0, EXPORT_CAP), capped: cursor !== undefined };
}

/**
 * Công việc (SPEC 9.2): bảng mọi việc `steps.list` không lọc theo người; lọc trạng thái, nhóm hạn, đơn vị,
 * người nhận, lượt chạy, loại; tìm theo tên; sắp theo hạn; chọn nhiều dòng để giao lại, gia hạn, đi thúc (tối đa 50);
 * xuất CSV. Việc "Cần giao người" có nút Giao người. Gantt thuộc Giai đoạn 4.
 */
export function TasksPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const lateId = useId();
  const can = useCan();
  const [giving, setGiving] = useState(false);

  const [q, setQ] = useState('');
  const [person, setPerson] = useState<PersonOption | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'dueAt', desc: false }]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<StepView | null>(null);
  const [exporting, setExporting] = useState(false);
  const term = useDebouncedValue(q.trim(), 300);

  /** Đổi một phần bộ lọc trên đường dẫn; giá trị null hoặc false nghĩa là bỏ điều kiện đó. */
  const setSearch = (patch: { [K in keyof TasksSearch]?: TasksSearch[K] | null }) => {
    setSelection({});
    void navigate({
      replace: true,
      search: (prev) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) if (next[key] === null || next[key] === undefined || next[key] === false) delete next[key];
        return next as TasksSearch;
      },
    });
  };

  const query: StepQuery = {
    ...(search.state ? { state: search.state } : {}),
    ...(search.bucket ? { bucket: search.bucket } : {}),
    ...(search.late ? { late: true } : {}),
    ...(search.kind ? { kind: search.kind } : {}),
    ...(search.runId ? { runId: search.runId } : {}),
    ...(search.unitId ? { unitId: search.unitId } : {}),
    ...(person ? { assignee: person.id } : {}),
    ...(term ? { q: term } : {}),
    sort: sorting[0]?.id === 'dueAt' && sorting[0].desc ? '-dueAt' : 'dueAt',
  };

  const steps = useApiInfiniteQuery('steps.list', { query: { ...query, limit: 50 } });
  const runs = useApiQuery('runs.list', { query: { limit: 200 } }, { staleTime: 60_000 });
  const runOptions = useMemo(() => sortByVi(runs.data?.items ?? [], (r) => r.title).map((r) => ({ value: r.id, label: r.title })), [runs.data]);

  const filtered = Object.keys(search).length > 0 || person !== null || term !== '';
  const clearFilters = () => {
    setQ('');
    setPerson(null);
    setSelection({});
    void navigate({ replace: true, search: {} });
  };

  const selected = selectedRows(steps.items, selection, stepId);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { items, capped } = await fetchAllSteps(query);
      if (items.length === 0) {
        toast.info(t.exportEmpty);
        return;
      }
      downloadCsv(`${t.fileName}-${vnToday()}`, items, CSV_COLUMNS);
      toast.success(fmt(t.exported, { n: items.length }), capped ? { description: fmt(t.exportCapped, { n: items.length }) } : undefined);
    } catch (err) {
      toast.error(t.exportFailed, { description: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo<ColumnDef<StepView>[]>(
    () => [
      {
        id: 'title',
        header: t.colStep,
        enableSorting: false,
        cell: ({ row }) => {
          const step = row.original;
          return (
            <>
              <button
                type="button"
                onClick={() => setOpenStepId(step.id)}
                aria-label={fmt(t.open, { việc: step.title })}
                className="rounded-sm text-left font-medium underline decoration-transparent underline-offset-4 transition-colors hover:text-primary hover:decoration-primary"
              >
                {step.title}
              </button>
              <p className="truncate text-sm text-ink-sub" title={runLabel(step)}>
                <Link to="/luot-chay/$runId" params={{ runId: step.runId }} className="rounded-sm hover:text-primary hover:underline">
                  {runLabel(step)}
                </Link>
              </p>
              {step.kind === 'approval' || step.blockedReason || step.pendingExtension ? (
                <p className="mt-1 flex flex-wrap gap-1.5">
                  {step.kind === 'approval' ? (
                    <Badge tone="gold">
                      <Stamp aria-hidden="true" />
                      {step.action === 'contribute' ? t.kindContribute : t.kindApproval}
                    </Badge>
                  ) : null}
                  {step.blockedReason ? (
                    <Badge tone="warn">
                      <Hand aria-hidden="true" />
                      {t.blocked}
                    </Badge>
                  ) : null}
                  {step.pendingExtension ? (
                    <Badge tone="muted">
                      <CalendarClock aria-hidden="true" />
                      {t.extensionPending}
                    </Badge>
                  ) : null}
                </p>
              ) : null}
            </>
          );
        },
      },
      {
        id: 'assignee',
        header: t.colAssignee,
        enableSorting: false,
        meta: { className: 'w-[184px]' },
        cell: ({ row }) => {
          const step = row.original;
          if (step.state === 'unassigned' || (!step.assignee && step.state !== 'pending')) {
            return (
              <div className="flex flex-col items-start gap-1.5">
                <Badge tone="warn">
                  <UserRoundX aria-hidden="true" />
                  {vi.common.stepState.unassigned}
                </Badge>
                {allows(step, 'reassign') ? (
                  <Button size="sm" aria-label={fmt(t.assignFor, { việc: step.title })} onClick={() => setAssigning(step)}>
                    <UserRoundPlus aria-hidden="true" />
                    {t.assign}
                  </Button>
                ) : null}
              </div>
            );
          }
          if (!step.assignee) return <span className="text-ink-sub">–</span>;
          return (
            <>
              <PersonName person={step.assignee} />
              {step.unitName ? <p className="truncate text-sm text-ink-sub">{step.unitName}</p> : null}
            </>
          );
        },
      },
      {
        id: 'dueAt',
        accessorFn: (s) => s.dueAt ?? '',
        header: t.colDue,
        meta: { className: 'w-[204px]' },
        cell: ({ row }) => (row.original.dueAt ? <DueLabel plain dueAt={row.original.dueAt} dueOriginalAt={row.original.dueOriginalAt} /> : <span className="text-ink-sub">–</span>),
      },
      {
        id: 'state',
        header: t.colState,
        enableSorting: false,
        meta: { className: 'w-[148px]' },
        cell: ({ row }) => <StatusChip step={row.original} />,
      },
      {
        id: 'completedAt',
        header: t.colCompleted,
        enableSorting: false,
        meta: { className: 'w-[112px]' },
        cell: ({ row }) =>
          row.original.completedAt ? (
            <time dateTime={row.original.completedAt} title={formatDateTime(row.original.completedAt)} className="tabular flex flex-col">
              <span>{formatDate(row.original.completedAt)}</span>
              <span className="text-sm text-ink-sub">{formatTime(row.original.completedAt)}</span>
            </time>
          ) : (
            <span className="text-ink-sub">–</span>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>,
        enableSorting: false,
        meta: { align: 'right', className: 'w-14' },
        cell: ({ row }) => <StepActionsMenu step={row.original} />,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        className="mb-1"
        title={t.title}
        description={t.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can('task.assign') ? (
              <Button variant="primary" onClick={() => setGiving(true)}>
                <Plus aria-hidden="true" />
                {vi.admin.shell.dispatch.giveTask.open}
              </Button>
            ) : null}
            <Button loading={exporting} onClick={() => void exportCsv()}>
              {exporting ? null : <Download aria-hidden="true" />}
              {exporting ? t.exporting : t.exportCsv}
            </Button>
          </div>
        }
      />

      <div role="group" aria-label={t.filters} className="flex flex-col gap-2">
        <div className="grid items-start gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub" />
            <Input
              type="search"
              aria-label={t.search}
              placeholder={t.searchPlaceholder}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSelection({});
              }}
              className="pl-9"
            />
          </div>
          <Select aria-label={t.filterState} value={search.state ?? null} onValueChange={(v) => setSearch({ state: v as StepStateName | null })} options={STATE_OPTIONS} emptyOption={t.allStates} />
          <Select aria-label={t.filterBucket} value={search.bucket ?? null} onValueChange={(v) => setSearch({ bucket: v as Bucket | null })} options={BUCKET_OPTIONS} emptyOption={t.allBuckets} />
          <Select aria-label={t.filterKind} value={search.kind ?? null} onValueChange={(v) => setSearch({ kind: v as 'task' | 'approval' | null })} options={KIND_OPTIONS} emptyOption={t.allKinds} />
          <UnitSelect allowAll aria-label={t.filterUnit} value={search.unitId ?? null} onValueChange={(v) => setSearch({ unitId: v })} />
          <PersonPicker
            aria-label={t.filterPerson}
            placeholder={t.filterPersonPlaceholder}
            value={person}
            onChange={(p) => {
              setPerson(p);
              setSelection({});
            }}
          />
          <Select aria-label={t.filterRun} value={search.runId ?? null} onValueChange={(v) => setSearch({ runId: v })} options={runOptions} emptyOption={t.allRuns} />
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-2.5">
              <Switch id={lateId} checked={search.late === true} onCheckedChange={(v) => setSearch({ late: v })} />
              <label htmlFor={lateId} className="font-medium">
                {t.lateOnly}
              </label>
            </div>
            {filtered ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t.clearFilters}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <StepDispatchProvider>
        <BulkStepActions steps={selected} onClear={() => setSelection({})} />

        {steps.isError ? (
          <Callout
            tone="error"
            title={vi.admin.shell.ui.loadFailedTitle}
            action={
              <Button size="sm" onClick={() => void steps.refetch()}>
                {vi.admin.shell.ui.retry}
              </Button>
            }
          >
            {errorMessage(steps.error)}
          </Callout>
        ) : (
          <DataTable
            caption={t.caption}
            tableClassName="min-w-[960px] table-fixed"
            columns={columns}
            data={steps.items}
            getRowId={stepId}
            rowLabel={(s) => s.title}
            selectable
            rowSelection={selection}
            onRowSelectionChange={setSelection}
            sorting={sorting}
            onSortingChange={setSorting}
            manualSorting
            isLoading={steps.isPending}
            hasMore={steps.hasNextPage}
            onLoadMore={() => void steps.fetchNextPage()}
            isLoadingMore={steps.isFetchingNextPage}
            empty={
              filtered ? (
                <EmptyState title={t.emptyFilteredTitle} description={t.emptyFilteredBody} action={<Button onClick={clearFilters}>{t.clearFilters}</Button>} />
              ) : (
                <EmptyState icon={ListTodo} title={t.emptyTitle} description={t.emptyBody} />
              )
            }
          />
        )}

        <StepDetailSheet
          linkRun
          stepId={openStepId}
          onOpenChange={(open) => {
            if (!open) setOpenStepId(null);
          }}
        />
      </StepDispatchProvider>

      <GiveTaskDialog open={giving} onOpenChange={setGiving} />

      {/* "Cần giao người": chọn người nhận bằng hộp thoại giao lại dùng chung. */}
      <ReassignDialog
        open={assigning !== null}
        steps={assigning ? [assigning] : []}
        onOpenChange={(open) => {
          if (!open) setAssigning(null);
        }}
      />
    </div>
  );
}
