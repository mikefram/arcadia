import { createContext, use, useId, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { Label } from './label';

type FieldContextValue = {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
};

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Thuộc tính trợ năng mà <Field> truyền xuống ô nhập bên trong. Input, Textarea, Select, PersonPicker
 * tự đọc nên chỉ cần lồng vào <Field>. Thuộc tính truyền thẳng cho ô nhập thắng thuộc tính của Field.
 */
export function useFieldControl(): Partial<FieldContextValue> {
  return use(FieldContext) ?? {};
}

export type FieldProps = {
  label: ReactNode;
  /** dòng gợi ý dưới nhãn */
  hint?: ReactNode;
  /** câu báo lỗi; có thì ô nhập mang aria-invalid và câu lỗi được đọc lên */
  error?: ReactNode;
  required?: boolean;
  /** ẩn nhãn khỏi mắt nhưng vẫn đọc được (ô lọc trong thanh công cụ) */
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * Nhãn, gợi ý và câu lỗi của một ô nhập:
 *   <Field label="Lý do" error={errors.reason?.message} required>
 *     <Textarea {...register('reason')} />
 *   </Field>
 */
export function Field({ label, hint, error, required, hideLabel, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
        {required ? <span className="font-normal text-ink-sub"> ({vi.admin.shell.ui.required})</span> : null}
      </Label>
      {hint ? (
        <p id={hintId} className="-mt-0.5 text-sm text-ink-sub">
          {hint}
        </p>
      ) : null}
      <FieldContext value={{ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, 'aria-required': required ? true : undefined }}>
        {children}
      </FieldContext>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/** Câu lỗi của ô nhập: có hình và chữ đậm, không dựa vào màu (đỏ nâu chỉ dành cho việc quá hạn). */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-sm font-medium text-ink">
      <CircleAlert aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
