/**
 * Client của giao diện nội bộ `/internal/v1/*` của API (SPEC 10.7.1). Đây là đường DUY NHẤT scribe chạm tới dữ liệu:
 * không có CSDL, không gọi endpoint công khai. Mọi yêu cầu kèm service token của `ai_service` (phạm vi read và propose).
 * AI không có đường ghi: tool `propose_*` chỉ tạo đề xuất, người bấm xác nhận thì máy chủ mới thực thi (SPEC 6.5).
 */
import { isToolName } from '@mihato/ai-tools';
import { InternalClaimResponseSchema, type InternalClaimResponse, type InternalToolResult, InternalToolResultSchema, InternalUsageResponseSchema } from '@mihato/domain';
import type { JSONWebKeySet } from 'jose';

/** Lỗi HTTP của giao diện nội bộ. Chỉ mang mã trạng thái, tên thao tác và mã lỗi của API (`code`), không mang thân phản hồi. */
export class InternalApiError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    readonly code: string | null = null,
  ) {
    super(`internal_api:${op}:${status}`);
    this.name = 'InternalApiError';
  }
}

/** Mã lỗi ổn định trong thân `application/problem+json` của API (SPEC 10.1). */
async function problemCode(res: Response): Promise<string | null> {
  try {
    const json: unknown = await res.json();
    return typeof json === 'object' && json !== null && 'code' in json && typeof json.code === 'string' ? json.code : null;
  } catch {
    return null;
  }
}

/** Người đang được thay mặt: đi vào header X-On-Behalf-Of và X-Org-Id. */
export type OnBehalfOf = { userId: string; orgId: string };

export type InternalMessage = { conversationId: string; role: 'user' | 'assistant' | 'tool'; content: unknown; sttConfidence?: number };

export type InternalUsage = { conversationId: string; llmCalls: number; llmInputTokens: number; llmOutputTokens: number; sttSeconds: number; ttsChars: number; errors: number };

export type InternalApiOptions = { baseUrl: string; serviceToken: string; fetch?: typeof fetch; timeoutMs?: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class InternalApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: InternalApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request(op: string, method: 'GET' | 'POST', path: string, body?: unknown, who?: OnBehalfOf): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    return doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.serviceToken}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(who ? { 'X-On-Behalf-Of': who.userId, 'X-Org-Id': who.orgId } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch(() => {
      throw new InternalApiError(0, op);
    });
  }

  /** Khoá công khai ES256 để kiểm token phiên. */
  async jwks(): Promise<JSONWebKeySet> {
    const res = await this.request('jwks', 'GET', '/internal/v1/jwks');
    if (!res.ok) throw new InternalApiError(res.status, 'jwks');
    const json: unknown = await res.json();
    if (!isRecord(json) || !Array.isArray(json.keys)) throw new InternalApiError(502, 'jwks');
    return json as unknown as JSONWebKeySet;
  }

  /**
   * Đánh dấu token đã dùng. 409 nghĩa là token đã dùng rồi; 503 kèm mã `ai_disabled` nghĩa là tổ chức đang tắt trợ lý.
   * `who` lấy từ claim `org` và `sub` của token phiên: API mở giao dịch theo tổ chức ở header X-Org-Id.
   */
  async claim(sessionId: string, jti: string, who: OnBehalfOf): Promise<InternalClaimResponse> {
    const res = await this.request('claim', 'POST', `/internal/v1/scribe/sessions/${encodeURIComponent(sessionId)}/claim`, { jti }, who);
    if (!res.ok) throw new InternalApiError(res.status, 'claim', await problemCode(res));
    const parsed = InternalClaimResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new InternalApiError(502, 'claim');
    return parsed.data;
  }

  /**
   * Chạy một tool thay người dùng. Lỗi nghiệp vụ (tham số sai, không có quyền, thực thể không tồn tại) trả về
   * dạng `{ ok: false, error }` để model biết mà nói lại; chỉ lỗi mạng mới ném ra.
   */
  async callTool(name: string, args: Record<string, unknown>, who: OnBehalfOf, conversationId: string): Promise<InternalToolResult> {
    // Tên tool do model sinh ra: chỉ nhận tên có trong danh mục, không ghép chuỗi lạ vào đường dẫn.
    if (!isToolName(name)) return { ok: false, error: { code: 'unknown_tool', message: 'Không có tool này.' } };
    const res = await this.request('tool', 'POST', `/internal/v1/tools/${name}`, { args, conversationId }, who);
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const parsed = InternalToolResultSchema.safeParse(json);
      if (parsed.success) return parsed.data;
      throw new InternalApiError(502, 'tool');
    }
    if (res.status >= 500) throw new InternalApiError(res.status, 'tool');
    const code = isRecord(json) && typeof json.code === 'string' ? json.code : `http_${res.status}`;
    return { ok: false, error: { code, message: 'Máy chủ không nhận lời gọi tool này.' } };
  }

  /** Ghi một dòng `messages` của hội thoại. Không bao giờ gửi âm thanh. */
  async postMessage(message: InternalMessage, who: OnBehalfOf): Promise<void> {
    const res = await this.request('message', 'POST', '/internal/v1/messages', message, who);
    if (!res.ok) throw new InternalApiError(res.status, 'message', await problemCode(res));
  }

  /** Cộng số liệu sau mỗi lượt; trả hạn mức còn lại của người dùng trong ngày. */
  async postUsage(usage: InternalUsage, who: OnBehalfOf): Promise<number> {
    const res = await this.request('usage', 'POST', '/internal/v1/scribe/usage', usage, who);
    if (!res.ok) throw new InternalApiError(res.status, 'usage', await problemCode(res));
    const parsed = InternalUsageResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new InternalApiError(502, 'usage');
    return parsed.data.quotaLeft;
  }
}
