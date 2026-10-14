import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { BookOpen, Download, FileText, Plus, Search, Settings2 } from 'lucide-react';
import type { RegisterColumn, RegisterEntryView, RegisterView } from '@mihato/domain';
import { fmt, formatDate, formatTime, vi, vnParts } from '@mihato/i18n';
import { PersonName } from '@/components/person-name';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { errorMessage } from '@/lib/errors';
import { useDebouncedValue } from '@/lib/hooks';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/query';
import { tableMinWidth, yearOptions } from './register-format';
import { choicesFor, entryText, filterEntries, FILTER_KEYS, hasColumn, hasFilters, NO_FILTERS, registerCsvColumns, registerCsvFileName, type EntryFilters } from './register-export';
import { RECOMMENDED_REGISTERS, recommendedValues } from './register-form';
import { RegisterConfigDialog, type RegisterConfigTarget } from './register-config-dialog';
import { EntryFilesSheet } from './entry-files-sheet';
import { RunStateBadge } from './run-state-badge';

const t = vi.admin.documents;
/** Xuất CSV: mỗi lần lấy 200 dòng (mức tối đa của máy chủ), dừng ở 5.000 dòng. */
const EXPORT_PAGE = 200;
const EXPORT_CAP = 5000;
const entryId = (e: RegisterEntryView) => e.id;

/** Cột cố định (Số, Ngày cấp, Trích yếu, Người tạo, Tình trạng) rồi các cột cấu hình của sổ, mỗi cột lấy một ô của biểu mẫu. */
function buildColumns(extra: readonly RegisterColumn[], canOpenRun: boolean, onOpenFiles: (entry: RegisterEntryView) => void): ColumnDef<RegisterEntryView>[] {
  const fixed: ColumnDef<RegisterEntryView>[] = [
    {
      id: 'number',
      header: t.colNumber,
      enableSorting: false,
      meta: { className: 'w-[150px]' },
      cell: ({ row }) => <span className="tabular font-semibold break-all">{row.original.number}</span>,
    },
    {
      id: 'date',
      header: t.colDate,
      enableSorting: false,
      meta: { className: 'w-[116px]' },
      cell: ({ row }) => (
        <time dateTime={row.original.createdAt} className="tabular flex flex-col">
          <span>{formatDate(row.original.createdAt)}</span>
          <span className="text-sm text-ink-sub">{formatTime(row.original.createdAt)}</span>
        </time>
      ),
    },
    {
      id: 'subject',
      header: t.colSubject,
      enableSorting: false,
      cell: ({ row }) => {
        const { subject, run } = row.original;
        if (!subject.trim()) return <span className="text-ink-sub italic">{t.noSubject}</span>;
        return canOpenRun ? (
          <Link
            to="/luot-chay/$runId"
            params={{ runId: run.id }}
            title={fmt(t.openRun, { tên: subject })}
            className="rounded-sm font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
          >
            {subject}
          </Link>
        ) : (
          <span className="font-medium">{subject}</span>
        );
      },
    },
    {
      id: 'createdBy',
      header: t.colCreatedBy,
      enableSorting: false,
      meta: { className: 'w-[160px]' },
      cell: ({ row }) => <PersonName person={row.original.createdBy} fallback="" />,
    },
    {
      id: 'state',
      header: t.colState,
      enableSorting: false,
      meta: { className: 'w-[140px]' },
      cell: ({ row }) => <RunStateBadge state={row.original.run.state} />,
    },
    {
      id: 'files',
      header: t.colFiles,
      enableSorting: false,
      meta: { className: 'w-[132px]' },
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="secondary"
          aria-label={fmt(t.filesButtonFor, { số: row.original.number })}
          aria-haspopup="dialog"
          // Bấm nút không được kích hoạt "mở lượt chạy" của cả dòng.
          onClick={(e) => {
            e.stopPropagation();
            onOpenFiles(row.original);
          }}
        >
          <FileText aria-hidden="true" />
          {t.filesButton}
        </Button>
      ),
    },
  ];
  const dynamic: ColumnDef<RegisterEntryView>[] = extra.map((column) => ({
    id: `col:${column.key}`,
    header: column.label,
    enableSorting: false,
    meta: { className: 'w-[150px]' },
    cell: ({ row }) => {
      const text = entryText(row.original, column.key);
      return text === null ? (
        <>
          <span aria-hidden="true" className="text-ink-sub">
            –
          </span>
          <span className="sr-only">{t.noValue}</span>
        </>
      ) : (
        <span className="line-clamp-3 break-words" title={text}>
          {text}
        </span>
      );
    },
  }));
  return [...fixed, ...dynamic];
}

