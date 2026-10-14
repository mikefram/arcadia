import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { Report } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable } from '@/components/ui/table';
import { downloadCsv, type CsvColumn } from '@/lib/csv';
import { personName } from '@/lib/person';
import { decimal, MagnitudeBar, RateMeter, ReportSection } from './report-parts';
import type { DateRange } from './period';

const t = vi.admin.org.reports;

type UserRow = Report['byUser'][number];
type UnitRow = Report['byUnit'][number];
type StepRow = Report['byTemplateStep'][number];
type NudgeRow = Report['nudges'][number];
type Tally = Pick<UserRow, 'open' | 'overdue' | 'completed' | 'onTimeRate'>;

/** Tỷ lệ 0..1 → số phần trăm cho CSV (ô trống khi chưa có mẫu số). */
const pct = (rate: number | null): number | null => (rate === null ? null : Math.round(rate * 100));
const fileName = (base: string, range: DateRange) => `${base}_${range.from}_${range.to}`;
const percentHeader = (label: string) => `${label} (%)`;

const count = (n: number, late = false) => <span className={n === 0 ? 'tabular text-ink-sub' : late ? 'tabular font-semibold text-late' : 'tabular'}>{n}</span>;

/** Bốn cột số chung của bảng theo người và theo đơn vị. */
function tallyColumns<T extends Tally>(): ColumnDef<T>[] {
  const c = t.byUser.col;
  return [
    { id: 'open', accessorFn: (r) => r.open, header: c.open, meta: { align: 'right', className: 'w-[104px]' }, cell: ({ row }) => count(row.original.open) },
    { id: 'overdue', accessorFn: (r) => r.overdue, header: c.overdue, meta: { align: 'right', className: 'w-[104px]' }, cell: ({ row }) => count(row.original.overdue, true) },
    { id: 'completed', accessorFn: (r) => r.completed, header: c.completed, meta: { align: 'right', className: 'w-[104px]' }, cell: ({ row }) => count(row.original.completed) },
    { id: 'onTime', accessorFn: (r) => r.onTimeRate, header: c.onTime, meta: { className: 'w-[220px]' }, cell: ({ row }) => <RateMeter rate={row.original.onTimeRate} /> },
  ];
}

const tallyCsv = <T extends Tally>(): CsvColumn<T>[] => [
  { header: t.byUser.col.open, value: (r) => r.open },
  { header: t.byUser.col.overdue, value: (r) => r.overdue },
  { header: t.byUser.col.completed, value: (r) => r.completed },
  { header: percentHeader(t.byUser.col.onTime), value: (r) => pct(r.onTimeRate) },
];

const userColumns: ColumnDef<UserRow>[] = [
  { id: 'user', accessorFn: (r) => `${r.user.givenName} ${r.user.fullName}`, header: t.byUser.col.user, cell: ({ row }) => <span className="font-medium">{personName(row.original.user, 'full')}</span> },
  { id: 'unit', accessorFn: (r) => r.unitName ?? '', header: t.byUser.col.unit, meta: { className: 'w-[168px]' }, cell: ({ row }) => row.original.unitName ?? <span className="text-ink-sub">–</span> },
  ...tallyColumns<UserRow>(),
];

/** Khối lượng theo người (SPEC 9.6): đang giữ, quá hạn, đã xong, tỷ lệ đúng hạn. */
export function ByUserTable({ rows, range, loading }: { rows: readonly UserRow[]; range: DateRange; loading: boolean }) {
  const exportCsv = () =>
    downloadCsv(fileName(t.byUser.fileName, range), rows, [
      { header: t.byUser.col.user, value: (r) => personName(r.user, 'full') },
      { header: t.byUser.col.unit, value: (r) => r.unitName },
      ...tallyCsv<UserRow>(),
    ]);
  return (
    <ReportSection id="bao-cao-theo-nguoi" title={t.byUser.title} description={t.byUser.description} onExport={exportCsv} canExport={rows.length > 0}>
      <DataTable
        caption={t.byUser.caption}
        tableClassName="min-w-[860px] table-fixed"
        columns={userColumns}
        data={rows}
        getRowId={(r) => r.user.id}
        isLoading={loading}
        empty={<EmptyState title={t.byUser.empty} />}
      />
    </ReportSection>
  );
}

