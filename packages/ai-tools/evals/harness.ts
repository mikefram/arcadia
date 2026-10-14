/**
 * Chạy một ca đánh giá: dựng `FakeToolBackend` từ trạng thái dữ liệu mẫu, rồi cho trợ lý trả lời từng lượt.
 *
 * Vòng lặp tác tử dùng ở đây chính là vòng lặp của `apps/scribe` (`runAgentTurn`), nhập bằng đường dẫn tương đối:
 * bộ đánh giá phải đo đúng thứ đang chạy thật (prompt, bộ tool, cổng đề xuất, chốt chặn số liệu), không đo một bản chép.
 * Đây là công cụ phát triển, không nằm trong `src` của gói, nên việc gói này với tới mã của app là chấp nhận được;
 * khi được phép sửa `src/index.ts`, nên chuyển `agent.ts` về `packages/ai-tools/src` và xuất từ đó.
 */
import { DEFAULT_ABBREVIATIONS } from '@mihato/domain/vi-normalize';
import type { LlmBlock, LlmClient, LlmEffort } from '@mihato/providers';
import { type AgentDeps, AgentError, type AgentUsage, emptyUsage, newAgentState, type ReplySource, runAgentTurn } from '../src/agent';
import { checkNumbers, checkStyle, type StyleReport } from '../src/guard';
import { buildSystemBlocks, buildTodayText } from '../src/prompt';
import { claudeToolDefinitions } from '../src/tools';
import { FakeToolBackend } from './fake-backend';
import { type Fixture, IDS } from './fixtures';
import type { EvalCase } from './types';

export type ToolCallSummary = { name: string; args: Record<string, unknown>; ok: boolean; errorCode?: string; proposals: number };

export type TurnRecord = {
  userText: string;
  reply: string;
  /** câu đầu tiên model viết, trước chốt chặn số liệu */
  firstReply: string;
  source: ReplySource | 'error';
  /** số lạ trong câu đầu tiên (trước chốt chặn) */
  unknownNumbersFirst: string[];
  /** số lạ trong câu cuối cùng gửi cho người dùng (sau chốt chặn): phải luôn rỗng */
  unknownNumbersFinal: string[];
  toolCalls: ToolCallSummary[];
  style: StyleReport;
  error?: string;
};

export type RunRecord = { turns: TurnRecord[]; usage: AgentUsage; error?: string };

const HONORIFIC_WORD: Record<string, string> = { anh: 'anh', chi: 'chị', ong: 'ông', ba: 'bà', co: 'cô', chu: 'chú', bac: 'bác' };

const ROLE_USER: Record<EvalCase['userRole'], string> = { chairman: IDS.U_CHAIRMAN, director: IDS.U_DIRECTOR, deputy: IDS.U_HUY };

/**
 * Khối "theo tổ chức" của lời nhắc (SPEC 6.6): danh bạ, mẫu quy trình, từ điển viết tắt. Chép đúng dạng mà API cấp
 * qua `claim` (`buildOrgPrompt` ở packages/backend/src/services/scribe.ts), để trợ lý được đánh giá trên đúng lời nhắc
 * nó nhận khi chạy thật. Không có id: muốn có id thì trợ lý phải gọi `search_people`.
 */
