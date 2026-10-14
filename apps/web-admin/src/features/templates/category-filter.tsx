import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { CATEGORY_ORDER, type CategoryCounts, type CategoryFilter } from './template-categories';

const t = vi.admin.designer.list;

const OPTIONS: readonly CategoryFilter[] = ['all', ...CATEGORY_ORDER];

export type CategoryFilterBarProps = {
  value: CategoryFilter;
  onChange: (value: CategoryFilter) => void;
  counts: CategoryCounts;
};

/**
 * Thanh lọc theo nhóm: "Tất cả" và tám nhóm, mỗi mục kèm số quy trình. Là nhóm nút bật tắt (aria-pressed), không phải tab,
 * vì bảng bên dưới là một, chỉ đổi dòng hiện. Nhóm trống vẫn hiện (số 0) để người dùng biết nhóm đó có tồn tại.
 */
export function CategoryFilterBar({ value, onChange, counts }: CategoryFilterBarProps) {
  return (
    <div role="group" aria-label={t.categoryFilter} className="mb-3 flex flex-wrap gap-2" data-testid="category-tabs">
      {OPTIONS.map((id) => {
        const label = id === 'all' ? t.categoryAll : t.category[id];
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            data-testid={`category-${id}`}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-base font-medium transition-colors',
              active ? 'border-primary bg-primary-tint font-semibold text-on-primary-tint' : 'border-line bg-surface text-ink hover:bg-surface-alt',
            )}
          >
            {label}
            <span aria-hidden="true" className={cn('tabular text-sm', active ? 'text-on-primary-tint' : 'text-ink-sub')}>
              {counts[id]}
            </span>
            <span className="sr-only">{fmt(t.categoryCountSr, { n: counts[id] })}</span>
          </button>
        );
      })}
    </div>
  );
}
