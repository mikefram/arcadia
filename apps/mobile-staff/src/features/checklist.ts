import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Dấu tích của danh sách kiểm (S2). Hợp đồng API chỉ có tên các mục (`checklist: string[]`), chưa có chỗ lưu
 * mục nào đã xong, nên dấu tích chỉ nằm trên máy này để người làm tự theo dõi; xoá khi phiên trên máy kết thúc.
 */
export const CHECKLIST_KEY = 'mihato.staff.checklist.v1';

type Marks = Record<string, number[]>;

let marks: Marks = {};
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(CHECKLIST_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed === 'object' && parsed !== null) {
      const next: Marks = {};
      for (const [stepId, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) next[stepId] = value.filter((v): v is number => typeof v === 'number');
      }
      marks = { ...next, ...marks };
      emit();
    }
  } catch {}
}

/** Phiên trên máy kết thúc: bỏ mọi dấu tích, cả trong bộ nhớ lẫn trên máy. */
export async function resetChecklist(): Promise<void> {
  marks = {};
  emit();
  await AsyncStorage.removeItem(CHECKLIST_KEY).catch(() => undefined);
}

const EMPTY: number[] = [];
const subscribe = (listener: () => void) => {
  void load();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Các mục đã tích của một việc, và hàm đổi dấu tích của một mục. */
export function useChecklist(stepId: string): { checked: readonly number[]; toggle: (index: number) => void } {
  const getSnapshot = useCallback(() => marks[stepId] ?? EMPTY, [stepId]);
  const checked = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const toggle = useCallback(
    (index: number) => {
      const current = marks[stepId] ?? EMPTY;
      marks = { ...marks, [stepId]: current.includes(index) ? current.filter((i) => i !== index) : [...current, index] };
      emit();
      void AsyncStorage.setItem(CHECKLIST_KEY, JSON.stringify(marks)).catch(() => undefined);
    },
    [stepId],
  );
  return { checked, toggle };
}
