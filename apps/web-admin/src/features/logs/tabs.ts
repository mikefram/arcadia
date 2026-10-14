import type { Action } from '@mihato/domain';
import { vi } from '@mihato/i18n';

const t = vi.admin.org.logs.page.tabs;

/** Các tab của màn /nhat-ky và quyền cần có để thấy từng tab (SPEC 9.1, 9.2). */
export const LOG_TABS = [
  { to: '/nhat-ky/hoat-dong', label: t.audit, action: 'audit.view' },
  { to: '/nhat-ky/thong-bao', label: t.notifications, action: 'notification.audit' },
  { to: '/nhat-ky/tac-vu-loi', label: t.effects, action: 'effect.retry' },
  { to: '/nhat-ky/tro-ly', label: t.aiUsage, action: 'ai_usage.view' },
] as const satisfies readonly { to: string; label: string; action: Action }[];

export const LOG_ACTIONS: readonly Action[] = LOG_TABS.map((tab) => tab.action);
