/**
 * Mô hình ngôn ngữ (SPEC 6.3, 6.9). `LlmClient.stream` chạy MỘT lượt gọi model và phát sự kiện theo dòng;
 * vòng lặp tác tử (gọi tool, gom tool_result, lặp lại) do `scribe` tự viết để chèn cổng xác nhận và chốt chặn số liệu.
 *
 * Quy ước cho bên gọi:
 *  - Chỉ chạy tool sau khi nhận `message_stop` với `stopReason: 'tool_use'`. Sự kiện `tool_use` đã mang đủ tham số
 *    (phân tích tại `content_block_stop`), nhưng một lượt bị cắt (`max_tokens`, `refusal`) thì không được chạy tool.
 *  - Mọi `tool_result` của một lượt trả trong MỘT tin nhắn người dùng.
 *  - Tin nhắn assistant đưa lại vào lịch sử phải giữ nguyên `raw` nhận từ `message_stop` (khối thinking của Claude
 *    phải được trả lại nguyên vẹn, và lịch sử chỉ được nối thêm, không sửa lượt cũ).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DraftAssignableRole } from '@mihato/domain';
import { parseNumber } from '@mihato/domain/vi-normalize';

export type LlmCacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' };
/** Một khối của system prompt. Khối có `cache_control` là điểm cache (tối đa 4 điểm mỗi yêu cầu). */
export type LlmBlock = { type: 'text'; text: string; cache_control?: LlmCacheControl };

/** Định nghĩa tool đúng dạng Claude Messages API; `claudeToolDefinitions()` ở @mihato/ai-tools trả đúng kiểu này. */
export type LlmToolDef = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  /** vắng mặt nghĩa là không strict: tool nặng bị tắt strict để tổng văn phạm của cả bộ không vượt trần của Claude (xem @mihato/ai-tools tools.ts) */
  strict?: true;
};

export type LlmTextPart = { type: 'text'; text: string };
export type LlmToolUsePart = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type LlmToolResultPart = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
/** Nội dung thô của nhà cung cấp, trả lại nguyên vẹn ở lượt gọi sau. */
export type LlmRaw = { provider: string; content: unknown };

export type LlmMsg =
  | { role: 'user'; content: string | (LlmTextPart | LlmToolResultPart)[] }
  | { role: 'assistant'; content: string | (LlmTextPart | LlmToolUsePart)[]; raw?: LlmRaw };

export type LlmEffort = 'low' | 'medium';

export type LlmRequest = {
  system: LlmBlock[];
  tools: LlmToolDef[];
  messages: LlmMsg[];
  effort: LlmEffort;
  /** huỷ khi người dùng ngắt lời hoặc ngắt kết nối */
  signal?: AbortSignal;
};

export type LlmUsage = {
  /** tổng token vào, gồm cả phần đọc và ghi cache */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
export type LlmErrorCode = 'timeout' | 'unavailable' | 'rate_limited' | 'bad_request' | 'schema_too_large' | 'aborted' | 'bad_tool_input';

export type LlmEvent =
  | { type: 'text_delta'; text: string }
  /** đã phân tích đủ tham số */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stopReason: LlmStopReason; usage: LlmUsage; raw?: LlmRaw }
  /** chỉ mang mã, không mang nội dung (SPEC 6.8) */
  | { type: 'error'; code: LlmErrorCode; retryable: boolean };

export interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}

/**
 * Tiền tố của ghi chú do hệ thống chèn vào lịch sử dưới vai người dùng (ví dụ báo lỗi của chốt chặn số liệu).
 * System prompt giải thích tiền tố này; `scribe` gỡ tiền tố khỏi câu người dùng thật để không ai giả được.
 */
export const LLM_SYSTEM_NOTE_PREFIX = '[Ghi chú hệ thống]';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ───────────────────────── Anthropic ─────────────────────────

export type AnthropicLlmOptions = {
  /** bỏ trống: SDK tự lấy từ môi trường (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN hoặc hồ sơ `ant auth login`) */
  apiKey?: string;
  /** một model, cấu hình bằng LLM_MODEL [QUYẾT ĐỊNH, SPEC 6.3]; mặc định claude-sonnet-5-5 */
  model?: string;
  /** trần token ra của một lượt gọi; thinking cũng tính vào đây */
  maxTokens?: number;
  /** quá từng này mili giây chưa có token đầu thì huỷ (SPEC 6.11: 15 giây) */
  firstTokenTimeoutMs?: number;
  /** tự động cache phần hội thoại đã qua (điểm cache thứ ba, TTL 5 phút); mặc định bật */
  cacheConversation?: boolean;
  /** client dựng sẵn (test) */
  client?: Anthropic;
};

export const DEFAULT_LLM_MODEL = 'claude-sonnet-5-5';

function toSdkMessages(messages: LlmMsg[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'assistant') {
      // Trả lại nguyên khối của chính Claude (kể cả thinking) để không vi phạm kiểm tra lịch sử.
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.content)) {
        return { role: 'assistant', content: m.raw.content as Anthropic.ContentBlockParam[] };
      }
      if (typeof m.content === 'string') return { role: 'assistant', content: m.content };
      return {
        role: 'assistant',
        content: m.content.map((p): Anthropic.ContentBlockParam => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'tool_use', id: p.id, name: p.name, input: p.input })),
      };
    }
    if (typeof m.content === 'string') return { role: 'user', content: m.content };
    return {
      role: 'user',
      content: m.content.map(
        (p): Anthropic.ContentBlockParam =>
          p.type === 'text' ? { type: 'text', text: p.text } : { type: 'tool_result', tool_use_id: p.tool_use_id, content: p.content, ...(p.is_error ? { is_error: true } : {}) },
      ),
    };
  });
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): LlmStopReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn';
  if (reason === 'tool_use' || reason === 'max_tokens' || reason === 'refusal') return reason;
  return 'other';
}

/** Chuỗi bắt lỗi từ cụ thể đến chung, bằng lớp lỗi có kiểu của SDK (không so chuỗi thông điệp). */
function mapSdkError(err: unknown, timedOut: boolean, aborted: boolean): Extract<LlmEvent, { type: 'error' }> {
  if (timedOut) return { type: 'error', code: 'timeout', retryable: true };
  if (aborted || err instanceof Anthropic.APIUserAbortError) return { type: 'error', code: 'aborted', retryable: false };
  if (err instanceof Anthropic.RateLimitError) return { type: 'error', code: 'rate_limited', retryable: true };
  if (err instanceof Anthropic.APIConnectionError) return { type: 'error', code: 'unavailable', retryable: true };
  if (err instanceof Anthropic.InternalServerError) return { type: 'error', code: 'unavailable', retryable: true };
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    if (status >= 500) return { type: 'error', code: 'unavailable', retryable: true };
    // Bộ công cụ strict biên dịch ra văn phạm quá lớn: Claude từ chối MỌI yêu cầu, tức là trợ lý hỏng ở mọi câu (gặp thật ngày
    // 04/10/2026, xem packages/ai-tools/src/tools.ts). API không có mã con cho lỗi 400 nên đây là chỗ DUY NHẤT so thông điệp; không khớp
    // thì vẫn là `bad_request`. Chỉ lấy kết quả so, thông điệp không đi đâu cả (SPEC 6.8).
    if (status === 400 && /compiled grammar is too large|too complex for compilation/i.test(err.message)) return { type: 'error', code: 'schema_too_large', retryable: false };
    return { type: 'error', code: 'bad_request', retryable: false };
  }
  return { type: 'error', code: 'unavailable', retryable: true };
}

/**
 * Claude qua `@anthropic-ai/sdk` `client.messages.stream()` (SPEC 6.3). Ràng buộc đã xác minh với Sonnet 5.5 và Opus 5.5:
 *  - `tool_choice` chỉ `auto` (`any` và `tool` trả lỗi 400); tool có `strict: true` và schema `additionalProperties: false`.
 *  - KHÔNG đặt `temperature`, `top_p`, `top_k`; không viết sẵn đầu câu trả lời (prefill).
 *  - Thinking bật mặc định dạng thích nghi và không tắt được: không gửi tham số `thinking`, chỉ chỉnh
 *    `output_config.effort` = `low` hoặc `medium` cho độ trễ của giọng nói.
 *  - Tham số tool đến dạng JSON từng phần (`input_json_delta`): chỉ phân tích tại `content_block_stop`.
 *    Không bật `eager_input_streaming`: tham số của bộ tool này rất ngắn, và cần giữ bảo đảm của `strict`.
 *  - Cache prompt: các khối system có `cache_control` do bên gọi đặt (tĩnh, theo tổ chức), cộng một điểm tự động
 *    cho phần hội thoại đã qua. Tối đa 4 điểm; khối TTL dài phải đứng trước khối TTL ngắn.
 *  - Một model theo `LLM_MODEL` [QUYẾT ĐỊNH]: không bật `fallbacks` sang model khác khi bị từ chối (`refusal`);
 *    lượt bị từ chối trả `stopReason: 'refusal'` để `scribe` dùng câu mẫu.
 * Chưa được gọi thật lần nào trong phiên dựng mã (không có khoá API).
 */
