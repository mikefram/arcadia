import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';

/**
 * primary    nút chính của màn hình hoặc hộp thoại (mỗi vùng chỉ một nút)
 * secondary  nút viền, mặc định
 * ghost      nút không viền trong thanh công cụ, hàng của bảng
 * danger     thao tác không hoàn tác được. Dùng màu mực đậm, KHÔNG dùng đỏ: đỏ nâu chỉ dành cho quá hạn
 * link       liên kết trong dòng chữ
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary hover:bg-primary-pressed active:bg-primary-pressed',
        secondary: 'border border-line bg-surface text-ink hover:bg-surface-alt active:bg-surface-alt',
        ghost: 'text-ink hover:bg-surface-alt active:bg-surface-alt',
        danger: 'bg-ink text-white hover:bg-ink-sub active:bg-ink-sub',
        link: 'rounded-sm text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-base',
        lg: 'h-12 px-5 text-lg',
        icon: 'size-10',
        'icon-sm': 'size-8',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0 font-medium' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** vẽ thành phần con (ví dụ <Link>) với kiểu của nút */
    asChild?: boolean;
    /** đang gửi: khoá nút và hiện vòng quay thay biểu tượng */
    loading?: boolean;
  };

export function Button({ className, variant, size, asChild = false, loading = false, disabled, type, onClick, children, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot.Root className={classes} onClick={onClick} {...props}>
        {children}
      </Slot.Root>
    );
  }
  // Khi đang gửi, nút dùng aria-disabled thay cho disabled để focus của người dùng bàn phím không bị mất;
  // lần bấm (kể cả Enter trong biểu mẫu) bị chặn để không gửi hai lần.
  return (
    <button
      type={type ?? 'button'}
      className={classes}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
      {children}
    </button>
  );
}
