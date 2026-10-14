/**
 * Chạm thông báo mở đúng màn hình (SPEC 10.9). Hàm thuần, có test.
 *   briefing → M1 Trang chủ; approval → M6 Việc cần quyết;
 *   proposal.office, proposal.failed → M3 Xem lại đề xuất (M3 tự hiện lý do khi đề xuất ở trạng thái `failed`).
 * Dữ liệu của thông báo: `{ type, link, notificationId, proposalId?, reason? }`.
 */
export type PushTarget = { screen: 'home' } | { screen: 'decisions' } | { screen: 'review'; proposalId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `mihato://proposal/{id}` hoặc `mihato-exec://proposal/{id}` → id của đề xuất. */
export function proposalIdFromLink(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/proposal\/([^/?#]+)/i.exec(link.trim());
  const id = m?.[1];
  return id && UUID_RE.test(id) ? id : null;
}

export function targetForNotification(data: unknown): PushTarget | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  switch (type) {
    case 'briefing':
      return { screen: 'home' };
    case 'approval':
    case 'approval_needed':
      return { screen: 'decisions' };
    case 'proposal.office':
    case 'proposal.failed': {
      const direct = typeof record.proposalId === 'string' && UUID_RE.test(record.proposalId) ? record.proposalId : null;
      const proposalId = direct ?? proposalIdFromLink(record.link);
      // Thiếu mã đề xuất thì mở Việc cần quyết: đề xuất đang chờ nằm ở đó.
      return proposalId ? { screen: 'review', proposalId } : { screen: 'decisions' };
    }
    default:
      return null;
  }
}

export function notificationIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as Record<string, unknown>).notificationId;
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
}