export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly cacheConversation: boolean;

  constructor(opts: AnthropicLlmOptions = {}) {
    this.client = opts.client ?? new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), maxRetries: 1 });
    this.model = opts.model || DEFAULT_LLM_MODEL;
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 15_000;
    this.cacheConversation = opts.cacheConversation ?? true;
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal?.aborted) {
      yield { type: 'error', code: 'aborted', retryable: false };
      return;
    }
    req.signal?.addEventListener('abort', onAbort, { once: true });

    let timedOut = false;
    let started = false;
    const timer = setTimeout(() => {
      if (!started) {
        timedOut = true;
        controller.abort();
      }
    }, this.firstTokenTimeoutMs);

    // Tham số tool gom theo chỉ số khối, chỉ phân tích khi khối đóng.
    const pending = new Map<number, { id: string; name: string; json: string }>();

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: req.system,
          tools: req.tools,
          tool_choice: { type: 'auto' },
          messages: toSdkMessages(req.messages),
          output_config: { effort: req.effort },
          ...(this.cacheConversation ? { cache_control: { type: 'ephemeral' as const } } : {}),
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          started = true;
          if (event.content_block.type === 'tool_use') pending.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
        } else if (event.type === 'content_block_delta') {
          started = true;
          if (event.delta.type === 'text_delta') {
            if (event.delta.text) yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const p = pending.get(event.index);
            if (p) p.json += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          const p = pending.get(event.index);
          if (!p) continue;
          pending.delete(event.index);
          let input: unknown;
          try {
            input = p.json.trim() ? JSON.parse(p.json) : {};
          } catch {
            yield { type: 'error', code: 'bad_tool_input', retryable: true };
            controller.abort();
            return;
          }
          if (!isRecord(input)) {
            yield { type: 'error', code: 'bad_tool_input', retryable: true };
            controller.abort();
            return;
          }
          yield { type: 'tool_use', id: p.id, name: p.name, input };
        }
      }

      const final = await stream.finalMessage();
      const cacheRead = final.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      yield {
        type: 'message_stop',
        stopReason: mapStopReason(final.stop_reason),
        usage: {
          inputTokens: final.usage.input_tokens + cacheRead + cacheWrite,
          outputTokens: final.usage.output_tokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        },
        raw: { provider: 'anthropic', content: final.content },
      };
    } catch (err) {
      yield mapSdkError(err, timedOut, req.signal?.aborted === true);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ───────────────────────── Bản giả ─────────────────────────

export type FakeLlmToolCall = { name: string; args: Record<string, unknown> };
export type FakeLlmTurn = { reply?: string; toolCalls?: FakeLlmToolCall[] };

/** Một lời gọi tool đã có kết quả, đọc lại từ lịch sử hội thoại. */
export type FakeLlmToolOutcome = {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** nội dung tool_result đã phân tích JSON (thường là `{ ok, result, error, proposals }`); undefined nếu không phải JSON */
  data: unknown;
  /** `data.result` nếu có, ngược lại là `data` */
  payload: unknown;
};

export type FakeLlmContext = {
  messages: LlmMsg[];
  /** toàn bộ system prompt nối lại */
  system: string;
  /** câu người dùng cuối (không tính tool_result và ghi chú hệ thống) */
  userText: string;
  /** các câu người dùng trước đó trong hội thoại, cũ trước mới sau */
  previousUserTexts: string[];
  /** câu trả lời bằng chữ gần nhất của trợ lý trước câu người dùng cuối */
  previousAssistantText: string;
  /** số ghi chú hệ thống (ví dụ báo lỗi chốt chặn số liệu) đến sau câu người dùng cuối */
  notices: number;
  /** kết quả tool kể từ câu người dùng cuối, theo thứ tự */
  toolResults: FakeLlmToolOutcome[];
  /** kết quả gần nhất của một tool kể từ câu người dùng cuối */
  last(name: string): FakeLlmToolOutcome | undefined;
  /**
   * mọi câu người dùng của CẢ hội thoại (không tính tool_result và ghi chú hệ thống), cũ trước mới sau, câu cuối là `userText`;
   * mỗi câu kèm câu trả lời bằng chữ gần nhất của trợ lý đứng ngay trước nó (rỗng với câu đầu)
   */
  turns: { userText: string; previousAssistantText: string }[];
  /** kết quả tool của CẢ hội thoại (không chỉ từ câu người dùng cuối), theo thứ tự */
  allToolResults: FakeLlmToolOutcome[];
};

export type FakeLlmStep = {
  /** RegExp thử trên câu người dùng cuối (cả bản có dấu và bản bỏ dấu); hoặc hàm nhận toàn bộ lịch sử */
  when: RegExp | ((messages: LlmMsg[]) => boolean);
  /** dạng tĩnh: lượt đầu gọi `toolCalls` (nếu có), có kết quả tool rồi thì trả `reply` */
  reply?: string;
  toolCalls?: FakeLlmToolCall[];
  /** dạng động: quyết định theo kết quả tool đã có; ưu tiên hơn dạng tĩnh */
  respond?: (ctx: FakeLlmContext) => FakeLlmTurn;
};

export type FakeLlmOptions = {
  /** nối thêm bộ kịch bản mặc định (tạo quy trình bằng hội thoại, kịch bản vàng biến thể B) sau các bước tự đặt; mặc định có */
  includeDefaults?: boolean;
  /** trễ trước sự kiện đầu (để kiểm ngưỡng 2 giây và 15 giây) */
  delayMs?: number;
};

export type FakeLlmCall = { system: LlmBlock[]; tools: LlmToolDef[]; messages: LlmMsg[]; effort: LlmEffort };

const stripDiacritics = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFC');

/** Gỡ thẻ bọc `<tool_result …>` (nếu có) rồi phân tích JSON; không phải JSON thì trả undefined. */
export function parseToolResultContent(content: string): unknown {
  const m = /^\s*<tool_result\b[^>]*>\s*([\s\S]*?)\s*<\/tool_result>\s*$/.exec(content);
  const body = (m ? (m[1] as string) : content).trim();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function textOfUser(m: Extract<LlmMsg, { role: 'user' }>): string | null {
  if (typeof m.content === 'string') return m.content;
  const texts = m.content.filter((p): p is LlmTextPart => p.type === 'text').map((p) => p.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

function textOfAssistant(m: Extract<LlmMsg, { role: 'assistant' }>): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p): p is LlmTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Kết quả một lời gọi tool, đọc lại từ phần `tool_result` của lịch sử. */
function toolOutcome(use: { name: string; args: Record<string, unknown> } | undefined, part: LlmToolResultPart): FakeLlmToolOutcome {
  const data = parseToolResultContent(part.content);
  const payload = isRecord(data) && 'result' in data ? data.result : data;
  return { name: use?.name ?? '', args: use?.args ?? {}, isError: part.is_error === true || (isRecord(data) && data.ok === false), data, payload };
}

/** Dựng ngữ cảnh cho kịch bản của FakeLlm từ lịch sử hội thoại. */
export function buildFakeLlmContext(req: Pick<LlmRequest, 'system' | 'messages'>): FakeLlmContext {
  const { messages } = req;
  let lastIdx = -1;
  const userTexts: { idx: number; text: string }[] = [];
  messages.forEach((m, idx) => {
    if (m.role !== 'user') return;
    const text = textOfUser(m);
    if (text === null || text.startsWith(LLM_SYSTEM_NOTE_PREFIX)) return;
    userTexts.push({ idx, text });
    lastIdx = idx;
  });

  let notices = 0;
  const uses = new Map<string, { name: string; args: Record<string, unknown> }>();
  const toolResults: FakeLlmToolOutcome[] = [];
  let previousAssistantText = '';
  messages.forEach((m, idx) => {
    if (idx < lastIdx) {
      if (m.role === 'assistant') {
        const t = textOfAssistant(m).trim();
        if (t) previousAssistantText = t;
      }
      return;
    }
    if (idx === lastIdx) return;
    if (m.role === 'assistant') {
      if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'tool_use') uses.set(p.id, { name: p.name, args: p.input });
      return;
    }
    const text = textOfUser(m);
    if (text !== null && text.startsWith(LLM_SYSTEM_NOTE_PREFIX)) notices++;
    if (typeof m.content === 'string') return;
    for (const p of m.content) if (p.type === 'tool_result') toolResults.push(toolOutcome(uses.get(p.tool_use_id), p));
  });

  // Cả hội thoại: luồng nhiều lượt (tạo quy trình) dựng lại trạng thái từ các câu người dùng và kết quả tool của mọi lượt trước.
  const turns: FakeLlmContext['turns'] = [];
  const allUses = new Map<string, { name: string; args: Record<string, unknown> }>();
  const allToolResults: FakeLlmToolOutcome[] = [];
  let assistantSoFar = '';
  for (const m of messages) {
    if (m.role === 'assistant') {
      const t = textOfAssistant(m).trim();
      if (t) assistantSoFar = t;
      if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'tool_use') allUses.set(p.id, { name: p.name, args: p.input });
      continue;
    }
    const text = textOfUser(m);
    if (text !== null && !text.startsWith(LLM_SYSTEM_NOTE_PREFIX)) turns.push({ userText: text, previousAssistantText: assistantSoFar });
    if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'tool_result') allToolResults.push(toolOutcome(allUses.get(p.tool_use_id), p));
  }

  return {
    messages,
    system: req.system.map((b) => b.text).join('\n\n'),
    userText: lastIdx >= 0 ? (userTexts[userTexts.length - 1] as { text: string }).text : '',
    previousUserTexts: userTexts.slice(0, -1).map((u) => u.text),
    previousAssistantText,
    notices,
    toolResults,
    last: (name) => {
      for (let i = toolResults.length - 1; i >= 0; i--) if ((toolResults[i] as FakeLlmToolOutcome).name === name) return toolResults[i];
      return undefined;
    },
    turns,
    allToolResults,
  };
}

