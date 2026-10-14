/**
 * Vòng lặp tác tử của một lượt nói (SPEC 6.1, 6.3, 6.5, 6.7). Tự viết, không dùng tool runner của SDK, để chèn:
 *  - cổng xác nhận: tool `propose_*` chỉ tạo đề xuất; có đề xuất thì dừng và đọc lại câu do MÁY CHỦ dựng;
 *  - chốt chặn số liệu: có số lạ thì sinh lại đúng một lần kèm báo lỗi, vẫn sai thì dùng mẫu dựng từ số liệu;
 *  - `redact()` trên mọi văn bản gửi ra LLM (SPEC 6.8).
 *
 * Tệp này không biết gì về WebSocket hay TTS: `session.ts` nghe sự kiện qua `hooks`. Bộ đánh giá ở
 * packages/ai-tools/evals chạy đúng hàm này với `FakeToolBackend`, nên thứ được đo là thứ đang chạy thật.
 *
 * Lịch sử hội thoại chỉ được NỐI THÊM trong một lượt gọi model đã gửi đi: Claude kiểm tra khối thinking theo
 * lịch sử đứng trước nó, nên không sửa hay xoá lượt cũ. Lượt bị huỷ hoặc lỗi thì cắt bỏ nguyên phần đuôi của lượt đó.
 */
import { checkNumbers, fallbackFromToolResults } from './guard';
import { ASSISTANT_PHRASES, numberGuardNotice, processReadback, proposalReadback, stripSystemNotePrefix, wrapToolResult } from './prompt';
import type { InternalToolResult } from '@mihato/domain';
import { redact } from '@mihato/domain/vi-normalize';
import type { LlmBlock, LlmClient, LlmEffort, LlmEvent, LlmMsg, LlmRaw, LlmStopReason, LlmTextPart, LlmToolDef, LlmToolResultPart, LlmToolUsePart } from '@mihato/providers';

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<InternalToolResult>;

export type ToolCallRecord = { name: string; args: Record<string, unknown>; result: InternalToolResult; ms: number };

export type ProposalRef = { proposalId: string; batchId: string | null; risk: number; summary: string };

/** Trạng thái hội thoại của một phiên. Chỉ sống trong bộ nhớ của phiên đó; không giữ lại giữa các phiên. */
export type AgentState = {
  history: LlmMsg[];
  /** kết quả tool của cả phiên: tập số được phép của chốt chặn số liệu */
  toolResults: { name: string; result: InternalToolResult }[];
  /** các câu người dùng đã nói (đã che dữ liệu cá nhân): trợ lý nhắc lại số người dùng vừa nói không phải là bịa */
  userTexts: string[];
};

export const newAgentState = (): AgentState => ({ history: [], toolResults: [], userTexts: [] });

export type AgentDeps = {
  llm: LlmClient;
  callTool: ToolExecutor;
  system: LlmBlock[];
  tools: LlmToolDef[];
  effort: LlmEffort;
  /** chức danh dùng để gọi người dùng, ví dụ "Chủ tịch" */
  title: string;
  /** dòng ngày hôm nay của khối theo lượt: ngày hôm nay là ngày hợp lệ với chốt chặn số liệu */
  todayText: string;
  /** số lượt gọi model tối đa cho một lượt nói (SPEC: 6); lần sinh lại của chốt chặn được tính riêng */
  maxRounds?: number;
  /** quá từng này mili giây chưa có sự kiện đầu của model thì coi là lỗi (SPEC 6.11: 15 giây) */
  llmTimeoutMs?: number;
};

export type LlmCallMetrics = { round: number; firstEventMs: number; totalMs: number; inputTokens: number; outputTokens: number; toolUses: number; stopReason: LlmStopReason };

export type AgentHooks = {
  /** huỷ khi người dùng ngắt lời hoặc ngắt kết nối */
  signal?: AbortSignal;
  onToolResult?: (call: ToolCallRecord) => void;
  onLlmCall?: (metrics: LlmCallMetrics) => void;
};

