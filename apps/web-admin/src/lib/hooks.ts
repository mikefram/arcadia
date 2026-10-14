import { useEffect, useState } from 'react';

/** Giá trị chỉ đổi sau khi người dùng ngừng gõ `delayMs` (ô tìm kiếm gọi API). */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
