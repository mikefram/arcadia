import { formatProgress } from '@mihato/i18n';
import { cn } from '@/lib/cn';

export type RunProgressProps = {
  done: number;
  total: number;
  /** lượt chạy đang có việc quá hạn: thanh đổi sang màu nâu đỏ */
  late?: boolean;
  /** ẩn dòng chữ, chỉ giữ thanh (dòng chữ vẫn được đọc lên) */
  compact?: boolean;
  className?: string;
};

/** Thanh tiến độ kèm chữ "4 trên 6 việc đã xong". */
export function RunProgress({ done, total, late = false, compact = false, className }: RunProgressProps) {
  const safeTotal = Math.max(total, 0);
  const safeDone = Math.min(Math.max(done, 0), safeTotal);
  const percent = safeTotal === 0 ? 0 : Math.round((safeDone / safeTotal) * 100);
  const text = formatProgress(safeDone, safeTotal);
  return (
    <div className={cn('flex min-w-28 flex-col gap-1', className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={safeDone}
        aria-valuetext={text}
        className="h-1.5 overflow-hidden rounded-full bg-surface-alt"
      >
        <div className={cn('h-full rounded-full transition-[width]', late ? 'bg-late' : 'bg-primary')} style={{ width: `${percent}%` }} />
      </div>
      {compact ? null : <span className="tabular text-sm text-ink-sub">{text}</span>}
    </div>
  );
}
