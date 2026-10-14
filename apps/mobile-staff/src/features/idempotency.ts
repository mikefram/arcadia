import { ApiError } from '@mihato/domain';

/**
 * Khoá chống lặp (`Idempotency-Key`) của các màn gửi một lần. Máy chủ lưu CẢ phản hồi lỗi 4xx theo khoá
 * (apps/api/src/registrar.ts): gửi lại cùng khoá thì nhận lại đúng lỗi cũ, còn gửi thân khác với cùng khoá thì nhận
 * `idempotency_key_reuse`. Quy tắc (giống ô tệp, form-files.ts):
 * - chưa nhận được phản hồi (mất mạng, 5xx): giữ khoá, để gửi lại không tạo thêm bản ghi;
 * - máy chủ đã trả lời (thành công hoặc 4xx): đổi khoá, lần bấm sau là yêu cầu mới.
 */
export type SendOutcome = { ok: true } | { ok: false; error: unknown };

export function shouldRotateKey(outcome: SendOutcome): boolean {
  if (outcome.ok) return true;
  return outcome.error instanceof ApiError && outcome.error.status >= 400 && outcome.error.status < 500;
}

export class IdempotencyKeys<Name extends string> {
  private readonly keys = new Map<Name, string>();

  constructor(private readonly makeId: () => string) {}

  /** Khoá hiện tại của một thao tác (tạo khi cần). */
  get(name: Name): string {
    let key = this.keys.get(name);
    if (!key) {
      key = this.makeId();
      this.keys.set(name, key);
    }
    return key;
  }

  /** Ghi nhận kết quả của lần gửi vừa rồi; trả true nếu đã đổi khoá. */
  settle(name: Name, outcome: SendOutcome): boolean {
    if (!shouldRotateKey(outcome)) return false;
    this.keys.set(name, this.makeId());
    return true;
  }
}
