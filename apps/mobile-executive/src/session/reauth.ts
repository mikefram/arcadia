/**
 * Xác thực lại ngay trên máy trước một việc quan trọng. Màn hình gọi `requestReauth(title)` và chờ kết quả;
 * `ReauthHost` ở lớp gốc hỏi sinh trắc học nếu đã bật, không thì hiện màn nhập PIN đầy đủ (không phải cửa sổ nổi).
 * Tệp này thuần TypeScript để test được.
 */
export type ReauthRequest = { id: number; title: string };

type Pending = { request: ReauthRequest; resolve: (ok: boolean) => void };

let pending: Pending | null = null;
let seq = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

export const reauthStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ReauthRequest | null {
    return pending?.request ?? null;
  },
  /** `ReauthHost` báo kết quả: true khi người dùng đã xác thực xong. */
  settle(ok: boolean): void {
    const current = pending;
    if (!current) return;
    pending = null;
    emit();
    current.resolve(ok);
  },
};

/** Mỗi lúc chỉ có một lần hỏi; lần hỏi mới thay lần cũ (lần cũ coi như chưa xác thực). */
export function requestReauth(title: string): Promise<boolean> {
  if (pending) reauthStore.settle(false);
  return new Promise<boolean>((resolve) => {
    pending = { request: { id: ++seq, title }, resolve };
    emit();
  });
}
