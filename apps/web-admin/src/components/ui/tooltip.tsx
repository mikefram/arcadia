import type { ComponentProps, ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/cn';

/** Đặt một lần ở gốc ứng dụng. */
export const TooltipProvider = TooltipPrimitive.Provider;

export type TooltipProps = {
  /** chữ của chú thích */
  content: ReactNode;
  /** phần tử được chú thích: phải nhận focus được (nút, liên kết) */
  children: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
};

/**
 * Chú thích khi rê chuột hoặc focus. Chỉ để bổ sung: nút chỉ có biểu tượng vẫn phải có aria-label riêng.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn('z-50 max-w-72 animate-fade-in rounded-md bg-ink px-2.5 py-1.5 text-sm text-white shadow-pop')}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
