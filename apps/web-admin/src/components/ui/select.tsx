import type { ComponentProps } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { controlClasses } from './input';

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  const field = useFieldControl();
  return (
    <SelectPrimitive.Trigger
      className={cn(controlClasses, 'flex h-10 items-center justify-between gap-2 text-left data-placeholder:text-ink-sub [&>span]:truncate', className)}
      {...field}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-sub" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          'z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) animate-pop-in overflow-hidden rounded-lg border border-line bg-surface shadow-pop',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="max-h-80 p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex min-h-9 items-center rounded-md py-1.5 pr-8 pl-2.5 text-base outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-alt data-[state=checked]:font-medium',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center">
        <Check aria-hidden="true" className="size-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean; /** bậc thụt vào, cho cây đơn vị */ indent?: number };

const NONE = '__none__';

export type SelectProps = {
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  /** thêm một dòng đầu, chọn thì trả null (ví dụ "Tất cả đơn vị") */
  emptyOption?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
};

/**
 * Hộp chọn một giá trị:
 *   <Select value={state} onValueChange={setState} options={[{ value: 'running', label: 'Đang chạy' }]} emptyOption="Tất cả" />
 */
export function Select({ value, onValueChange, options, placeholder, emptyOption, disabled, className, id, 'aria-label': ariaLabel }: SelectProps) {
  const rootValue = value ?? (emptyOption !== undefined ? NONE : '');
  return (
    <SelectRoot value={rootValue} onValueChange={(v) => onValueChange(v === NONE ? null : v)} disabled={disabled}>
      {/* Chỉ truyền id và aria-label khi có: giá trị undefined sẽ đè id mà <Field> cấp và làm ô chọn mất nhãn. */}
      <SelectTrigger {...(id ? { id } : {})} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {emptyOption !== undefined ? <SelectItem value={NONE}>{emptyOption}</SelectItem> : null}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} style={o.indent ? { paddingLeft: `${0.625 + o.indent * 0.875}rem` } : undefined}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
