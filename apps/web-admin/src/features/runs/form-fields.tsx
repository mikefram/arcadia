import { Hash } from 'lucide-react';
import { FORM_LIMITS, type FormField } from '@mihato/domain';
import { fmt, formatMoney, vi } from '@mihato/i18n';
import { AutoGrowTextarea } from '@/components/auto-grow-textarea';
import { FileField } from '@/components/file-field';
import { FileList } from '@/components/file-list';
import { PeopleMultiPicker } from '@/components/people-multi-picker';
import { PersonPicker } from '@/components/person-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { describeValue, filesOf, hasInput, MAX_MONEY_DIGITS, parseMoney, peopleOf, personOf, textOf, type DisplayContext, type FieldErrors, type FieldValue, type FieldValues } from './field-values';

// Giữ nguyên chỗ nhập khẩu cũ: logic thuần nằm ở field-values.ts, vẽ ô ở đây.
export {
  asFormFields,
  attachedFileIds,
  buildPersonIndex,
  describeValue,
  displayValue,
  fieldCodeText,
  fieldErrorsFromProblem,
  hasInput,
  hasUploading,
  needsFileUpload,
  parseMoney,
  personIdsIn,
  proposalInputs,
  toPayload,
  validateFields,
  type DescribedValue,
  type DisplayContext,
  type FieldErrors,
  type FieldValue,
  type FieldValues,
} from './field-values';

const t = vi.admin.runs.form;

export type DynamicFieldProps = {
  field: FormField;
  value: FieldValue | undefined;
  onChange: (value: FieldValue) => void;
  error?: string | undefined;
  disabled?: boolean | undefined;
};

/**
 * Một ô của biểu mẫu sinh tự động: nhãn, gợi ý, ô nhập theo kiểu, câu lỗi. Dùng chung cho biểu mẫu khởi chạy,
 * biểu mẫu kết quả của việc và biểu mẫu của người duyệt hoặc đóng góp. Mỗi ô nằm trong một khối có
 * `data-testid="field-<khoá>"`; ô tệp có thêm `file-<khoá>-input` (ô chọn tệp thật, dùng với setInputFiles).
 * Các loại: text, longtext (tự giãn), date, number, money, select, user, users (nhiều người), file, autonumber (chỉ đọc).
 */
export function DynamicField({ field, value, onChange, error, disabled }: DynamicFieldProps) {
  const required = field.required === true;
  const testId = `field-${field.key}`;

  if (field.type === 'autonumber') {
    return (
      <div data-testid={testId} className="flex flex-col gap-1.5">
        <p className="text-base font-medium text-ink">{field.label}</p>
        <p className="flex items-start gap-2 rounded-lg border border-dashed border-line bg-surface-alt px-3 py-2 text-ink-sub">
          <Hash aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{t.autonumberNote}</span>
        </p>
        {field.hint ? <p className="text-sm text-ink-sub">{field.hint}</p> : null}
      </div>
    );
  }

  if (field.type === 'user') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          <PersonPicker value={personOf(value)} onChange={onChange} placeholder={t.personPlaceholder} disabled={disabled} />
        </Field>
      </div>
    );
  }

  if (field.type === 'users') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          <PeopleMultiPicker value={peopleOf(value)} onChange={onChange} label={field.label} disabled={disabled} max={FORM_LIMITS.users} />
        </Field>
      </div>
    );
  }

  if (field.type === 'file') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          <FileField fieldKey={field.key} label={field.label} value={filesOf(value)} onChange={onChange} multiple={field.multiple === true} disabled={disabled} />
        </Field>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          {/* aria-label: hộp chọn của khung chưa nhận id từ <Field> nên nhãn phải truyền thẳng. */}
          <Select aria-label={field.label} value={textOf(value) || null} onValueChange={(v) => onChange(v ?? '')} options={field.options ?? []} placeholder={t.selectPlaceholder} disabled={disabled} />
        </Field>
      </div>
    );
  }

  if (field.type === 'money') {
    const amount = parseMoney(textOf(value));
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={amount !== null ? fmt(t.moneyEcho, { tiền: formatMoney(amount) }) : (field.hint ?? t.moneyHint)}>
          <Input
            inputMode="numeric"
            autoComplete="off"
            className="tabular"
            disabled={disabled}
            value={textOf(value)}
            // Chỉ giữ chữ số: dán "20.000.000" hay "20 000 000" vẫn ra 20000000.
            onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, MAX_MONEY_DIGITS))}
          />
        </Field>
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          <Input inputMode="decimal" autoComplete="off" className="tabular" disabled={disabled} value={textOf(value)} onChange={(e) => onChange(e.target.value)} />
        </Field>
      </div>
    );
  }

  if (field.type === 'date') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          <Input type="date" disabled={disabled} value={textOf(value)} onChange={(e) => onChange(e.target.value)} />
        </Field>
      </div>
    );
  }

  if (field.type === 'longtext') {
    return (
      <div data-testid={testId}>
        <Field label={field.label} required={required} error={error} hint={field.hint}>
          <AutoGrowTextarea disabled={disabled} value={textOf(value)} onChange={(e) => onChange(e.target.value)} />
        </Field>
      </div>
    );
  }

  return (
    <div data-testid={testId}>
      <Field label={field.label} required={required} error={error} hint={field.hint}>
        <Input autoComplete="off" disabled={disabled} value={textOf(value)} onChange={(e) => onChange(e.target.value)} />
      </Field>
    </div>
  );
}

