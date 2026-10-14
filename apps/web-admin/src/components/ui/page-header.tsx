import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type PageHeaderProps = {
  /** tiêu đề trang (h1), mỗi trang đúng một cái */
  title: ReactNode;
  description?: ReactNode;
  /** nút hành động, nút chính đặt cuối */
  actions?: ReactNode;
  /** đường về trang cha, đặt trên tiêu đề (ví dụ <Link> về danh sách) */
  back?: ReactNode;
  /** dòng phụ bên phải tiêu đề: ngày, thời điểm số liệu */
  meta?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, actions, back, meta, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        {back ? <div className="mb-1.5 text-sm">{back}</div> : null}
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-[72ch] text-base text-ink-sub">{description}</p> : null}
      </div>
      {meta || actions ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {meta ? <div className="text-sm text-ink-sub">{meta}</div> : null}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
