import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Khối giữ chỗ khi đang tải. Vùng chứa nên có aria-busy; khối này tự ẩn với trình đọc màn hình. */
export function Skeleton({ className, ...props }: ComponentProps<'span'>) {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded-md bg-surface-alt', className)} {...props} />;
}