/** Dòng tóm tắt dưới các thẻ chọn sổ: loại, mẫu số, cách đánh số, số kế tiếp, số văn bản. */
function RegisterInfo({ register }: { register: RegisterView }) {
  return (
    <ul aria-label={register.name} className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-sub" data-testid="register-info">
      <li>{fmt(t.info.direction, { loại: t.direction[register.direction] })}</li>
      <li>{fmt(t.info.code, { mã: register.code })}</li>
      <li>
        {fmt(t.info.pattern, { mẫu: '' })}
        <span className="tabular font-medium text-ink">{register.pattern}</span>
      </li>
      <li>{t.info.reset[register.resetPolicy]}</li>
      <li>
        {fmt(t.info.next, { số: '' })}
        <span className="tabular font-medium text-ink">{register.nextNumber}</span>
      </li>
      <li>{fmt(t.info.count, { n: register.entryCount })}</li>
    </ul>
  );
}

function RegisterTable({ register, canOpenRun }: { register: RegisterView; canOpenRun: boolean }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const years = useMemo(() => yearOptions(Date.now()), []);
  /** null = tất cả các năm */
  const [year, setYear] = useState<number | null>(years[0] ?? vnParts(Date.now()).year);
  const q = useDebouncedValue(text.trim(), 300);
  const yearChoices = useMemo(() => years.map((y) => ({ value: String(y), label: String(y) })), [years]);

  const entries = useApiInfiniteQuery('registers.entries', {
    params: { code: register.code },
    query: { limit: 50, year: year ?? undefined, q: q || undefined },
  });
  const [filesFor, setFilesFor] = useState<RegisterEntryView | null>(null);
  const columns = useMemo(() => buildColumns(register.columns, canOpenRun, setFilesFor), [register.columns, canOpenRun]);
  const [filters, setFilters] = useState<EntryFilters>(NO_FILTERS);
  const [exporting, setExporting] = useState(false);
  const rows = useMemo(() => filterEntries(entries.items, filters), [entries.items, filters]);
  const filtered = q !== '' || year !== years[0] || hasFilters(filters);
  const clear = () => {
    setText('');
    setYear(years[0] ?? null);
    setFilters(NO_FILTERS);
  };
  const patch = (change: Partial<EntryFilters>) => setFilters((prev) => ({ ...prev, ...change }));
  const choices = useMemo(
    () => ({ type: choicesFor(entries.items, FILTER_KEYS.type), urgency: choicesFor(entries.items, FILTER_KEYS.urgency), secrecy: choicesFor(entries.items, FILTER_KEYS.secrecy) }),
    [entries.items],
  );

  /** Tải mọi trang theo năm và từ khoá đang chọn (không chỉ các dòng đã hiện), lọc như bảng, rồi xuất CSV. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: RegisterEntryView[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.call('registers.entries', { params: { code: register.code }, query: { limit: EXPORT_PAGE, cursor, year: year ?? undefined, q: q || undefined } });
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && all.length < EXPORT_CAP);
      const out = filterEntries(all, filters).slice(0, EXPORT_CAP);
      if (out.length === 0) {
        toast.info(t.export.empty);
        return;
      }
      downloadCsv(registerCsvFileName(register, year), out, registerCsvColumns(register));
      toast.success(fmt(t.export.done, { n: out.length }), cursor !== undefined ? { description: fmt(t.export.capped, { n: out.length }) } : undefined);
    } catch (err) {
      toast.error(t.export.failed, { description: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t.filters} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub" />
          <Input type="search" aria-label={t.search} placeholder={t.searchPlaceholder} value={text} onChange={(e) => setText(e.target.value)} className="pl-9" data-testid="register-search" />
        </div>
        <Select aria-label={t.year} value={year === null ? null : String(year)} onValueChange={(v) => setYear(v === null ? null : Number(v))} options={yearChoices} emptyOption={t.allYears} />
      </div>
      <div role="group" aria-label={t.filter.group} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(6,minmax(0,1fr))_auto]">
        <Input type="search" aria-label={t.filter.place} placeholder={t.filter.place} value={filters.place} onChange={(e) => patch({ place: e.target.value })} data-testid="register-filter-place" />
        {hasColumn(register.columns, FILTER_KEYS.type) ? (
          <Select aria-label={t.filter.type} value={filters.type} onValueChange={(v) => patch({ type: v })} options={choices.type} emptyOption={t.filter.allTypes} />
        ) : null}
        {hasColumn(register.columns, FILTER_KEYS.urgency) ? (
          <Select aria-label={t.filter.urgency} value={filters.urgency} onValueChange={(v) => patch({ urgency: v })} options={choices.urgency} emptyOption={t.filter.allUrgency} />
        ) : null}
        {hasColumn(register.columns, FILTER_KEYS.secrecy) ? (
          <Select aria-label={t.filter.secrecy} value={filters.secrecy} onValueChange={(v) => patch({ secrecy: v })} options={choices.secrecy} emptyOption={t.filter.allSecrecy} />
        ) : null}
        <Input type="date" aria-label={t.filter.from} value={filters.from} max={filters.to || undefined} onChange={(e) => patch({ from: e.target.value })} />
        <Input type="date" aria-label={t.filter.to} value={filters.to} min={filters.from || undefined} onChange={(e) => patch({ to: e.target.value })} />
        <Button loading={exporting} onClick={() => void exportCsv()} data-testid="register-export">
          {exporting ? null : <Download aria-hidden="true" />}
          {exporting ? t.export.exporting : t.export.button}
        </Button>
      </div>

      {entries.isError ? (
        <Callout
          tone="error"
          title={vi.admin.shell.ui.loadFailedTitle}
          action={
            <Button size="sm" onClick={() => void entries.refetch()}>
              {vi.admin.shell.ui.retry}
            </Button>
          }
        >
          {errorMessage(entries.error)}
        </Callout>
      ) : (
        <DataTable
          caption={fmt(t.caption, { sổ: register.name })}
          tableClassName={`table-fixed ${tableMinWidth(register.columns.length)}`}
          columns={columns}
          data={rows}
          getRowId={entryId}
          isLoading={entries.isPending}
          hasMore={entries.hasNextPage}
          onLoadMore={() => void entries.fetchNextPage()}
          isLoadingMore={entries.isFetchingNextPage}
          onRowClick={canOpenRun ? (entry) => void navigate({ to: '/luot-chay/$runId', params: { runId: entry.run.id } }) : undefined}
          empty={
            filtered ? (
              <EmptyState title={t.emptyFilteredTitle} description={t.emptyFilteredBody} action={<Button onClick={clear}>{t.clearFilters}</Button>} />
            ) : (
              <EmptyState icon={BookOpen} title={t.emptyTitle} description={t.emptyBody} />
            )
          }
        />
      )}
      <EntryFilesSheet entry={filesFor} onOpenChange={(open) => (open ? undefined : setFilesFor(null))} />
    </div>
  );
}

/** Chưa có sổ nào: gợi ý ba sổ nên có, bấm một nút là mở biểu mẫu tạo đã điền sẵn. */
function NoRegisters({ canConfigure, onCreate }: { canConfigure: boolean; onCreate: (target: RegisterConfigTarget) => void }) {
  const n = t.noRegisters;
  return (
    <div className="rounded-xl border border-hairline bg-surface" data-testid="registers-empty">
      <EmptyState
        icon={BookOpen}
        title={n.title}
        description={canConfigure ? n.bodyAdmin : n.bodyReader}
        action={
          canConfigure ? (
            <div className="flex flex-col items-center gap-3">
              <div role="group" aria-label={n.recommendedLabel} className="flex flex-wrap justify-center gap-2">
                {RECOMMENDED_REGISTERS.map((r) => (
                  <Button key={r.code} variant="primary" onClick={() => onCreate({ mode: 'create', initial: recommendedValues(r.code) })} data-testid={`create-${r.code}`}>
                    <Plus aria-hidden="true" />
                    {fmt(n.createRecommended, { tên: t.recommended[r.code].name })}
                  </Button>
                ))}
              </div>
              <Button variant="secondary" onClick={() => onCreate({ mode: 'create' })}>
                {n.createCustom}
              </Button>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Sổ văn bản (docs/DECISIONS.md, 06/10/2026): mỗi sổ (văn bản đến, văn bản đi, chỉ thị) là một thẻ; bảng liệt kê số, ngày cấp,
 * trích yếu, người tạo, tình trạng của lượt chạy và các cột cấu hình. Người có `document.view` xem; người có `org.settings`
 * thêm và sửa cấu hình sổ. Chỉ người có `run.view_all` mở được lượt chạy từ dòng sổ.
 */
export function DocumentsPage() {
  const can = useCan();
  const canConfigure = can('org.settings');
  const canOpenRun = can('run.view_all');
  const canView = can('document.view');
  const registers = useApiQuery('registers.list', {});
  const active = useMemo(() => (registers.data?.items ?? []).filter((r) => r.archivedAt === null), [registers.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const [config, setConfig] = useState<RegisterConfigTarget | null>(null);
  const current = active.find((r) => r.code === picked) ?? active[0] ?? null;
  const takenCodes = useMemo(() => (registers.data?.items ?? []).map((r) => r.code), [registers.data]);

  const actions = canConfigure ? (
    <>
      <Button onClick={() => setConfig({ mode: 'create' })} data-testid="register-add">
        <Plus aria-hidden="true" />
        {t.config.add}
      </Button>
      {current ? (
        <Button onClick={() => setConfig({ mode: 'edit', register: current })} aria-label={fmt(t.config.buttonFor, { sổ: current.name })} data-testid="register-config">
          <Settings2 aria-hidden="true" />
          {t.config.button}
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="registers-page">
      <PageHeader className="mb-1" title={t.title} description={t.description} actions={actions} />

      {registers.isError ? (
        <Callout
          tone="error"
          title={vi.admin.shell.ui.loadFailedTitle}
          action={
            <Button size="sm" onClick={() => void registers.refetch()}>
              {vi.admin.shell.ui.retry}
            </Button>
          }
        >
          {errorMessage(registers.error)}
        </Callout>
      ) : registers.isPending ? (
        <div role="status" aria-label={vi.admin.shell.ui.loading} className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full max-w-lg" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : current === null ? (
        <NoRegisters canConfigure={canConfigure} onCreate={setConfig} />
      ) : (
        <Tabs value={current.code} onValueChange={setPicked}>
          <TabsList aria-label={t.registerLabel} data-testid="register-select">
            {active.map((r) => (
              <TabsTrigger key={r.code} value={r.code} data-testid={`register-${r.code}`}>
                {r.name}
                <Badge tone="muted" className="tabular">
                  {r.entryCount}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={current.code} className="flex flex-col gap-3 pt-4">
            <RegisterInfo register={current} />
            {canView ? (
              <RegisterTable key={current.code} register={current} canOpenRun={canOpenRun} />
            ) : (
              <Callout tone="info" data-testid="register-config-only">
                {t.configOnly}
              </Callout>
            )}
          </TabsContent>
        </Tabs>
      )}

      {canConfigure ? (
        <RegisterConfigDialog
          target={config}
          onOpenChange={(open) => !open && setConfig(null)}
          takenCodes={takenCodes}
          onSaved={setPicked}
        />
      ) : null}
    </div>
  );
}