const unitKey = (r: UnitRow) => r.unitId ?? 'khong-don-vi';
/** Người chưa xếp đơn vị nào gom thành một dòng; máy chủ để trống tên, chữ hiển thị lấy ở đây. */
const unitLabel = (r: UnitRow): string => r.unitName || t.byUnit.noUnit;
const unitColumns: ColumnDef<UnitRow>[] = [
  { id: 'unit', accessorFn: unitLabel, header: t.byUnit.col.unit, cell: ({ row }) => <span className="font-medium">{unitLabel(row.original)}</span> },
  ...tallyColumns<UnitRow>(),
];

export function ByUnitTable({ rows, range, loading }: { rows: readonly UnitRow[]; range: DateRange; loading: boolean }) {
  const exportCsv = () => downloadCsv(fileName(t.byUnit.fileName, range), rows, [{ header: t.byUnit.col.unit, value: unitLabel }, ...tallyCsv<UnitRow>()]);
  return (
    <ReportSection id="bao-cao-theo-don-vi" title={t.byUnit.title} description={t.byUnit.description} onExport={exportCsv} canExport={rows.length > 0}>
      <DataTable
        caption={t.byUnit.caption}
        tableClassName="min-w-[720px] table-fixed"
        columns={unitColumns}
        data={rows}
        getRowId={unitKey}
        isLoading={loading}
        empty={<EmptyState title={t.byUnit.empty} />}
      />
    </ReportSection>
  );
}

type TemplateGroup = { templateId: string; templateName: string; steps: StepRow[]; maxAvg: number; slowest: string | null; mostOverdue: string | null };

/**
 * Nút thắt theo từng mẫu quy trình (SPEC 9.6): bước có thời gian xử lý trung bình dài nhất và bước có tỷ lệ quá hạn
 * cao nhất. Bước dẫn đầu được gắn nhãn chữ; tỷ lệ quá hạn bằng 0 thì không gắn nhãn "quá hạn nhiều nhất".
 */
function groupByTemplate(rows: readonly StepRow[]): TemplateGroup[] {
  const groups = new Map<string, TemplateGroup>();
  for (const row of rows) {
    const group = groups.get(row.templateId) ?? { templateId: row.templateId, templateName: row.templateName, steps: [], maxAvg: 0, slowest: null, mostOverdue: null };
    group.steps.push(row);
    groups.set(row.templateId, group);
  }
  for (const group of groups.values()) {
    group.steps.sort((a, b) => (b.avgWorkingDays ?? -1) - (a.avgWorkingDays ?? -1));
    let maxAvg = 0;
    let maxRate = 0;
    for (const step of group.steps) {
      if ((step.avgWorkingDays ?? 0) > maxAvg) {
        maxAvg = step.avgWorkingDays ?? 0;
        group.slowest = step.nodeId;
      }
      if ((step.overdueRate ?? 0) > maxRate) {
        maxRate = step.overdueRate ?? 0;
        group.mostOverdue = step.nodeId;
      }
    }
    group.maxAvg = maxAvg;
  }
  return [...groups.values()];
}

function BottleneckGroup({ group, loading }: { group: TemplateGroup; loading: boolean }) {
  const c = t.bottlenecks.col;
  const columns = useMemo<ColumnDef<StepRow>[]>(
    () => [
      {
        id: 'step',
        accessorFn: (r) => r.title,
        header: c.step,
        cell: ({ row: { original: r } }) => (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{r.title}</span>
            {r.nodeId === group.slowest ? <Badge tone="gold">{t.bottlenecks.slowest}</Badge> : null}
            {r.nodeId === group.mostOverdue ? <Badge tone="late">{t.bottlenecks.mostOverdue}</Badge> : null}
          </div>
        ),
      },
      { id: 'count', accessorFn: (r) => r.count, header: c.count, meta: { align: 'right', className: 'w-[124px]' }, cell: ({ row }) => count(row.original.count) },
      {
        id: 'avg',
        accessorFn: (r) => r.avgWorkingDays,
        header: c.avg,
        meta: { className: 'w-[220px]' },
        cell: ({ row: { original: r } }) => <MagnitudeBar value={r.avgWorkingDays} max={group.maxAvg} label={r.avgWorkingDays === null ? '' : fmt(t.bottlenecks.days, { n: decimal(r.avgWorkingDays) })} />,
      },
      { id: 'overdueRate', accessorFn: (r) => r.overdueRate, header: c.overdueRate, meta: { className: 'w-[220px]' }, cell: ({ row }) => <RateMeter rate={row.original.overdueRate} tone="late" /> },
    ],
    [group, c],
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="font-semibold">{group.templateName}</h3>
      <DataTable
        caption={fmt(t.bottlenecks.caption, { tên: group.templateName })}
        tableClassName="min-w-[820px] table-fixed"
        columns={columns}
        data={group.steps}
        getRowId={(r) => r.nodeId}
        isLoading={loading}
      />
    </div>
  );
}