// ── Tiện ích đọc kết quả tool một cách khoan dung (hình dạng kết quả do máy chủ quyết định) ──

/** Mảng nằm ngay ở `value`, hoặc ở một trong các khoá cho trước. */
export function pickArray(value: unknown, ...keys: string[]): Record<string, unknown>[] {
  const take = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : null);
  const direct = take(value);
  if (direct) return direct;
  if (isRecord(value)) {
    for (const k of keys) {
      const found = take(value[k]);
      if (found) return found;
    }
  }
  return [];
}

/** Id của một dòng kết quả: thử lần lượt các khoá (máy chủ dùng `runId`, `stepId`, `templateId`; người thì `id`). */
export function idOf(row: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(row)) return undefined;
  for (const k of [...keys, 'id']) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Những người khớp RÕ trong kết quả `search_people`. Máy chủ trả kèm `score` và cả các ứng viên khớp yếu:
 * chỉ giữ người có điểm từ 0.5 và trong khoảng 90% điểm cao nhất. Hai người trùng tên có cùng điểm nên đều được giữ.
 * Kết quả không có `score` thì giữ tất cả.
 */
export function matchedPeople(payload: unknown): Record<string, unknown>[] {
  const people = pickArray(payload, 'people', 'matches', 'items');
  if (!people.some((p) => typeof p.score === 'number')) return people;
  const scores = people.map((p) => (typeof p.score === 'number' ? p.score : 0));
  const top = Math.max(0, ...scores);
  return people.filter((_, i) => (scores[i] as number) >= 0.5 && (scores[i] as number) >= top * 0.9);
}

const HONORIFIC_WORD: Record<string, string> = { anh: 'anh', chi: 'chị', ong: 'ông', ba: 'bà', co: 'cô', chu: 'chú', bac: 'bác' };

/** "anh Tuấn", "chị Lan": xưng hô kèm tên gọi; thiếu thì dùng họ tên. Nhận cả nhãn dựng sẵn dạng chuỗi. */
export function personLabel(person: unknown): string {
  if (typeof person === 'string' && person.trim()) return person.trim();
  if (!isRecord(person)) return 'người nhận việc';
  if (typeof person.label === 'string' && person.label) return person.label;
  const given = typeof person.givenName === 'string' ? person.givenName : '';
  const honorific = typeof person.honorific === 'string' ? (HONORIFIC_WORD[person.honorific] ?? person.honorific) : '';
  if (given) return honorific ? `${honorific} ${given}` : given;
  return typeof person.fullName === 'string' && person.fullName ? person.fullName : 'người nhận việc';
}

const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const OPEN_STATES = new Set(['unassigned', 'ready', 'in_progress']);

/** Câu tóm tắt một lượt chạy, chỉ dùng số có trong kết quả `get_run`. */
export function describeRunForFake(payload: unknown, title = 'Chủ tịch'): string {
  const run = isRecord(payload) && isRecord(payload.run) ? payload.run : isRecord(payload) ? payload : {};
  const steps = pickArray(run, 'steps');
  // Máy chủ trả `done` và `total` ngay ở lượt chạy; bản cũ để trong `progress`.
  const progress = isRecord(run.progress) ? run.progress : run;
  const total = asNumber(progress.total) ?? steps.length;
  const done = asNumber(progress.done) ?? steps.filter((s) => s.state === 'done').length;
  const overdue = steps.filter((s) => s.isOverdue === true);
  const working = steps.filter((s) => typeof s.state === 'string' && OPEN_STATES.has(s.state) && s.isOverdue !== true).length;
  const name = asString(run.title) ?? 'này';
  let out = `Dạ thưa ${title}, đợt “${name}” có ${done} trên ${total} việc đã xong.`;
  if (overdue.length === 0) {
    out += working > 0 ? ` Còn ${working} việc đang làm, chưa có việc nào quá hạn.` : ' Chưa có việc nào quá hạn.';
    return out;
  }
  out += working > 0 ? ` Còn ${working} việc đang làm và ${overdue.length} việc quá hạn.` : ` Có ${overdue.length} việc quá hạn.`;
  const worst = overdue[0] as Record<string, unknown>;
  const late = asNumber(worst.lateWorkingDays);
  out += ` Việc quá hạn là “${asString(worst.title) ?? 'chưa rõ tên'}” của ${personLabel(worst.assignee)}${late !== null && late > 0 ? `, trễ ${late} ngày làm việc` : ''}.`;
  return out;
}