export type AgentUsage = { llmCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

/**
 * Nguồn của câu trả lời cuối:
 *  llm          chữ của model, qua chốt chặn ngay lần đầu
 *  regenerated  chữ của model sau một lần sinh lại
 *  fallback     mẫu dựng thẳng từ số liệu (model sai số hai lần)
 *  readback     câu đọc lại đề xuất (dựng từ `summary` của máy chủ) hoặc đọc lại các bước quy trình vừa nghe
 *  canned       câu mẫu (model từ chối, trả lời rỗng, hoặc hết số vòng)
 */
export type ReplySource = 'llm' | 'regenerated' | 'fallback' | 'readback' | 'canned';

export type AgentTurnResult = {
  reply: string;
  source: ReplySource;
  /** câu đầu tiên model viết, trước chốt chặn (rỗng nếu model chưa viết câu nào) */
  firstReply: string;
  /** số lạ trong `firstReply` */
  unknownNumbers: string[];
  toolCalls: ToolCallRecord[];
  proposals: ProposalRef[];
  usage: AgentUsage;
  cannedReason?: 'refusal' | 'empty' | 'max_rounds' | 'truncated';
};

export type AgentErrorCode = 'llm_unavailable' | 'aborted';

/** Lỗi của một lượt. `detail` chỉ là mã (timeout, rate_limited…), không chứa nội dung hội thoại. */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    readonly detail: string,
    readonly partial: { toolCalls: ToolCallRecord[]; usage: AgentUsage } = { toolCalls: [], usage: emptyUsage() },
  ) {
    super(`${code}:${detail}`);
    this.name = 'AgentError';
  }
}

export function emptyUsage(): AgentUsage {
  return { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

type LlmCallOutput = { text: string; toolUses: LlmToolUsePart[]; stopReason: LlmStopReason; raw?: LlmRaw };

const TOOL_UNAVAILABLE: InternalToolResult = { ok: false, error: { code: 'tool_unavailable', message: 'Hệ thống chưa chạy được tool này.' } };

/** Một lượt gọi model. Chạy đua từng sự kiện với hạn chờ, nên nhà cung cấp treo cũng không treo phiên. */
async function callLlm(deps: AgentDeps, state: AgentState, hooks: AgentHooks, round: number, usage: AgentUsage): Promise<LlmCallOutput> {
  const controller = new AbortController();
  let rejectAbort: (reason: AgentError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => {});
  const onOuterAbort = () => {
    controller.abort();
    rejectAbort(new AgentError('aborted', 'cancelled'));
  };
  if (hooks.signal?.aborted) throw new AgentError('aborted', 'cancelled');
  hooks.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const startedAt = performance.now();
  let firstEventMs = -1;
  const timer = setTimeout(() => {
    if (firstEventMs >= 0) return;
    controller.abort();
    rejectAbort(new AgentError('llm_unavailable', 'timeout'));
  }, deps.llmTimeoutMs ?? 15_000);

  let text = '';
  const toolUses: LlmToolUsePart[] = [];
  let stop: Extract<LlmEvent, { type: 'message_stop' }> | undefined;
  const iterator = deps.llm.stream({ system: deps.system, tools: deps.tools, messages: state.history, effort: deps.effort, signal: controller.signal })[Symbol.asyncIterator]();
  usage.llmCalls++;
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      const e = next.value;
      if (firstEventMs < 0) firstEventMs = performance.now() - startedAt;
      if (e.type === 'text_delta') text += e.text;
      else if (e.type === 'tool_use') toolUses.push({ type: 'tool_use', id: e.id, name: e.name, input: e.input });
      else if (e.type === 'message_stop') stop = e;
      else throw new AgentError(e.code === 'aborted' && hooks.signal?.aborted ? 'aborted' : 'llm_unavailable', e.code);
    }
  } finally {
    clearTimeout(timer);
    hooks.signal?.removeEventListener('abort', onOuterAbort);
    // Không chờ: nhà cung cấp treo thì `return()` cũng có thể treo.
    void iterator.return?.()?.catch(() => {});
  }
  if (!stop) throw new AgentError('llm_unavailable', 'no_message_stop');
  usage.inputTokens += stop.usage.inputTokens;
  usage.outputTokens += stop.usage.outputTokens;
  usage.cacheReadTokens += stop.usage.cacheReadTokens;
  usage.cacheWriteTokens += stop.usage.cacheWriteTokens;
  hooks.onLlmCall?.({
    round,
    firstEventMs: Math.round(firstEventMs),
    totalMs: Math.round(performance.now() - startedAt),
    inputTokens: stop.usage.inputTokens,
    outputTokens: stop.usage.outputTokens,
    toolUses: toolUses.length,
    stopReason: stop.stopReason,
  });
  return { text, toolUses, stopReason: stop.stopReason, raw: stop.raw };
}

