import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Nhãn nhỏ. `late` CHỈ dùng cho quá hạn; `warn` cho đến hạn hôm nay và lời lưu ý.
 * `count` là số đếm trên nền vàng đồng (chuông thông báo, số việc đã chọn).
 */
const badgeVariants = cva('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0', {
  variants: {
    tone: {
      neutral: 'border border-line bg-surface text-ink',
      muted: 'bg-surface-alt text-ink-sub',
      primary: 'bg-primary-tint text-on-primary-tint',
      gold: 'bg-gold-tint text-gold',
      warn: 'bg-warn-bg text-warn',
      late: 'bg-late-bg text-late',
      count: 'tabular min-w-5 justify-center rounded-full bg-gold px-1.5 text-xs font-semibold text-white',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