/** Phần tên sau động từ: "đi thúc anh Tuấn giúp tôi nhé" → "anh Tuấn". */
export function extractNameAfter(text: string, verbs: RegExp): string {
  const m = verbs.exec(text.normalize('NFC'));
  if (!m) return '';
  return text
    .normalize('NFC')
    .slice(m.index + m[0].length)
    .replace(/[.,!?…]+/g, ' ')
    .replace(/\s+(giúp tôi|giúp|hộ tôi|hộ|đi|nhé|nha|ạ|với|ngay|luôn)(?=\s|$)/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HONORIFIC_ALT = 'anh|chị|ông|bà|cô|chú|bác|Anh|Chị|Ông|Bà|Cô|Chú|Bác';

/**
 * Cách gọi một người trong câu: "nhắc anh Tuấn làm cho xong việc…" → "anh Tuấn"; "chị Ngọc Anh đang giữ việc gì" → "chị Ngọc Anh".
 * Tên viết hoa thì lấy tới hai tiếng; tên viết thường (STT không viết hoa) thì lấy một tiếng. Không thấy thì trả chuỗi rỗng.
 */
export function extractPersonQuery(text: string): string {
  const s = text.normalize('NFC');
  const cap = new RegExp(String.raw`(?<![\p{L}\p{N}])(${HONORIFIC_ALT})\s+(\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*)?)`, 'u').exec(s);
  if (cap) return `${(cap[1] as string).toLowerCase()} ${cap[2] as string}`;
  const low = new RegExp(String.raw`(?<![\p{L}\p{N}])(${HONORIFIC_ALT})\s+(\p{L}+)`, 'u').exec(s);
  return low ? `${(low[1] as string).toLowerCase()} ${low[2] as string}` : '';
}

/**
 * Luồng "đi thúc" của bản giả: `search_people` → (một người) `list_overdue_steps` → `propose_nudge`.
 * Nhiều người khớp thì hỏi lại đúng một câu, không chọn thay người dùng.
 */
const SKIP_TEXT: Record<string, string> = {
  already_nudged_today: 'hôm nay việc này đã được nhắc rồi',
  quiet_hours: 'bây giờ đang trong giờ yên tĩnh của người nhận',
  not_overdue: 'việc này chưa quá hạn',
  extension_pending: 'việc này đang có yêu cầu gia hạn chờ duyệt',
  not_open: 'việc này không còn mở',
};

/**
 * `propose_nudge` không tạo được đề xuất nào vì mọi việc đều bị chặn làm phiền (SPEC 4.7): nói rõ lý do thay vì
 * nói "đã soạn lời nhắc". Trả null khi có đề xuất được tạo hoặc kết quả không mang số liệu này.
 */
function nudgeSkippedReply(outcome: FakeLlmToolOutcome): string | null {
  if (!isRecord(outcome.payload)) return null;
  const created = outcome.payload.created;
  if (typeof created !== 'number' || created > 0) return null;
  const skipped = pickArray(outcome.payload, 'skipped');
  if (skipped.length === 0) return 'Dạ thưa Chủ tịch, trợ lý chưa soạn được lời nhắc nào.';
  const reasons = [...new Set(skipped.map((x) => SKIP_TEXT[String(x.reason)] ?? 'việc này đang được chặn nhắc'))];
  return `Dạ thưa Chủ tịch, trợ lý chưa soạn lời nhắc vì ${reasons.join(', ')}.`;
}

export function fakeNudgeFlow(ctx: FakeLlmContext, query: string): FakeLlmTurn {
  const found = ctx.last('search_people');
  if (!found) return { toolCalls: [{ name: 'search_people', args: { query } }] };
  const people = matchedPeople(found.payload);
  if (people.length === 0) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy ai tên như vậy. Xin Chủ tịch nói lại tên giúp trợ lý ạ.' };
  if (people.length > 1) return { reply: `Dạ, ${query} nào ạ?` };
  const person = people[0] as Record<string, unknown>;
  const overdue = ctx.last('list_overdue_steps');
  if (!overdue) return { toolCalls: [{ name: 'list_overdue_steps', args: { assigneeId: person.id } }] };
  const stepIds = pickArray(overdue.payload, 'steps', 'items')
    .map((s) => idOf(s, 'stepId'))
    .filter((id): id is string => id !== undefined);
  if (stepIds.length === 0) return { reply: `Dạ thưa Chủ tịch, ${personLabel(person)} hiện không có việc nào quá hạn.` };
  const proposed = ctx.last('propose_nudge');
  if (!proposed) return { toolCalls: [{ name: 'propose_nudge', args: { stepRunIds: stepIds, named: true } }] };
  if (proposed.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa soạn được lời nhắc này. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.' };
  const skipped = nudgeSkippedReply(proposed);
  if (skipped) return { reply: skipped };
  return { reply: `Dạ thưa Chủ tịch, trợ lý đã soạn lời nhắc gửi ${personLabel(person)}. Xin Chủ tịch xem trên màn hình và bấm Đồng ý gửi nếu đúng.` };
}

const QUOTED_NAME_RE = /[‘'“"]([^’'”"]+)[’'”"]/u;
/** "đi thúc các việc đang chậm", "thúc tất cả", "nhắc những việc quá hạn": nhắc hàng loạt, không nêu một người. */
export const MASS_NUDGE_RE = /(^|\s)(đi\s+thúc|thúc|nhắc)\s+(tất cả|hết|mọi|các|những)(\s|$)/iu;

/**
 * Đi thúc mọi việc đang chậm (SPEC 1, kết quả 3: "đi thúc các việc đang chậm"). Có tên lượt chạy trong ngoặc kép
 * (câu soạn sẵn ở M5: "Đi thúc các việc đang chậm của lượt ‘…’") thì chỉ lấy các việc của lượt đó.
 */
export function fakeMassNudgeFlow(ctx: FakeLlmContext): FakeLlmTurn {
  const runName = QUOTED_NAME_RE.exec(ctx.userText)?.[1]?.trim();
  let runId: string | undefined;
  if (runName) {
    const listed = ctx.last('list_runs');
    if (!listed) return { toolCalls: [{ name: 'list_runs', args: { state: 'running', query: runName } }] };
    runId = pickArray(listed.payload, 'runs', 'items')
      .map((r) => idOf(r, 'runId'))
      .find(Boolean);
    if (!runId) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy đợt việc đó. Chủ tịch muốn đi thúc đợt việc nào ạ?' };
  }
  const overdue = ctx.last('list_overdue_steps');
  if (!overdue) return { toolCalls: [{ name: 'list_overdue_steps', args: runId ? { runId } : {} }] };
  const stepIds = pickArray(overdue.payload, 'steps', 'items')
    .map((x) => idOf(x, 'stepId'))
    .filter((id): id is string => id !== undefined);
  if (stepIds.length === 0) return { reply: 'Dạ thưa Chủ tịch, hiện không có việc nào quá hạn.' };
  const proposed = ctx.last('propose_nudge');
  if (!proposed) return { toolCalls: [{ name: 'propose_nudge', args: { stepRunIds: stepIds.slice(0, 50), named: true } }] };
  if (proposed.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa soạn được lời nhắc. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.' };
  const skipped = nudgeSkippedReply(proposed);
  if (skipped) return { reply: skipped };
  return { reply: 'Dạ thưa Chủ tịch, trợ lý đã soạn lời nhắc. Xin Chủ tịch xem trên màn hình và bấm Đồng ý gửi nếu đúng.' };
}

/** "Ai đang chậm?": đọc các việc quá hạn rồi nêu việc trễ nhất. Số liệu lấy từ kết quả tool. */
export function fakeWhoIsLateFlow(ctx: FakeLlmContext): FakeLlmTurn {
  const overdue = ctx.last('list_overdue_steps');
  if (!overdue) return { toolCalls: [{ name: 'list_overdue_steps', args: {} }] };
  const steps = pickArray(overdue.payload, 'steps', 'items');
  if (steps.length === 0) return { reply: 'Dạ thưa Chủ tịch, hiện không có việc nào quá hạn.' };
  const worst = steps[0] as Record<string, unknown>;
  const late = typeof worst.lateWorkingDays === 'number' && Number.isFinite(worst.lateWorkingDays) ? worst.lateWorkingDays : 0;
  return {
    reply: `Dạ thưa Chủ tịch, hiện có ${steps.length} việc quá hạn. Việc “${typeof worst.title === 'string' ? worst.title : ''}” của ${personLabel(worst.assignee)}${late > 0 ? ` trễ ${late} ngày làm việc` : ' đã quá hạn'}.`,
  };
}

const NUDGE_PERSON_RE = /(^|\s)(đi\s+thúc|thúc|nhắc)\s+\S+/iu;
const WHICH_ONE_RE = /nào ạ\?$/u;

export const FAKE_LLM_DEFAULT_REPLY = 'Dạ thưa Chủ tịch, trợ lý chưa hiểu rõ ý vừa rồi. Xin Chủ tịch nói lại giúp trợ lý ạ.';

/**
 * Bộ kịch bản mặc định, đủ cho kịch bản vàng biến thể B (SPEC 13.2 bước 8, 9 và nhánh B3):
 *  - "tình hình đón đoàn Nhật" → `list_runs` rồi `get_run` rồi trả lời từ kết quả tool;
 *  - "đi thúc anh Tuấn" → `search_people`, `list_overdue_steps`, `propose_nudge`;
 *  - "đi thúc các việc đang chậm [của lượt ‘…’]" → `list_overdue_steps` rồi `propose_nudge` cho mọi việc quá hạn;
 *  - "ai đang chậm" → `list_overdue_steps`;
 *  - "huỷ cả đợt đón đoàn" → `list_runs` rồi `propose_cancel_run`;
 *  - câu lạ → câu trả lời lịch sự mặc định.
 * Tất định: cùng lịch sử hội thoại thì cùng kết quả. Không đo chất lượng của trợ lý thật.
 */
export const GOLDEN_B_SCRIPT: FakeLlmStep[] = [
  {
    when: /hu[ỷy]\s+(cả\s+|toàn bộ\s+)?(đợt|lượt|quy trình)/iu,
    respond: (ctx) => {
      const listed = ctx.last('list_runs');
      if (!listed) return { toolCalls: [{ name: 'list_runs', args: { state: 'running', query: 'đón đoàn' } }] };
      const runId = pickArray(listed.payload, 'runs', 'items')
        .map((r) => idOf(r, 'runId'))
        .find(Boolean);
      if (!runId) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy đợt việc nào đang chạy như vậy. Chủ tịch muốn huỷ đợt việc nào ạ?' };
      const proposed = ctx.last('propose_cancel_run');
      if (!proposed) return { toolCalls: [{ name: 'propose_cancel_run', args: { runId, reason: 'Người dùng yêu cầu huỷ qua trợ lý' } }] };
      if (proposed.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa soạn được đề xuất huỷ này. Xin Chủ tịch thử lại, hoặc bấm Nhờ Văn phòng.' };
      return { reply: 'Dạ thưa Chủ tịch, trợ lý đã soạn đề xuất huỷ đợt việc này. Việc huỷ cần Chủ tịch chạm xác nhận trên màn hình và nhập mã PIN hoặc dùng sinh trắc học.' };
    },
  },
  { when: MASS_NUDGE_RE, respond: fakeMassNudgeFlow },
  {
    // Người dùng chạm chọn một người sau câu hỏi "… nào ạ?": tiếp tục đúng việc đang dở.
    when: (messages) => {
      const ctx = buildFakeLlmContext({ system: [], messages });
      return WHICH_ONE_RE.test(ctx.previousAssistantText) && NUDGE_PERSON_RE.test(ctx.previousUserTexts.at(-1) ?? '');
    },
    respond: (ctx) => fakeNudgeFlow(ctx, ctx.userText),
  },
  {
    when: NUDGE_PERSON_RE,
    respond: (ctx) => {
      const query = extractPersonQuery(ctx.userText) || extractNameAfter(ctx.userText, /(đi\s+thúc|thúc\s+giục|thúc|nhắc\s+việc|nhắc)\s+/iu) || ctx.userText;
      return fakeNudgeFlow(ctx, query);
    },
  },
  { when: /ai (đang )?(chậm|trễ)|có gì chậm|(việc|cái) (nào|gì) (đang )?(chậm|quá hạn|trễ)/iu, respond: fakeWhoIsLateFlow },
  {
    when: /(tình hình|đến đâu|tiến độ|thế nào|ra sao).*(đoàn|đợt)|(đoàn|đợt).*(tình hình|đến đâu|tiến độ|thế nào|ra sao)/iu,
    respond: (ctx) => {
      const listed = ctx.last('list_runs');
      if (!listed) return { toolCalls: [{ name: 'list_runs', args: { state: 'running', query: 'đón đoàn' } }] };
      const runId = pickArray(listed.payload, 'runs', 'items')
        .map((r) => idOf(r, 'runId'))
        .find(Boolean);
      if (!runId) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa tìm thấy đợt việc nào như vậy. Chủ tịch muốn hỏi đợt việc nào ạ?' };
      const detail = ctx.last('get_run');
      if (!detail) return { toolCalls: [{ name: 'get_run', args: { runId } }] };
      if (detail.isError) return { reply: 'Dạ thưa Chủ tịch, trợ lý chưa xem được đợt việc này. Xin Chủ tịch thử lại sau.' };
      return { reply: describeRunForFake(detail.payload) };
    },
  },
];

// ───────────────────────── Tạo quy trình bằng hội thoại ─────────────────────────

/**
 * Luồng "tạo quy trình" và "xuất bản quy trình" của bản giả (docs/DECISIONS.md, 04/10/2026). Người dùng nói tên quy trình rồi đọc từng bước;
 * mỗi bước trợ lý tra người (`search_people`, song song) rồi gửi TOÀN BỘ các bước đã đọc cho `preview_process`, để máy chủ đọc lại bước vừa nghe
 * hoặc báo `problems` cho trợ lý hỏi đúng chỗ còn thiếu; khi người dùng nói "xong" thì gọi `propose_create_process`.
 *
 * Không giữ trạng thái nào ngoài lịch sử: mỗi lượt dựng lại quy trình từ các câu người dùng đã nói (và câu hỏi trợ lý đã đặt trước mỗi câu),
 * nên tất định. Cú pháp hiểu được (không phân biệt hoa thường và dấu; số viết bằng chữ số hoặc bằng chữ từ "một" đến "ba mươi"):
 *   tạo | lập [một] quy trình [mới] [tên là] <tên>
 *   bước <n>[:,] <việc>, <người> làm, hạn | trong <số> ngày [, làm cùng lúc với bước trước | song song]
 *   bước <n>[:,] <người hoặc chức danh> duyệt <việc>, hạn <số> ngày
 *   xong | hết rồi | đã hết | hết | đó là tất cả
 *   xuất bản [quy trình] <tên> [và giao việc [với tên] <tên lượt>]
 * Người là tên ("anh Tuấn") hoặc chức danh (Văn phòng, Giám đốc, Phó giám đốc, Chủ tịch) hoặc "người giao việc".
 * Không cần thông minh: câu ngoài cú pháp này rơi về câu mặc định.
 */

type DraftWho = { kind: 'person'; query: string } | { kind: 'role'; role: DraftAssignableRole } | { kind: 'initiator' };

/** Một bước người dùng đã đọc; ô còn null là chỗ còn thiếu. */
type DraftStep = {
  title: string | null;
  approval: boolean;
  who: DraftWho | null;
  dueDays: number | null;
  parallel: boolean;
  /** thứ tự (từ 0) của câu người dùng đã thêm hoặc sửa bước này lần cuối */
  turn: number;
};

/** Câu hỏi trợ lý đã đặt và đang chờ trả lời. */
type DraftAsk = { kind: 'name' } | { kind: 'person' } | { kind: 'title' | 'who' | 'due'; step: number };

type ProcessDraft = {
  started: boolean;
  name: string | null;
  steps: DraftStep[];
  ask: DraftAsk | null;
  /** việc của câu người dùng cuối trong luồng này; null nghĩa là câu đó không thuộc luồng */
  last: 'open' | 'name' | 'step' | 'answer' | 'finish' | null;
  /** thứ tự (từ 0) của câu người dùng cuối */
  lastTurn: number;
};

/**
 * Chữ thường, bỏ dấu, CÙNG ĐỘ DÀI với bản NFC: dò từ khoá trên bản này (cả khi người dùng gõ không dấu) rồi cắt chữ gốc theo cùng vị trí,
 * nên tên người và tên việc vẫn giữ nguyên dấu.
 */
const foldVi = (s: string) => stripDiacritics(s.normalize('NFC')).toLowerCase();
const queryKey = (s: string) => foldVi(s).replace(/\s+/g, ' ').trim();
const capitalize = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('vi') + s.slice(1) : s);

/** Số từ 1 đến 30 viết bằng chữ số hoặc bằng chữ (mẫu dò trên bản đã bỏ dấu; `parseNumber` đổi ra số). */
const NUM_UNIT = 'mot|hai|ba|bon|tu|nam|lam|sau|bay|tam|chin';
const NUM = String.raw`(?:\d{1,3}|(?:hai|ba)\s+muoi(?:\s+(?:${NUM_UNIT}))?|muoi(?:\s+(?:${NUM_UNIT}))?|${NUM_UNIT})`;

const OPEN_RE = /^(?:(?:toi\s+(?:muon|can)|cho\s+toi|giup\s+toi|hay|xin)\s+)?(?:tao|lap|soan)\s+(?:mot\s+)?quy\s+trinh(?![a-z])(?:\s+moi(?![a-z]))?\s*(?:(?:ten\s+la|co\s+ten|goi\s+la|ten)(?![a-z])\s*)?(.*)$/;
const FINISH_RE = /^(?:(?:da|vang|a)[,\s]+)?(?:xong(?:\s+roi)?|het\s+roi|da\s+het|het|do\s+la\s+tat\s+ca)(?:\s+(?:a|nhe|nha|roi|thoi|day))*\s*[.!]*$/;
const STEP_HEAD_RE = new RegExp(String.raw`^buoc\s+(?:thu\s+)?(nhat|${NUM})(?![a-z\d])\s*[:,.\-]?\s*`);
const DUE_INLINE_RE = new RegExp(String.raw`(?:^|[\s,;])(?:han|trong)\s*(?:la\s+|:\s*)?(${NUM})\s*ngay(?:\s+lam\s+viec)?(?![a-z])`);
const DUE_CLAUSE_RE = new RegExp(String.raw`^(?:(?:han|trong)\s*(?:la\s+|:\s*)?)?(${NUM})\s*ngay(?:\s+lam\s+viec)?$`);
/** "… soạn tài liệu họp ba ngày": hạn nói liền cuối câu, không có "hạn" và không có dấu phẩy. */
const DUE_TAIL_RE = new RegExp(String.raw`\s+(${NUM})\s*ngay(?:\s+lam\s+viec)?$`);
const PARALLEL_RE = /(?:(?:^|[,;])\s*(?:lam\s+)?|\s+)(?:cung\s+luc|song\s+song|dong\s+thoi)(?:\s+voi\s+buoc\s+(?:truoc|tren))?(?![a-z])/;
const PUBLISH_RE = /^(?:(?:toi\s+(?:muon|can)|cho\s+toi|giup\s+toi|hay|xin)\s+)?xuat\s+ban\s+(?:quy\s+trinh\s+)?(.+)$/;
const RUN_SPLIT_RE = /(?:\s+(?:va|roi)\s+|\s*[,;]\s*)giao\s+viec(?![a-z])/;
const RUN_LEAD_RE = /^\s*(?:(?:voi|dat)\s+)?(?:ten\s+(?:la\s+)?)?/;
const RUN_FILLER_RE = /^(?:ngay(?:\s+luon|\s+di)?|luon|di|nhe|nha|a|bay\s+gio)?[\s.!]*$/;

/** Gỡ dấu ngoặc kép ở hai đầu, dấu câu ở cuối và lời đưa đẩy ("ạ", "nhé"); viết hoa chữ đầu nếu `upper`. Rỗng nếu không còn gì. */
function cleanLabel(raw: string, upper = true): string {
  const s = raw
    .trim()
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s.,!?…;:]+$/gu, '')
    .replace(/\s+(?:ạ|nhé|nhỉ|đi|giúp tôi|giúp)$/iu, '')
    .trim();
  return upper ? capitalize(s) : s;
}

/** Tên việc của một bước: bước duyệt luôn mở đầu bằng "Duyệt". */
function stepTitle(raw: string, approval: boolean): string {
  let s = raw.trim().replace(/[.,!?…;:]+$/u, '').trim();
  if (approval && !/^duyet(?![a-z])/.test(foldVi(s))) s = `Duyệt ${s}`;
  return capitalize(s);
}

/** "Giám đốc", "Văn phòng", "người giao việc" là vai; còn lại là một người, giữ nguyên cách gọi để đem đi `search_people`. */
function readWho(raw: string): DraftWho | null {
  const text = cleanLabel(raw, false);
  if (!text) return null;
  const f = foldVi(text);
  if (/^(?:ban\s+)?pho\s+giam\s+doc$/.test(f)) return { kind: 'role', role: 'deputy' };
  if (/^(?:ban\s+)?giam\s+doc$/.test(f)) return { kind: 'role', role: 'director' };
  if (/^chu\s+tich$/.test(f)) return { kind: 'role', role: 'chairman' };
  if (/^(?:phong\s+)?van\s+phong$/.test(f)) return { kind: 'role', role: 'office_admin' };
  if (/^nguoi\s+giao\s+viec$/.test(f)) return { kind: 'initiator' };
  return { kind: 'person', query: text };
}

/**
 * Đoạn chữ đứng trước "làm" có phải chỉ người làm không: mở đầu bằng xưng hô, hoặc là một vai, hoặc ngắn ("Lan kinh doanh").
 * Dài hơn và không mở đầu bằng xưng hô ("soạn tài liệu họp anh Tuấn") là việc dính liền với người, để cắt theo xưng hô.
 */
const looksLikeWho = (text: string): boolean => /^(?:anh|chi|ong|ba|co|chu|bac)\s/.test(foldVi(text)) || readWho(text)?.kind !== 'person' || text.trim().split(/\s+/).length <= 3;

/** Gỡ chữ "làm" hay "duyệt" ở cuối: "anh Tuấn làm" thành "anh Tuấn". */
function stripVerb(raw: string): string {
  const text = raw.trim();
  const m = /\s+(?:lam|duyet)$/.exec(foldVi(text));
  return m ? text.slice(0, m.index) : text;
}

function readOpen(text: string): { name: string | null } | null {
  const t = text.normalize('NFC').trim();
  const m = OPEN_RE.exec(foldVi(t));
  if (!m) return null;
  return { name: cleanLabel(t.slice(t.length - (m[1] as string).length)) || null };
}

const isFinish = (text: string) => FINISH_RE.test(foldVi(text).trim());

type ReadStep = Omit<DraftStep, 'turn'> & { n: number };

/** Đọc một câu "bước <n> …". Ô nào không nghe được thì để null, để máy chủ báo thiếu và trợ lý hỏi lại đúng chỗ đó. */
function readStep(text: string): ReadStep | null {
  const t = text.normalize('NFC').trim();
  const p = foldVi(t);
  const head = STEP_HEAD_RE.exec(p);
  if (!head) return null;
  const n = head[1] === 'nhat' ? 1 : parseNumber(head[1] as string);
  if (n === null || n < 1) return null;

  let body = t.slice(head[0].length);
  let bodyFolded = p.slice(head[0].length);
  // Cắt một đoạn khỏi cả bản gốc lẫn bản bỏ dấu (cùng độ dài nên vẫn thẳng hàng).
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(bodyFolded);
    if (m) {
      body = `${body.slice(0, m.index)} ${body.slice(m.index + m[0].length)}`;
      bodyFolded = `${bodyFolded.slice(0, m.index)} ${bodyFolded.slice(m.index + m[0].length)}`;
    }
    return m;
  };
  const parallel = take(PARALLEL_RE) !== null;
  const inlineDue = take(DUE_INLINE_RE);
  let dueDays = inlineDue ? parseNumber(inlineDue[1] as string) : null;

  let who: DraftWho | null = null;
  let approval = false;
  let titles: string[] = [];
  for (const piece of body.split(/\s*[,;]\s*/u)) {
    const clause = piece.trim().replace(/[.!?…]+$/u, '').trim();
    if (!clause) continue;
    const f = foldVi(clause);
    // "làm" lẻ loi là chữ của "làm song song với bước trước" còn sót lại sau khi cắt cụm đó.
    if (f === 'lam') continue;
    const due = DUE_CLAUSE_RE.exec(f);
    if (due) {
      dueDays ??= parseNumber(due[1] as string);
      continue;
    }
    const approve = /(?<![a-z])duyet(?![a-z])/.exec(f);
    if (approve) {
      approval = true;
      const before = clause.slice(0, approve.index).trim();
      const after = clause.slice(approve.index + approve[0].length).trim();
      if (!before) titles.push(clause);
      else {
        who ??= readWho(before);
        if (after) titles.push(after);
      }
      continue;
    }
    const doer = /^(.+?)\s+lam$/.exec(f);
    const doerText = doer ? clause.slice(0, (doer[1] as string).length) : '';
    if (doer && looksLikeWho(doerText)) {
      who ??= readWho(doerText);
      continue;
    }
    const tailDue = dueDays === null ? DUE_TAIL_RE.exec(f) : null;
    if (tailDue) {
      dueDays = parseNumber(tailDue[1] as string);
      titles.push(clause.slice(0, tailDue.index));
      continue;
    }
    titles.push(clause);
  }

  // Người nói liền với việc, không có dấu phẩy: "Văn phòng soạn tài liệu", "anh Bình soạn tài liệu", "soạn tài liệu anh Tuấn làm".
  const first = titles[0];
  if (!who && first) {
    const f = foldVi(first);
    const role = /^(van\s+phong|pho\s+giam\s+doc|giam\s+doc|chu\s+tich)\s+(.+)$/.exec(f);
    const named = extractPersonQuery(first);
    const tail = /^(.+?)\s+((?:anh|chi|ong|ba|co|chu|bac)\s+[a-z]+(?:\s+[a-z]+){0,2})\s+lam$/d.exec(f);
    const tailWho = tail?.indices?.[2];
    if (role) {
      who = readWho(first.slice(0, (role[1] as string).length));
      titles = [first.slice(first.length - (role[2] as string).length), ...titles.slice(1)];
    } else if (named && f.startsWith(foldVi(named))) {
      who = { kind: 'person', query: named };
      titles = [first.slice(named.length).trim(), ...titles.slice(1)];
    } else if (tail && tailWho) {
      who = readWho(first.slice(tailWho[0], tailWho[1]));
      titles = [first.slice(0, (tail[1] as string).length), ...titles.slice(1)];
    }
  }
  titles = titles.filter(Boolean);
  return { n, title: titles.length > 0 ? stepTitle(titles.join(', '), approval) : null, approval, who, dueDays, parallel };
}

/** Câu trợ lý hỏi lại; mỗi câu mang đủ chữ để lượt sau nhận ra mình đang trả lời câu nào (xem `ASK_READERS`). */
const DRAFT_ASK = {
  name: (title: string) => `Dạ thưa ${title}, quy trình mới này tên là gì ạ?`,
  rename: (title: string, name: string) => `Dạ thưa ${title}, đã có quy trình tên ‘${name}’. ${title} muốn đặt tên khác là gì ạ?`,
  title: (title: string, n: number, approval: boolean) => `Dạ thưa ${title}, bước ${n} ${approval ? 'duyệt' : 'làm'} việc gì ạ?`,
  who: (title: string, n: number, approval: boolean) => `Dạ thưa ${title}, bước ${n} ai ${approval ? 'duyệt' : 'làm'} ạ?`,
  due: (title: string, n: number) => `Dạ thưa ${title}, bước ${n} hạn mấy ngày làm việc ạ?`,
  runTitle: (title: string) => `Dạ thưa ${title}, lượt giao việc này đặt tên là gì ạ?`,
};

const ASK_READERS: { re: RegExp; read: (m: RegExpExecArray) => DraftAsk }[] = [
  { re: /quy trình[^?]*tên[^?]*gì ạ\?$/u, read: () => ({ kind: 'name' }) },
  { re: /bước (\d+) (?:làm|duyệt) việc gì ạ\?$/iu, read: (m) => ({ kind: 'title', step: Number(m[1]) }) },
  { re: /bước (\d+) ai (?:làm|duyệt) ạ\?$/iu, read: (m) => ({ kind: 'who', step: Number(m[1]) }) },
  { re: /bước (\d+) hạn mấy ngày làm việc ạ\?$/iu, read: (m) => ({ kind: 'due', step: Number(m[1]) }) },
  // Cùng câu với luồng đi thúc: "chị Lan nào ạ?", "chưa tìm thấy ai tên như vậy".
  { re: /nào ạ\?$|chưa tìm thấy ai tên như vậy/u, read: () => ({ kind: 'person' }) },
];

const readAsk = (text: string): DraftAsk | null => {
  for (const { re, read } of ASK_READERS) {
    const m = re.exec(text);
    if (m) return read(m);
  }
  return null;
};

/** Kết quả `search_people` gần nhất cho một cách gọi, ở bất kỳ lượt nào của hội thoại. */
function searchedPeople(ctx: FakeLlmContext, query: string): FakeLlmToolOutcome | undefined {
  const key = queryKey(query);
  return [...ctx.allToolResults].reverse().find((r) => r.name === 'search_people' && typeof r.args.query === 'string' && queryKey(r.args.query) === key);
}

const stepMissing = (s: DraftStep) => s.title === null || s.who === null || s.dueDays === null || s.dueDays < 1;

/** Câu người dùng trả lời câu hỏi đang chờ: điền đúng ô được hỏi. Trả về việc đã làm, hoặc null nếu câu không phải câu trả lời. */
function answerDraft(d: ProcessDraft, ctx: FakeLlmContext, text: string, turn: number): ProcessDraft['last'] {
  const ask = d.ask;
  if (!ask) return null;
  if (ask.kind === 'name') {
    const name = cleanLabel(text);
    if (!name) return null;
    d.name = name;
    d.ask = null;
    return d.steps.length > 0 ? 'answer' : 'name';
  }
  if (ask.kind === 'person') {
    // Người dùng chạm chọn một người (hoặc nói lại tên): thay cách gọi ở bước đang vướng, rồi tra lại.
    const stuck = d.steps.find((s) => {
      if (s.who?.kind !== 'person') return false;
      const found = searchedPeople(ctx, s.who.query);
      return found !== undefined && (found.isError || matchedPeople(found.payload).length !== 1);
    });
    const who = readWho(stripVerb(text));
    if (!stuck || !who) return null;
    stuck.who = who;
    stuck.turn = turn;
    d.ask = null;
    return 'answer';
  }
  const step = d.steps[ask.step - 1];
  if (!step) return null;
  if (ask.kind === 'title') {
    if (!text.trim()) return null;
    step.title = stepTitle(text, step.approval);
  } else if (ask.kind === 'who') {
    const who = readWho(stripVerb(text));
    if (!who) return null;
    step.who = who;
  } else {
    const m = DUE_CLAUSE_RE.exec(foldVi(text).trim().replace(/[.!?…]+$/u, ''));
    const days = m ? parseNumber(m[1] as string) : null;
    if (days === null) return null;
    step.dueDays = days;
  }
  step.turn = turn;
  d.ask = null;
  return 'answer';
}

/** Dựng lại quy trình đang đọc từ các câu người dùng của cả hội thoại. */
function replayDraft(ctx: FakeLlmContext): ProcessDraft {
  const d: ProcessDraft = { started: false, name: null, steps: [], ask: null, last: null, lastTurn: -1 };
  ctx.turns.forEach(({ userText, previousAssistantText }, k) => {
    d.last = null;
    d.lastTurn = k;
    // Câu hỏi còn chờ trả lời giữ nguyên qua các lượt trợ lý trả lời việc khác (câu lạ, luồng khác).
    d.ask = readAsk(previousAssistantText) ?? d.ask;
    const open = readOpen(userText);
    if (open) {
      d.started = true;
      d.name = open.name;
      d.steps = [];
      d.ask = open.name ? null : { kind: 'name' };
      d.last = 'open';
      return;
    }
    if (!d.started) return;
    if (isFinish(userText)) {
      d.last = 'finish';
      return;
    }
    const step = readStep(userText);
    if (step) {
      const { n, ...rest } = step;
      // Số bước đã có thì là sửa bước đó; số mới thì nối vào cuối.
      d.steps[n <= d.steps.length ? n - 1 : d.steps.length] = { ...rest, turn: k };
      d.last = 'step';
      return;
    }
    d.last = answerDraft(d, ctx, userText, k);
  });
  return d;
}

/** Chức danh để gọi người dùng, lấy từ khối "theo lượt" của lời nhắc hệ thống; không có thì "Chủ tịch" như mọi luồng khác của bản giả. */
const userTitleOf = (ctx: FakeLlmContext) => /Gọi người dùng là "([^"]+)"/u.exec(ctx.system)?.[1] ?? 'Chủ tịch';

