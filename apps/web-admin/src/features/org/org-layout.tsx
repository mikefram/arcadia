import { Outlet } from '@tanstack/react-router';
import { vi } from '@mihato/i18n';
import { PageHeader } from '@/components/ui/page-header';
import { useCan } from '@/lib/auth';
import { RouteTabs } from './route-tabs';
import { ORG_TABS } from './tabs';

const t = vi.admin.org.page;

/** Khung của màn "Người dùng và tổ chức" (SPEC 9.2): tiêu đề, dải tab theo quyền, rồi tab đang mở. */
export function OrgLayout() {
  const can = useCan();
  const tabs = ORG_TABS.filter((tab) => can(tab.action));
  return (
    <>
      <PageHeader title={t.title} description={t.description} className="mb-4" />
      <RouteTabs label={t.tabsLabel} tabs={tabs} />
      <Outlet />
    </>
  );
}
