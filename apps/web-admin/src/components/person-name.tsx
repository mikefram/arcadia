import type { PersonRef } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { personName, type PersonNameForm } from '@/lib/person';

export type PersonNameProps = {
  person: Pick<PersonRef, 'fullName' | 'givenName' | 'honorific'> | null | undefined;
  /** `full`: "chị Nguyễn Thu Lan" (mặc định, lần đầu nhắc tới). `short`: "chị Lan" */
  form?: PersonNameForm;
  /** viết hoa chữ đầu khi đứng đầu câu: "Chị Lan" */
  capitalize?: boolean;
  /** chữ hiện khi chưa có người; mặc định "Chưa có người nhận" */
  fallback?: string;
  className?: string;
};

/** Tên người kèm xưng hô (SPEC 7.5). Muốn lấy chuỗi (cho CSV, câu thông báo) thì dùng personName() ở @/lib/person. */
export function PersonName({ person, form = 'full', capitalize = false, fallback = vi.admin.shell.people.none, className }: PersonNameProps) {
  if (!person) return <span className={cn('text-ink-sub', className)}>{fallback}</span>;
  return <span className={className}>{personName(person, form, capitalize)}</span>;
}
