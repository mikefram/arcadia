import { listNotifications, markNotificationOpened, markNotificationsRead } from '@mihato/backend';
import type { Registrar } from '../registrar';

/** SPEC 10.9: tin của chính mình. Bản tin sáng (briefings.latest) nằm ở routes/proposals.ts cùng phần AI. */
export function registerNotificationRoutes(r: Registrar): void {
  r.user('notifications.list', ({ tx, viewer, input }) => listNotifications(tx, viewer, input.query));
  r.user('notifications.read', async ({ tx, viewer, input }) => {
    await markNotificationsRead(tx, viewer, input.body);
    return { ok: true };
  });
  r.user('notifications.opened', async ({ tx, viewer, input }) => {
    await markNotificationOpened(tx, viewer, input.params.id);
    return { ok: true };
  });
}
