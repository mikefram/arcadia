import { X } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { personName } from '@/lib/person';
import { PersonPicker, type PersonOption, type PickedPerson } from './person-picker';

const t = vi.admin.runs.form;

export type PeopleMultiPickerProps = {
  value: readonly PickedPerson[];
  onChange: (people: PickedPerson[]) => void;
  /** nhãn của ô, để đọc danh sách người đã chọn */
  label: string;
  placeholder?: string;
  disabled?: boolean | undefined;
  /** số người tối đa; đủ rồi thì ô tìm bị khoá */
  max?: number;
};

/**
 * Chọn nhiều người (ô `users` của biểu mẫu): gõ tên để tìm và thêm, người đã chọn hiện thành thẻ và bỏ chọn được.
 * Lồng trong <Field> để ô tìm nhận nhãn và câu lỗi.
 */
export function PeopleMultiPicker({ value, onChange, label, placeholder = t.usersPlaceholder, disabled = false, max }: PeopleMultiPickerProps) {
  const full = max !== undefined && value.length >= max;
  const add = (person: PersonOption | null) => {
    if (!person || value.some((p) => p.id === person.id)) return;
    onChange([...value, person]);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="people-multi">
      <PersonPicker value={null} onChange={add} placeholder={placeholder} excludeIds={value.map((p) => p.id)} disabled={disabled || full} />
      {value.length > 0 ? (
        <ul aria-label={fmt(t.usersSelectedLabel, { ô: label })} className="flex flex-wrap gap-2">
          {value.map((person) => (
            <li key={person.id} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface py-1 pr-1 pl-2.5">
              <span className="font-medium">{personName(person, 'full')}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={fmt(vi.admin.shell.people.clear, { tên: personName(person, 'short') })}
                onClick={() => onChange(value.filter((p) => p.id !== person.id))}
                className="inline-flex size-7 items-center justify-center rounded-md text-ink-sub transition-colors hover:bg-surface-alt hover:text-ink disabled:pointer-events-none disabled:opacity-50"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-sub">{t.usersNone}</p>
      )}
    </div>
  );
}
