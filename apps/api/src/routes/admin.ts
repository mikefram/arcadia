import { getAiUsage, getReport, listAdminNotifications, listAuditLog, listEffects, retryEffect } from '@mihato/backend';
import type { Registrar } from '../registrar';

/** SPEC 9.2 "Thông báo và nhật ký", 9.6 báo cáo, 10.3 số liệu dùng AI (không có nội dung hội thoại). */
export function registerAdminRoutes(r: Registrar): void {
  r.user('admin.audit', ({ tx, ctx, input }) => listAuditLog(tx, ctx, input.query));
  r.user('admin.notifications', ({ tx, ctx, input }) => listAdminNotifications(tx, ctx, input.query));
  r.user('admin.effects', ({ tx, input }) => listEffects(tx, input.query));
  r.user('admin.effectRetry', ({ tx, viewer, input, meta }) => retryEffect(tx, viewer, input.params.id, meta));
  r.user('admin.aiUsage', ({ tx, ctx, input }) => getAiUsage(tx, ctx, input.query));
  r.user('reports.summary', ({ tx, ctx, viewer, input }) => getReport(tx, ctx, viewer, input.query));
}
