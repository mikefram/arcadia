import { Link, type LinkProps } from '@tanstack/react-router';

export type RouteTab = { to: NonNullable<LinkProps['to']>; label: string };

/**
 * Dải tab mà mỗi tab là một route con: đường dẫn giữ được tab đang mở, và nút Quay lại của trình duyệt đi đúng tab.
 * Kiểu chữ giống <TabsList> của bộ thành phần. Dùng chung cho /to-chuc và /nhat-ky.
 */
export function RouteTabs({ label, tabs }: { label: string; tabs: readonly RouteTab[] }) {
  return (
    <nav aria-label={label} className="mb-5 flex gap-1 overflow-x-auto border-b border-hairline">
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className="-mb-px inline-flex h-10 shrink-0 items-center border-b-2 border-transparent px-3 text-base font-medium whitespace-nowrap text-ink-sub transition-colors -outline-offset-2 hover:text-ink data-[status=active]:border-primary data-[status=active]:font-semibold data-[status=active]:text-primary"
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