export type FormFieldsGroupProps = {
  fields: readonly FormField[];
  values: FieldValues;
  /** lỗi kiểm ở máy khách (`validateFields`) */
  errors: FieldErrors;
  /** lỗi do máy chủ trả theo ô; hiện trước */
  serverErrors?: FieldErrors | undefined;
  /** đã bấm gửi: ô bắt buộc còn trống mới báo lỗi. Ô đã gõ mà sai kiểu thì báo ngay. */
  showErrors: boolean;
  onChange: (key: string, value: FieldValue) => void;
  disabled?: boolean | undefined;
};

/** Cả biểu mẫu: mọi ô của `fields` với quy tắc hiện lỗi chung (dùng ở hộp thoại báo xong, duyệt và gửi phần). */
export function FormFieldsGroup({ fields, values, errors, serverErrors, showErrors, onChange, disabled }: FormFieldsGroupProps) {
  return (
    <>
      {fields.map((field) => (
        <DynamicField
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(v) => onChange(field.key, v)}
          error={serverErrors?.[field.key] ?? (showErrors || hasInput(field, values[field.key]) ? errors[field.key] : undefined)}
          disabled={disabled}
        />
      ))}
    </>
  );
}

/** Một giá trị đã lưu, vẽ theo loại ô: ngày dd/mm/yyyy, tiền, tên người, danh sách người, tệp có nút tải xuống, nhiều dòng giữ xuống dòng. */
export function FieldValueView({ field, value, ctx }: { field: Pick<FormField, 'type' | 'options'>; value: unknown; ctx?: DisplayContext }) {
  const described = describeValue(field, value, ctx);
  switch (described.kind) {
    case 'empty':
      return <span className="text-ink-sub">{t.empty}</span>;
    case 'text':
      return <span className={described.multiline ? 'block whitespace-pre-line' : undefined}>{described.text}</span>;
    case 'list':
      return (
        <ul className="flex flex-col gap-0.5">
          {described.items.map((name, i) => (
            <li key={`${name}-${i}`}>{name}</li>
          ))}
        </ul>
      );
    case 'files':
      return (
        <div className="flex flex-col gap-2">
          <FileList files={described.files} showUploader={false} />
          {described.missing > 0 ? <span className="text-ink-sub">{fmt(vi.admin.runs.files.hidden, { n: described.missing })}</span> : null}
        </div>
      );
  }
}

/** Ô có giá trị dài: tệp và nhiều dòng. */
function isWide(field: Pick<FormField, 'type'>): boolean {
  return field.type === 'file' || field.type === 'longtext';
}

export type FieldValueListProps = {
  fields: readonly FormField[];
  values: Record<string, unknown>;
  /** tệp và người để tra theo id khi hiện ô tệp, ô chọn người */
  files?: DisplayContext['files'];
  people?: DisplayContext['people'];
  className?: string;
};

/** Danh sách "nhãn: giá trị" chỉ đọc cho các ô đã có giá trị (thông tin đầu vào, kết quả đã nhập). Ô số văn bản hiện số đã cấp. */
export function FieldValueList({ fields, values, files, people, className }: FieldValueListProps) {
  const known = new Set(fields.map((f) => f.key));
  // Khoá có giá trị nhưng không còn trong khai báo (biểu mẫu đã đổi) vẫn hiện, dùng khoá làm nhãn.
  const extra: FormField[] = Object.keys(values)
    .filter((key) => !known.has(key))
    .map((key) => ({ key, label: key, type: 'text' }));
  const rows = [...fields, ...extra].filter((f) => {
    const v = values[f.key];
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });
  if (rows.length === 0) return null;
  const ctx: DisplayContext = { files, people };
  return (
    <dl className={className ?? 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5'}>
      {rows.map((f) => (
        <div key={f.key} className="contents">
          {/* Giá trị dài (tệp, nhiều dòng) xuống hàng riêng dưới nhãn, để không bị ép vào cột hẹp. */}
          <dt className={cn('text-ink-sub', isWide(f) && 'col-span-2 mt-1')}>{f.label}</dt>
          <dd data-testid={`value-${f.key}`} className={cn('min-w-0 font-medium', (f.type === 'money' || f.type === 'number') && 'tabular', isWide(f) && 'col-span-2')}>
            <FieldValueView field={f} value={values[f.key]} ctx={ctx} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
