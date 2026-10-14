import type { FormField } from '@mihato/domain';
import { fmt, formatDateWeekday, formatMoney, vi } from '@mihato/i18n';
import { useState } from 'react';
import { View } from 'react-native';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { DateGrid } from '../ui/DateGrid';
import { ChoiceList, Field, TextField } from '../ui/Field';
import { space } from '../ui/theme';
import { FileField } from './FileField';
import { PersonPicker, type PickedPerson } from './PersonPicker';
import { noonOf } from './calendar';
import { fileFieldState, type FormFiles } from './files';
import type { FormFilesController } from './form-files';
import { parseMoney, type FormValues } from './result-form';

const t = vi.staff.complete;

type Props = {
  fields: readonly FormField[];
  values: FormValues;
  onChange: (key: string, value: string) => void;
  /** khoá của các ô cần báo lỗi (bắt buộc mà trống, hoặc số chưa đúng) */
  missing: readonly string[];
  invalid: readonly string[];
  today: string;
  /** các tệp đã chọn theo khoá ô `file`, và bộ điều khiển tải lên (xem `useFormFiles`) */
  files: FormFiles;
  controller: FormFilesController;
  /** đã bấm Gửi ít nhất một lần: bắt đầu báo ô tệp còn đang tải hoặc tải lỗi (tự hết khi xong) */
  attempted: boolean;
};

/** Các ô của biểu mẫu kết quả: chữ, số, tiền, ngày, chọn một, chọn người và tệp. Ô bắt buộc ghi rõ dấu sao. */
export function ResultFormFields({ fields, values, onChange, missing, invalid, today, files, controller, attempted }: Props) {
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [people, setPeople] = useState<Record<string, PickedPerson | null>>({});
  const fileIssues: { uploading: string[]; failed: string[] } = attempted ? fileFieldState(fields, files) : { uploading: [], failed: [] };

  return (
    <View style={{ gap: space.lg }}>
      {fields.map((field) => {
        const label = field.required ? fmt(t.requiredField, { tên: field.label }) : field.label;
        const value = values[field.key] ?? '';
        const error = missing.includes(field.key) ? t.fieldMissing : invalid.includes(field.key) ? t.fieldInvalidNumber : null;

        switch (field.type) {
          case 'text':
            return <TextField key={field.key} label={label} value={value} onChangeText={(v) => onChange(field.key, v)} error={error} testID={`field-${field.key}`} />;
          case 'longtext':
            return <TextField key={field.key} label={label} value={value} onChangeText={(v) => onChange(field.key, v)} multiline maxLength={50_000} hint={field.hint} error={error} testID={`field-${field.key}`} />;
          case 'number':
            return <TextField key={field.key} label={label} value={value} onChangeText={(v) => onChange(field.key, v)} keyboardType="numeric" error={error} testID={`field-${field.key}`} />;
          case 'file': {
            const fileError = fileIssues.uploading.includes(field.key) ? vi.staff.files.stillUploading : fileIssues.failed.includes(field.key) ? vi.staff.files.hasFailed : error;
            return <FileField key={field.key} field={field} label={label} items={files[field.key] ?? []} error={fileError} controller={controller} />;
          }
          case 'users':
            // App chưa chọn được nhiều người: ô bắt buộc thì nói rõ phải làm trên web, ô không bắt buộc thì ghi chú để người dùng biết còn có thể bổ sung.
            return (
              <Field key={field.key} label={label} error={field.required ? t.webOnlyRequired : null}>
                <AppText tone="sub" testID={`field-${field.key}`}>
                  {t.webOnly}
                </AppText>
              </Field>
            );
          case 'autonumber':
            return (
              <Field key={field.key} label={field.label}>
                <AppText tone="sub">{t.autonumber}</AppText>
              </Field>
            );
          case 'money': {
            const amount = parseMoney(value);
            return (
              <TextField
                key={field.key}
                label={label}
                value={value}
                onChangeText={(v) => onChange(field.key, v)}
                keyboardType="number-pad"
                error={error}
                // Viết lại số tiền đầy đủ để người nhập soát: "20.000.000 đồng".
                hint={amount !== null ? formatMoney(amount) : t.moneyHint}
                testID={`field-${field.key}`}
              />
            );
          }
          case 'date':
            return (
              <Field key={field.key} label={label} error={error}>
                <Button
                  variant="secondary"
                  label={value ? formatDateWeekday(noonOf(value)) : vi.staff.extension.pickDate}
                  onPress={() => setOpenDate((cur) => (cur === field.key ? null : field.key))}
                  testID={`field-${field.key}`}
                />
                {openDate === field.key ? (
                  <DateGrid
                    value={value || null}
                    today={today}
                    onChange={(day) => {
                      onChange(field.key, day);
                      setOpenDate(null);
                    }}
                  />
                ) : null}
              </Field>
            );
          case 'select':
            return <ChoiceList key={field.key} label={label} options={field.options ?? []} value={value || null} onChange={(v) => onChange(field.key, v)} error={error} />;
          case 'user':
            return (
              <PersonPicker
                key={field.key}
                label={label}
                value={people[field.key] ?? null}
                error={error}
                onChange={(person) => {
                  setPeople((cur) => ({ ...cur, [field.key]: person }));
                  onChange(field.key, person?.id ?? '');
                }}
              />
            );
        }
      })}
    </View>
  );
}
