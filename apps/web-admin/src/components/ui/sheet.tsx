import type { ComponentProps } from 'react';
import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { DialogOverlay, useReturnFocus } from './dialog';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export type SheetContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** mặc định trượt từ phải; `left` dùng cho trình đơn trên điện thoại */
  side?: 'right' | 'left';
  hideClose?: boolean;
};

/** Bảng trượt cạnh màn hình: xem chi tiết một dòng mà không rời danh sách. */
export function SheetContent({ className, side = 'right', hideClose, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: SheetContentProps) {
  const returnFocus = useReturnFocus();
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-full max-w-[520px] flex-col bg-surface shadow-dialog outline-none',
          side === 'right' ? 'right-0 animate-sheet-right border-l border-line' : 'left-0 animate-sheet-left border-r border-line',
          className,
        )}
        onOpenAutoFocus={(e) => {
          returnFocus.onOpenAutoFocus();
          onOpenAutoFocus?.(e);
        }}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented) returnFocus.onCloseAutoFocus(e);
        }}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            aria-label={vi.admin.shell.ui.close}
            className="absolute top-3.5 right-3.5 inline-flex size-8 items-center justify-center rounded-lg text-ink-sub transition-colors hover:bg-surface-alt hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 border-b border-hairline px-6 pt-5 pr-14 pb-4', className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-xl font-semibold text-ink', className)} {...props} />;
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-base text-ink-sub', className)} {...props} />;
}

export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5', className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 border-t border-hairline bg-canvas px-6 py-3.5 sm:flex-row sm:justify-end', className)} {...props} />;
}
