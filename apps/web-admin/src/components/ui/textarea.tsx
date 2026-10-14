import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { controlClasses } from './input';

export function Textarea({ className, rows = 3, ...props }: ComponentProps<'textarea'>) {
  const field = useFieldControl();
  return <textarea rows={rows} className={cn(controlClasses, 'min-h-20 resize-y py-2 leading-normal', className)} {...field} {...props} />;
}
