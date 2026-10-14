import type { Me, PersonRef } from '@mihato/domain';
import { DEFAULT_ADDRESS, vi } from '@mihato/i18n';

type RoleGrant = Me['roles'][number];

/**
 * Cách trợ lý và app gọi người dùng (SPEC 6.6 điều 6): theo chức danh, không dùng "con", "cháu", "em".
 * Người có nhiều vai trò thì lấy vai trò cao nhất. Không thuộc nhóm điều hành thì dùng cách gọi mặc định.
 */
export function addressForRoles(roles: readonly RoleGrant[]): string {
  const byRole = vi.executive.address.byRole;
  for (const role of ['chairman', 'director', 'deputy'] as const) {
    if (roles.some((r) => r.role === role)) return byRole[role];
  }
  return DEFAULT_ADDRESS;
}

const honorificWord = (h: PersonRef['honorific']): string => (h ? vi.common.honorific[h] : '');

/** "chị Nguyễn Thu Lan": cách viết lần đầu nhắc tới một người (SPEC 7.5). */
export function fullPersonName(p: Pick<PersonRef, 'fullName' | 'honorific'>): string {
  return [honorificWord(p.honorific), p.fullName].filter(Boolean).join(' ');
}

/** "chị Lan": cách viết từ lần thứ hai. Tài khoản không có xưng hô (tài khoản dùng chung) thì giữ tên đầy đủ. */
export function shortPersonName(p: Pick<PersonRef, 'fullName' | 'givenName' | 'honorific'>): string {
  return p.honorific ? `${honorificWord(p.honorific)} ${p.givenName}` : p.fullName;
}

/**
 * Bộ đặt tên cho một màn hình: lần đầu "chị Nguyễn Thu Lan", sau đó "chị Lan" (SPEC 7.5).
 * Hai người trùng tên gọi và xưng hô (hai "chị Lan") thì luôn viết đủ họ tên để không lẫn.
 */
export function createNamer(people: readonly (PersonRef | null | undefined)[] = []): (p: PersonRef) => string {
  const shortCount = new Map<string, Set<string>>();
  for (const p of people) {
    if (!p) continue;
    const key = shortPersonName(p);
    const ids = shortCount.get(key) ?? new Set<string>();
    ids.add(p.id);
    shortCount.set(key, ids);
  }
  const seen = new Set<string>();
  return (p) => {
    const ambiguous = (shortCount.get(shortPersonName(p))?.size ?? 1) > 1;
    if (seen.has(p.id) && !ambiguous) return shortPersonName(p);
    seen.add(p.id);
    return fullPersonName(p);
  };
}

/** Viết hoa chữ cái đầu câu (tiếng Việt có dấu): "ông Huy" → "Ông Huy". */
export function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1) : text;
}
