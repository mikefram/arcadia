import { Outlet } from '@tanstack/react-router';
import { vi } from '@mihato/i18n';
import { PageHeader } from '@/components/ui/page-header';
import { RouteTabs } from '@/features/org/route-tabs';
import { useCan } from '@/lib/auth';
import { LOG_TABS } from './tabs';

const t = vi.admin.org.logs.page;

/** Khung của màn "Thông báo và nhật ký" (SPEC 9.2): tiêu đề, dải tab theo quyền, rồi tab đang mở. */
export function LogsLayout() {
  const can = useCan();
  const tabs = LOG_TABS.filter((tab) => can(tab.action));
  return (
    <>
      <PageHeader title={t.title} description={t.description} className="mb-4" />
      <RouteTabs label={t.tabsLabel} tabs={tabs} />
      <Outlet />
    </>
  );
}