export function BottlenecksSection({ rows, range, loading }: { rows: readonly StepRow[]; range: DateRange; loading: boolean }) {
  const groups = useMemo(() => groupByTemplate(rows), [rows]);
  const c = t.bottlenecks.col;
  const exportCsv = () =>
    downloadCsv(
      fileName(t.bottlenecks.fileName, range),
      groups.flatMap((g) => g.steps),
      [
        { header: c.template, value: (r) => r.templateName },
        { header: c.step, value: (r) => r.title },
        { header: c.count, value: (r) => r.count },
        { header: `${c.avg} (${vi.admin.org.reports.stats.avgHint.toLocaleLowerCase('vi')})`, value: (r) => r.avgWorkingDays },
        { header: percentHeader(c.overdueRate), value: (r) => pct(r.overdueRate) },
      ],
    );
  return (
    <ReportSection id="bao-cao-nut-that" title={t.bottlenecks.title} description={`${t.bottlenecks.description} ${t.bottlenecks.avgDef} ${t.bottlenecks.overdueDef}`} onExport={exportCsv} canExport={rows.length > 0}>
      {groups.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-surface">
          <EmptyState title={t.bottlenecks.empty} />
        </div>
      ) : (
        groups.map((group) => <BottleneckGroup key={group.templateId} group={group} loading={loading} />)
      )}
    </ReportSection>
  );
}

const nudgeColumns: ColumnDef<NudgeRow>[] = [
  { id: 'user', accessorFn: (r) => `${r.user.givenName} ${r.user.fullName}`, header: t.nudges.col.user, cell: ({ row }) => <span className="font-medium">{personName(row.original.user, 'full')}</span> },
  { id: 'received', accessorFn: (r) => r.received, header: t.nudges.col.received, meta: { align: 'right', className: 'w-[160px]' }, cell: ({ row }) => count(row.original.received) },
  { id: 'replied', accessorFn: (r) => r.repliedWithinOneWorkingDay, header: t.nudges.col.replied, meta: { align: 'right', className: 'w-[248px]' }, cell: ({ row }) => count(row.original.repliedWithinOneWorkingDay) },
  { id: 'rate', accessorFn: (r) => r.replyRate, header: t.nudges.col.rate, meta: { className: 'w-[220px]' }, cell: ({ row }) => <RateMeter rate={row.original.replyRate} /> },
];

/** Đi thúc (SPEC 9.6): số lần theo người nhận và tỷ lệ phản hồi trong một ngày làm việc. */
export function NudgesTable({ rows, range, loading }: { rows: readonly NudgeRow[]; range: DateRange; loading: boolean }) {
  const exportCsv = () =>
    downloadCsv(fileName(t.nudges.fileName, range), rows, [
      { header: t.nudges.col.user, value: (r) => personName(r.user, 'full') },
      { header: t.nudges.col.received, value: (r) => r.received },
      { header: t.nudges.col.replied, value: (r) => r.repliedWithinOneWorkingDay },
      { header: percentHeader(t.nudges.col.rate), value: (r) => pct(r.replyRate) },
    ]);
  return (
    <ReportSection id="bao-cao-di-thuc" title={t.nudges.title} description={t.nudges.description} onExport={exportCsv} canExport={rows.length > 0}>
      <DataTable
        caption={t.nudges.caption}
        tableClassName="min-w-[820px] table-fixed"
        columns={nudgeColumns}
        data={rows}
        getRowId={(r) => r.user.id}
        isLoading={loading}
        empty={<EmptyState title={t.nudges.empty} />}
      />
    </ReportSection>
  );
}
