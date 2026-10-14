import { useRef, type ComponentProps } from 'react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import { cn } from '@/lib/cn';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

export function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn('z-50 min-w-48 animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-pop outline-none', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-base outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-alt [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-sub',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2.5 py-1.5 text-sm text-ink-sub', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-hairline', className)} {...props} />;
}

/**
 * Mở hộp thoại từ một mục của trình đơn. Việc mở được hoãn tới khi trình đơn đã đóng và focus đã về nút mở
 * trình đơn; nhờ vậy khi hộp thoại đóng, focus trở lại đúng nút đó thay vì rơi về đầu trang.
 *   const afterClose = useAfterMenuClose();
 *   <DropdownMenuContent onCloseAutoFocus={afterClose.flush}>
 *     <DropdownMenuItem onSelect={() => afterClose.run(() => setDialogOpen(true))}>…
 */
export function useAfterMenuClose(): { run: (action: () => void) => void; flush: () => void } {
  const pending = useRef<(() => void) | null>(null);
  return {
    run: (action) => {
      pending.current = action;
    },
    flush: () => {
      const action = pending.current;
      pending.current = null;
      if (action) setTimeout(action, 0);
    },
  };
}
