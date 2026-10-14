import type { ComponentProps, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Skeleton } from './skeleton';

/**
 * Dải thẻ số: các ô liền nhau, ngăn bằng đường kẻ mảnh như một dòng sổ, thay cho nhiều thẻ rời.
 *   <StatGroup aria-label="Các con số chính">
 *     <StatCard label="Việc quá hạn" value={5} tone="late" />
 *   </StatGroup>
 */
export function StatGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="group"
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3 xl:grid-cols-6 [&>*]:rounded-none [&>*]:border-0',
        className,
      )}
      {...props}
    />
  );
}

export type StatCardProps = {
  label: ReactNode;
  /** con số chính; để undefined khi đang tải */
  value: ReactNode | undefined;
  /** dòng nhỏ dưới con số */
  hint?: ReactNode;
  /** `late` chỉ cho số việc quá hạn và chỉ khi số đó lớn hơn 0 */
  tone?: 'default' | 'late' | 'warn';
  loading?: boolean;
  /** vẽ thành phần con (<Link>, <button>) làm ô bấm được; nội dung thẻ được chèn vào trong */
  asChild?: boolean;
  className?: string;
  children?: ReactNode;
};

export function StatCard({ label, value, hint, tone = 'default', loading, asChild, className, children }: StatCardProps) {
  const Comp = asChild ? Slot.Root : 'div';
  const color = tone === 'late' ? 'text-late' : tone === 'warn' ? 'text-warn' : null;
  return (
    <Comp
      className={cn(
        'relative flex min-h-[108px] flex-col rounded-xl border border-hairline bg-surface px-4 py-3.5 text-left',
        tone === 'late' && 'bg-late-bg',
        tone === 'warn' && 'bg-warn-bg',
        asChild && 'transition-colors -outline-offset-2 hover:bg-surface-alt',
        asChild && tone === 'late' && 'hover:bg-late-bg',
        asChild && tone === 'warn' && 'hover:bg-warn-bg',
        className,
      )}
    >
      <Slot.Slottable>{children}</Slot.Slottable>
      <span className={cn('text-sm font-medium', asChild && 'pr-5', color ?? 'text-ink-sub')}>{label}</span>
      {/* Ô bấm được có dấu mũi nhỏ ở góc để phân biệt với ô chỉ để xem. */}
      {asChild ? <ChevronRight aria-hidden="true" className={cn('absolute top-4 right-3 size-4', color ?? 'text-ink-sub')} /> : null}
      {loading || value === undefined ? <Skeleton className="mt-2 h-8 w-16" /> : <span className={cn('tabular mt-1 text-3xl font-semibold', color ?? 'text-ink')}>{value}</span>}
      {hint ? <span className={cn('mt-auto pt-1 text-sm', color ?? 'text-ink-sub')}>{hint}</span> : null}
    </Comp>
  );
}
