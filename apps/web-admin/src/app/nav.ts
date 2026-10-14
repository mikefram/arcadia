import { BookText, ChartColumn, CirclePlay, ClipboardCheck, LayoutDashboard, ListTodo, ScrollText, Settings, Users, Workflow, type LucideIcon } from 'lucide-react';
import { TEMPLATE_VIEW_ACTIONS, type Action } from '@mihato/domain';
import { vi } from '@mihato/i18n';

const t = vi.admin.shell.nav;

export type NavItem = {
  to: '/' | '/viec-cua-toi' | '/luot-chay' | '/cong-viec' | '/quy-trinh' | '/so-van-ban' | '/bao-cao' | '/to-chuc' | '/nhat-ky' | '/cai-dat';
  label: string;
  icon: LucideIcon;
  /** hiện mục khi người dùng có một trong các quyền này; bỏ trống = mọi người đã đăng nhập */
  anyOf?: readonly Action[];
};

export type NavGroup = { label?: string; items: readonly NavItem[] };

/** Thanh bên: nhóm mục theo quyền (SPEC 9.1, 9.2). Bộ gác của từng route dùng đúng các quyền này. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    items: [
      { to: '/', label: t.overview, icon: LayoutDashboard, anyOf: ['overview.view'] },
      { to: '/viec-cua-toi', label: t.myTasks, icon: ClipboardCheck },
    ],
  },
  {
    label: t.groupCoordination,
    items: [
      { to: '/luot-chay', label: t.runs, icon: CirclePlay, anyOf: ['run.view_all'] },
      { to: '/cong-viec', label: t.tasks, icon: ListTodo, anyOf: ['run.view_all'] },
      { to: '/quy-trinh', label: t.templates, icon: Workflow, anyOf: TEMPLATE_VIEW_ACTIONS },
      { to: '/so-van-ban', label: t.documents, icon: BookText, anyOf: ['document.view', 'org.settings'] },
      { to: '/bao-cao', label: t.reports, icon: ChartColumn, anyOf: ['report.view'] },
    ],
  },
  {
    label: t.groupAdmin,
    items: [
      { to: '/to-chuc', label: t.org, icon: Users, anyOf: ['user.manage', 'holiday.manage'] },
      { to: '/nhat-ky', label: t.logs, icon: ScrollText, anyOf: ['audit.view', 'notification.audit'] },
      { to: '/cai-dat', label: t.settings, icon: Settings, anyOf: ['org.settings'] },
    ],
  },
];
