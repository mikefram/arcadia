import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from './field';

/** Kiểu chung của ô nhập. Trên màn hình chạm chữ là 16px để iOS không tự phóng to khi focus. */
export const controlClasses =
  'w-full rounded-lg border border-line bg-surface px-3 text-base text-ink transition-colors pointer-coarse:text-lg placeholder:text-ink-sub/80 hover:border-ink disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-alt disabled:text-ink-sub aria-invalid:border-ink aria-invalid:ring-1 aria-invalid:ring-ink';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  const field = useFieldControl();
  return <input type={type} className={cn(controlClasses, 'h-10', className)} {...field} {...props} />;
}
