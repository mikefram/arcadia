import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { FORM_FIELD_TYPES, type FormField } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/features/templates/field-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { newField, retypeField, tidyField, type FieldType } from './form-model';
import { slugKey } from './model';
import { RegisterPicker } from './register-picker';
import { IconButton } from './ui';

const t = vi.admin.designer.editor.fields;

function isType(v: string | null, allowed: readonly FieldType[]): v is FieldType {
  return v !== null && (allowed as readonly string[]).includes(v);
}

/** Các lựa chọn của ô "Chọn trong danh sách": mỗi dòng một lựa chọn, giá trị lưu chính là chữ hiển thị. */
function OptionsInput({ field, onChange }: { field: FormField; onChange: (options: FormField['options']) => void }) {
  const [text, setText] = useState(() => (field.options ?? []).map((o) => o.label).join('\n'));
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {t.options}
      </label>
      <Textarea
        id={id}
        rows={3}
        aria-label={fmt(t.optionsOf, { tên: field.label })}
        aria-describedby={`${id}-hint`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const lines = [...new Set(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))];
          onChange(lines.map((l) => ({ value: l, label: l })));
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-ink-sub">
        {t.optionsHint}
      </p>
    </div>
  );
}

/** Dòng chú thích dưới ô. Ô nào chưa có chú thích thì chỉ hiện nút "Thêm chú thích", để biểu mẫu dài không rối. */
function HintInput({ id, field, onChange }: { id: string; field: FormField; onChange: (hint: string) => void }) {
  const [open, setOpen] = useState(field.hint !== undefined);
  const ref = useRef<HTMLInputElement>(null);
  if (!open) {
    return (
      <Button
        variant="link"
        size="sm"
        className="self-start text-sm"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => ref.current?.focus());
        }}
        data-testid="field-hint-add"
      >
        <Plus aria-hidden="true" />
        {t.hintAdd}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {fmt(t.hintOf, { tên: field.label })}
      </label>
      <Input id={id} ref={ref} value={field.hint ?? ''} maxLength={300} placeholder={t.hintPlaceholder} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" data-testid="field-hint" />
    </div>
  );
}

export type FormFieldsEditorProps = {
  fields: readonly FormField[];
  onChange: (fields: FormField[]) => void;
  /** khoá của ô đang là mốc đích: hiện nhãn và không cho bỏ "Bắt buộc" */
  targetKey?: string;
  emptyText: string;
  /** tiền tố data-testid, để phân biệt biểu mẫu khởi chạy và biểu mẫu kết quả */
  testId: string;
  /** loại ô không cho chọn ở biểu mẫu này (ví dụ số văn bản tự cấp không hợp với phần mỗi người điền) */
  excludeTypes?: readonly FieldType[];
};

/**
 * Soạn một biểu mẫu (biểu mẫu khởi chạy của quy trình, biểu mẫu kết quả của một việc, phần mỗi người điền ở bước góp nội dung):
 * thêm, sửa, xoá, sắp thứ tự. Mã ô sinh từ tên lúc thêm và giữ nguyên về sau, vì người nhận, mốc đích và điều kiện rẽ nhánh tham chiếu tới mã.
 */
