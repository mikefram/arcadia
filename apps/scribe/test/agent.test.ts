/**
 * Vòng lặp tác tử (SPEC 6.3, 6.5, 6.7): kiểm bằng một LlmClient phát lại sự kiện đã ghi sẵn, không cần WebSocket.
 */
import { ASSISTANT_PHRASES, checkNumbers, claudeToolDefinitions, processReadback } from '@mihato/ai-tools';
import type { InternalToolResult } from '@mihato/domain';
import type { LlmClient, LlmEvent, LlmMsg, LlmRequest, LlmUsage } from '@mihato/providers';
import { describe, expect, it } from 'vitest';
import { type AgentDeps, AgentError, newAgentState, runAgentTurn, type ToolExecutor } from '@mihato/ai-tools';

const USAGE: LlmUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 };
const use = (id: string, name: string, input: Record<string, unknown> = {}): LlmEvent => ({ type: 'tool_use', id, name, input });
const stop = (stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal', raw?: unknown): LlmEvent => ({ type: 'message_stop', stopReason, usage: USAGE, ...(raw !== undefined ? { raw: { provider: 'anthropic', content: raw } } : {}) });
const say = (text: string): LlmEvent => ({ type: 'text_delta', text });

/** Model giả: mỗi lượt gọi phát một dãy sự kiện; ghi lại bản chụp lịch sử tại lúc gọi. */
function scripted(turns: (LlmEvent[] | ((req: LlmRequest) => LlmEvent[]))[]): LlmClient & { seen: LlmMsg[][] } {
  const seen: LlmMsg[][] = [];
  let i = 0;
  return {
    seen,
    async *stream(req) {
      seen.push(structuredClone(req.messages));
      const next = turns[Math.min(i++, turns.length - 1)] as LlmEvent[] | ((req: LlmRequest) => LlmEvent[]);
      for (const e of typeof next === 'function' ? next(req) : next) yield e;
    },
  };
}

function deps(llm: LlmClient, callTool: ToolExecutor, over: Partial<AgentDeps> = {}): AgentDeps {
  return { llm, callTool, system: [{ type: 'text', text: 'S' }], tools: claudeToolDefinitions(), effort: 'low', title: 'Chủ tịch', todayText: 'Thứ Năm, ngày 8 tháng 10 năm 2026', ...over };
}

const okTool: ToolExecutor = async (name) => ({ ok: true, result: { tool: name, overdue: 1 } });

describe('runAgentTurn', () => {
  it('mọi tool_result của một lượt nằm trong MỘT tin nhắn người dùng, đúng thứ tự model gọi', async () => {
    const llm = scripted([[use('a', 'get_overview', { scope: 'all' }), use('b', 'list_overdue_steps'), use('c', 'list_runs'), stop('tool_use')], [say('Dạ thưa Chủ tịch, có 1 việc quá hạn.'), stop('end_turn')]]);
    // Tool chạy song song; cái gọi trước về sau cũng không làm đổi thứ tự kết quả.
    const slowFirst: ToolExecutor = async (name) => {
      await new Promise((r) => setTimeout(r, name === 'get_overview' ? 30 : 1));
      return { ok: true, result: { tool: name, overdue: 1 } };
    };
    const state = newAgentState();
    const out = await runAgentTurn(deps(llm, slowFirst), state, 'tình hình chung');
    expect(out).toMatchObject({ reply: 'Dạ thưa Chủ tịch, có 1 việc quá hạn.', source: 'llm' });
    expect(out.toolCalls.map((t) => t.name)).toEqual(['get_overview', 'list_overdue_steps', 'list_runs']);

    expect(state.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const results = state.history[2]?.content;
    expect(Array.isArray(results) && results.map((p) => (p.type === 'tool_result' ? p.tool_use_id : p.type))).toEqual(['a', 'b', 'c']);
    expect(Array.isArray(results) && results.every((p) => p.type === 'tool_result' && p.content.startsWith('<tool_result name="'))).toBe(true);
    expect(out.usage).toEqual({ llmCalls: 2, inputTokens: 200, outputTokens: 20, cacheReadTokens: 160, cacheWriteTokens: 10 });
  });

  it('giữ nguyên nội dung thô của nhà cung cấp (khối thinking) khi đưa lượt assistant vào lịch sử', async () => {
    const raw1 = [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 'a', name: 'get_overview', input: {} }];
    const raw2 = [{ type: 'thinking', thinking: '', signature: 'y' }, { type: 'text', text: 'Dạ.' }];
    const llm = scripted([[use('a', 'get_overview', { scope: 'all' }), stop('tool_use', raw1)], [say('Dạ.'), stop('end_turn', raw2)]]);
    const state = newAgentState();
    await runAgentTurn(deps(llm, okTool), state, 'tình hình chung');
    expect(state.history[1]).toMatchObject({ role: 'assistant', raw: { provider: 'anthropic', content: raw1 } });
    expect(state.history[3]).toMatchObject({ role: 'assistant', content: 'Dạ.', raw: { provider: 'anthropic', content: raw2 } });
    // Lượt sau gửi lại đúng lịch sử cũ, chỉ nối thêm.
    await runAgentTurn(deps(llm, okTool), state, 'cảm ơn');
    expect(llm.seen.at(-1)?.slice(0, 4)).toEqual(state.history.slice(0, 4));
  });

  it('lặp tối đa 6 vòng rồi dừng bằng câu mẫu; lịch sử vẫn hợp lệ', async () => {
    let n = 0;
    const llm = scripted([() => [use(`t${++n}`, 'list_runs'), stop('tool_use')]]);
    const state = newAgentState();
    const out = await runAgentTurn(deps(llm, okTool), state, 'cứ gọi tool mãi');
    expect(out).toMatchObject({ source: 'canned', cannedReason: 'max_rounds', reply: ASSISTANT_PHRASES.tooManySteps('Chủ tịch') });
    expect(out.usage.llmCalls).toBe(6);
    expect(out.toolCalls).toHaveLength(6);
    expect(state.history.at(-1)).toEqual({ role: 'assistant', content: out.reply });
    // user, rồi 6 cặp (assistant gọi tool, user trả kết quả), rồi câu mẫu.
    expect(state.history).toHaveLength(1 + 12 + 1);
  });

  it('tool tạo đề xuất mức 1 trở lên: dừng ngay, đọc lại bằng summary của máy chủ, không gọi model thêm', async () => {
    const llm = scripted([[say('Để trợ lý soạn.'), use('a', 'propose_nudge', { stepRunIds: ['x'] }), stop('tool_use')], [say('KHÔNG ĐƯỢC TỚI ĐÂY'), stop('end_turn')]]);
    const propose: ToolExecutor = async () => ({ ok: true, proposals: [{ proposalId: '01920000-0000-7000-8000-0000000f0001', batchId: null, risk: 1, summary: 'Gửi lời nhắc tới anh Tuấn.' }] });
    const out = await runAgentTurn(deps(llm, propose), newAgentState(), 'đi thúc anh Tuấn');
    expect(out).toMatchObject({ source: 'readback', reply: 'Dạ, trợ lý hiểu như sau: Gửi lời nhắc tới anh Tuấn. Xin Chủ tịch xem trên màn hình và bấm Đồng ý nếu đúng.' });
    expect(out.proposals).toHaveLength(1);
    expect(out.usage.llmCalls).toBe(1);
  });

  describe('đọc các bước của quy trình mới (preview_process trả processReadback)', () => {
    const rb = { name: 'Họp hội đồng quản trị', lines: ['Bước 1: ‘Soạn tài liệu họp’, anh Bùi Quốc Tuấn làm, hạn 3 ngày làm việc.'], total: 1 };
    const ok = { name: rb.name, stepCount: 1, steps: [{ n: 1, text: rb.lines[0] }], problems: [], complete: true };
    const STEP = 'bước một, anh Tuấn soạn tài liệu họp, ba ngày';
    const previewCall = use('a', 'preview_process', { name: rb.name, steps: [], readFrom: 1 });

    it('dừng ngay, đọc đúng câu do máy chủ dựng (nguồn readback), KHÔNG gọi model lần hai', async () => {
      const llm = scripted([[say('Để trợ lý ghi lại.'), previewCall, stop('tool_use')], [say('KHÔNG ĐƯỢC TỚI ĐÂY'), stop('end_turn')]]);
      const preview: ToolExecutor = async () => ({ ok: true, result: ok, processReadback: rb });
      const state = newAgentState();
      const out = await runAgentTurn(deps(llm, preview), state, STEP);

      expect(out).toMatchObject({ source: 'readback', reply: processReadback(rb, 'Chủ tịch'), proposals: [] });
      // Câu đọc lại có nguyên văn câu của máy chủ, mời đọc bước tiếp theo hoặc nói "xong"; chữ của model ("Để trợ lý ghi lại.") không lọt ra.
      expect(out.reply).toBe('Dạ, trợ lý ghi lại. Bước 1: ‘Soạn tài liệu họp’, anh Bùi Quốc Tuấn làm, hạn 3 ngày làm việc. Hiện quy trình có 1 bước. Xin Chủ tịch đọc bước tiếp theo, hoặc nói “xong” nếu hết.');
      expect(out.reply).not.toContain('Để trợ lý ghi lại');
      expect(out.usage.llmCalls).toBe(1);
      expect(llm.seen).toHaveLength(1);
      // Lịch sử kết thúc bằng đúng câu người dùng đã nghe, sau tool_result: lượt sau nối tiếp được.
      expect(state.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(state.history.at(-1)).toEqual({ role: 'assistant', content: out.reply });
      // Mọi số trong câu đọc lại (3 ngày, 1 bước) đều có trong kết quả tool: không phải số lạ.
      expect(checkNumbers(out.reply, state.toolResults.map((r) => r.result))).toEqual([]);
    });

    it('chạy tool song song cũng vậy: search_people cùng preview_process trong một lượt vẫn dừng ở câu đọc lại', async () => {
      const llm = scripted([[use('a', 'search_people', { query: 'anh Tuấn' }), use('b', 'preview_process', { name: rb.name, steps: [], readFrom: 1 }), stop('tool_use')], [say('KHÔNG ĐƯỢC TỚI ĐÂY'), stop('end_turn')]]);
      const tool: ToolExecutor = async (name) => (name === 'preview_process' ? { ok: true, result: ok, processReadback: rb } : { ok: true, result: { count: 1, ambiguous: false, people: [] } });
      const out = await runAgentTurn(deps(llm, tool), newAgentState(), STEP);
      expect(out).toMatchObject({ source: 'readback', reply: processReadback(rb, 'Chủ tịch') });
      expect(out.toolCalls.map((t) => t.name)).toEqual(['search_people', 'preview_process']);
      expect(out.usage.llmCalls).toBe(1);
    });

    it('còn thiếu thông tin (`problems`, không có processReadback): vòng lặp đi tiếp và model hỏi lại đúng chỗ thiếu bằng lời của nó', async () => {
      const llm = scripted([[previewCall, stop('tool_use')], [say('Dạ thưa Chủ tịch, bước 1 hạn mấy ngày làm việc ạ?'), stop('end_turn')]]);
      const preview: ToolExecutor = async () => ({ ok: true, result: { ...ok, problems: [{ step: 1, field: 'dueDays', code: 'due_missing' }], complete: false } });
      const out = await runAgentTurn(deps(llm, preview), newAgentState(), 'bước một, anh Tuấn soạn tài liệu họp');
      expect(out).toMatchObject({ source: 'llm', reply: 'Dạ thưa Chủ tịch, bước 1 hạn mấy ngày làm việc ạ?', unknownNumbers: [] });
      expect(out.usage.llmCalls).toBe(2);
    });

    it('chỉ kết quả thành công mới được đọc lại: processReadback đi kèm lỗi bị bỏ qua', async () => {
      const llm = scripted([[previewCall, stop('tool_use')], [say('Dạ, trợ lý chưa kiểm được các bước này.'), stop('end_turn')]]);
      const preview: ToolExecutor = async () => ({ ok: false, error: { code: 'tool_unavailable', message: 'x' }, processReadback: rb });
      const out = await runAgentTurn(deps(llm, preview), newAgentState(), STEP);
      expect(out).toMatchObject({ source: 'llm', reply: 'Dạ, trợ lý chưa kiểm được các bước này.' });
      expect(out.usage.llmCalls).toBe(2);
    });

    it('nhiều lượt liên tiếp: mỗi lượt đọc lại bước vừa nghe, lượt sau nhận lịch sử của các lượt trước (chỉ nối thêm)', async () => {
      const llm = scripted([
        [previewCall, stop('tool_use')],
        [use('b', 'preview_process', { name: rb.name, steps: [], readFrom: 2 }), stop('tool_use')],
      ]);
      const lines = ['Bước 1: ‘Soạn tài liệu họp’, anh Bùi Quốc Tuấn làm, hạn 3 ngày làm việc.', 'Bước 2: ‘Duyệt tài liệu họp’, Giám đốc duyệt, hạn 2 ngày làm việc.'];
      let n = 0;
      const preview: ToolExecutor = async () => {
        n++;
        return { ok: true, result: { ...ok, stepCount: n }, processReadback: { name: rb.name, lines: [lines[n - 1] as string], total: n } };
      };
      const state = newAgentState();
      const first = await runAgentTurn(deps(llm, preview), state, STEP);
      const snapshot = structuredClone(state.history);
      const second = await runAgentTurn(deps(llm, preview), state, 'bước hai, Giám đốc duyệt tài liệu họp, hai ngày');
      expect([first.source, second.source]).toEqual(['readback', 'readback']);
      expect(second.reply).toContain('Bước 2: ‘Duyệt tài liệu họp’, Giám đốc duyệt, hạn 2 ngày làm việc. Hiện quy trình có 2 bước.');
      expect(llm.seen.at(-1)?.slice(0, snapshot.length)).toEqual(snapshot);
      expect(first.usage.llmCalls + second.usage.llmCalls).toBe(2);
    });
  });

  it('đề xuất mức 0 (ghi chú, máy chủ tự xác nhận) không dừng vòng lặp', async () => {
    const llm = scripted([[use('a', 'save_note', { text: 'ghi lại' }), stop('tool_use')], [say('Dạ, trợ lý đã ghi lại.'), stop('end_turn')]]);
    const note: ToolExecutor = async () => ({ ok: true, proposals: [{ proposalId: '01920000-0000-7000-8000-0000000f0002', batchId: null, risk: 0, summary: 'Ghi chú: ghi lại' }] });
    const out = await runAgentTurn(deps(llm, note), newAgentState(), 'ghi lại giúp tôi');
    expect(out).toMatchObject({ source: 'llm', reply: 'Dạ, trợ lý đã ghi lại.' });
    expect(out.proposals).toHaveLength(1);
  });

  it('tool lỗi hoặc máy chủ tool hỏng: trả tool_result có is_error để model biết, không ném lỗi', async () => {
    const llm = scripted([[use('a', 'get_run', { runId: 'x' }), use('b', 'list_runs'), stop('tool_use')], [say('Dạ, trợ lý chưa xem được.'), stop('end_turn')]]);
    const flaky: ToolExecutor = async (name): Promise<InternalToolResult> => {
      if (name === 'get_run') throw new Error('mạng hỏng');
      return { ok: false, error: { code: 'not_found', message: 'Không tìm thấy.' } };
    };
    const state = newAgentState();
    const out = await runAgentTurn(deps(llm, flaky), state, 'xem đợt việc');
    expect(out.reply).toBe('Dạ, trợ lý chưa xem được.');
    const results = state.history[2]?.content;
    expect(Array.isArray(results) && results.map((p) => (p.type === 'tool_result' ? p.is_error : null))).toEqual([true, true]);
    expect(JSON.stringify(results)).toContain('tool_unavailable');
  });

  it('chốt chặn số liệu: lần sinh lại mà model lại đòi gọi tool thì dùng mẫu dựng từ số liệu', async () => {
    const llm = scripted([
      [use('a', 'get_overview', { scope: 'all' }), stop('tool_use')],
      [say('Dạ, có 42 việc quá hạn.'), stop('end_turn')],
      [use('b', 'list_runs'), stop('tool_use')],
    ]);
    const overview: ToolExecutor = async () => ({ ok: true, result: { running: 2, overdue: 1, dueToday: 0, dueTomorrow: 3, awaitingMyDecision: 0 } });
    const state = newAgentState();
    const out = await runAgentTurn(deps(llm, overview), state, 'tình hình chung');
    expect(out).toMatchObject({ source: 'fallback', firstReply: 'Dạ, có 42 việc quá hạn.', unknownNumbers: ['42'] });
    expect(out.reply).toBe('Dạ thưa Chủ tịch, hiện có 2 quy trình đang chạy và 1 việc quá hạn. Hôm nay không có việc nào đến hạn, ngày mai có 3 việc đến hạn. Không có việc nào đang chờ Chủ tịch quyết.');
    expect(out.usage.llmCalls).toBe(3);
    // Lịch sử kết thúc bằng đúng câu người dùng đã nghe, không có tool_use treo.
    expect(state.history.at(-1)).toEqual({ role: 'assistant', content: out.reply });
    expect(state.history.at(-2)).toMatchObject({ role: 'user' });
    expect(String(state.history.at(-2)?.content)).toContain('[Ghi chú hệ thống]');
  });

  it('số trong kết quả tool của các lượt TRƯỚC trong phiên vẫn được phép', async () => {
    const llm = scripted([[use('a', 'get_overview', { scope: 'all' }), stop('tool_use')], [say('Dạ, có 7 việc quá hạn.'), stop('end_turn')], [say('Dạ, như trợ lý vừa báo, có 7 việc quá hạn.'), stop('end_turn')]]);
    const state = newAgentState();
    const tool: ToolExecutor = async () => ({ ok: true, result: { overdue: 7 } });
    await runAgentTurn(deps(llm, tool), state, 'tình hình chung');
    const second = await runAgentTurn(deps(llm, tool), state, 'nhắc lại xem');
    expect(second).toMatchObject({ source: 'llm', unknownNumbers: [] });
  });

  it('model từ chối (refusal): câu mẫu, và lượt đó không nằm lại trong lịch sử', async () => {
    const llm = scripted([[stop('refusal')]]);
    const state = newAgentState();
    const out = await runAgentTurn(deps(llm, okTool), state, 'một câu bị từ chối');
    expect(out).toMatchObject({ source: 'canned', cannedReason: 'refusal', reply: ASSISTANT_PHRASES.cannotHelp('Chủ tịch') });
    expect(state.history).toEqual([]);
    expect(state.userTexts).toEqual([]);
  });

  it('model trả lời rỗng, hoặc bị cắt giữa lời gọi tool: câu mẫu, không chạy tool bị cắt', async () => {
    let ran = 0;
    const counting: ToolExecutor = async () => {
      ran++;
      return { ok: true, result: {} };
    };
    const empty = await runAgentTurn(deps(scripted([[stop('end_turn')]]), counting), newAgentState(), 'a');
    expect(empty).toMatchObject({ source: 'canned', cannedReason: 'empty' });
    const cut = await runAgentTurn(deps(scripted([[use('a', 'propose_cancel_run', { runId: 'x' }), stop('max_tokens')]]), counting), newAgentState(), 'a');
    expect(cut).toMatchObject({ source: 'canned', cannedReason: 'truncated' });
    expect(ran).toBe(0);
  });

  it('model lỗi giữa lượt: ném AgentError kèm phần đã chạy, và cắt bỏ lượt dở khỏi lịch sử', async () => {
    const llm = scripted([[use('a', 'list_runs'), stop('tool_use')], [{ type: 'error', code: 'rate_limited', retryable: true }]]);
    const state = newAgentState();
    state.history.push({ role: 'user', content: 'lượt trước' }, { role: 'assistant', content: 'Dạ.' });
    const err = await runAgentTurn(deps(llm, okTool), state, 'tình hình chung').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'llm_unavailable', detail: 'rate_limited' });
    expect((err as AgentError).partial.toolCalls.map((t) => t.name)).toEqual(['list_runs']);
    expect((err as AgentError).partial.usage.llmCalls).toBe(2);
    expect(state.history).toEqual([
      { role: 'user', content: 'lượt trước' },
      { role: 'assistant', content: 'Dạ.' },
    ]);
  });

  it('nhà cung cấp treo và không nghe tín hiệu huỷ: vẫn báo quá hạn, không treo phiên', async () => {
    const hanging: LlmClient = {
      // eslint-disable-next-line require-yield
      async *stream() {
        await new Promise(() => {});
      },
    };
    const started = Date.now();
    const err = await runAgentTurn(deps(hanging, okTool, { llmTimeoutMs: 50 }), newAgentState(), 'a').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'llm_unavailable', detail: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bị huỷ từ ngoài: AgentError aborted', async () => {
    const controller = new AbortController();
    const slow: LlmClient = {
      async *stream(req) {
        await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()));
        yield { type: 'error', code: 'aborted', retryable: false };
      },
    };
    const pending = runAgentTurn(deps(slow, okTool), newAgentState(), 'a', { signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toMatchObject({ code: 'aborted' });
  });
});
