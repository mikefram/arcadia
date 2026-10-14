import type { PersonRef } from '@mihato/domain';
import { useApiQuery } from '@/lib/query';

/**
 * Bảng id sang người để hiện tên ở ô chọn người đã lưu (máy chủ chỉ lưu id). Bắt đầu từ những người đã có sẵn trong
 * dữ liệu của màn hình (`known`); id còn thiếu thì tra thêm qua `people.search` (một lần, giữ trong bộ nhớ đệm 5 phút).
 * Id vẫn không tra được thì để nơi vẽ dùng chữ "Một người".
 */
export function usePeople(ids: readonly string[], known: ReadonlyMap<string, PersonRef>): ReadonlyMap<string, PersonRef> {
  const missing = ids.some((id) => !known.has(id));
  const found = useApiQuery('people.search', { query: { q: '', limit: 100 } }, { enabled: missing, staleTime: 5 * 60_000 });
  if (!missing || !found.data) return known;
  const merged = new Map(known);
  for (const person of found.data.items) if (!merged.has(person.id)) merged.set(person.id, person);
  return merged;
}
