import { LoaderCircle } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';

/** Vòng quay luôn đi kèm chữ (SPEC 7.5: không để vòng quay không chữ). `label` trống thì đọc "Đang tải…". */
export function Spinner({ label = vi.common.loading, showLabel = false, className }: { label?: string; showLabel?: boolean; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-ink-sub', className)}>
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      <span className={showLabel ? undefined : 'sr-only'}>{label}</span>
    </span>
  );
}