async function runTools(deps: AgentDeps, uses: LlmToolUsePart[]): Promise<ToolCallRecord[]> {
  // Tool gọi song song (SPEC 6.3); thứ tự kết quả giữ theo thứ tự model gọi.
  return Promise.all(
    uses.map(async (use): Promise<ToolCallRecord> => {
      const t0 = performance.now();
      let result: InternalToolResult;
      try {
        result = await deps.callTool(use.name, use.input);
      } catch {
        result = TOOL_UNAVAILABLE;
      }
      return { name: use.name, args: use.input, result, ms: Math.round(performance.now() - t0) };
    }),
  );
}

/**
 * Chạy một lượt: nhận câu người dùng (đã chốt), trả câu trả lời đã qua chốt chặn.
 * Ném `AgentError` khi model lỗi, quá hạn hoặc lượt bị huỷ; khi đó lịch sử của lượt này được cắt bỏ.
 */
export async function runAgentTurn(deps: AgentDeps, state: AgentState, userText: string, hooks: AgentHooks = {}): Promise<AgentTurnResult> {
  const maxRounds = deps.maxRounds ?? 6;
  const historyMark = state.history.length;
  const userTextsMark = state.userTexts.length;
  const usage = emptyUsage();
  const toolCalls: ToolCallRecord[] = [];
  const proposals: ProposalRef[] = [];

  const clean = redact(stripSystemNotePrefix(userText));
  state.history.push({ role: 'user', content: clean });
  state.userTexts.push(clean);

  const finish = (reply: string, source: ReplySource, firstReply: string, unknownNumbers: string[], cannedReason?: AgentTurnResult['cannedReason']): AgentTurnResult => ({
    reply,
    source,
    firstReply,
    unknownNumbers,
    toolCalls,
    proposals,
    usage,
    ...(cannedReason ? { cannedReason } : {}),
  });
  const canned = (reason: NonNullable<AgentTurnResult['cannedReason']>, firstReply = '', unknown: string[] = []) => {
    const reply = reason === 'max_rounds' ? ASSISTANT_PHRASES.tooManySteps(deps.title) : ASSISTANT_PHRASES.cannotHelp(deps.title);
    state.history.push({ role: 'assistant', content: reply });
    return finish(reply, 'canned', firstReply, unknown, reason);
  };

  try {
    let firstReply = '';
    let firstUnknown: string[] = [];
    let regenerating = false;

    for (let round = 1; round <= maxRounds + 1; round++) {
      // Vòng thứ maxRounds + 1 chỉ dành cho lần sinh lại của chốt chặn số liệu.
      if (round > maxRounds && !regenerating) break;
      const out = await callLlm(deps, state, hooks, round, usage);

      if (out.stopReason === 'refusal') {
        // Bỏ cả lượt khỏi lịch sử để câu bị từ chối không kéo theo các lượt sau.
        state.history.length = historyMark;
        state.userTexts.length = userTextsMark;
        const reply = ASSISTANT_PHRASES.cannotHelp(deps.title);
        return finish(reply, 'canned', firstReply, firstUnknown, 'refusal');
      }

      if (out.stopReason === 'tool_use' && out.toolUses.length > 0) {
        // Lần sinh lại mà model lại đòi gọi tool: coi như vẫn sai, dùng mẫu dựng từ số liệu.
        if (regenerating) break;
        const parts: (LlmTextPart | LlmToolUsePart)[] = [...(out.text.trim() ? [{ type: 'text' as const, text: out.text }] : []), ...out.toolUses];
        state.history.push({ role: 'assistant', content: parts, ...(out.raw ? { raw: out.raw } : {}) });

        const records = await runTools(deps, out.toolUses);
        // Mọi tool_result của một lượt nằm trong MỘT tin nhắn người dùng (SPEC 6.3).
        const results: LlmToolResultPart[] = records.map((r, i) => ({
          type: 'tool_result',
          tool_use_id: (out.toolUses[i] as LlmToolUsePart).id,
          content: redact(wrapToolResult(r.name, r.result)),
          ...(r.result.ok ? {} : { is_error: true }),
        }));
        state.history.push({ role: 'user', content: results });

        const created: ProposalRef[] = [];
        for (const r of records) {
          toolCalls.push(r);
          state.toolResults.push({ name: r.name, result: r.result });
          for (const p of r.result.proposals ?? []) created.push({ proposalId: p.proposalId, batchId: p.batchId, risk: p.risk, summary: p.summary });
          hooks.onToolResult?.(r);
        }
        proposals.push(...created);
        if (hooks.signal?.aborted) throw new AgentError('aborted', 'cancelled');

        // Có đề xuất cần người xác nhận: dừng, đọc lại bằng câu do máy chủ dựng (không lấy chữ của LLM).
        const readback = proposalReadback(created, deps.title);
        if (readback) {
          state.history.push({ role: 'assistant', content: readback });
          return finish(readback, 'readback', firstReply, firstUnknown);
        }
        // Người dùng đang đọc các bước của quy trình mới: máy chủ đã dựng câu đọc lại, dừng và đọc đúng câu đó
        // (không để LLM diễn đạt lại, để người dùng nghe đúng điều sẽ được tạo).
        const dictated = records.find((r) => r.result.ok && r.result.processReadback)?.result.processReadback;
        if (dictated) {
          const text = processReadback(dictated, deps.title);
          state.history.push({ role: 'assistant', content: text });
          return finish(text, 'readback', firstReply, firstUnknown);
        }
        continue;
      }

      if (out.stopReason === 'max_tokens' && out.toolUses.length > 0) return canned('truncated', firstReply, firstUnknown);

      const text = out.text.trim();
      if (!text) return canned('empty', firstReply, firstUnknown);

      const unknown = checkNumbers(
        text,
        state.toolResults.map((r) => r.result),
        { allowed: [...state.userTexts, deps.todayText] },
      );
      if (!regenerating) {
        firstReply = text;
        firstUnknown = unknown;
      }
      if (unknown.length === 0) {
        state.history.push({ role: 'assistant', content: text, ...(out.raw ? { raw: out.raw } : {}) });
        return finish(text, regenerating ? 'regenerated' : 'llm', firstReply, firstUnknown);
      }
      if (regenerating) break;

      // Sinh lại đúng MỘT lần kèm báo lỗi (SPEC 6.7).
      regenerating = true;
      state.history.push({ role: 'assistant', content: text, ...(out.raw ? { raw: out.raw } : {}) });
      state.history.push({ role: 'user', content: numberGuardNotice(unknown) });
    }

    if (regenerating) {
      // Vẫn sai sau một lần sinh lại: mẫu văn bản dựng thẳng từ số liệu, không qua LLM.
      const source = toolCalls.length > 0 ? toolCalls : state.toolResults;
      const reply = fallbackFromToolResults(source, deps.title);
      state.history.push({ role: 'assistant', content: reply });
      return finish(reply, 'fallback', firstReply, firstUnknown);
    }
    return canned('max_rounds', firstReply, firstUnknown);
  } catch (err) {
    state.history.length = historyMark;
    state.userTexts.length = userTextsMark;
    if (err instanceof AgentError) throw new AgentError(err.code, err.detail, { toolCalls, usage });
    throw new AgentError('llm_unavailable', 'internal', { toolCalls, usage });
  }
}