const errorCodeOf = (outcome: FakeLlmToolOutcome): string =>
  isRecord(outcome.data) && isRecord(outcome.data.error) && typeof outcome.data.error.code === 'string' ? outcome.data.error.code : '';

/** Một bước đúng dạng đầy đủ mà Claude gửi cho `preview_process` và `propose_create_process`: mọi ô đều có. */
type DraftStepArg = {
  title: string;
  kind: 'task' | 'approval';
  assignee: { kind: 'person'; personId: string } | { kind: 'role'; role: DraftAssignableRole } | { kind: 'initiator' } | { kind: 'unknown' };
  dueDays: number;
  parallel: boolean;
};

/** Hỏi đúng chỗ máy chủ báo thiếu (`problems` của `preview_process`): một câu, về lỗi đầu tiên. */
function askAboutProblem(p: { step: number | null; field: string; code: string }, steps: readonly DraftStepArg[], name: string, title: string): string {
  const n = p.step ?? 0;
  const approval = steps[n - 1]?.kind === 'approval';
  switch (p.field) {
    case 'name':
      return p.code === 'name_taken' ? DRAFT_ASK.rename(title, name) : DRAFT_ASK.name(title);
    case 'steps':
      return p.code === 'too_many_steps'
        ? `Dạ thưa ${title}, quy trình đã có quá nhiều bước nên trợ lý chưa ghi thêm được. Xin ${title} nói “xong” để tạo quy trình.`
        : `Dạ thưa ${title}, quy trình chưa có bước nào. Xin ${title} đọc bước thứ nhất ạ.`;
    case 'title':
      return DRAFT_ASK.title(title, n, approval);
    case 'assignee':
      return p.code === 'person_unavailable' ? `Dạ thưa ${title}, người này hiện không nhận được việc. Bước ${n} ai ${approval ? 'duyệt' : 'làm'} ạ?` : DRAFT_ASK.who(title, n, approval);
    case 'dueDays':
      return p.code === 'due_invalid' ? `Dạ thưa ${title}, hạn của bước ${n} chưa hợp lệ. Bước ${n} hạn mấy ngày làm việc ạ?` : DRAFT_ASK.due(title, n);
    default:
      return `Dạ thưa ${title}, trợ lý chưa ghi được các bước này. Xin ${title} đọc lại giúp trợ lý ạ.`;
  }
}

