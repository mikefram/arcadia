import { useMemo, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { fmt, formatDate, formatTime, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { StatCard, StatGroup } from '@/components/ui/stat-card';
import { UnitSelect } from '@/components/unit-select';
import { isLocalDate, vnNoon } from '@/features/org/dates';
import { LoadError } from '@/features/org/shared';
import { useCan } from '@/lib/auth';
import { sortByVi } from '@/lib/collator';
import { useApiQuery } from '@/lib/query';
import { isPeriodPreset, PERIOD_PRESETS, rangeOf, type PeriodPreset } from './period';
import { decimal, percent, StatLabel } from './report-parts';
import { BottlenecksSection, ByUnitTable, ByUserTable, NudgesTable } from './report-tables';
import { TEMPLATE_VIEW_ACTIONS } from '@mihato/domain';

const t = vi.admin.org.reports;
const PERIOD_OPTIONS = PERIOD_PRESETS.map((p) => ({ value: p, label: t.periods[p] }));

/**
 * Báo cáo (SPEC 9.6, `reports.summary`): bộ lọc kỳ, đơn vị, người, quy trình; thẻ số; bảng theo người, theo đơn vị,
 * nút thắt và đi thúc, mỗi bảng xuất được CSV. Số liệu đọc cùng nguồn với Tổng quan và Trợ lý AI nên khớp nhau.
 */
export function ReportsPage() {
  const can = useCan();
  const [preset, setPreset] = useState<PeriodPreset>('last30');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [unitId, setUnitId] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonOption | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);

  const range = useMemo(() => rangeOf(preset, custom), [preset, custom]);
  const rangeInvalid = preset === 'custom' && isLocalDate(custom.from) && isLocalDate(custom.to) && custom.from > custom.to;

  const report = useApiQuery(
    'reports.summary',
    { query: { from: range?.from ?? '', to: range?.to ?? '', unitId: unitId ?? undefined, userId: person?.id, templateId: templateId ?? undefined } },
    { enabled: range !== null, placeholderData: keepPreviousData },
  );
  const canListTemplates = can(TEMPLATE_VIEW_ACTIONS);
  const templates = useApiQuery('templates.list', {}, { enabled: canListTemplates, staleTime: 60_000 });
  const templateOptions = useMemo(() => sortByVi(templates.data?.items ?? [], (x) => x.name).map((x) => ({ value: x.id, label: x.name })), [templates.data]);

  const data = range ? report.data : undefined;
  const loading = range !== null && report.isPending;
  const filtered = unitId !== null || person !== null || templateId !== null;
  const shown = data ? { from: data.from, to: data.to } : range;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title={t.title}
        description={shown ? fmt(t.range, { từ: formatDate(vnNoon(shown.from)), đến: formatDate(vnNoon(shown.to)) }) : undefined}
        meta={data ? <time dateTime={data.asOf}>{fmt(t.asOf, { giờ: formatTime(data.asOf) })}</time> : undefined}
      />

      <div role="group" aria-label={t.filters} className="flex flex-wrap items-end gap-2">
        <Field label={t.period} hideLabel className="w-full sm:w-44">
          <Select value={preset} onValueChange={(v) => isPeriodPreset(v) && setPreset(v)} options={PERIOD_OPTIONS} />
        </Field>
        {preset === 'custom' ? (
          <>
            <Field label={t.from} className="w-full sm:w-40">
              <Input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label={t.to} className="w-full sm:w-40">
              <Input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </>
        ) : null}
        <UnitSelect allowAll aria-label={t.filterUnit} value={unitId} onValueChange={setUnitId} className="w-full sm:w-48" />
        <PersonPicker aria-label={t.filterPerson} placeholder={t.filterPersonPlaceholder} value={person} onChange={setPerson} className="w-full sm:w-52" />
        {canListTemplates ? (
          <Select aria-label={t.filterTemplate} value={templateId} onValueChange={setTemplateId} options={templateOptions} emptyOption={t.allTemplates} className="w-full sm:w-60" />
        ) : null}
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setUnitId(null);
              setPerson(null);
              setTemplateId(null);
            }}
          >
            {t.clearFilters}
          </Button>
        ) : null}
      </div>

      {rangeInvalid ? (
        <p role="alert" className="font-medium">
          {t.rangeInvalid}
        </p>
      ) : report.isError ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : range ? (
        <div aria-busy={report.isFetching || undefined} className="flex flex-col gap-8">
          <StatGroup aria-label={t.stats.label} className="sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-5">
            <StatCard
              label={<StatLabel label={t.stats.onTime} definition={t.stats.onTimeDef} />}
              value={data ? (data.onTimeRate === null ? '–' : percent(data.onTimeRate)) : undefined}
              hint={t.stats.onTimeHint}
              loading={loading}
            />
            <StatCard
              label={<StatLabel label={t.stats.onTimeExt} definition={t.stats.onTimeExtDef} />}
              value={data ? (data.onTimeRateAfterExtension === null ? '–' : percent(data.onTimeRateAfterExtension)) : undefined}
              hint={t.stats.onTimeExtHint}
              loading={loading}
            />
            <StatCard
              label={<StatLabel label={t.stats.overdue} definition={t.stats.overdueDef} />}
              value={data?.overdueNow}
              hint={t.stats.overdueHint}
              tone={data && data.overdueNow > 0 ? 'late' : 'default'}
              loading={loading}
            />
            <StatCard
              label={<StatLabel label={t.stats.avg} definition={t.stats.avgDef} />}
              value={data ? (data.avgHandlingWorkingDays === null ? '–' : decimal(data.avgHandlingWorkingDays)) : undefined}
              hint={t.stats.avgHint}
              loading={loading}
            />
            <StatCard
              className="col-span-2 lg:col-span-1"
              label={<StatLabel label={t.stats.completed} definition={t.stats.completedDef} />}
              value={data?.completedCount}
              hint={t.stats.completedHint}
              loading={loading}
            />
          </StatGroup>

          <ByUserTable rows={data?.byUser ?? []} range={range} loading={loading} />
          <ByUnitTable rows={data?.byUnit ?? []} range={range} loading={loading} />
          <BottlenecksSection rows={data?.byTemplateStep ?? []} range={range} loading={loading} />
          <NudgesTable rows={data?.nudges ?? []} range={range} loading={loading} />
        </div>
      ) : null}
    </div>
  );
}
