import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { Textarea } from './ui/textarea';

/** Chiều cao tối đa trước khi hộp cuộn (24rem): văn bản dài vẫn không đẩy trang đi quá xa. */
const MAX_HEIGHT_PX = 384;

/**
 * Ô nhiều dòng tự giãn theo nội dung (ô `longtext` của biểu mẫu). Co lại khi xoá bớt chữ; quá chiều cao tối đa thì cuộn.
 * Người dùng vẫn kéo giãn thủ công được. Nhận mọi thuộc tính của <Textarea>.
 */
export function AutoGrowTextarea({ className, value, rows = 3, ...props }: ComponentProps<typeof Textarea>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_HEIGHT_PX)}px`;
  }, [value]);
  return <Textarea ref={ref} rows={rows} value={value} className={cn('max-h-96 overflow-y-auto', className)} {...props} />;
}
