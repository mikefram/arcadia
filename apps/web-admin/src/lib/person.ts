import type { PersonRef } from '@mihato/domain';
import { vi } from '@mihato/i18n';

type PersonLike = Pick<PersonRef, 'fullName' | 'givenName' | 'honorific'>;

export type PersonNameForm = 'full' | 'short';

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLocaleUpperCase('vi') + s.slice(1);
}

/**
 * Tên người kèm xưng hô (SPEC 7.5): lần đầu "chị Nguyễn Thu Lan" (`full`), sau đó "chị Lan" (`short`).
 * Tài khoản dùng chung không có xưng hô thì chỉ hiện tên. `capitalize` khi tên đứng đầu câu: "Chị Lan".
 */
export function personName(person: PersonLike, form: PersonNameForm = 'full', capitalize = false): string {
  const name = form === 'short' ? person.givenName || person.fullName : person.fullName;
  const text = person.honorific ? `${vi.common.honorific[person.honorific]} ${name}` : name;
  return capitalize ? capitalizeFirst(text) : text;
}
