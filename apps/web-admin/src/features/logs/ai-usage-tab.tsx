import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, Sparkles } from 'lucide-react';
import type { RouteResponse } from '@mihato/api-client';
import { fmt, formatDate, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { StatCard, StatGroup } from '@/components/ui/stat-card';
import { DataTable } from '@/components/ui/table';
import { isLocalDate, vnNoon } from '@/features/org/dates';
import { LoadError } from '@/features/org/shared';
import { useCan } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { vnToday } from '@/lib/datetime';
import { personName } from '@/lib/person';
import { useApiQuery } from '@/lib/query';

const t = vi.admin.org.logs.aiUsage;
const tl = vi.admin.org.logs;

type UsageRow = RouteResponse<'admin.aiUsage'>['rows'][number];
const rowId = (r: UsageRow) => `${r.user.id}:${r.day}`;

/** Số nguyên có dấu chấm ngăn nghìn theo cách viết tiếng Việt. */
const int = (n: number) => n.toLocaleString('vi-VN');
const usd = (n: number) => n.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const number = (id: 'calls' | 'tokensIn' | 'tokensOut' | 'sttSeconds' | 'ttsChars' | 'errors', key: keyof Omit<UsageRow, 'user' | 'day'>, width: string): ColumnDef<UsageRow> => ({
  id,
  accessorFn: (r) => r[key],
  header: id === 'sttSeconds' || id === 'ttsChars' ? t.col[id] : t[id],
  meta: { align: 'right', className: width },
  cell: ({ row }) => <span className={row.original[key] === 0 ? 'tabular text-ink-sub' : 'tabular'}>{int(row.original[key])}</span>,
});

const columns: ColumnDef<UsageRow>[] = [
  { id: 'user', accessorFn: (r) => `${r.user.givenName} ${r.user.fullName}`, header: t.col.user, cell: ({ row }) => <span className="font-medium">{personName(row.original.user, 'full')}</span> },
  {
    id: 'day',
    accessorFn: (r) => r.day,
    header: t.col.day,
    meta: { className: 'w-[116px]' },
    cell: ({ row }) => (
      <time dateTime={row.original.day} className="tabular whitespace-nowrap">
        {formatDate(vnNoon(row.original.day))}
      </time>
    ),
  },
  number('calls', 'llmCalls', 'w-[100px]'),
  number('tokensIn', 'llmInputTokens', 'w-[112px]'),
  number('tokensOut', 'llmOutputTokens', 'w-[104px]'),
  number('sttSeconds', 'sttSeconds', 'w-[168px]'),
  number('ttsChars', 'ttsChars', 'w-[128px]'),
  number('errors', 'errors', 'w-[76px]'),
];

function exportCsv(rows: readonly UsageRow[]): void {
  downloadCsv(t.fileName, rows, [
    { header: t.col.user, value: (r) => personName(r.user, 'full') },
    { header: t.col.day, value: (r) => formatDate(vnNoon(r.day)) },
    { header: t.calls, value: (r) => r.llmCalls },
    { header: t.tokensIn, value: (r) => r.llmInputTokens },
    { header: t.tokensOut, value: (r) => r.llmOutputTokens },
    { header: t.sttSeconds, value: (r) => r.sttSeconds },
    { header: t.ttsChars, value: (r) => r.ttsChars },
    { header: t.errors, value: (r) => r.errors },
  ]);
}

/**
 * Số liệu dùng Trợ lý AI theo người và ngày (`admin.aiUsage`): số lượt, token, giây, lỗi, tổng và chi phí ước tính.
 * [QUYẾT ĐỊNH, SPEC 9.1] Quản trị hệ thống chỉ thấy số liệu, không thấy nội dung hội thoại: màn này nói rõ điều đó.
 */
export function AiUsageTab() {
  const can = useCan();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const rangeInvalid = isLocalDate(from) && isLocalDate(to) && from > to;

  const usage = useApiQuery('admin.aiUsage', { query: { from: isLocalDate(from) ? from : undefined, to: isLocalDate(to) ? to : undefined } }, { enabled: !rangeInvalid });
  const settings = useApiQuery('org.settingsGet', {}, { enabled: can('org.settings'), staleTime: 5 * 60_000 });
  const totals = usage.data?.totals;
  const rows = usage.data?.rows ?? [];
  const budget = settings.data?.ai.monthlyBudgetUsd ?? null;
  const loading = usage.isPending && !rangeInvalid;

  // Ngân sách là của cả tháng nên luôn so với chi phí từ đầu tháng tới nay, không phụ thuộc kỳ đang xem (SPEC 12.6).
  const today = vnToday();
  const hasBudget = budget !== null && budget > 0;
  const month = useApiQuery('admin.aiUsage', { query: { from: `${today.slice(0, 8)}01`, to: today } }, { enabled: hasBudget, staleTime: 60_000 });
  const monthCost = month.data?.totals.estimatedUsd;
  const share = hasBudget && monthCost !== undefined ? monthCost / budget : null;
  const percentUsed = share === null ? null : Math.round(share * 100);
  // Cảnh báo ở 80% và 100%; vượt thì chỉ cảnh báo, không cắt Trợ lý AI.
  const warning = share === null ? null : share >= 1 ? t.budgetOver : share >= 0.8 ? t.budgetNear : null;

  const budgetLine = !settings.data || !totals ? undefined : hasBudget ? (percentUsed === null ? undefined : fmt(t.budget, { tiền: usd(budget), phần: percentUsed })) : t.budgetNone;

  return (
    <section aria-labelledby="tab-tro-ly" className="flex min-w-0 flex-col gap-4">
      <h2 id="tab-tro-ly" className="sr-only">
        {tl.page.tabs.aiUsage}
      </h2>

      <Callout tone="info" title={t.noticeTitle}>
        {t.notice}
      </Callout>

      {warning && hasBudget && monthCost !== undefined && percentUsed !== null ? (
        <Callout tone="warn" title={warning.title}>
          {fmt(warning.body, { chi: usd(monthCost), phần: percentUsed, tiền: usd(budget) })} {t.budgetAction}
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div role="group" aria-label={t.filters} className="flex flex-wrap items-end gap-2">
          <Field label={tl.from} className="w-40">
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={tl.to} className="w-40">
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {from || to ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              {tl.clearFilters}
            </Button>
          ) : (
            <p className="pb-2.5 text-sm text-ink-sub">{t.defaultPeriod}</p>
          )}
        </div>
        <Button disabled={rows.length === 0} onClick={() => exportCsv(rows)}>
          <Download aria-hidden="true" />
          {t.exportCsv}
        </Button>
      </div>

      {rangeInvalid ? (
        <p role="alert" className="font-medium">
          {tl.rangeInvalid}
        </p>
      ) : usage.isError ? (
        <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <StatGroup aria-label={t.statsLabel} className="sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
            <StatCard label={t.calls} value={totals ? int(totals.llmCalls) : undefined} loading={loading} />
            <StatCard label={t.tokensIn} value={totals ? int(totals.llmInputTokens) : undefined} loading={loading} />
            <StatCard label={t.tokensOut} value={totals ? int(totals.llmOutputTokens) : undefined} loading={loading} />
            <StatCard label={t.errors} value={totals ? int(totals.errors) : undefined} loading={loading} />
            <StatCard label={t.sttSeconds} value={totals ? int(totals.sttSeconds) : undefined} loading={loading} />
            <StatCard label={t.ttsChars} value={totals ? int(totals.ttsChars) : undefined} loading={loading} />
            <StatCard
              className="col-span-2 sm:col-span-3 lg:col-span-2"
              label={t.cost}
              value={totals ? fmt(t.costValue, { tiền: usd(totals.estimatedUsd) }) : undefined}
              hint={
                <>
                  {t.costHint}
                  {budgetLine ? ` ${budgetLine} ${t.budgetNote}` : null}
                </>
              }
              loading={loading}
            />
          </StatGroup>

          <DataTable
            caption={t.caption}
            tableClassName="min-w-[980px] table-fixed"
            columns={columns}
            data={rows}
            getRowId={rowId}
            isLoading={loading}
            empty={<EmptyState icon={Sparkles} title={t.empty.title} description={t.empty.body} />}
          />
        </>
      )}
    </section>
  );
}
