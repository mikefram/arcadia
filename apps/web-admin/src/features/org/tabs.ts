import type { Action } from '@mihato/domain';
import { vi } from '@mihato/i18n';

const t = vi.admin.org.page.tabs;

/**
 * Các tab của màn /to-chuc và quyền cần có để thấy từng tab (SPEC 9.1). Thứ tự này cũng là thứ tự chọn tab
 * mặc định khi mở /to-chuc: Quản trị hệ thống vào "Người dùng", Văn phòng vào "Ngày nghỉ".
 */
export const ORG_TABS = [
  { to: '/to-chuc/nguoi-dung', label: t.users, action: 'user.manage' },
  { to: '/to-chuc/don-vi', label: t.units, action: 'unit.manage' },
  { to: '/to-chuc/uy-quyen', label: t.delegations, action: 'delegation.manage' },
  { to: '/to-chuc/ngay-nghi', label: t.holidays, action: 'holiday.manage' },
  { to: '/to-chuc/phan-quyen', label: t.permissions, action: 'permission.manage' },
] as const satisfies readonly { to: string; label: string; action: Action }[];

export const ORG_ACTIONS: readonly Action[] = ORG_TABS.map((tab) => tab.action);
