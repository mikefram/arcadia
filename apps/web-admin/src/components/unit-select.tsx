import { useMemo } from 'react';
import type { UnitView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { viCollator } from '@/lib/collator';
import { useApiQuery } from '@/lib/query';
import { Select, type SelectOption } from './ui/select';

const t = vi.admin.shell.units;

/** Trải cây đơn vị thành danh sách thụt bậc, anh em cùng cấp xếp theo thứ tự chữ cái tiếng Việt. */
export function flattenUnits(units: readonly UnitView[]): SelectOption[] {
  const byParent = new Map<string | null, UnitView[]>();
  const ids = new Set(units.map((u) => u.id));
  for (const u of units) {
    // Đơn vị có cha nằm ngoài tầm nhìn thì coi như gốc.
    const parent = u.parentId && ids.has(u.parentId) ? u.parentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(u);
    byParent.set(parent, list);
  }
  const out: SelectOption[] = [];
  const walk = (parent: string | null, depth: number) => {
    const children = [...(byParent.get(parent) ?? [])].sort((a, b) => viCollator.compare(a.name, b.name));
    for (const u of children) {
      out.push({ value: u.id, label: u.name, indent: depth });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export type UnitSelectProps = {
  value: string | null;
  onValueChange: (unitId: string | null) => void;
  /** thêm dòng "Tất cả đơn vị" (trả null) cho ô lọc */
  allowAll?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
};

/** Hộp chọn đơn vị theo cây (`units.list`). Lồng trong <Field> để có nhãn, hoặc truyền aria-label. */
export function UnitSelect({ value, onValueChange, allowAll = false, disabled, className, id, 'aria-label': ariaLabel }: UnitSelectProps) {
  const { data, isPending } = useApiQuery('units.list', {}, { staleTime: 5 * 60_000 });
  const options = useMemo(() => flattenUnits(data?.items ?? []), [data]);
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onValueChange={onValueChange}
      options={options}
      emptyOption={allowAll ? t.all : undefined}
      placeholder={isPending ? vi.common.loading : t.placeholder}
      disabled={disabled || isPending}
      className={className}
    />
  );
}