export function buildOrgPrompt(fixture: Fixture): string {
  const people = fixture.people.map((p) => {
    const name = [p.honorific ? (HONORIFIC_WORD[p.honorific] ?? p.honorific) : null, p.fullName].filter(Boolean).join(' ');
    return `- ${[name, `tên gọi: ${p.givenName}`, p.unitName, p.roleTitle].filter(Boolean).join('; ')}`;
  });
  // Chỉ mẫu đã xuất bản: bản nháp (chưa xuất bản lần nào) không nằm trong lời nhắc, trợ lý phải tìm bằng `search_templates` kèm includeDrafts.
  const templates = fixture.templates.filter((t) => t.status !== 'draft_only').map((t) => `- ${t.name}: ${t.description}`);
  const abbrev = Object.entries(DEFAULT_ABBREVIATIONS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- ${k}: ${v}`);
  return [
    'Tổ chức: Tổ chức mẫu',
    '',
    'Danh sách người (xưng hô và họ tên; tên gọi; đơn vị; chức danh):',
    ...people,
    '',
    'Mẫu quy trình đã xuất bản (tên: mô tả ngắn):',
    ...templates,
    '',
    'Từ điển viết tắt:',
    ...abbrev,
  ].join('\n');
}

export type RunCaseOptions = { llm: LlmClient; effort: LlmEffort; llmTimeoutMs?: number };

/**
 * Câu đọc lại (`source` là 'readback': đề xuất, hoặc các bước quy trình vừa nghe) do MÁY CHỦ dựng, đọc nguyên văn điều sắp xảy ra.
 * Số câu của nó theo số bước hay số đề xuất, không phải văn phong của trợ lý, nên chỉ kiểm từ cấm và biểu tượng, không đếm câu và câu hỏi.
 */
const SERVER_TEXT_STYLE = { maxSentences: Number.POSITIVE_INFINITY, maxQuestions: Number.POSITIVE_INFINITY };

export function systemBlocksFor(c: Pick<EvalCase, 'now' | 'userRole'>, backend: FakeToolBackend): { system: LlmBlock[]; title: string; todayText: string } {
  const user = backend.fixture.people.find((p) => p.id === ROLE_USER[c.userRole]);
  if (!user) throw new Error(`Trạng thái dữ liệu mẫu không có người dùng vai ${c.userRole}`);
  const todayText = buildTodayText(c.now);
  const system = buildSystemBlocks({ orgPrompt: buildOrgPrompt(backend.fixture), turn: { todayText, userName: user.fullName, userTitle: user.roleTitle, honorific: user.honorific } });
  return { system, title: user.roleTitle, todayText };
}

/** Chạy mọi lượt của một ca với một hội thoại mới và một trạng thái dữ liệu mới. */
export async function runCase(c: EvalCase, opts: RunCaseOptions): Promise<RunRecord> {
  const backend = new FakeToolBackend({ fixture: c.fixture, now: c.now, userId: ROLE_USER[c.userRole] });
  const { system, title, todayText } = systemBlocksFor(c, backend);
  const deps: AgentDeps = {
    llm: opts.llm,
    callTool: async (name, args) => backend.call(name, args),
    system,
    tools: claudeToolDefinitions(),
    effort: opts.effort,
    title,
    todayText,
    ...(opts.llmTimeoutMs !== undefined ? { llmTimeoutMs: opts.llmTimeoutMs } : {}),
  };
  const state = newAgentState();
  const usage = emptyUsage();
  const turns: TurnRecord[] = [];
  const add = (u: AgentUsage) => {
    usage.llmCalls += u.llmCalls;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  };

  for (const userText of c.turns) {
    try {
      const out = await runAgentTurn(deps, state, userText);
      add(out.usage);
      turns.push({
        userText,
        reply: out.reply,
        firstReply: out.firstReply,
        source: out.source,
        unknownNumbersFirst: out.unknownNumbers,
        unknownNumbersFinal: checkNumbers(
          out.reply,
          state.toolResults.map((r) => r.result),
          { allowed: [...state.userTexts, todayText] },
        ),
        toolCalls: out.toolCalls.map((t) => ({ name: t.name, args: t.args, ok: t.result.ok, ...(t.result.error ? { errorCode: t.result.error.code } : {}), proposals: t.result.proposals?.length ?? 0 })),
        style: checkStyle(out.reply, out.source === 'readback' ? SERVER_TEXT_STYLE : {}),
      });
    } catch (err) {
      const detail = err instanceof AgentError ? `${err.code}:${err.detail}` : 'internal';
      if (err instanceof AgentError) add(err.partial.usage);
      turns.push({ userText, reply: '', firstReply: '', source: 'error', unknownNumbersFirst: [], unknownNumbersFinal: [], toolCalls: [], style: checkStyle(''), error: detail });
      return { turns, usage, error: detail };
    }
  }
  return { turns, usage };
}
