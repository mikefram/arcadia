import { useCallback, useMemo, useRef, useState } from 'react';

/** Số bước hoàn tác giữ lại. */
const LIMIT = 100;
/** Các lần sửa liên tiếp cùng một ô (gõ chữ) trong khoảng này gộp thành một bước hoàn tác. */
const COALESCE_MS = 1_500;

type State<T> = { past: T[]; present: T; future: T[]; lastKey: string | null; lastAt: number };

export type History<T> = {
  /** bản đang hiện */
  value: T;
  canUndo: boolean;
  canRedo: boolean;
  /** bản mới nhất, đọc được ngay sau `commit` trong cùng một lượt xử lý sự kiện */
  get: () => T;
  /**
   * Ghi một thay đổi. `coalesce`: khoá gộp, ví dụ 'node:s1:title'; các lần ghi liền nhau cùng khoá là một bước hoàn tác.
   * Hàm sửa trả lại đúng bản cũ thì coi như không đổi gì.
   */
  commit: (next: T | ((current: T) => T), opts?: { coalesce?: string }) => T;
  undo: () => void;
  redo: () => void;
  /** thay toàn bộ (tải bản mới từ máy chủ): xoá lịch sử hoàn tác */
  reset: (value: T) => void;
};

/**
 * Hoàn tác và làm lại nhiều bước (SPEC 9.3) cho một giá trị bất biến.
 * Trạng thái giữ thêm trong ref để `get()` trả bản mới nhất mà không phải chờ React vẽ lại.
 */
export function useHistory<T>(initial: T | (() => T)): History<T> {
  const [state, setState] = useState<State<T>>(() => ({
    past: [],
    present: typeof initial === 'function' ? (initial as () => T)() : initial,
    future: [],
    lastKey: null,
    lastAt: 0,
  }));
  const ref = useRef(state);

  const apply = useCallback((next: State<T>) => {
    ref.current = next;
    setState(next);
  }, []);

  const get = useCallback(() => ref.current.present, []);

  const commit = useCallback<History<T>['commit']>(
    (next, opts) => {
      const s = ref.current;
      const value = typeof next === 'function' ? (next as (current: T) => T)(s.present) : next;
      if (value === s.present) return value;
      const now = Date.now();
      const merge = opts?.coalesce !== undefined && s.lastKey === opts.coalesce && now - s.lastAt < COALESCE_MS && s.past.length > 0;
      apply({
        past: merge ? s.past : [...s.past, s.present].slice(-LIMIT),
        present: value,
        future: [],
        lastKey: opts?.coalesce ?? null,
        lastAt: now,
      });
      return value;
    },
    [apply],
  );

  const undo = useCallback(() => {
    const s = ref.current;
    const previous = s.past.at(-1);
    if (previous === undefined) return;
    apply({ past: s.past.slice(0, -1), present: previous, future: [s.present, ...s.future], lastKey: null, lastAt: 0 });
  }, [apply]);

  const redo = useCallback(() => {
    const s = ref.current;
    const next = s.future[0];
    if (next === undefined) return;
    apply({ past: [...s.past, s.present], present: next, future: s.future.slice(1), lastKey: null, lastAt: 0 });
  }, [apply]);

  const reset = useCallback((value: T) => apply({ past: [], present: value, future: [], lastKey: null, lastAt: 0 }), [apply]);

  return useMemo(
    () => ({ value: state.present, canUndo: state.past.length > 0, canRedo: state.future.length > 0, get, commit, undo, redo, reset }),
    [state, get, commit, undo, redo, reset],
  );
}
