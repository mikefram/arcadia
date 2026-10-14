import { TriangleAlert } from 'lucide-react';
import type { StepView } from '@mihato/domain';
import { fmt, formatLate, vi } from '@mihato/i18n';
import { PersonName } from '@/components/person-name';
import { StepActionsMenu } from '@/features/dispatch';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.shell.overview.needsAttention;
const MAX_SHOWN = 5;

/** "Cần Chủ tịch biết": các việc quá hạn từ 3 ngày làm việc (SPEC 4.6). Chỉ hiện khi có. */
export function NeedsAttention({ steps }: { steps: readonly StepView[] }) {
  if (steps.length === 0) return null;
  const shown = steps.slice(0, MAX_SHOWN);
  const rest = steps.length - shown.length;
  return (
    <section aria-labelledby="can-chu-tich-biet" className="overflow-hidden rounded-xl border border-late/35 bg-surface">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 bg-late-bg px-5 py-3 text-late">
        <h2 id="can-chu-tich-biet" className="flex items-center gap-2 text-lg font-semibold">
          <TriangleAlert aria-hidden="true" className="size-[18px] shrink-0 self-center" />
          {t.title}
        </h2>
        <p className="text-sm">{t.description}</p>
      </div>
      <ul className="divide-y divide-hairline">
        {shown.map((step) => (
          <li key={step.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-2.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto]">
            <div className="min-w-0">
              <p className="truncate font-medium">{step.title}</p>
              <p className="truncate text-sm text-ink-sub">{runLabel(step)}</p>
            </div>
            <div className="hidden min-w-0 md:block">
              <PersonName person={step.assignee} className="block truncate" />
              {step.unitName ? <p className="truncate text-sm text-ink-sub">{step.unitName}</p> : null}
            </div>
            <p className="hidden text-sm font-medium whitespace-nowrap text-late md:block">{formatLate(step.lateWorkingDays)}</p>
            <StepActionsMenu step={step} />
            <p className="col-span-2 text-sm md:hidden">
              <PersonName person={step.assignee} form="short" capitalize />, <span className="font-medium text-late">{formatLate(step.lateWorkingDays)}</span>
            </p>
          </li>
        ))}
      </ul>
      {rest > 0 ? <p className="border-t border-hairline bg-canvas px-5 py-2 text-sm text-ink-sub">{fmt(t.more, { n: rest })}</p> : null}
    </section>
  );
}
