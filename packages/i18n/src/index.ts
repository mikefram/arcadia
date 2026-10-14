/**
 * Chuỗi giao diện tiếng Việt (CLAUDE.md luật 7): mọi chữ người dùng thấy nằm ở gói này.
 * Kho: vi.common, vi.errors (mỗi mã lỗi API một câu), vi.notifications (chữ thông báo do máy chủ dựng),
 * vi.staff (app nhân viên), vi.executive (app Chủ tịch), vi.timeline (câu của dòng thời gian), vi.admin.* (web quản trị).
 */
import { adminDesigner } from './vi/admin/designer';
import { adminDocuments } from './vi/admin/documents';
import { adminOrg } from './vi/admin/org';
import { adminRuns } from './vi/admin/runs';
import { adminShell } from './vi/admin/shell';
import { common } from './vi/common';
import { errors } from './vi/errors';
import { executive } from './vi/executive';
import { notifications } from './vi/notifications';
import { server } from './vi/server';
import { staff } from './vi/staff';
import { timeline } from './vi/timeline';

export const vi = {
  common,
  errors,
  notifications,
  staff,
  executive,
  timeline,
  /** câu do máy chủ dựng: câu xác nhận đề xuất, báo cáo đầu ngày */
  server,
  admin: { shell: adminShell, runs: adminRuns, designer: adminDesigner, org: adminOrg, documents: adminDocuments },
} as const;

export { fmt } from './fmt';
export * from './format';
export { DEFAULT_ADDRESS, fmtExecutive } from './vi/executive';
export { NOTIFICATION_VARIABLES } from './vi/notifications';
export { BANNED_WORDS, findBannedWords, type BannedWord } from './banned';
