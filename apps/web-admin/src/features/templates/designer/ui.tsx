import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

/** Một khối của bảng thuộc tính. `collapsible`: thu gọn được, dùng cho các tuỳ chọn ít khi cần. */
export function Section({
  title,
  hint,
  badge,
  collapsible = false,
  defaultOpen = true,
  children,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** nhãn nhỏ cạnh tiêu đề, ví dụ số ô đã có */
  badge?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const shown = !collapsible || open;
  return (
    <section className={cn('border-t border-hairline px-4 py-3.5 first:border-t-0', className)}>
      {collapsible ? (
        <h3>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
            className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-left text-base font-semibold hover:bg-surface-alt"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{title}</span>
              {badge}
            </span>
            <ChevronDown aria-hidden="true" className={cn('size-4 shrink-0 text-ink-sub transition-transform', open && 'rotate-180')} />
          </button>
        </h3>
      ) : (
        <h3 className="flex items-center gap-2 text-base font-semibold">
          {title}
          {badge}
        </h3>
      )}
      {shown ? (
        <div id={bodyId} className="mt-2.5 flex flex-col gap-3">
          {hint ? <p className="-mt-1.5 text-sm text-ink-sub">{hint}</p> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Nút chỉ có hình, kèm nhãn cho trình đọc màn hình và chú thích khi rê chuột. */
export function IconButton({ label, children, className, ...props }: { label: string } & Omit<ComponentProps<typeof Button>, 'aria-label'>) {
  return (
    <Tooltip content={label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} className={cn('text-ink-sub hover:text-ink', className)} {...props}>
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * Ô nhập số nguyên. Giữ chữ đang gõ ở trạng thái riêng để gõ được ô trống hoặc dấu trừ;
 * chỉ báo ra ngoài khi là số hợp lệ, rời ô thì trả về số đang lưu.
 */
export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  className,
  ...props
}: { value: number; onValueChange: (value: number) => void; min?: number; max?: number } & Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type' | 'min' | 'max'>) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      inputMode="numeric"
      className={cn('tabular', className)}
      value={text ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d-]/g, '');
        setText(raw);
        if (!/^-?\d+$/.test(raw)) return;
        let n = Number(raw);
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        if (Number.isSafeInteger(n)) onValueChange(n);
      }}
      onBlur={() => setText(null)}
      {...props}
    />
  );
}

/** Công tắc bật tắt kèm nhãn và dòng giải thích; bấm vào nhãn cũng bật tắt được. */
export function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
  testId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-describedby={hint ? `${id}-hint` : undefined} className="mt-0.5" data-testid={testId} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-base font-medium">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-ink-sub">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