const createFailedReply = (outcome: FakeLlmToolOutcome, title: string): string => {
  const code = errorCodeOf(outcome);
  if (code === 'forbidden') {
    return `Dạ thưa ${title}, trợ lý chưa tạo được quy trình này vì tài khoản của ${title} chưa có quyền soạn quy trình. Việc này làm trên trang quản trị, hoặc xin ${title} bấm Nhờ Văn phòng.`;
  }
  if (code === 'input_invalid') return `Dạ thưa ${title}, trợ lý chưa tạo được vì thông tin các bước chưa đủ. Xin ${title} đọc lại bước còn thiếu ạ.`;
  return `Dạ thưa ${title}, trợ lý chưa soạn được đề xuất tạo quy trình này. Xin ${title} thử lại, hoặc bấm Nhờ Văn phòng.`;
};

/** Cả quy trình: nhận lời, tra người, kiểm các bước bằng `preview_process`, và "xong" thì đề xuất tạo bản nháp. */
function fakeProcessFlow(ctx: FakeLlmContext): FakeLlmTurn {
  const d = replayDraft(ctx);
  const title = userTitleOf(ctx);
  const firstStep = `Xin ${title} đọc bước thứ nhất ạ.`;
  if (d.last === 'open' || (d.last === 'name' && d.steps.length === 0)) {
    return { reply: d.name ? `Dạ thưa ${title}, quy trình mới tên là ‘${d.name}’. ${firstStep}` : DRAFT_ASK.name(title) };
  }
  if (d.last === 'finish' && d.steps.length === 0) return { reply: `Dạ thưa ${title}, quy trình chưa có bước nào. ${firstStep}` };

  // Mọi người được nhắc tên phải tra trước (song song) và phải khớp đúng một người; nhiều người thì hỏi lại, không chọn thay.
  const people = d.steps.flatMap((s) => (s.who?.kind === 'person' ? [s.who.query] : []));
  const unsearched = [...new Map(people.filter((q) => !searchedPeople(ctx, q)).map((q) => [queryKey(q), q])).values()];
  if (unsearched.length > 0) return { toolCalls: unsearched.map((query) => ({ name: 'search_people', args: { query } })) };
  const personIds = new Map<string, string>();
  for (const query of people) {
    const found = searchedPeople(ctx, query) as FakeLlmToolOutcome;
    if (found.isError) return { reply: `Dạ thưa ${title}, trợ lý chưa tra được người này. Xin ${title} thử lại, hoặc bấm Nhờ Văn phòng.` };
    const matched = matchedPeople(found.payload);
    if (matched.length === 0) return { reply: `Dạ thưa ${title}, trợ lý chưa tìm thấy ai tên như vậy. Xin ${title} nói lại tên giúp trợ lý ạ.` };
    if (matched.length > 1) return { reply: `Dạ, ${query} nào ạ?` };
    personIds.set(queryKey(query), idOf(matched[0]) ?? '');
  }

  // Dạng đầy đủ như Claude gửi: ô nào chưa nghe được thì dùng giá trị quy ước (hạn 0, người làm "unknown").
  const steps = d.steps.map((s): DraftStepArg => {
    const personId = s.who?.kind === 'person' ? personIds.get(queryKey(s.who.query)) : undefined;
    const assignee: DraftStepArg['assignee'] =
      s.who?.kind === 'role' ? { kind: 'role', role: s.who.role } : s.who?.kind === 'initiator' ? { kind: 'initiator' } : personId ? { kind: 'person', personId } : { kind: 'unknown' };
    return { title: s.title ?? '', kind: s.approval ? 'approval' : 'task', assignee, dueDays: s.dueDays !== null && s.dueDays >= 1 ? s.dueDays : 0, parallel: s.parallel };
  });

  if (d.last === 'finish' && d.name !== null && !d.steps.some(stepMissing)) {
    const proposed = ctx.last('propose_create_process');
    if (!proposed) return { toolCalls: [{ name: 'propose_create_process', args: { name: d.name, steps } }] };
    if (proposed.isError) return { reply: createFailedReply(proposed, title) };
    return { reply: `Dạ thưa ${title}, trợ lý đã soạn đề xuất tạo bản nháp quy trình. Xin ${title} xem trên màn hình và bấm Đồng ý nếu đúng.` };
  }

  const previewed = ctx.last('preview_process');
  if (!previewed) {
    // Đọc lại từ bước vừa thêm hoặc vừa sửa trong lượt này; 0 là đọc cả quy trình.
    const readFrom = d.steps.findIndex((s) => s.turn === d.lastTurn) + 1;
    return { toolCalls: [{ name: 'preview_process', args: { name: d.name ?? '', steps, readFrom } }] };
  }
  if (previewed.isError) {
    // Không có quyền soạn quy trình thì nói rõ ngay từ bước đầu (máy chủ từ chối cả preview_process), không đợi tới lúc "xong".
    if (errorCodeOf(previewed) === 'forbidden') return { reply: createFailedReply(previewed, title) };
    return { reply: `Dạ thưa ${title}, trợ lý chưa kiểm tra được các bước này. Xin ${title} thử lại, hoặc bấm Nhờ Văn phòng.` };
  }
  const problem = pickArray(previewed.payload, 'problems').find((p) => typeof p.field === 'string' && typeof p.code === 'string');
  if (problem) {
    const first = { step: typeof problem.step === 'number' ? problem.step : null, field: String(problem.field), code: String(problem.code) };
    return { reply: askAboutProblem(first, steps, d.name ?? '', title) };
  }
  return { reply: `Dạ thưa ${title}, trợ lý đã ghi lại. Xin ${title} đọc bước tiếp theo, hoặc nói “xong” nếu hết ạ.` };
}

