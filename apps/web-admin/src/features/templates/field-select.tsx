import { useFieldControl } from '@/components/ui/field';
import { Select as BaseSelect, type SelectProps } from '@/components/ui/select';

/**
 * Hộp chọn dùng trong <Field>. `Select` của bộ thành phần truyền `id={undefined}` xuống nút bấm, đè mất `id`
 * mà <Field> cấp, nên nhãn không còn gắn với hộp chọn (trình đọc màn hình không đọc được nhãn).
 * Bản bọc này lấy `id` từ <Field> và truyền lại cho đúng. Ngoài <Field> thì chạy như `Select` thường.
 */
export function Select(props: SelectProps) {
  const field = useFieldControl();
  return <BaseSelect {...props} id={props.id ?? field.id} />;
}
