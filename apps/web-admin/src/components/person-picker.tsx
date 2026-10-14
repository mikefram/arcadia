import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import type { RouteResponse } from '@mihato/api-client';
import type { PersonRef } from '@mihato/domain';
import { normalizeText, stripDiacritics } from '@mihato/domain/vi-normalize';
import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { useDebouncedValue } from '@/lib/hooks';
import { personName } from '@/lib/person';
import { useApiQuery } from '@/lib/query';
import { useFieldControl } from './ui/field';
import { controlClasses } from './ui/input';
import { Spinner } from './ui/spinner';

const t = vi.admin.shell.people;
const MAX_RESULTS = 8;

/** Một người trong kết quả `people.search`: PersonRef kèm đơn vị và chức danh. */
export type PersonOption = RouteResponse<'people.search'>['items'][number];
export type PickedPerson = PersonRef & { unitName?: string | null; roleTitle?: string | null };

export type PersonPickerProps = {
  value: PickedPerson | null;
  onChange: (person: PersonOption | null) => void;
  placeholder?: string;
  /** những người không cho chọn, ví dụ người đang nhận việc */
  excludeIds?: readonly string[];
  /** có thì chỉ chọn được trong danh sách này (gõ chữ chỉ lọc, không hỏi máy chủ); null hoặc bỏ trống: tìm trong cả tổ chức */
  candidates?: readonly PersonOption[] | null;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
};

/**
 * Ô tìm và chọn một người (`people.search`, tìm không phân biệt dấu). Điều khiển bằng phím:
 * mũi tên lên xuống để di chuyển, Enter để chọn, Esc để đóng danh sách.
 * Lồng trong <Field> để có nhãn và câu lỗi, hoặc truyền aria-label.
 */
export function PersonPicker({ value, onChange, placeholder = t.searchPlaceholder, excludeIds, candidates, disabled, id, className, 'aria-label': ariaLabel }: PersonPickerProps) {
  const field = useFieldControl();
  const listId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(text.trim(), 200);

  const search = useApiQuery(
    'people.search',
    { query: { q, limit: MAX_RESULTS + (excludeIds?.length ?? 0) } },
    { enabled: open && !value && !disabled && !candidates, staleTime: 60_000, placeholderData: (prev) => prev },
  );

  const options = useMemo(() => {
    const needle = stripDiacritics(normalizeText(text));
    const pool = candidates ? candidates.filter((p) => !needle || stripDiacritics(normalizeText(p.fullName)).includes(needle)) : (search.data?.items ?? []);
    return pool.filter((p) => !excludeIds?.includes(p.id)).slice(0, MAX_RESULTS);
  }, [candidates, text, search.data, excludeIds]);
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const activeId = open && options[activeIndex] ? `${listId}-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const pick = (person: PersonOption) => {
    onChange(person);
    setText('');
    setOpen(false);
  };

  const clear = () => {
    onChange(null);
    setText('');
    setActive(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (options.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
    } else if (e.key === 'Home' && open && options.length > 0) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && open && options.length > 0) {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' && open && !value) {
      const person = options[activeIndex];
      if (person) {
        e.preventDefault();
        // Danh sách đang hiện có thể còn là kết quả của chữ gõ trước (đang chờ tìm lại sau khi ngừng gõ): chưa chọn, kẻo chọn nhầm người.
        if (candidates || (text.trim() === q && !search.isPlaceholderData)) pick(person);
      }
    } else if (e.key === 'Escape' && open) {
      // Chỉ đóng danh sách, không đóng hộp thoại đang chứa ô này.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const shown = value ? personName(value, 'full') : text;
  const showList = open && !value && !disabled;

  return (
    <PopoverPrimitive.Root open={showList} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div ref={anchorRef} className={cn('relative', className)}>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label={ariaLabel}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={placeholder}
            value={shown}
            className={cn(controlClasses, 'h-10 pr-10 pl-9', value && 'font-medium')}
            {...field}
            {...(id ? { id } : {})}
            onChange={(e) => {
              if (value) onChange(null);
              setText(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            // Danh sách mở khi bấm, gõ chữ hoặc nhấn mũi tên xuống; không tự mở khi ô chỉ vừa nhận focus
            // (ví dụ lúc hộp thoại mở ra), để không che các ô bên dưới.
            onClick={() => {
              if (!value) setOpen(true);
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {value || text ? (
            <button
              type="button"
              aria-label={value ? fmt(t.clear, { tên: personName(value, 'short') }) : t.clearText}
              disabled={disabled}
              onClick={clear}
              className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-sub transition-colors hover:bg-surface-alt hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          role="none"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.target instanceof Node && anchorRef.current?.contains(e.target)) e.preventDefault();
          }}
          className="z-50 w-(--radix-popover-trigger-width) min-w-64 animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-pop"
        >
          <ul id={listId} role="listbox" aria-label={t.results}>
            {options.map((person, i) => (
              <li
                key={person.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                // Giữ focus ở ô nhập khi bấm chuột vào một dòng.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(person)}
                className={cn('flex flex-col rounded-md px-2.5 py-1.5', i === activeIndex && 'bg-surface-alt')}
              >
                <span className="font-medium text-ink">{personName(person, 'full')}</span>
                {person.roleTitle || person.unitName ? (
                  <span className="text-sm text-ink-sub">{[person.roleTitle, person.unitName].filter(Boolean).join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {options.length === 0 ? (
            <div className="px-2.5 py-2 text-base text-ink-sub">
              {candidates ? t.noMatch : search.isPending || search.isFetching ? <Spinner label={t.searching} showLabel /> : search.isError ? vi.admin.shell.errors.generic : t.noMatch}
            </div>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
