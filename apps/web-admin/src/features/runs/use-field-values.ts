import { useCallback, useState } from 'react';
import type { FormField } from '@mihato/domain';
import { codeMessage, problemFields } from '@/lib/errors';
import { fieldCodeText, fieldErrorsFromProblem, type FieldErrors, type FieldValue, type FieldValues } from './field-values';

/**
 * Trạng thái của một biểu mẫu sinh tự động: giá trị đang gõ, và lỗi từng ô do máy chủ trả (422 `errors[].path/code`).
 * Lỗi của máy chủ gỡ đi khi người dùng sửa đúng ô đó.
 */
export function useFieldValues() {
  const [values, setValues] = useState<FieldValues>({});
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});

  const setValue = useCallback((key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      if (prev[key] === undefined) return prev;
      const { [key]: _fixed, ...rest } = prev;
      return rest;
    });
  }, []);

  /** Nhận lỗi 422 của máy chủ và gắn vào các ô khớp khoá; trả số ô được gắn lỗi. */
  const captureServerErrors = useCallback((fields: readonly FormField[], err: unknown): number => {
    const found = fieldErrorsFromProblem(fields, problemFields(err), (code) => fieldCodeText(code, codeMessage));
    setServerErrors(found);
    return Object.keys(found).length;
  }, []);

  const clearServerErrors = useCallback(() => setServerErrors({}), []);

  return { values, setValue, serverErrors, captureServerErrors, clearServerErrors };
}
