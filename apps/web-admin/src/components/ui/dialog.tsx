import { useRef, type ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn('fixed inset-0 z-40 animate-fade-in bg-scrim', className)} {...props} />;
}

const contentVariants = cva(
  'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 animate-dialog-in flex-col rounded-2xl border border-line bg-surface shadow-dialog outline-none',
  {
    variants: { size: { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'h-[calc(100dvh-2rem)] max-w-6xl' } },
    defaultVariants: { size: 'md' },
  },
);

/**
 * Trả focus về phần tử đã mở hộp thoại. Radix chỉ tự làm việc này khi dùng <DialogTrigger>;
 * hộp thoại mở bằng trạng thái (open/onOpenChange) thì focus sẽ rơi về đầu trang nếu không có đoạn này.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const target = opener.current;
      opener.current = null;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
  };
}

export type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof contentVariants> & { hideClose?: boolean };

/**
 * Hộp thoại giữa màn hình. Bên trong xếp: DialogHeader (DialogTitle bắt buộc, DialogDescription),
 * DialogBody (phần cuộn được), DialogFooter (nút chính đặt cuối).
 */
export function DialogContent({ className, size, hideClose, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: DialogContentProps) {
  const returnFocus = useReturnFocus();
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(contentVariants({ size }), className)}
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

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-6 pt-5 pr-14 pb-4', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-xl font-semibold text-ink', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-base text-ink-sub', className)} {...props} />;
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-1 pb-5', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col-reverse gap-2 border-t border-hairline bg-canvas px-6 py-3.5 sm:flex-row sm:items-center sm:justify-end', 'rounded-b-2xl', className)} {...props} />
  );
}
