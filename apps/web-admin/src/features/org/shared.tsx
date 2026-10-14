import { useMemo, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ApiError } from '@mihato/api-client';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { flattenUnits } from '@/components/unit-select';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { useApiQuery } from '@/lib/query';

/** Lời báo "chưa tải được dữ liệu" kèm nút thử lại, dùng ở mọi tab của các màn quản trị. */
export function LoadError({ error, onRetry, className }: { error: unknown; onRetry: () => void; className?: string }) {
  return (
    <Callout
      tone="error"
      title={vi.admin.shell.ui.loadFailedTitle}
      className={className}
      action={
        <Button size="sm" onClick={onRetry}>
          {vi.admin.shell.ui.retry}
        </Button>
      }
    >
      {errorMessage(error)}
    </Callout>
  );
}

const CHIP_TONE = {
  /** trạng thái thường: nền trắng viền xám */
  plain: 'border border-line bg-surface text-ink',
  /** trạng thái tốt, đang chạy: nền xanh nhạt */
  good: 'bg-primary-tint text-on-primary-tint',
  /** đã tắt, đã hết: nền phụ, chữ phụ */
  muted: 'bg-surface-alt text-ink-sub',
  /** cần lưu ý */
  warn: 'bg-warn-bg text-warn',
} as const;

/** Nhãn trạng thái có hình và chữ (không chỉ dựa vào màu). Không có tông đỏ nâu: màu đó chỉ dành cho việc quá hạn. */
export function StateChip({ tone = 'plain', icon: Icon, children, className }: { tone?: keyof typeof CHIP_TONE; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-sm font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0', CHIP_TONE[tone], className)}>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Mã lỗi của một ô mà máy chủ trả kèm `input_invalid` hoặc `state_conflict` (errors[].path, errors[].code). */
export function fieldIssue(err: unknown, path: string): string | null {
  if (!(err instanceof ApiError)) return null;
  return err.extra.errors?.find((e) => e.path === path)?.code ?? null;
}

/** Chép chữ vào bộ nhớ tạm rồi báo kết quả; trình duyệt chặn thì nhắc người dùng chép tay. */
export async function copyText(text: string, okMessage: string, failMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMessage);
  } catch {
    toast.info(failMessage);
  }
}

/** Tên đơn vị theo id, để hiện phạm vi của vai trò và đối tượng trong nhật ký. */
export function useUnitNames(): Map<string, string> {
  const { data } = useApiQuery('units.list', {}, { staleTime: 5 * 60_000 });
  return useMemo(() => new Map((data?.items ?? []).map((u) => [u.id, u.name])), [data]);
}

export type UnitPickerProps = {
  value: string | null;
  onValueChange: (unitId: string | null) => void;
  /** chữ của lựa chọn "không chọn đơn vị nào" (trả null), ví dụ "Toàn tổ chức" */
  emptyOption: string;
  /** các đơn vị không cho chọn, ví dụ chính đơn vị đang sửa và các đơn vị con của nó */
  excludeIds?: ReadonlySet<string>;
  disabled?: boolean;
  'aria-label'?: string;
};

/**
 * Hộp chọn đơn vị theo cây, có lựa chọn trống mang chữ riêng. <UnitSelect> của khung chỉ có "Tất cả đơn vị",
 * không hợp với ô "Đơn vị cha" hay "Phạm vi của vai trò".
 */
export function UnitPicker({ value, onValueChange, emptyOption, excludeIds, disabled, 'aria-label': ariaLabel }: UnitPickerProps) {
  const { data, isPending } = useApiQuery('units.list', {}, { staleTime: 5 * 60_000 });
  const options = useMemo(() => flattenUnits(data?.items ?? []).filter((o) => !excludeIds?.has(o.value)), [data, excludeIds]);
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      onValueChange={onValueChange}
      options={options}
      emptyOption={emptyOption}
      placeholder={isPending ? vi.common.loading : undefined}
      disabled={disabled || isPending}
    />
  );
}
