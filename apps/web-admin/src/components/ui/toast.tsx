import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';

type ToastTone = 'success' | 'error' | 'info';

export type ToastOptions = {
  /** dòng phụ dưới câu chính */
  description?: string;
  /** thời gian hiện, tính bằng mili giây; 0 = không tự đóng */
  duration?: number;
  /** một nút hành động, ví dụ "Thử lại" */
  action?: { label: string; onClick: () => void };
};

type ToastItem = ToastOptions & { id: number; tone: ToastTone; message: string; duration: number };

const DEFAULT_DURATION: Record<ToastTone, number> = { success: 5_000, info: 6_000, error: 9_000 };
const MAX_VISIBLE = 4;

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: readonly ToastItem[]): void {
  items = next;
  for (const fn of listeners) fn();
}

function push(tone: ToastTone, message: string, options: ToastOptions = {}): number {
  const id = nextId++;
  emit([...items, { ...options, id, tone, message, duration: options.duration ?? DEFAULT_DURATION[tone] }].slice(-MAX_VISIBLE));
  return id;
}

/**
 * Thông báo nổi ở góc màn hình, gọi được từ bất kỳ đâu (kể cả ngoài React):
 *   toast.success('Đã giao lại việc cho chị Lan.');
 *   toast.error(errorMessage(err));
 */
export const toast = {
  success: (message: string, options?: ToastOptions) => push('success', message, options),
  error: (message: string, options?: ToastOptions) => push('error', message, options),
  info: (message: string, options?: ToastOptions) => push('info', message, options),
  dismiss: (id: number) => emit(items.filter((t) => t.id !== id)),
};

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const ICON: Record<ToastTone, ReactNode> = {
  success: <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />,
  info: <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-sub" />,
  error: <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />,
};

function ToastRow({ item }: { item: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const start = () => {
    if (item.duration <= 0) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => toast.dismiss(item.id), item.duration);
  };
  const stop = () => clearTimeout(timer.current);

  useEffect(() => {
    if (item.duration > 0) timer.current = setTimeout(() => toast.dismiss(item.id), item.duration);
    return () => clearTimeout(timer.current);
  }, [item.id, item.duration]);

  return (
    <li
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={stop}
      onMouseLeave={start}
      onFocus={stop}
      onBlur={start}
      className={cn(
        'pointer-events-auto flex w-full animate-toast-in items-start gap-2.5 rounded-xl border px-3.5 py-3 text-base shadow-pop',
        item.tone === 'error' ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-ink',
      )}
    >
      {ICON[item.tone]}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.message}</p>
        {item.description ? <p className={cn('mt-0.5 text-sm', item.tone === 'error' ? 'text-white/85' : 'text-ink-sub')}>{item.description}</p> : null}
        {item.action ? (
          <button
            type="button"
            className={cn('mt-1.5 rounded-sm text-sm font-semibold underline underline-offset-4', item.tone === 'error' && 'outline-white')}
            onClick={() => {
              item.action?.onClick();
              toast.dismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={vi.admin.shell.ui.dismissToast}
        onClick={() => toast.dismiss(item.id)}
        className={cn(
          '-mt-0.5 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
          item.tone === 'error' ? 'text-white/85 outline-white hover:bg-white/15' : 'text-ink-sub hover:bg-surface-alt',
        )}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}

/** Vùng hiện thông báo nổi. Đặt một lần ở gốc ứng dụng. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items);
  return (
    <ol
      aria-live="polite"
      aria-label={vi.admin.shell.ui.toastRegion}
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px]"
    >
      {list.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </ol>
  );
}
