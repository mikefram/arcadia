import { useMemo, useState } from 'react';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { CircleCheck } from 'lucide-react';
import type { StepView } from '@mihato/domain';
import { fmt, formatDate, formatDateTime, formatTime, vi } from '@mihato/i18n';
import { DueLabel } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/select';
import { DataTable, selectedRows } from '@/components/ui/table';
import { UnitSelect } from '@/components/unit-select';
import { BulkStepActions, StepActionsMenu } from '@/features/dispatch';
import { sortByVi } from '@/lib/collator';
import { vnDayDiff } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/query';
import { OVERDUE_SECTION_ID } from './stat-band';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.shell.overview.overdue;
const stepId = (s: StepView) => s.id;

function lastNudged(at: string): string {
  const diff = vnDayDiff(at);
  if (diff === 0) return `${vi.admin.shell.due.today} ${formatTime(at)}`;
  if (diff === -1) return `${vi.admin.shell.due.yesterday} ${formatTime(at)}`;
  return formatDate(at);
}

// Bảng dùng bố cục cố định: cột "Việc" nhận phần còn lại, các cột khác có độ rộng đặt sẵn.
const columns: ColumnDef<StepView>[] = [
  {
    id: 'title',
    accessorFn: (s) => s.title,
    header: t.colStep,
    cell: ({ row }) => (
      <>
        <p className="font-medium">{row.original.title}</p>
        <p className="truncate text-sm text-ink-sub" title={runLabel(row.original)}>
          {runLabel(row.original)}
        </p>
      </>
    ),
  },
  {
    id: 'assignee',
    accessorFn: (s) => s.assignee?.givenName ?? '',
    header: t.colAssignee,
    meta: { className: 'w-[176px]' },
    cell: ({ row }) => (
      <>
        <PersonName person={row.original.assignee} />
        {row.original.unitName ? <p className="truncate text-sm text-ink-sub">{row.original.unitName}</p> : null}
      </>
    ),
  },
  {
    id: 'dueAt',
    accessorFn: (s) => s.dueAt ?? '',
    header: t.colDue,
    meta: { className: 'w-[212px]' },
    cell: ({ row }) => <DueLabel plain dueAt={row.original.dueAt} dueOriginalAt={row.original.dueOriginalAt} />,
  },
  {
    id: 'late',
    accessorFn: (s) => s.lateWorkingDays,
    header: t.colLate,
    meta: { align: 'right', className: 'w-[88px]' },
    cell: ({ row }) => (
      <span className="tabular font-semibold whitespace-nowrap text-late">
        {row.original.lateWorkingDays > 0 ? fmt(t.lateDays, { n: row.original.lateWorkingDays }) : t.lateToday}
      </span>
    ),
  },
  {
    id: 'lastNudgedAt',
    accessorFn: (s) => s.lastNudgedAt ?? '',
    header: t.colLastNudged,
    meta: { className: 'w-[148px]' },
    cell: ({ row }) =>
      row.original.lastNudgedAt ? (
        <time dateTime={row.original.lastNudgedAt} title={formatDateTime(row.original.lastNudgedAt)} className="tabular whitespace-nowrap">
          {lastNudged(row.original.lastNudgedAt)}
        </time>
      ) : (
        <span className="text-ink-sub">{t.neverNudged}</span>
      ),
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>,
    enableSorting: false,
    meta: { align: 'right', className: 'w-14' },
    cell: ({ row }) => <StepActionsMenu step={row.original} />,
  },
];

/** Bảng việc quá hạn của Tổng quan: lọc theo đơn vị, người nhận, lượt chạy; chọn nhiều dòng để thao tác hàng loạt. */
export function OverdueSection() {
  const [unitId, setUnitId] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonOption | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [selection, setSelection] = useState<RowSelectionState>({});

  const steps = useApiInfiniteQuery('steps.list', {
    query: { late: true, sort: 'dueAt', limit: 50, unitId: unitId ?? undefined, assignee: person?.id, runId: runId ?? undefined },
  });
  const lateRuns = useApiQuery('runs.list', { query: { state: 'running', late: true, limit: 100 } }, { staleTime: 60_000 });
  const runOptions = useMemo(() => sortByVi(lateRuns.data?.items ?? [], (r) => r.title).map((r) => ({ value: r.id, label: r.title })), [lateRuns.data]);

  const filtered = unitId !== null || person !== null || runId !== null;
  const selected = selectedRows(steps.items, selection, stepId);

  const changeFilter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setSelection({});
  };
  const clearFilters = () => {
    setUnitId(null);
    setPerson(null);
    setRunId(null);
    setSelection({});
  };

  return (
    <section id={OVERDUE_SECTION_ID} aria-labelledby="viec-qua-han-tieu-de" className="flex min-w-0 scroll-mt-20 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="viec-qua-han-tieu-de" className="text-lg font-semibold">
          {t.title}
        </h2>
        {steps.isSuccess && steps.items.length > 0 ? (
          <Badge tone="late">{`${fmt(t.count, { n: steps.items.length })}${steps.hasNextPage ? '+' : ''}`}</Badge>
        ) : null}
      </div>

      <div role="group" aria-label={t.filters} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <UnitSelect allowAll aria-label={t.filterUnit} value={unitId} onValueChange={changeFilter(setUnitId)} />
        <PersonPicker aria-label={t.filterPerson} placeholder={t.filterPersonPlaceholder} value={person} onChange={changeFilter(setPerson)} />
        <Select aria-label={t.filterRun} value={runId} onValueChange={changeFilter(setRunId)} options={runOptions} emptyOption={t.allRuns} />
        {filtered ? (
          <Button variant="ghost" onClick={clearFilters}>
            {t.clearFilters}
          </Button>
        ) : null}
      </div>

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
          tableClassName="min-w-[900px] table-fixed"
          columns={columns}
          data={steps.items}
          getRowId={stepId}
          rowLabel={(s) => s.title}
          selectable
          rowSelection={selection}
          onRowSelectionChange={setSelection}
          isLoading={steps.isPending}
          hasMore={steps.hasNextPage}
          onLoadMore={() => void steps.fetchNextPage()}
          isLoadingMore={steps.isFetchingNextPage}
          empty={
            filtered ? (
              <EmptyState title={t.emptyFilteredTitle} description={t.emptyFilteredBody} action={<Button onClick={clearFilters}>{t.clearFilters}</Button>} />
            ) : (
              <EmptyState icon={CircleCheck} title={t.emptyTitle} description={t.emptyBody} />
            )
          }
        />
      )}
    </section>
  );
}
