import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import type { FormField } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { useCan } from '@/lib/auth';
import { useApiQuery } from '@/lib/query';
import { cleanRegisterCode, registerChoices } from './form-model';

const t = vi.admin.designer.editor.fields;

/**
 * Chọn sổ văn bản cho ô "Số văn bản tự cấp". Sổ lấy từ `registers.list` (tên và mẫu số); người chưa có quyền xem danh sách sổ
 * thì nhập mã sổ trực tiếp. Chưa có sổ nào thì báo và chỉ đường tới Cài đặt, mục Sổ văn bản.
 */
export function RegisterPicker({ field, onChange, disabled }: { field: FormField; onChange: (code: string | undefined) => void; disabled?: boolean }) {
  const can = useCan();
  const canList = can(['document.view', 'org.settings']);
  const registers = useApiQuery('registers.list', {}, { enabled: canList, staleTime: 5 * 60_000 });
  const items = registers.data?.items;
  const choices = useMemo(() => registerChoices(items ?? [], field.register), [items, field.register]);
  const picked = items?.find((r) => r.code === field.register);

  // Không xem được danh sách sổ (thiếu quyền, hoặc máy chủ không trả lời): nhập mã sổ trực tiếp.
  if (!canList || registers.isError) {
    return (
      <Field label={t.registerCode} hint={t.registerCodeHint}>
        <Input
          aria-label={fmt(t.registerCodeOf, { tên: field.label })}
          placeholder={t.registerCodePlaceholder}
          value={field.register ?? ''}
          maxLength={32}
          disabled={disabled}
          onChange={(e) => onChange(cleanRegisterCode(e.target.value))}
          className="h-9"
          data-testid="field-register-code"
        />
      </Field>
    );
  }

  if (registers.isPending) return <p className="text-sm text-ink-sub">{t.registerLoading}</p>;

  if (choices.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1 rounded-lg border border-hairline bg-surface-alt px-3 py-2.5 text-sm" data-testid="field-register-none">
        <p className="font-medium">{t.registersNone}</p>
        {can('org.settings') ? (
          <p>
            {t.registersNoneGo}{' '}
            <Link to="/cai-dat" className="font-medium underline underline-offset-2">
              {t.registersGo}
            </Link>
          </p>
        ) : (
          <p>{t.registersNoneAsk}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Field label={t.register}>
        <Select
          aria-label={fmt(t.registerOf, { tên: field.label })}
          placeholder={t.registerPlaceholder}
          value={field.register ?? null}
          options={choices}
          disabled={disabled}
          onValueChange={(code) => onChange(code ?? undefined)}
          className="h-9"
        />
      </Field>
      {picked ? <p className="text-sm text-ink-sub">{fmt(t.registerPattern, { mẫu: picked.pattern, số: picked.nextNumber })}</p> : field.register ? <p className="text-sm text-ink-sub">{t.registerUnknown}</p> : null}
    </div>
  );
}
