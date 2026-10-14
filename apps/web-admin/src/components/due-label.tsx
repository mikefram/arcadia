import { TriangleAlert } from 'lucide-react';
import { formatDate, formatDateWeekday, formatLate, formatTime, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { vnDayDiff } from '@/lib/datetime';

const t = vi.admin.shell.due;

/** "Hôm nay 17:00", "Ngày mai 09:00", còn lại "Thứ Năm 15/10/2026 17:00". */
export function formatDue(dueAt: string, now: number = Date.now()): string {
  const diff = vnDayDiff(dueAt, now);
  const day = diff === 0 ? t.today : diff === 1 ? t.tomorrow : diff === -1 ? t.yesterday : formatDateWeekday(dueAt);
  return `${day} ${formatTime(dueAt)}`;
}

export type DueLabelProps = {
  dueAt: string | null;
  /** hạn gốc; chỉ hiện khi khác hạn hiện tại (việc đã được gia hạn) */
  dueOriginalAt?: string | null;
  isOverdue?: boolean;
  lateWorkingDays?: number;
  /** việc đã xong thì không tô màu "hôm nay" */
  closed?: boolean;
  /** chỉ hiện ngày giờ, không tô màu và không kèm dòng quá hạn (bảng đã có cột "Trễ" riêng) */
  plain?: boolean;
  className?: string;
};

/**
 * Hạn của một việc: ngày giờ theo giờ Việt Nam, hạn gốc nếu đã gia hạn,
 * và dòng "Đã quá hạn n ngày làm việc" khi trễ. Màu nâu đỏ chỉ xuất hiện khi quá hạn.
 */
export function DueLabel({ dueAt, dueOriginalAt, isOverdue = false, lateWorkingDays = 0, closed = false, plain = false, className }: DueLabelProps) {
  if (!dueAt) return <span className={cn('text-ink-sub', className)}>{vi.common.due.none}</span>;
  const late = isOverdue && !plain;
  const dueToday = !closed && !plain && !isOverdue && vnDayDiff(dueAt) === 0;
  const extended = dueOriginalAt && dueOriginalAt !== dueAt;
  return (
    <span className={cn('inline-flex flex-col', className)}>
      <time dateTime={dueAt} className={cn('tabular whitespace-nowrap', late && 'font-medium text-late', dueToday && 'font-medium text-warn')}>
        {formatDue(dueAt)}
      </time>
      {extended ? (
        <span className="text-sm whitespace-nowrap text-ink-sub">
          {vi.common.due.original}: <time dateTime={dueOriginalAt}>{formatDate(dueOriginalAt)}</time>
        </span>
      ) : null}
      {late ? (
        <span className="inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap text-late">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {formatLate(lateWorkingDays)}
        </span>
      ) : null}
    </span>
  );
}