type PublishRequest = { name: string; wantsRun: boolean; runTitle: string | null };

/** "xuất bản quy trình <tên> [và giao việc [với tên] <tên lượt>]". */
function readPublish(text: string): PublishRequest | null {
  const t = text.normalize('NFC').trim();
  const p = foldVi(t);
  const m = PUBLISH_RE.exec(p);
  if (!m) return null;
  const start = t.length - (m[1] as string).length;
  const rest = t.slice(start);
  const restFolded = p.slice(start);
  const split = RUN_SPLIT_RE.exec(restFolded);
  const name = cleanLabel(split ? rest.slice(0, split.index) : rest);
  if (!name) return null;
  if (!split) return { name, wantsRun: false, runTitle: null };
  const from = split.index + split[0].length;
  const after = restFolded.slice(from);
  if (RUN_FILLER_RE.test(after.trim())) return { name, wantsRun: true, runTitle: null };
  const lead = RUN_LEAD_RE.exec(after);
  return { name, wantsRun: true, runTitle: cleanLabel(rest.slice(from + (lead?.[0].length ?? 0))) || null };
}

const ASK_RUN_TITLE_RE = /lượt giao việc này đặt tên là gì ạ\?$/u;

/** Yêu cầu xuất bản của lượt này: câu lệnh, hoặc câu trả lời tên lượt giao việc cho câu lệnh "… và giao việc" ở lượt trước. */
function publishRequest(ctx: FakeLlmContext): PublishRequest | null {
  const direct = readPublish(ctx.userText);
  if (direct) return direct;
  if (!ASK_RUN_TITLE_RE.test(ctx.previousAssistantText)) return null;
  const earlier = [...ctx.previousUserTexts]
    .reverse()
    .map(readPublish)
    .find((r) => r !== null && r.wantsRun && r.runTitle === null);
  const runTitle = cleanLabel(ctx.userText);
  return earlier && runTitle ? { ...earlier, runTitle } : null;
}

