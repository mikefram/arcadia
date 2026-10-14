import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Lời báo tại chỗ trong trang hoặc hộp thoại.
 *   info     giải thích, hướng dẫn
 *   success  đã làm xong
 *   warn     cần lưu ý trước khi làm tiếp
 *   error    thao tác chưa làm được (viền mực đậm, không dùng đỏ)
 *   late     CHỈ cho nội dung về việc quá hạn
 */
const calloutVariants = cva('flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-base', {
  variants: {
    tone: {
      info: 'border-hairline bg-surface-alt text-ink',
      success: 'border-primary/30 bg-primary-tint text-on-primary-tint',
      warn: 'border-warn/30 bg-warn-bg text-warn',
      error: 'border-ink bg-surface text-ink',
      late: 'border-late/30 bg-late-bg text-late',
    },
  },
  defaultVariants: { tone: 'info' },
});

const ICONS: Record<NonNullable<VariantProps<typeof calloutVariants>['tone']>, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
  late: TriangleAlert,
};

export type CalloutProps = VariantProps<typeof calloutVariants> & {
  title?: ReactNode;
  children?: ReactNode;
  /** nút đặt bên phải */
  action?: ReactNode;
  className?: string;
  /** mốc cho kiểm thử trình duyệt; trước đây bị bỏ rơi nên `data-testid` truyền vào Callout không ra DOM */
  'data-testid'?: string;
};

export function Callout({ tone = 'info', title, children, action, className, 'data-testid': testId }: CalloutProps) {
  const Icon = ICONS[tone ?? 'info'];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn(calloutVariants({ tone }), className)} data-testid={testId}>
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-0.5' : undefined}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
