import { Link } from '@tanstack/react-router';
import type { Overview } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { StatCard, StatGroup } from '@/components/ui/stat-card';
import { useCan } from '@/lib/auth';

const t = vi.admin.shell.overview.stats;

export const OVERDUE_SECTION_ID = 'viec-qua-han';

/** Dải thẻ số của Tổng quan (SPEC 9.2), đọc từ `overview.get`: cùng nguồn với số liệu Trợ lý AI đọc cho Chủ tịch. */
export function StatBand({ overview, onOpenExtensions }: { overview: Overview | undefined; onOpenExtensions: () => void }) {
  const can = useCan();
  const loading = overview === undefined;
  const rate = overview?.onTimeRateThisWeek;

  return (
    <StatGroup aria-label={t.label}>
      <StatCard label={t.running} value={overview?.running} hint={can('run.view_all') ? t.runningHint : undefined} loading={loading} asChild={can('run.view_all')}>
        {can('run.view_all') ? <Link to="/luot-chay" /> : null}
      </StatCard>

      <StatCard
        label={t.overdue}
        value={overview?.overdue}
        hint={overview ? fmt(t.overdueHint, { n: overview.dueToday }) : undefined}
        tone={overview && overview.overdue > 0 ? 'late' : 'default'}
        loading={loading}
        asChild
      >
        <a href={`#${OVERDUE_SECTION_ID}`} />
      </StatCard>

      <StatCard
        label={t.pendingApproval}
        value={overview?.pendingApproval}
        hint={overview && overview.awaitingMyDecision > 0 ? fmt(t.pendingApprovalMine, { n: overview.awaitingMyDecision }) : t.pendingApprovalNone}
        loading={loading}
      />

      <StatCard
        label={t.onTime}
        value={rate === null || rate === undefined ? '–' : `${Math.round(rate * 100)}%`}
        hint={overview ? (rate === null ? t.onTimeNone : fmt(t.onTimeHint, { n: overview.completedThisWeek })) : undefined}
        loading={loading}
      />

      <StatCard label={t.unassigned} value={overview?.unassigned} hint={t.unassignedHint} loading={loading} asChild={can('run.view_all')}>
        {can('run.view_all') ? <Link to="/cong-viec" /> : null}
      </StatCard>

      <StatCard label={t.pendingExtensions} value={overview?.pendingExtensions} hint={t.pendingExtensionsHint} loading={loading} asChild>
        <button type="button" onClick={onOpenExtensions} />
      </StatCard>
    </StatGroup>
  );
}
