import { ApiError, newId, type BlockReasonCode } from '@mihato/domain';

/**
 * Hàng đợi thao tác ngoại tuyến (SPEC 8.4), lưu bền riêng, tách khỏi bộ nhớ đệm của TanStack Query.
 *
 * Nguyên tắc: KHÔNG BAO GIỜ ĐỂ MẤT THAO TÁC.
 * - Bốn thao tác Đã nhận, Báo hoàn thành, Xin thêm thời gian, Báo vướng luôn đi qua hàng đợi, kể cả khi có mạng:
 *   ghi xuống máy trước, rồi mới gửi.
 * - Mỗi thao tác mang một `eventId` (UUID sinh ngay trên máy). Khi gửi, `eventId` là header `Idempotency-Key`,
 *   và cũng là `eventId` của sự kiện engine (SPEC 4.4, 10.1), nên gửi lại bao nhiêu lần cũng chỉ có hiệu lực một lần.
 * - Gửi theo đúng thứ tự xếp hàng. Lỗi tạm (mất mạng, máy chủ bận) thì dừng lại, giữ nguyên thứ tự, lần sau gửi tiếp.
 * - Máy chủ từ chối vì tình huống đã đổi (409 `state_conflict`, 404, 403…): KHÔNG âm thầm bỏ. Thao tác chuyển sang
 *   `rejected`, giữ nguyên ghi chú người dùng đã nhập, chờ người dùng đọc lý do rồi bấm "Đã rõ".
 *
 * Tệp này không phụ thuộc React Native: `storage` và `send` truyền vào, test bằng Vitest (test/queue.test.ts).
 */

export type QueuedAction =
  | { kind: 'accept' }
  | { kind: 'complete'; note?: string; result?: Record<string, unknown>; nudgeId?: string }
  | { kind: 'requestExtension'; proposedDueAt: string; reason: string; nudgeId?: string }
  | { kind: 'block'; reasonCode: BlockReasonCode; note?: string; nudgeId?: string };

export type QueuedActionKind = QueuedAction['kind'];

export type QueueItem = {
  /** UUID sinh trên máy; dùng làm Idempotency-Key và eventId */
  eventId: string;
  stepId: string;
  /** tên việc và tên lượt chạy lúc thao tác, để báo lý do bằng chữ cả khi việc không còn xem được */
  stepTitle: string;
  runTitle: string;
  action: QueuedAction;
  createdAt: string;
  status: 'pending' | 'rejected';
  /** số lần đã thử gửi */
  attempts: number;
  /** mã lỗi của lần gửi gần nhất (ApiError.code), hoặc 'network' */
  lastErrorCode: string | null;
  /** kèm theo 409 state_conflict: trạng thái hiện tại của việc hoặc lượt chạy */
  conflictState: string | null;
};

export type QueueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type QueueDeps = {
  storage: QueueStorage;
  /** Gửi một thao tác lên máy chủ với Idempotency-Key = item.eventId. Ném lỗi khi không thành. */
  send: (item: QueueItem) => Promise<void>;
  /** false thì không thử gửi (đang mất mạng); mặc định luôn thử */
  isOnline?: () => boolean;
  newId?: () => string;
  now?: () => Date;
  storageKey?: string;
};

export type SubmitInput = { stepId: string; stepTitle: string; runTitle: string; action: QueuedAction };

export type SubmitOutcome =
  /** máy chủ đã nhận */
  | { status: 'sent'; eventId: string }
  /** đã lưu trên máy, sẽ gửi khi có mạng: hiện chip "Chờ gửi" */
  | { status: 'queued'; eventId: string }
  /** máy chủ từ chối vì tình huống đã đổi: báo lý do, giữ ghi chú */
  | { status: 'rejected'; eventId: string; code: string; conflictState: string | null };

export const QUEUE_STORAGE_KEY = 'mihato.staff.queue.v1';

export type ErrorVerdict = { verdict: 'retry'; code: string } | { verdict: 'reject'; code: string; conflictState: string | null };

/**
 * Phân loại lỗi gửi.
 * - retry: mất mạng, hết thời gian chờ, máy chủ lỗi (5xx), quá tần suất (429), yêu cầu cùng khoá đang chạy
 *   (409 `request_in_progress`), token hết hạn (401, lớp phiên tự làm mới hoặc tự kết thúc phiên), bản app cũ (426).
 * - reject: mọi 4xx còn lại. Gửi lại y nguyên cũng không thành, nên phải báo cho người dùng.
 */
export function classifySendError(err: unknown): ErrorVerdict {
  if (err instanceof ApiError) {
    const { status, code } = err;
    if (status === 401 || status === 408 || status === 425 || status === 426 || status === 429 || status >= 500) return { verdict: 'retry', code };
    if (code === 'request_in_progress') return { verdict: 'retry', code };
    if (status >= 400) return { verdict: 'reject', code, conflictState: typeof err.extra.currentState === 'string' ? err.extra.currentState : null };
    return { verdict: 'retry', code };
  }
  return { verdict: 'retry', code: 'network' };
}

function isQueueItem(v: unknown): v is QueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const action = r.action as { kind?: unknown } | null | undefined;
  return (
    typeof r.eventId === 'string' &&
    typeof r.stepId === 'string' &&
    typeof r.createdAt === 'string' &&
    (r.status === 'pending' || r.status === 'rejected') &&
    typeof action === 'object' &&
    action !== null &&
    (action.kind === 'accept' || action.kind === 'complete' || action.kind === 'requestExtension' || action.kind === 'block')
  );
}

export class OfflineQueue {
  private items: QueueItem[] = [];
  private loaded: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private readonly key: string;

  constructor(private readonly deps: QueueDeps) {
    this.key = deps.storageKey ?? QUEUE_STORAGE_KEY;
  }

