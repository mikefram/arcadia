/**
 * Đẩy thông báo (SPEC 6.9, 10.9). Nhà cung cấp là Expo Push Service sau giao diện PushProvider;
 * đổi nhà cung cấp là đổi cấu hình, không sửa nghiệp vụ. CI luôn dùng FakePush.
 */
export type PushMessage = {
  /** devices.push_token */
  to: string;
  title: string;
  body: string;
  /** type, notificationId, link (mihato://step/{id}). Không chứa dữ liệu nhạy cảm. */
  data: Record<string, unknown>;
  /** kênh Android: Công việc (mức thường) và Đi thúc (mức cao) */
  channelId: 'work' | 'nudge';
  priority: 'high' | 'normal';
  ttlSeconds?: number;
};

export type PushTicket =
  | { ok: true; ticketId: string }
  /** DeviceNotRegistered: ngừng gửi tới token đó. transient: thử lại theo backoff. permanent: không thử lại. */
  | { ok: false; error: 'DeviceNotRegistered' | 'transient' | 'permanent'; message?: string };

export type PushReceipt = { ok: true } | { ok: false; error: 'DeviceNotRegistered' | 'other'; message?: string };

export interface PushProvider {
  /** Gửi tối đa 100 thông điệp mỗi lần gọi; trả vé theo đúng thứ tự. */
  sendBatch(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Lấy biên nhận (khuyến nghị sau 15 phút, trước 24 giờ). Vé chưa có biên nhận thì không có trong kết quả. */
  getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

export const PUSH_BATCH_SIZE = 100;

/** Bản giả chạy trong bộ nhớ: ghi lại mọi thông điệp để test kiểm "mỗi thông báo đúng một lần". */
export class FakePush implements PushProvider {
  readonly sent: (PushMessage & { ticketId: string; at: number })[] = [];
  /** token trả DeviceNotRegistered ngay ở vé */
  readonly unregistered = new Set<string>();
  /** token trả DeviceNotRegistered ở biên nhận */
  readonly unregisteredAtReceipt = new Set<string>();
  /** số lần gửi kế tiếp sẽ lỗi tạm (để kiểm thử lại theo backoff) */
  failNext = 0;
  private seq = 0;
  private readonly ticketToken = new Map<string, string>();

  async sendBatch(messages: PushMessage[]): Promise<PushTicket[]> {
    if (messages.length > PUSH_BATCH_SIZE) throw new Error('Quá 100 thông điệp mỗi lần gọi');
    if (this.failNext > 0) {
      this.failNext--;
      return messages.map(() => ({ ok: false, error: 'transient', message: 'giả lập lỗi tạm' }) as const);
    }
    return messages.map((m) => {
      if (this.unregistered.has(m.to)) return { ok: false, error: 'DeviceNotRegistered' } as const;
      const ticketId = `fake-ticket-${++this.seq}`;
      this.ticketToken.set(ticketId, m.to);
      this.sent.push({ ...m, ticketId, at: Date.now() });
      return { ok: true, ticketId } as const;
    });
  }

  async getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (const id of ticketIds) {
      const token = this.ticketToken.get(id);
      if (!token) continue;
      out[id] = this.unregisteredAtReceipt.has(token) ? { ok: false, error: 'DeviceNotRegistered' } : { ok: true };
    }
    return out;
  }

  reset(): void {
    this.sent.length = 0;
    this.unregistered.clear();
    this.unregisteredAtReceipt.clear();
    this.failNext = 0;
  }
}

type ExpoTicket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } };
type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

/**
 * Expo Push Service [ĐÃ XÁC MINH 02/10/2026, SPEC 10.9]: gửi tại /--/api/v2/push/send (tối đa 100 thông điệp
 * mỗi yêu cầu), biên nhận tại /--/api/v2/push/getReceipts. Bật yêu cầu access token và giữ ở EXPO_ACCESS_TOKEN.
 * Kiểm lại trang chính thức trước khi dựa vào tham số (SPEC mục 17).
 */
export class ExpoPush implements PushProvider {
  constructor(
    private readonly opts: { accessToken?: string; fetch?: typeof fetch; baseUrl?: string; /** quá hạn này thì coi là lỗi tạm (mặc định 10 giây) */ timeoutMs?: number } = {},
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.opts.baseUrl ?? 'https://exp.host'}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.opts.accessToken ? { Authorization: `Bearer ${this.opts.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      // Không có hạn thì một kết nối treo giữ giao dịch của worker và dòng effect vô hạn (audit ai-4).
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async sendBatch(messages: PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) return [];
    try {
      const res = await this.post<{ data: ExpoTicket[] }>(
        '/--/api/v2/push/send',
        messages.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, channelId: m.channelId, priority: m.priority, ttl: m.ttlSeconds, sound: 'default' })),
      );
      return res.data.map((t): PushTicket => {
        if (t.status === 'ok') return { ok: true, ticketId: t.id };
        const code = t.details?.error;
        if (code === 'DeviceNotRegistered') return { ok: false, error: 'DeviceNotRegistered', message: t.message };
        if (code === 'MessageRateExceeded') return { ok: false, error: 'transient', message: t.message };
        return { ok: false, error: 'permanent', message: t.message };
      });
    } catch (err) {
      // 5xx và lỗi mạng: thử lại theo backoff của hàng effect.
      return messages.map(() => ({ ok: false, error: 'transient', message: err instanceof Error ? err.message : 'network' }) as const);
    }
  }

  async getReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    if (ticketIds.length === 0) return {};
    const res = await this.post<{ data: Record<string, ExpoReceipt> }>('/--/api/v2/push/getReceipts', { ids: ticketIds });
    const out: Record<string, PushReceipt> = {};
    for (const [id, r] of Object.entries(res.data ?? {})) {
      out[id] = r.status === 'ok' ? { ok: true } : { ok: false, error: r.details?.error === 'DeviceNotRegistered' ? 'DeviceNotRegistered' : 'other', message: r.message };
    }
    return out;
  }
}