export function FormFieldsEditor({ fields, onChange, targetKey, emptyText, testId, excludeTypes }: FormFieldsEditorProps) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [error, setError] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const newId = useId();

  const types = FORM_FIELD_TYPES.filter((x) => !excludeTypes?.includes(x));
  const typeOptions = types.map((x) => ({ value: x, label: t.types[x] }));
  const typeHint = (t.typeHints as Partial<Record<FieldType, string>>)[type];

  const update = (index: number, patch: Partial<FormField>) => {
    onChange(
      fields.map((f, i) => {
        if (i !== index) return f;
        return tidyField({ ...f, ...patch });
      }),
    );
  };
  const retype = (index: number, next: FieldType) => onChange(fields.map((f, i) => (i === index ? retypeField(f, next) : f)));
  const move = (index: number, delta: -1 | 1) => {
    const next = [...fields];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  const add = () => {
    const name = label.trim();
    if (!name) {
      setError(true);
      labelRef.current?.focus();
      return;
    }
    const key = slugKey(name, new Set(fields.map((f) => f.key)));
    onChange([...fields, newField(key, name, type)]);
    setLabel('');
    setType(types.includes('text') ? 'text' : (types[0] ?? 'text'));
    setError(false);
    labelRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {fields.length === 0 ? <p className="text-sm text-ink-sub">{emptyText}</p> : null}
      <ul className="flex flex-col gap-2">
        {fields.map((f, i) => {
          const isTarget = targetKey !== undefined && f.key === targetKey;
          const requiredId = `${newId}-req-${i}`;
          const multipleId = `${newId}-multi-${i}`;
          const hintId = `${newId}-hint-${i}`;
          // Loại đã lưu mà biểu mẫu này không cho chọn nữa vẫn hiện được, để ô không trống.
          const rowOptions = typeOptions.some((o) => o.value === f.type) ? typeOptions : [...typeOptions, { value: f.type, label: t.types[f.type] }];
          return (
            <li key={f.key} className="flex flex-col gap-2 rounded-lg border border-hairline bg-canvas p-2.5" data-testid={`${testId}-row`}>
              <div className="flex items-center gap-1">
                <Input aria-label={fmt(t.labelOf, { n: i + 1 })} value={f.label} onChange={(e) => update(i, { label: e.target.value })} className="h-9 min-w-0 flex-1" />
                <IconButton label={fmt(t.moveUp, { tên: f.label })} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp aria-hidden="true" />
                </IconButton>
                <IconButton label={fmt(t.moveDown, { tên: f.label })} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown aria-hidden="true" />
                </IconButton>
                <IconButton label={fmt(t.remove, { tên: f.label })} onClick={() => onChange(fields.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Select
                  aria-label={fmt(t.typeOf, { tên: f.label })}
                  value={f.type}
                  options={rowOptions}
                  onValueChange={(v) => isType(v, FORM_FIELD_TYPES) && retype(i, v)}
                  className="h-9 w-[11.5rem]"
                />
                {f.type !== 'autonumber' ? (
                  <span className="flex items-center gap-1.5">
                    <Checkbox
                      id={requiredId}
                      aria-label={fmt(t.requiredOf, { tên: f.label })}
                      checked={f.required === true || isTarget}
                      disabled={isTarget}
                      onCheckedChange={(checked) => update(i, { required: checked === true })}
                    />
                    <label htmlFor={requiredId} className="text-sm">
                      {t.required}
                    </label>
                  </span>
                ) : null}
                {isTarget ? <Badge tone="gold">{t.isTarget}</Badge> : null}
              </div>
              {f.type === 'select' ? <OptionsInput field={f} onChange={(options) => update(i, { options })} /> : null}
              {f.type === 'file' ? (
                <span className="flex items-center gap-2">
                  <Switch id={multipleId} aria-label={fmt(t.multipleOf, { tên: f.label })} checked={f.multiple === true} onCheckedChange={(checked) => update(i, { multiple: checked ? true : undefined })} data-testid="field-multiple" />
                  <label htmlFor={multipleId} className="text-sm">
                    {t.multiple}
                  </label>
                </span>
              ) : null}
              {f.type === 'autonumber' ? (
                <>
                  <RegisterPicker field={f} onChange={(register) => update(i, { register })} />
                  <p className="text-xs text-ink-sub">{t.autoNote}</p>
                </>
              ) : null}
              <HintInput id={hintId} field={f} onChange={(hint) => update(i, { hint })} />
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line p-2.5">
        <label htmlFor={newId} className="text-sm font-medium">
          {t.addHeading}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={newId}
            ref={labelRef}
            value={label}
            placeholder={t.labelPlaceholder}
            aria-invalid={error || undefined}
            onChange={(e) => {
              setLabel(e.target.value);
              if (error) setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            className="h-9 min-w-0 flex-1 basis-full"
            data-testid={`${testId}-new-label`}
          />
          <div className="min-w-0 flex-1" data-testid="field-type">
            <Select aria-label={t.type} value={type} options={typeOptions} onValueChange={(v) => isType(v, types) && setType(v)} className="h-9" />
          </div>
          <Button size="sm" onClick={add} className="h-9" data-testid={`${testId}-add`}>
            <Plus aria-hidden="true" />
            {t.add}
          </Button>
        </div>
        {typeHint ? <p className="text-xs text-ink-sub">{typeHint}</p> : null}
        {error ? <FieldError>{t.addLabelRequired}</FieldError> : null}
      </div>
    </div>
  );
}
