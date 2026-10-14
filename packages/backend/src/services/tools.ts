import { TOOLS, isToolName, type ToolName } from '@mihato/ai-tools';
import { canStartRun } from '@mihato/workflow-engine';
import { ApiError, DraftDefinitionSchema, HONORIFIC_LABEL, ROLES, TEMPLATE_DRAFT_ACTIONS, can, canAny, type Honorific, type InternalToolResult, type ProposalView, type RunSummary, type StepView } from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { matchPerson, normalizeText, redact, resolveDate, stripDiacritics } from '@mihato/domain/vi-normalize';
import { formatDateFull, vi } from '@mihato/i18n';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext, UserRecord } from '../context';
import { inOrder, schema, type Tx } from '../db/client';
import { loadDefinition } from '../engine/runner';
import { seesAllRuns, type Viewer } from '../views';
import { getOverview } from './overview';
import { analyzeDraft, definitionIssues, definitionOf, nameTaken } from './process-draft';
import { createProposals, isProposalTool, listProposals, parseToolArgs, personLabel, stepAssigneeLabel, stepSentence } from './proposals';
import { findVisibleRun, getRun, listRuns, listSteps } from './runs';

/**
 * Thực thi tool của AI Scribe thay cho một người dùng, dưới ĐÚNG tầm nhìn của người đó (SPEC 10.7.1).
 *
 * - Tool đọc chỉ trả dữ liệu tối thiểu (SPEC 6.8): tên, tên việc, hạn, trạng thái, id. Không có số điện thoại,
 *   thư điện tử, nội dung biểu mẫu, ghi chú, lý do vướng. Chữ tự do (tên việc, tên lượt) đi qua `redact()`.
 * - Tool `save_note` và `propose_*` chỉ tạo dòng `proposals`. KHÔNG có tool nào ghi thẳng lên lượt chạy:
 *   tệp này không import hàm ghi nào của engine (CLAUDE.md luật 3).
 * - Lỗi trả về cho tool dạng `{ ok: false, error }` để trợ lý hỏi lại, không ném ra ngoài.
 */

/** Câu giải thích lỗi cho mô hình đọc (không phải chuỗi giao diện): ngắn, không chứa dữ liệu người dùng. */
const TOOL_ERROR_TEXT: Record<string, string> = {
  ai_disabled: 'Tổ chức đang tắt trợ lý AI.',
  unknown_tool: 'Không có công cụ này. Trợ lý không được duyệt, báo xong thay người khác, đổi quyền hay xoá dữ liệu.',
  forbidden: 'Người dùng không có quyền với việc này.',
  not_found: 'Không tìm thấy, hoặc nằm ngoài tầm nhìn của người dùng. Hãy tìm lại bằng tool đọc, không đoán id.',
  input_invalid: 'Tham số chưa hợp lệ. Thiếu thông tin thì hỏi người dùng từng câu một.',
  state_conflict: 'Trạng thái hiện tại không cho phép: việc đã xong, đã đổi người, lượt đã dừng, hoặc bản nháp đã được xuất bản.',
  template_invalid: 'Mẫu quy trình chưa dùng được: chưa có bản xuất bản, hoặc bản nháp còn lỗi.',
  nudge_throttled: 'Chưa đi thúc được lúc này để tránh làm phiền người nhận.',
  date_unresolved: 'Chưa hiểu được cụm từ chỉ ngày. Hãy hỏi lại người dùng ngày cụ thể.',
  other: 'Hệ thống chưa làm được việc này.',
};

function failure(code: string, errors?: { path: string; code: string }[]): InternalToolResult {
  const detail = errors?.length
    ? ` Chi tiết: ${errors
        .slice(0, 10)
        .map((e) => `${e.path} (${e.code})`)
        .join('; ')}.`
    : '';
  return { ok: false, error: { code, message: (TOOL_ERROR_TEXT[code] ?? TOOL_ERROR_TEXT.other!) + detail } };
}

