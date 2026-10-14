/**
 * Thư điện tử giao dịch (thư kích hoạt tài khoản, đặt mật khẩu). Nhà cung cấp là Resend (resend.com) sau giao diện
 * EmailProvider; đổi nhà cung cấp là đổi cấu hình, không sửa nghiệp vụ. CI và phát triển luôn dùng FakeEmail.
 *
 * Thư là kênh riêng tới đúng người nhận nên được chứa tên người và liên kết một lần; nhật ký và báo lỗi thì không
 * (CLAUDE.md luật 6): mọi lỗi trả về ở đây chỉ mang mã HTTP và tên lỗi, không mang địa chỉ hay nội dung thư.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  /** bản chữ thuần, luôn có để máy đọc thư không hiện HTML vẫn đọc được */
  text: string;
  html: string;
};

export type EmailResult =
  | { ok: true; messageId: string }
  /** transient: thử lại theo backoff của hàng effect (5xx, 429, mạng). permanent: không thử lại (4xx khác, địa chỉ sai). */
  | { ok: false; error: 'transient' | 'permanent'; message?: string };

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailResult>;
}

/** Bản giả chạy trong bộ nhớ: ghi lại mọi thư để test kiểm "mỗi người một thư" và đọc liên kết trong thư. */
export class FakeEmail implements EmailProvider {
  readonly sent: (EmailMessage & { messageId: string; at: number })[] = [];
  /** số lần gửi kế tiếp sẽ lỗi tạm (để kiểm thử lại theo backoff) */
  failNext = 0;
  /** địa chỉ bị coi là sai: trả lỗi vĩnh viễn */
  readonly rejected = new Set<string>();
  private seq = 0;

  async send(message: EmailMessage): Promise<EmailResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, error: 'transient', message: 'fake transient failure' };
    }
    if (this.rejected.has(message.to.toLowerCase())) return { ok: false, error: 'permanent', message: 'fake rejected address' };
    const messageId = `fake-email-${++this.seq}`;
    this.sent.push({ ...message, messageId, at: Date.now() });
    return { ok: true, messageId };
  }

  /** Thư gửi tới một địa chỉ, mới nhất sau cùng. */
  to(address: string): (EmailMessage & { messageId: string })[] {
    const a = address.toLowerCase();
    return this.sent.filter((m) => m.to.toLowerCase() === a);
  }
}

// ───────────────────────── Resend ─────────────────────────

export type ResendEmailOptions = {
  apiKey: string;
  /** địa chỉ gửi, dạng `Tên <thu@ten-mien-da-xac-minh>`; tên miền phải được xác minh ở Resend */
  from: string;
  /** mặc định https://api.resend.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** quá hạn này thì coi là lỗi tạm (mặc định 10 giây) */
  timeoutMs?: number;
};

const RESEND_BASE_URL = 'https://api.resend.com';

/**
 * Resend: `POST /emails` với `Authorization: Bearer <khoá>`, thân JSON { from, to, subject, text, html }, trả `{ id }`.
 * 429 và 5xx là lỗi tạm (thử lại); 4xx khác là lỗi vĩnh viễn (khoá sai, địa chỉ gửi chưa xác minh, địa chỉ nhận sai).
 */
export class ResendEmail implements EmailProvider {
  constructor(private readonly opts: ResendEmailOptions) {
    if (!opts.apiKey) throw new Error('ResendEmail: thiếu RESEND_API_KEY');
    if (!opts.from) throw new Error('ResendEmail: thiếu EMAIL_FROM');
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl ?? RESEND_BASE_URL}/emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({ from: this.opts.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        // Không có hạn thì một kết nối treo giữ giao dịch của worker và dòng effect vô hạn.
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      return { ok: false, error: 'transient', message: err instanceof Error ? err.name : 'network' };
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { ok: true, messageId: typeof body.id === 'string' ? body.id : '' };
    }
    const transient = res.status === 429 || res.status >= 500;
    return { ok: false, error: transient ? 'transient' : 'permanent', message: `Resend HTTP ${res.status}` };
  }
}
