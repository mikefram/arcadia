import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export type EmptyStateProps = {
  icon?: LucideIcon;
  title: ReactNode;
  /** nói rõ làm gì tiếp theo */
  description?: ReactNode;
  /** nút hành động để bắt đầu */
  action?: ReactNode;
  className?: string;
};

/** Trạng thái rỗng hoặc lỗi tải: một câu nói rõ tình hình và một lời mời hành động. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-6 py-10 text-center', className)}>
      {Icon ? <Icon aria-hidden="true" className="mb-1 size-7 text-ink-sub" strokeWidth={1.5} /> : null}
      <p className="text-lg font-semibold text-ink">{title}</p>
      {description ? <p className="max-w-md text-base text-ink-sub">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
