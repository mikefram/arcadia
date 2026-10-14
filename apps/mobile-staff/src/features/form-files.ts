import type { FileUpload, FormField } from '@mihato/domain';
import { buildUploadBody, isRetryable, patchItem, planPick, problemCodeOf, readyFileIds, removeItem, type FileItem, type FormFiles } from './files';

/**
 * Bộ điều khiển các tệp trong biểu mẫu (S3 Báo hoàn thành, S6 Gửi phần của bạn): chọn tệp, tải lên, thử lại, gỡ.
 * Giống hàng đợi ngoại tuyến và lớp phiên: không phụ thuộc React Native, mọi phụ thuộc truyền vào (`FormFilesDeps`),
 * màn hình chỉ đăng ký nghe qua useSyncExternalStore. Có test ở test/form-files.test.ts.
 *
 * Quy tắc:
 * - Tệp lên máy chủ ngay khi chọn và ở trạng thái "chờ gắn"; id tệp là giá trị của ô khi gửi biểu mẫu.
 * - Mỗi lần tải mang một Idempotency-Key: mất mạng giữa chừng rồi thử lại cùng khoá thì máy chủ trả đúng tệp đã nhận,
 *   không tạo bản thứ hai. Máy chủ đã trả lỗi (4xx) thì phản hồi đó được lưu theo khoá, nên thử lại phải dùng khoá mới.
 * - Gỡ một tệp đang tải thì dừng việc tải; tải xong mới thấy đã gỡ thì xoá tệp vừa lên để không nằm chờ.
 * - Rời màn hình thì dừng các lần tải dở; KHÔNG xoá tệp đã tải xong: thao tác báo xong có thể còn nằm trong hàng đợi ngoại tuyến
 *   và cần các tệp đó khi gửi. Tệp chưa gắn tự dọn sau 24 giờ ở máy chủ.
 */

/** Một tệp người dùng vừa chọn trên máy, chưa đọc nội dung. */
export type PickedFile = {
  name: string;
  sizeBytes: number;
  /** đọc nội dung thành base64 trơn; chỉ gọi sau khi đã kiểm cỡ */
  readBase64: () => Promise<string>;
  /** trả lại bản sao tạm trên máy (nếu có); gọi nhiều lần cũng được */
  dispose: () => void;
};

export type UploadedFile = { id: string; name: string; sizeBytes: number };

export type FormFilesDeps = {
  /** `POST /v1/files` */
  upload: (body: FileUpload, options: { idempotencyKey: string; signal: AbortSignal }) => Promise<UploadedFile>;
  /** `DELETE /v1/files/:id` cho tệp chưa gắn; lỗi thì bỏ qua (tệp tự dọn sau 24 giờ) */
  discard: (id: string) => Promise<void>;
  newId: () => string;
};

type Entry = { key: string; picked: PickedFile; idempotencyKey: string; abort: AbortController | null };

export class FormFilesController {
  private state: FormFiles = {};
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  constructor(private readonly deps: FormFilesDeps) {}

  // ───── đọc (dùng với useSyncExternalStore) ─────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FormFiles => this.state;

  private set(next: FormFiles): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  private itemsOf(key: string): FileItem[] {
    return this.state[key] ?? [];
  }

  private setItems(key: string, items: FileItem[]): void {
    this.set({ ...this.state, [key]: items });
  }

  /** Id các tệp đã tải xong của một ô. */
  readyIds(key: string): string[] {
    return readyFileIds(this.itemsOf(key));
  }

  // ───── thao tác ─────

  /** Người dùng chọn tệp cho một ô `file`. */
  add(field: Pick<FormField, 'key' | 'multiple'>, picked: readonly PickedFile[]): void {
    if (picked.length === 0) return;
    const plan = planPick(
      this.itemsOf(field.key),
      picked.map((p) => ({ name: p.name, size: p.sizeBytes })),
      field,
      this.deps.newId,
    );
    for (const old of plan.discard) this.drop(old);
    this.setItems(field.key, plan.items);
    const started = new Set(plan.uploads.map((u) => u.index));
    picked.forEach((file, index) => {
      // Tệp bị từ chối ngay (sai đuôi, rỗng, quá cỡ, vượt số lượng) hoặc bị bỏ bớt ở ô một tệp: không cần giữ bản sao tạm.
      if (!started.has(index)) file.dispose();
    });
    for (const u of plan.uploads) {
      const file = picked[u.index];
      if (!file) continue;
      this.entries.set(u.localId, { key: field.key, picked: file, idempotencyKey: u.localId, abort: null });
      void this.run(u.localId);
    }
  }