const publishFailedReply = (outcome: FakeLlmToolOutcome, title: string): string => {
  const code = errorCodeOf(outcome);
  if (code === 'forbidden') {
    return `Dạ thưa ${title}, trợ lý chưa xuất bản được vì tài khoản của ${title} chưa có quyền xuất bản quy trình. Việc này làm trên trang quản trị, hoặc xin ${title} bấm Nhờ Văn phòng.`;
  }
  if (code === 'state_conflict') {
    return `Dạ thưa ${title}, quy trình này chưa có bản nháp để xuất bản, hoặc đã được xuất bản rồi. Xin ${title} kiểm tra lại giúp trợ lý ạ.`;
  }
  if (code === 'input_invalid') {
    return `Dạ thưa ${title}, trợ lý chưa soạn được vì biểu mẫu giao việc của quy trình này còn thiếu thông tin. Xin ${title} giao việc trên trang quản trị.`;
  }
  return `Dạ thưa ${title}, trợ lý chưa soạn được đề xuất xuất bản này. Xin ${title} thử lại, hoặc bấm Nhờ Văn phòng.`;
};

/** Xuất bản bản nháp (kèm giao việc ngay nếu có tên lượt): `search_templates` với includeDrafts rồi `propose_publish_process`. */
function fakePublishFlow(ctx: FakeLlmContext): FakeLlmTurn {
  const title = userTitleOf(ctx);
  const req = publishRequest(ctx) as PublishRequest;
  if (req.wantsRun && !req.runTitle) return { reply: DRAFT_ASK.runTitle(title) };
  const searched = ctx.last('search_templates');
  if (!searched) return { toolCalls: [{ name: 'search_templates', args: { query: req.name, includeDrafts: true } }] };
  if (searched.isError) return { reply: `Dạ thưa ${title}, trợ lý chưa tìm được quy trình này. Xin ${title} thử lại, hoặc bấm Nhờ Văn phòng.` };

  const found = pickArray(searched.payload, 'templates', 'items');
  const drafts = found.filter((t) => t.status === 'draft_only' || t.status === 'published_with_draft');
  const exact = drafts.filter((t) => typeof t.name === 'string' && queryKey(t.name) === queryKey(req.name));
  const pick = exact.length === 1 ? exact[0] : drafts.length === 1 ? drafts[0] : undefined;
  if (!pick) {
    if (drafts.length > 1) return { reply: `Dạ thưa ${title}, có nhiều bản nháp tên gần giống nhau. Xin ${title} nói rõ tên quy trình cần xuất bản ạ.` };
    if (found.length > 0) return { reply: `Dạ thưa ${title}, quy trình ‘${req.name}’ đã được xuất bản, hiện chưa có bản nháp mới để xuất bản ạ.` };
    const notFound = `trợ lý chưa tìm thấy bản nháp quy trình ‘${req.name}’. Có thể bản nháp chưa được tạo xong: xin ${title} bấm Đồng ý ở đề xuất tạo quy trình rồi nói lại giúp trợ lý ạ.`;
    return { reply: `Dạ thưa ${title}, ${notFound}` };
  }

  const proposed = ctx.last('propose_publish_process');
  if (!proposed) {
    const startRun = req.runTitle ? { startRun: { title: req.runTitle, inputs: [] } } : {};
    return { toolCalls: [{ name: 'propose_publish_process', args: { templateId: idOf(pick, 'templateId'), ...startRun } }] };
  }
  if (proposed.isError) return { reply: publishFailedReply(proposed, title) };
  return { reply: `Dạ thưa ${title}, trợ lý đã soạn đề xuất xuất bản quy trình${req.runTitle ? ' và giao việc ngay' : ''}. Xin ${title} xem trên màn hình và bấm Đồng ý nếu đúng.` };
}

/**
 * Bộ kịch bản tạo và xuất bản quy trình bằng hội thoại (cú pháp ở đầu mục này). Nằm trong bộ mặc định của `FakeLlm`, trước `GOLDEN_B_SCRIPT`:
 * một bước như "bước ba, nhắc khách hàng, chị Lan làm" chứa chữ "nhắc" mà luồng đi thúc cũng bắt, nên luồng này phải được xét trước.
 * Bộ đánh giá (`packages/ai-tools/evals`) cũng đặt bộ này lên đầu các luật của riêng nó.
 */
export const PROCESS_DRAFT_SCRIPT: FakeLlmStep[] = [
  { when: (messages) => publishRequest(buildFakeLlmContext({ system: [], messages })) !== null, respond: fakePublishFlow },
  { when: (messages) => replayDraft(buildFakeLlmContext({ system: [], messages })).last !== null, respond: fakeProcessFlow },
];

function stepMatches(step: FakeLlmStep, ctx: FakeLlmContext): boolean {
  if (typeof step.when === 'function') return step.when(ctx.messages);
  const flags = step.when.flags.replace('g', '');
  if (new RegExp(step.when.source, flags).test(ctx.userText)) return true;
  // Câu gõ hoặc nhận dạng KHÔNG dấu ("di thuc anh Tuan"): thử lại với mẫu đã bỏ dấu.
  const plain = stripDiacritics(ctx.userText);
  return plain === ctx.userText.normalize('NFC') && new RegExp(stripDiacritics(step.when.source), flags).test(plain);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** Ước lượng token tất định cho bản giả: 1 token cho mỗi 4 ký tự. Không phải số đếm thật của Claude. */
const fakeTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * LLM giả, tất định, chạy theo kịch bản (SPEC 6.9, 13.1). Bước đầu tiên khớp câu người dùng cuối sẽ quyết định
 * lượt trả lời; không bước nào khớp thì trả câu lịch sự mặc định. Ghi lại mọi yêu cầu để test kiểm
 * (ví dụ văn bản gửi ra đã qua `redact()` hay chưa).
 */
export class FakeLlm implements LlmClient {
  readonly calls: FakeLlmCall[] = [];
  /** số lần gọi kế tiếp sẽ phát sự kiện lỗi (để kiểm `llm_unavailable`) */
  failNext = 0;
  private readonly steps: FakeLlmStep[];
  private readonly delayMs: number;
  private seq = 0;

  constructor(steps: FakeLlmStep[] = [], opts: FakeLlmOptions = {}) {
    // Bộ đánh giá đặt `PROCESS_DRAFT_SCRIPT` lên đầu luật của riêng nó: đừng xét lại lần hai ở bộ mặc định.
    const defaults = [...PROCESS_DRAFT_SCRIPT, ...GOLDEN_B_SCRIPT].filter((step) => !steps.includes(step));
    this.steps = opts.includeDefaults === false ? [...steps] : [...steps, ...defaults];
    this.delayMs = opts.delayMs ?? 0;
  }

  /** Lượt trả lời của kịch bản cho một yêu cầu (không phát sự kiện). */
  decide(req: Pick<LlmRequest, 'system' | 'messages'>): FakeLlmTurn {
    const ctx = buildFakeLlmContext(req);
    const step = this.steps.find((s) => stepMatches(s, ctx));
    if (!step) return { reply: FAKE_LLM_DEFAULT_REPLY };
    if (step.respond) return step.respond(ctx);
    if (step.toolCalls && step.toolCalls.length > 0 && ctx.toolResults.length === 0) return { toolCalls: step.toolCalls };
    return { reply: step.reply ?? FAKE_LLM_DEFAULT_REPLY };
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.calls.push(structuredClone({ system: req.system, tools: req.tools, messages: req.messages, effort: req.effort }));
    if (this.delayMs > 0) await sleep(this.delayMs, req.signal);
    if (req.signal?.aborted) {
      yield { type: 'error', code: 'aborted', retryable: false };
      return;
    }
    if (this.failNext > 0) {
      this.failNext--;
      yield { type: 'error', code: 'unavailable', retryable: true };
      return;
    }

    const turn = this.decide(req);
    const reply = turn.reply ?? '';
    const toolCalls = turn.toolCalls ?? [];
    // Phát chữ theo cụm vài từ, như một dòng token thật.
    const words = reply.split(/(?<=\s)/u);
    for (let i = 0; i < words.length; i += 4) {
      const text = words.slice(i, i + 4).join('');
      if (text) yield { type: 'text_delta', text };
    }
    for (const call of toolCalls) {
      yield { type: 'tool_use', id: `fake_toolu_${++this.seq}`, name: call.name, input: structuredClone(call.args) };
    }
    const inputChars = req.system.reduce((n, b) => n + b.text.length, 0) + JSON.stringify(req.messages).length;
    const outputChars = reply.length + toolCalls.reduce((n, c) => n + JSON.stringify(c).length, 0);
    yield {
      type: 'message_stop',
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: fakeTokens(inputChars), outputTokens: fakeTokens(outputChars), cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
