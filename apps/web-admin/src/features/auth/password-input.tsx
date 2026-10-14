import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { Input } from '@/components/ui/input';

const t = vi.admin.shell.ui;

/** Ô mật khẩu có nút hiện hoặc ẩn chữ. Dùng trong <Field>. */
export function PasswordInput(props: Omit<ComponentProps<'input'>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input type={shown ? 'text' : 'password'} className="pr-11" {...props} />
      <button
        type="button"
        aria-label={shown ? t.hidePassword : t.showPassword}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-sub transition-colors hover:bg-surface-alt hover:text-ink"
      >
        {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
      </button>
    </div>
  );
}