  /** Thử tải lại một tệp lỗi (lỗi mạng, máy chủ bận). Lỗi do chính tệp thì không thử lại được: phải gỡ rồi chọn tệp khác. */
  retry(key: string, localId: string): void {
    const item = this.itemsOf(key).find((i) => i.localId === localId);
    const entry = this.entries.get(localId);
    if (!item || !entry || !isRetryable(item)) return;
    // Chưa nhận được phản hồi nào (mất mạng) thì giữ khoá cũ; máy chủ đã trả lỗi thì phản hồi đó đã được lưu theo khoá, nên đổi khoá.
    if (item.problem !== 'network') entry.idempotencyKey = this.deps.newId();
    this.setItems(key, patchItem(this.itemsOf(key), localId, { status: 'uploading', problem: null }));
    void this.run(localId);
  }

  /** Gỡ một tệp khỏi ô. */
  remove(key: string, localId: string): void {
    const item = this.itemsOf(key).find((i) => i.localId === localId);
    if (!item) return;
    this.setItems(key, removeItem(this.itemsOf(key), localId));
    this.drop(item);
  }

  /** Rời màn hình: dừng các lần tải dở và trả các bản sao tạm. Tệp đã tải xong được giữ (xem đầu tệp). */
  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.abort?.abort();
      entry.picked.dispose();
    }
    this.entries.clear();
  }

  // ───── bên trong ─────

  /** Dừng và dọn một tệp không còn trong danh sách: dừng lần tải, trả bản sao tạm, gỡ tệp đã lên máy chủ. */
  private drop(item: FileItem): void {
    const entry = this.entries.get(item.localId);
    entry?.abort?.abort();
    entry?.picked.dispose();
    this.entries.delete(item.localId);
    if (item.status === 'done' && item.id) void this.deps.discard(item.id).catch(() => undefined);
  }

  private stillListed(key: string, localId: string): boolean {
    return this.itemsOf(key).some((i) => i.localId === localId);
  }

  private async run(localId: string): Promise<void> {
    const entry = this.entries.get(localId);
    if (!entry) return;
    const abort = new AbortController();
    entry.abort = abort;
    const { key } = entry;
    const item = this.itemsOf(key).find((i) => i.localId === localId);
    if (!item) return;
    let data: string;
    try {
      data = await entry.picked.readBase64();
    } catch {
      this.fail(key, localId, abort, 'read_failed');
      return;
    }
    if (abort.signal.aborted || !this.stillListed(key, localId)) return;
    try {
      const body = buildUploadBody(item.name, data);
      const done = await this.deps.upload(body, { idempotencyKey: entry.idempotencyKey, signal: abort.signal });
      if (abort.signal.aborted || !this.stillListed(key, localId)) {
        // Người dùng đã gỡ trong lúc tải: xoá tệp vừa lên.
        void this.deps.discard(done.id).catch(() => undefined);
        return;
      }
      this.setItems(key, patchItem(this.itemsOf(key), localId, { status: 'done', id: done.id, name: done.name, sizeBytes: done.sizeBytes, problem: null }));
      entry.picked.dispose();
      entry.abort = null;
    } catch (err) {
      this.fail(key, localId, abort, problemCodeOf(err));
    }
  }

  private fail(key: string, localId: string, abort: AbortController, code: string): void {
    if (abort.signal.aborted || !this.stillListed(key, localId)) return;
    this.setItems(key, patchItem(this.itemsOf(key), localId, { status: 'error', problem: code }));
    const entry = this.entries.get(localId);
    if (entry) entry.abort = null;
  }
}