  // ───── đọc (dùng với useSyncExternalStore) ─────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Mảng mới sau mỗi thay đổi, giữ nguyên tham chiếu khi không đổi. */
  getSnapshot = (): readonly QueueItem[] => this.items;

  pendingCount(): number {
    return this.items.filter((i) => i.status === 'pending').length;
  }

  // ───── lưu bền ─────

  /** Đọc hàng đợi đã lưu. Gọi nhiều lần cũng chỉ đọc một lần. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = await this.deps.storage.getItem(this.key);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        const stored = Array.isArray(parsed) ? parsed.filter(isQueueItem) : [];
        // Thao tác xếp hàng trong lúc đang đọc (hiếm) nằm sau các thao tác đã lưu.
        this.items = [...stored, ...this.items.filter((i) => !stored.some((s) => s.eventId === i.eventId))];
      } catch {
        // Dữ liệu lưu hỏng: giữ những gì đang có trong bộ nhớ, không làm app dừng.
      }
      this.emit();
    })();
    return this.loaded;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Đổi danh sách rồi ghi xuống máy. Các lần ghi nối đuôi nhau để không ghi đè lẫn nhau. */
  private commit(next: QueueItem[]): Promise<void> {
    this.items = next;
    this.emit();
    const snapshot = JSON.stringify(next);
    this.writes = this.writes.then(() => this.deps.storage.setItem(this.key, snapshot)).catch(() => undefined);
    return this.writes;
  }

  private patch(eventId: string, change: Partial<QueueItem>): Promise<void> {
    return this.commit(this.items.map((i) => (i.eventId === eventId ? { ...i, ...change } : i)));
  }

  // ───── ghi ─────

  /** Xếp một thao tác vào hàng đợi và ghi xuống máy. Chưa gửi. */
  async enqueue(input: SubmitInput): Promise<QueueItem> {
    await this.load();
    const item: QueueItem = {
      eventId: (this.deps.newId ?? newId)(),
      stepId: input.stepId,
      stepTitle: input.stepTitle,
      runTitle: input.runTitle,
      action: input.action,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      status: 'pending',
      attempts: 0,
      lastErrorCode: null,
      conflictState: null,
    };
    await this.commit([...this.items, item]);
    return item;
  }

  /**
   * Thao tác của người dùng: lưu trước, rồi thử gửi cả hàng đợi theo thứ tự, và cho biết thao tác này ra sao.
   * Mất mạng thì trả `queued` ngay; thao tác vẫn nằm an toàn trên máy.
   */
  async submit(input: SubmitInput): Promise<SubmitOutcome> {
    const item = await this.enqueue(input);
    const find = () => this.items.find((i) => i.eventId === item.eventId);
    const joined = this.flushing !== null;
    await this.flush();
    // Nếu vừa chờ chung một lượt gửi đã chạy từ trước, lượt đó có thể đã duyệt xong hàng đợi ngay trước khi
    // thao tác này được xếp vào: gửi thêm một lượt.
    if (joined && find()?.status === 'pending' && find()?.attempts === 0) await this.flush();
    const current = find();
    if (!current) return { status: 'sent', eventId: item.eventId };
    if (current.status === 'rejected') {
      return { status: 'rejected', eventId: item.eventId, code: current.lastErrorCode ?? 'state_conflict', conflictState: current.conflictState };
    }
    return { status: 'queued', eventId: item.eventId };
  }

  /**
   * Gửi các thao tác đang chờ, theo thứ tự xếp hàng. Chỉ một lượt gửi chạy tại một thời điểm;
   * gọi chồng lên nhau thì cùng chờ lượt đang chạy, không gửi song song.
   */
  flush(): Promise<void> {
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    await this.load();
    const tried = new Set<string>();
    for (;;) {
      if (this.deps.isOnline && !this.deps.isOnline()) return;
      const next = this.items.find((i) => i.status === 'pending' && !tried.has(i.eventId));
      if (!next) return;
      tried.add(next.eventId);
      try {
        await this.deps.send(next);
        // Thao tác có thể đã bị xoá trong lúc chờ (đăng xuất): chỉ gỡ nếu còn.
        await this.commit(this.items.filter((i) => i.eventId !== next.eventId));
      } catch (err) {
        const verdict = classifySendError(err);
        if (verdict.verdict === 'retry') {
          // Giữ nguyên thứ tự: dừng ở đây, lần sau gửi lại đúng thao tác này với đúng eventId.
          await this.patch(next.eventId, { attempts: next.attempts + 1, lastErrorCode: verdict.code });
          return;
        }
        await this.patch(next.eventId, { status: 'rejected', attempts: next.attempts + 1, lastErrorCode: verdict.code, conflictState: verdict.conflictState });
      }
    }
  }

  /** Người dùng đã đọc lý do của một thao tác bị từ chối và bấm "Đã rõ". */
  async dismiss(eventId: string): Promise<void> {
    await this.load();
    const target = this.items.find((i) => i.eventId === eventId);
    if (target?.status !== 'rejected') return;
    await this.commit(this.items.filter((i) => i.eventId !== eventId));
  }

  /** Xoá sạch khi phiên trên máy kết thúc (đăng xuất, thu hồi thiết bị, quá 5 lần sai PIN). */
  async clear(): Promise<void> {
    await this.load();
    await this.commit([]);
  }
}

/** Ghi chú người dùng đã nhập trong một thao tác, để hiện lại khi thao tác bị từ chối. */
export function noteOf(action: QueuedAction): string | null {
  switch (action.kind) {
    case 'accept':
      return null;
    case 'complete':
    case 'block':
      return action.note?.trim() ? action.note : null;
    case 'requestExtension':
      return action.reason.trim() ? action.reason : null;
  }
}