const ok = (result: unknown, extra: Partial<InternalToolResult> = {}): InternalToolResult => ({ ok: true, result, ...extra });
const plain = (s: string) => stripDiacritics(normalizeText(s));
/** Chữ tự do do người dùng nhập là dữ liệu không đáng tin và có thể chứa thông tin cá nhân: che trước khi đưa cho mô hình. */
const safe = (s: string, max = 200) => {
  const t = redact(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const dateText = (instant: string | null) => (instant ? formatDateFull(instant) : null);

/**
 * Câu trợ lý đọc lại sau khi tạo đề xuất (nguyên tắc 3 của prompt). Mặc định là `summary` của máy chủ. Tạo bản nháp quy trình
 * thì đọc thêm từng bước, vì người nghe (nhiều khi chỉ nghe, không đọc màn hình) cần nghe đủ điều sẽ được tạo trước khi đồng ý.
 */
const spokenSummary = (p: ProposalView): string => (p.tool === 'propose_create_process' ? [p.summary, ...p.items.map((i) => i.text)].join(' ') : p.summary);

function stepBrief(s: StepView) {
  return {
    stepId: s.id,
    title: safe(s.title),
    kind: s.kind,
    state: s.state,
    stateText: vi.common.stepState[s.state],
    runId: s.runId,
    runTitle: safe(s.runTitle),
    assigneeId: s.assignee?.id ?? null,
    assignee: s.assignee ? personLabel(s.assignee) : null,
    dueAt: s.dueAt,
    dueText: dateText(s.dueAt),
    isOverdue: s.isOverdue,
    lateWorkingDays: s.lateWorkingDays,
    /** chỉ là cờ: lý do vướng là chữ tự do, không gửi ra ngoài */
    blocked: s.blockedReason !== null,
  };
}

function runBrief(r: RunSummary) {
  return {
    runId: r.id,
    title: safe(r.title),
    templateName: safe(r.templateName),
    state: r.state,
    stateText: vi.common.runState[r.state],
    done: r.progress.done,
    total: r.progress.total,
    schedule: r.schedule.status,
    lateWorkingDays: r.schedule.lateWorkingDays,
    targetAt: r.targetAt,
    targetText: dateText(r.targetAt),
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

function personBrief(ctx: OrgContext, u: UserRecord) {
  const role = ROLES.find((r) => u.roles.some((g) => g.role === r));
  return {
    id: u.id,
    fullName: u.fullName,
    givenName: u.givenName,
    honorific: u.honorific ? HONORIFIC_LABEL[u.honorific as Honorific] : null,
    unitName: u.unitId ? (ctx.units.get(u.unitId)?.name ?? null) : null,
    roleTitle: role ? vi.common.role[role] : null,
  };
}

const matches = (haystack: string, query: string | undefined): boolean => {
  const tokens = plain(query ?? '').split(' ').filter(Boolean);
  const text = plain(haystack);
  return tokens.every((t) => text.includes(t));
};

export type ExecuteToolOptions = { conversationId?: string };

async function run(tx: Tx, ctx: OrgContext, viewer: Viewer, name: ToolName, rawArgs: unknown, opts: ExecuteToolOptions): Promise<InternalToolResult> {
  const now = clock.now();
  switch (name) {
    case 'get_overview': {
      const a = parseToolArgs(TOOLS.get_overview.args, rawArgs);
      if (!can(viewer, 'overview.view')) throw new ApiError('forbidden');
      let runId: string | undefined;
      let unitId: string | undefined;
      if (a.scope === 'run') {
        if (!a.runId) throw new ApiError('input_invalid', { errors: [{ path: 'args.runId', code: 'required' }] });
        runId = (await findVisibleRun(tx, ctx, viewer, a.runId)).id;
      } else if (a.scope === 'unit') {
        if (!a.unitId) throw new ApiError('input_invalid', { errors: [{ path: 'args.unitId', code: 'required' }] });
        if (!ctx.units.has(a.unitId)) throw new ApiError('not_found');
        unitId = a.unitId;
      }
      // Cùng hàm và cùng view với thẻ số trên web (SPEC 5.5): số liệu không lệch nhau.
      const o = await getOverview(tx, ctx, viewer, { runId, unitId });
      return ok({
        scope: a.scope,
        asOf: o.asOf,
        today: formatDateFull(o.asOf),
        running: o.running,
        overdue: o.overdue,
        dueToday: o.dueToday,
        dueTomorrow: o.dueTomorrow,
        awaitingMyDecision: o.awaitingMyDecision,
        pendingApproval: o.pendingApproval,
        unassigned: o.unassigned,
        pendingExtensions: o.pendingExtensions,
        completedThisWeek: o.completedThisWeek,
        onTimePercentThisWeek: o.onTimeRateThisWeek === null ? null : Math.round(o.onTimeRateThisWeek * 100),
        needsAttention: o.needsAttention.slice(0, 20).map(stepBrief),
        recentlyCompletedRuns: o.recentlyCompletedRuns.slice(0, 10).map((r) => ({ runId: r.id, title: safe(r.title), completedAt: r.completedAt, completedText: dateText(r.completedAt) })),
      });
    }
    case 'list_runs': {
      const a = parseToolArgs(TOOLS.list_runs.args, rawArgs);
      // Lọc tên ở tầng ứng dụng để không phân biệt dấu ("don doan" khớp "Đón đoàn").
      const page = await listRuns(tx, ctx, viewer, { limit: 200, state: a.state, sort: '-startedAt' });
      const items = page.items.filter((r) => matches(`${r.title} ${r.templateName}`, a.query)).slice(0, 20);
      return ok({ count: items.length, runs: items.map(runBrief) });
    }
    case 'get_run': {
      const a = parseToolArgs(TOOLS.get_run.args, rawArgs);
      const r = await getRun(tx, ctx, viewer, a.runId);
      // Không trả `inputs` của biểu mẫu khởi chạy hay `result` của từng việc: đó là nội dung biểu mẫu tự do (SPEC 6.8).
      return ok({ ...runBrief(r), steps: r.steps.map(stepBrief) });
    }
    case 'list_overdue_steps': {
      const a = parseToolArgs(TOOLS.list_overdue_steps.args, rawArgs);
      if (a.assigneeId && !ctx.users.has(a.assigneeId)) throw new ApiError('not_found');
      if (a.runId) await findVisibleRun(tx, ctx, viewer, a.runId);
      const page = await listSteps(tx, ctx, viewer, { limit: 200, bucket: 'overdue', runId: a.runId, assignee: a.assigneeId, sort: 'dueAt' });
      const items = page.items.filter((s) => s.lateWorkingDays >= (a.minDaysLate ?? 0)).sort((x, y) => y.lateWorkingDays - x.lateWorkingDays);
      return ok({
        count: items.length,
        steps: items.slice(0, 50).map((s) => ({ ...stepBrief(s), canNudge: s.allowedActions.includes('nudge'), lastNudgedAt: s.lastNudgedAt })),
      });
    }
    case 'get_person_workload': {
      const a = parseToolArgs(TOOLS.get_person_workload.args, rawArgs);
      const person = ctx.users.get(a.personId);
      if (!person) throw new ApiError('not_found');
      const page = await listSteps(tx, ctx, viewer, { limit: 200, assignee: person.id, open: true, sort: 'dueAt' });
      const open = page.items;
      // Tỉ lệ đúng hạn là số liệu về một người: chỉ người điều phối, cấp trên của họ, hoặc chính họ được xem.
      let completed: number | null = null;
      let onTimePercent: number | null = null;
      if (seesAllRuns(viewer) || person.id === viewer.id || ctx.teamUserIds(viewer.id).has(person.id)) {
        const res = await tx.execute<{ completed: string | null; on_time: string | null }>(
          sql`SELECT sum(completed) AS completed, sum(on_time_original) AS on_time FROM v_on_time_rate WHERE user_id = ${person.id}`,
        );
        completed = Number(res.rows[0]?.completed ?? 0);
        onTimePercent = completed > 0 ? Math.round((Number(res.rows[0]?.on_time ?? 0) / completed) * 100) : null;
      }
      return ok({
        person: personBrief(ctx, person),
        holding: open.length,
        overdue: open.filter((s) => s.isOverdue).length,
        completed,
        onTimePercent,
        steps: open.slice(0, 30).map(stepBrief),
      });
    }
    case 'search_people': {
      const a = parseToolArgs(TOOLS.search_people.args, rawArgs);
      const people = [...ctx.users.values()]
        .filter((u) => u.status !== 'disabled')
        .sort((x, y) => x.displayOrder - y.displayOrder || x.fullName.localeCompare(y.fullName, 'vi'));
      const found = matchPerson(
        a.query,
        people.map((u) => ({ id: u.id, fullName: u.fullName, givenName: u.givenName, honorific: u.honorific, unitName: u.unitId ? (ctx.units.get(u.unitId)?.name ?? null) : null })),
      );
      const top = found[0]?.score ?? 0;
      // Nhiều người khớp gần ngang nhau: trả CẢ danh sách và báo mơ hồ; trợ lý phải hỏi lại, không tự chọn (SPEC 6.6).
      const ambiguous = found.filter((m) => m.score >= top * 0.9).length > 1;
      return ok({
        count: found.length,
        ambiguous,
        people: found.slice(0, 10).map((m) => ({ ...personBrief(ctx, ctx.users.get(m.id)!), score: m.score })),
      });
    }
    case 'search_templates': {
      const a = parseToolArgs(TOOLS.search_templates.args, rawArgs);
      if (!can(viewer, 'template.read_published')) throw new ApiError('forbidden');
      // Bản nháp chưa xuất bản chỉ người sửa hoặc xuất bản mẫu mới thấy.
      const withDrafts = a.includeDrafts === true && canAny(viewer, TEMPLATE_DRAFT_ACTIONS);
      const [templates, versions] = await inOrder([
        tx.select().from(schema.processTemplates).where(and(isNull(schema.processTemplates.archivedAt), eq(schema.processTemplates.kind, 'process'))),
        tx
          .select({ id: schema.processTemplateVersions.id, templateId: schema.processTemplateVersions.templateId, version: schema.processTemplateVersions.version })
          .from(schema.processTemplateVersions)
          .where(eq(schema.processTemplateVersions.status, 'published')),
      ]);
      const draftRows = withDrafts
        ? await tx
            .select({ templateId: schema.processTemplateVersions.templateId, definition: schema.processTemplateVersions.definition })
            .from(schema.processTemplateVersions)
            .where(eq(schema.processTemplateVersions.status, 'draft'))
        : [];
      const drafts = new Map(draftRows.map((d) => [d.templateId, d.definition]));
      const latest = new Map<string, { id: string; version: number }>();
      for (const v of versions) if ((latest.get(v.templateId)?.version ?? 0) < v.version) latest.set(v.templateId, { id: v.id, version: v.version });
      const hits = templates
        .filter((t) => (latest.has(t.id) || drafts.has(t.id)) && matches(`${t.name} ${t.description ?? ''}`, a.query))
        .sort((x, y) => x.name.localeCompare(y.name, 'vi'))
        .slice(0, 10);
      const out = [];
      for (const t of hits) {
        const draft = drafts.get(t.id);
        const published = latest.get(t.id);
        // Tìm bản nháp để xuất bản thì các ô biểu mẫu lấy từ bản nháp; không thì từ bản xuất bản mới nhất như trước.
        const draftDef = draft === undefined ? null : DraftDefinitionSchema.parse(draft);
        const publishedDef = draftDef ? null : await loadDefinition(tx, (published as { id: string }).id);
        const def = draftDef ?? (publishedDef as NonNullable<typeof publishedDef>);
        // Ô số văn bản do máy chủ tự cấp nên trợ lý không hỏi; ô tệp đính kèm không điền được bằng giọng nói (`attachOnApp`).
        const fields = publishedDef
          ? publishedDef.inputs
              .filter((f) => f.type !== 'autonumber')
              .map((f) => ({
                key: f.key,
                label: safe(f.label, 80),
                type: f.type,
                required: f.required === true,
                ...(f.type === 'file' ? { attachOnApp: true } : {}),
                ...(f.options ? { options: f.options.slice(0, 20).map((o) => ({ value: o.value, label: safe(o.label, 80) })) } : {}),
              }))
          : (draftDef as NonNullable<typeof draftDef>).inputs
              .filter((f) => String(f.type) !== 'autonumber')
              .map((f) => ({ key: String(f.key), label: safe(String(f.label), 80), type: String(f.type), required: f.required === true, ...(String(f.type) === 'file' ? { attachOnApp: true } : {}) }));
        out.push({
          templateId: t.id,
          name: safe(t.name),
          description: t.description ? safe(t.description) : null,
          ...(withDrafts ? { status: published ? (draft ? 'published_with_draft' : 'published') : 'draft_only' } : {}),
          stepCount: def.nodes.filter((n) => n.type === 'task' || n.type === 'approval').length,
          targetField: def.targetField ?? null,
          // Người đang hỏi có khởi chạy được quy trình này không (quy trình có thể giới hạn người khởi chạy, ví dụ chỉ Chủ tịch ra chỉ thị).
          canStart: publishedDef ? canStartRun(publishedDef, viewer.id, ctx.resolve) : false,
          category: t.category,
          // Các ô của biểu mẫu khởi chạy: trợ lý hỏi từng câu cho ô còn thiếu rồi mới gọi propose_start_run.
          fields,
        });
      }
      return ok({ count: out.length, templates: out });
    }
    case 'resolve_date': {
      const a = parseToolArgs(TOOLS.resolve_date.args, rawArgs);
      // Ngày tính bằng mã theo lịch làm việc của tổ chức, không để mô hình tự tính (SPEC 6.6).
      const r = resolveDate(a.phrase, now, ctx.calendar);
      if (!r) return failure('date_unresolved');
      const today = toLocalDate(now, ctx.calendar);
      return ok({ date: r.date, weekday: r.weekday, text: formatDateFull(r.date), lunarLabel: r.lunarLabel, isWorkingDay: r.isWorkingDay, isToday: r.date === today, isPast: r.date < today });
    }
    case 'list_pending_proposals': {
      parseToolArgs(TOOLS.list_pending_proposals.args, rawArgs);
      const items = await listProposals(tx, ctx, viewer, { state: 'pending', limit: 50 });
      return ok({
        count: items.length,
        proposals: items.map((p) => ({ proposalId: p.id, batchId: p.batchId, tool: p.tool, risk: p.risk, summary: p.summary, requiresStepUp: p.requiresStepUp, expiresAt: p.expiresAt })),
      });
    }
    case 'preview_process': {
      const a = parseToolArgs(TOOLS.preview_process.args, rawArgs);
      if (!can(viewer, 'template.edit')) throw new ApiError('forbidden');
      const analysis = analyzeDraft(ctx, a);
      const problems = [...analysis.problems];
      if (analysis.name !== '' && (await nameTaken(tx, analysis.name))) problems.push({ step: null, field: 'name', code: 'name_taken' });
      if (problems.length === 0 && definitionIssues(ctx, definitionOf(analysis)).length > 0) problems.push({ step: null, field: 'steps', code: 'definition_invalid' });
      // Còn lỗi thì chưa đọc lại: trợ lý hỏi đúng chỗ còn thiếu (mỗi lượt một câu), rồi gửi lại cả danh sách.
      if (problems.length > 0) return ok({ name: analysis.name, stepCount: a.steps.length, steps: [], problems, complete: false });
      const lines = analysis.steps.map((s, i) => stepSentence({ n: i + 1, kind: s.kind, title: s.title, who: stepAssigneeLabel(ctx, s.assignee), dueDays: s.dueDays, parallel: s.parallel }));
      const from = Math.min(Math.max(a.readFrom ?? 1, 1), lines.length);
      return ok(
        { name: analysis.name, stepCount: lines.length, steps: lines.map((text, i) => ({ n: i + 1, text })), problems: [], complete: true },
        // Câu đọc lại do máy chủ dựng; vòng lặp của trợ lý dừng và đọc đúng các dòng này, không để LLM diễn đạt lại.
        { processReadback: { name: analysis.name, lines: lines.slice(from - 1), total: lines.length } },
      );
    }
    case 'save_note':
    case 'propose_nudge':
    case 'propose_start_run':
    case 'propose_reassign':
    case 'propose_extend_due':
    case 'propose_cancel_run':
    case 'propose_assign_task':
    case 'propose_create_process':
    case 'propose_publish_process': {
      if (!isProposalTool(name)) throw new ApiError('internal_error');
      const res = await createProposals(tx, ctx, viewer, name, rawArgs, { source: 'ai', conversationId: opts.conversationId });
      return ok(
        {
          created: res.proposals.length,
          // Câu do máy chủ dựng: trợ lý đọc lại đúng các câu này, không tự diễn đạt lại (SPEC 6.6 điều 3).
          items: res.proposals.flatMap((p) => p.items.map((i) => i.text)).slice(0, 20),
          saved: name === 'save_note',
          skipped: res.skipped,
        },
        { proposals: res.proposals.map((p) => ({ proposalId: p.id, batchId: p.batchId, risk: p.risk, summary: spokenSummary(p) })) },
      );
    }
  }
}

/**
 * Chạy một tool thay cho `viewer`. `viewer` là người ở header `X-On-Behalf-Of`, dựng từ CSDL với vai trò hiện tại;
 * mọi truy vấn đi qua cùng lớp tầm nhìn (`findVisibleRun`, `findVisibleStep`, `listSteps`) như khi chính họ gọi API.
 */
export async function executeTool(tx: Tx, ctx: OrgContext, viewer: Viewer, name: string, rawArgs: unknown, opts: ExecuteToolOptions = {}): Promise<InternalToolResult> {
  // Công tắc AI theo tổ chức kiểm ở máy chủ, không chỉ ở app (SPEC 11.7).
  const ai = ctx.settings.ai;
  if (!ai.enabled || ai.llm === 'off') return failure('ai_disabled');
  if (!isToolName(name)) return failure('unknown_tool');
  const user = ctx.users.get(viewer.id);
  if (!user || user.status === 'disabled' || !can(viewer, 'assistant.use')) return failure('forbidden');
  try {
    // Savepoint: tool lỗi giữa chừng thì không để lại dòng nào (đề xuất tạo dở cũng bị hoàn lại).
    return await tx.transaction((sp) => run(sp, ctx, viewer, name, rawArgs, opts));
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) return failure(err.code, err.extra.errors);
    throw err;
  }
}
