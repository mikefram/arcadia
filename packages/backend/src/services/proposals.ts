import { TOOLS } from '@mihato/ai-tools';
import {
  ApiError,
  HONORIFIC_LABEL,
  OPEN_STEP_STATES,
  PG_NOTIFY_CHANNEL,
  PROPOSAL_RISK,
  PROPOSAL_TOOLS,
  PROPOSAL_TTL_MS,
  PROPOSAL_UNDO_WINDOW_MS,
  ProposalPayloadSchemas,
  SimulationRowSchema,
  can,
  deterministicId,
  isExecutive,
  newId,
  type EngineEvent,
  type FormField,
  type Honorific,
  type PersonRef,
  type ProcessDefinition,
  type ProposalState,
  type ProposalTool,
  type ProposalView,
  type ResolvedDraftStep,
  type SimulationRowView,
  type StreamEvent,
} from '@mihato/domain';
import { endOfWorkday, lateWorkingDays, toLocalDate } from '@mihato/domain/calendar';
import { matchVoiceConfirm, normalizeText, parseMoney, parseNumber, stripDiacritics } from '@mihato/domain/vi-normalize';
import { fmt, formatDateFull, vi } from '@mihato/i18n';
import { canStartRun, simulate } from '@mihato/workflow-engine';
import { and, desc, eq, gt, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit';
import { requireStepUp, type RequestMeta } from '../auth/service';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, withOrg, type Tx } from '../db/client';
import { applyRunEvent, insertEffect, loadDefinition, mapEngineError } from '../engine/runner';
import { env } from '../env';
import { allowedActions, type Viewer } from '../views';
import type { EffectHandler, EffectOutcome } from '../worker';
import { canTakeStep, checkTask, createAdhocTask, previewTask } from './adhoc';
import { createSystemNotification } from './notifications';
import { checkNudgeThrottle, composeNudge, sendOneNudge, type ThrottleReason } from './nudges';
import { analyzeDraft, definitionIssues, definitionOf, nameTaken, problemErrors } from './process-draft';
import { actOnStep, addRunNote, findVisibleRun, findVisibleStep, latestPublishedVersion, startRun } from './runs';
import { createTemplate, previewPublish, publishTemplate } from './templates';

/**
 * Đề xuất và cổng xác nhận (SPEC 6.5, 10.6): phần an toàn quan trọng nhất của AI Scribe, nằm ở máy chủ.
 *
 * - AI không có đường ghi: tool `propose_*` chỉ tạo dòng `proposals` ở `pending`.
 * - Câu xác nhận (`summary`, `items[].text`) do máy chủ dựng từ `payload` bằng MẪU CỐ ĐỊNH ở `PROPOSAL_TEMPLATES`;
 *   không có chữ nào của LLM được dùng làm câu xác nhận. Chữ tự do (lý do, tên lượt chạy mới) chỉ xuất hiện
 *   trong ngoặc kép ở đúng ô của nó, sau khi đã làm sạch và cắt ngắn.
 * - Chỉ đúng người `for_user_id`, bằng phiên đăng nhập của họ, mới xác nhận được. Hiệu lực chạy trễ 30 giây
 *   qua một dòng `effects` kiểu `proposal.apply`; worker kiểm lại quyền và trạng thái rồi mới gọi `advance()`.
 */

type ProposalRow = typeof schema.proposals.$inferSelect;
type StepRow = typeof schema.stepRuns.$inferSelect;
type RunRow = typeof schema.processRuns.$inferSelect;
type FieldError = { path: string; code: string };

export type ProposalSource = 'ai' | 'office';
export const isProposalTool = (name: string): name is ProposalTool => (PROPOSAL_TOOLS as readonly string[]).includes(name);

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const invalid = (errors: FieldError[]) => new ApiError('input_invalid', { errors });
const isOpenStep = (state: string) => (OPEN_STEP_STATES as readonly string[]).includes(state);

/** Viewer của một người lấy từ danh bạ hiện tại (vai trò hiện tại), để chạy việc thay họ ở máy chủ. Người đã bị vô hiệu hoá: null. */
export function viewerForUser(ctx: OrgContext, userId: string | null | undefined): Viewer | null {
  const u = userId ? ctx.users.get(userId) : undefined;
  if (!u || u.status === 'disabled') return null;
  return { id: u.id, orgId: ctx.orgId, roles: u.roles, permissions: u.permissions, unitId: u.unitId, deviceId: null, sessionId: null, via: 'bearer' };
}

async function notifyProposal(tx: Tx, orgId: string, proposalId: string, userId: string): Promise<void> {
  const event: StreamEvent = { kind: 'proposal.updated', orgId, proposalId, userId };
  await tx.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
}

// ───────────────────────── Mẫu câu xác nhận (một chỗ duy nhất, có test ảnh chụp) ─────────────────────────

/**
 * MẪU CỐ ĐỊNH của câu xác nhận (SPEC 6.5 điều 3). Trợ lý đọc lại `summary` sau câu "Dạ, trợ lý hiểu như sau:"
 * (SPEC 6.6). Sửa mẫu ở đây thì test ảnh chụp đổi theo. Lời văn theo SPEC 7.5: ngày viết đủ, không dùng từ vay mượn.
 * [GIẢ ĐỊNH] câu chữ chờ Chủ tịch hoặc Chánh văn phòng duyệt như các mẫu khác ở 7.5.
 */
export const PROPOSAL_TEMPLATES = vi.server.proposals;

/** Dữ kiện để điền mẫu: tên và mốc lấy từ CSDL; chữ tự do đã qua `quote()`. */
/** Một bước của quy trình đang soạn, đã đổi người thành chữ gọi ("anh Bùi Quốc Tuấn", "Giám đốc", "người giao việc"). */
export type ProcessStepFact = { n: number; kind: 'task' | 'approval'; title: string; who: string; dueDays: number; parallel: boolean };
type RunRowFact = { title: string; assignee: string | null; dueAt: string | null; pastDue: boolean };

export type ProposalFacts =
  | { tool: 'save_note'; text: string; runTitle: string | null }
  | { tool: 'propose_nudge'; to: string; stepTitle: string; runTitle: string; lateWorkingDays: number; overdue: boolean }
  | { tool: 'propose_start_run'; templateName: string; title: string; rows: { title: string; assignee: string | null; dueAt: string | null; pastDue: boolean }[] }
  | { tool: 'propose_reassign'; stepTitle: string; runTitle: string; from: string | null; to: string; reason: string }
  | { tool: 'propose_extend_due'; stepTitle: string; runTitle: string; holder: string | null; currentDueAt: string | null; newDueAt: string; reason: string }
  | { tool: 'propose_cancel_run'; runTitle: string; openSteps: number; reason: string }
  | { tool: 'propose_assign_task'; title: string; to: string; description: string | null; dueAt: string | null; pastDue: boolean }
  | { tool: 'propose_create_process'; name: string; steps: ProcessStepFact[] }
  | { tool: 'propose_publish_process'; templateName: string; version: number; run: { title: string; rows: RunRowFact[] } | null };

/**
 * Làm sạch chữ đưa vào ô của mẫu: gộp khoảng trắng và xuống dòng, bỏ ký tự điều khiển, đổi dấu ngoặc kép cong
 * để chữ không "thoát" khỏi ngoặc của mẫu, cắt ngắn. Chữ sau khi làm sạch vẫn chỉ là dữ liệu trong ngoặc.
 */
function quote(text: string, max = 200): string {
  const clean = text
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/[“”"]/g, "'")
    .replace(/[‘’]/g, "'")
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "chị Nguyễn Thu Lan": lần đầu nêu tên thì viết đủ xưng hô và họ tên (SPEC 7.5). */
export function personLabel(p: PersonRef | null): string {
  if (!p) return PROPOSAL_TEMPLATES.unknownPerson;
  const h = p.honorific ? HONORIFIC_LABEL[p.honorific as Honorific] : null;
  return quote(h ? `${h} ${p.fullName}` : p.fullName, 120);
}

function lateText(overdue: boolean, days: number): string {
  const t = PROPOSAL_TEMPLATES.nudge;
  if (!overdue) return t.notLate;
  return days > 0 ? fmt(t.late, { n: days }) : t.lateToday;
}

/** Dòng của từng việc khi giao việc: dùng chung cho `propose_start_run` và `propose_publish_process` kèm giao việc. */
function runRowTexts(rows: readonly RunRowFact[]): string[] {
  const T = PROPOSAL_TEMPLATES.startRun;
  return rows.map((r) =>
    fmt(T.item, {
      việc: quote(r.title, 120),
      người: r.assignee ?? T.noAssignee,
      hạn: r.dueAt ? fmt(r.pastDue ? T.duePast : T.due, { ngày: formatDateFull(r.dueAt) }) : T.noDue,
    }),
  );
}

/**
 * Câu của một bước quy trình, để đọc lại cho người dùng xác nhận và hiện thành thẻ ở màn xác nhận. Một chỗ duy nhất:
 * cả `preview_process` (đọc lại từng bước vừa nghe) và `propose_create_process` (đọc cả quy trình) dùng đúng hàm này.
 */
export function stepSentence(s: ProcessStepFact): string {
  const T = PROPOSAL_TEMPLATES.createProcess;
  const base = fmt(s.kind === 'approval' ? T.stepApproval : T.stepTask, { n: s.n, việc: quote(s.title, 120), người: s.who, k: s.dueDays });
  return s.parallel && s.n > 1 ? `${base} ${T.parallel}` : base;
}

/** Người làm của một bước, đổi thành chữ gọi theo xưng hô của người đó, hoặc tên vai trò, hoặc "người giao việc". */
export function stepAssigneeLabel(ctx: OrgContext, a: ResolvedDraftStep['assignee']): string {
  if (a.kind === 'person') return personLabel(ctx.person(a.userId));
  if (a.kind === 'role') return vi.common.role[a.role];
  return PROPOSAL_TEMPLATES.createProcess.initiator;
}

/** Dựng câu xác nhận từ dữ kiện bằng mẫu cố định. Hàm thuần: cùng dữ kiện luôn cho cùng câu. */
export function renderProposal(f: ProposalFacts): { summary: string; items: string[] } {
  const T = PROPOSAL_TEMPLATES;
  switch (f.tool) {
    case 'save_note': {
      const vars = { lượt: quote(f.runTitle ?? '', 120), 'ghi chú': quote(f.text) };
      const summary = fmt(f.runTitle === null ? T.note.noRun : T.note.withRun, vars);
      return { summary, items: [summary] };
    }
    case 'propose_nudge': {
      const vars = { người: f.to, Người: capitalize(f.to), việc: quote(f.stepTitle, 120), lượt: quote(f.runTitle, 120), 'tình trạng': lateText(f.overdue, f.lateWorkingDays) };
      return { summary: fmt(T.nudge.summary, vars), items: [fmt(T.nudge.item, vars)] };
    }
    case 'propose_start_run': {
      const past = f.rows.filter((r) => r.pastDue).length;
      const summary =
        fmt(T.startRun.summary, { mẫu: quote(f.templateName, 120), tên: quote(f.title, 120), n: f.rows.length }) + (past > 0 ? ` ${fmt(T.startRun.pastDue, { k: past })}` : '');
      return { summary, items: runRowTexts(f.rows) };
    }
    case 'propose_reassign': {
      const vars = { việc: quote(f.stepTitle, 120), lượt: quote(f.runTitle, 120), 'người cũ': f.from ?? '', 'người mới': f.to };
      const summary = fmt(f.from === null ? T.reassign.unassigned : T.reassign.summary, vars);
      return { summary, items: [`${summary} ${fmt(T.reason, { 'lý do': quote(f.reason) })}`] };
    }
    case 'propose_extend_due': {
      const vars = {
        việc: quote(f.stepTitle, 120),
        lượt: quote(f.runTitle, 120),
        'hạn cũ': f.currentDueAt ? formatDateFull(f.currentDueAt) : '',
        'hạn mới': formatDateFull(f.newDueAt),
      };
      const summary = fmt(f.currentDueAt === null ? T.extendDue.noDue : T.extendDue.summary, vars);
      const holder = f.holder ? ` ${fmt(T.extendDue.holder, { người: f.holder })}` : '';
      return { summary, items: [`${summary}${holder} ${fmt(T.reason, { 'lý do': quote(f.reason) })}`] };
    }
    case 'propose_cancel_run': {
      const summary = fmt(T.cancelRun.summary, { lượt: quote(f.runTitle, 120), n: f.openSteps });
      return { summary, items: [`${summary} ${fmt(T.reason, { 'lý do': quote(f.reason) })}`] };
    }
    case 'propose_assign_task': {
      const due = f.dueAt ? fmt(f.pastDue ? T.startRun.duePast : T.startRun.due, { ngày: formatDateFull(f.dueAt) }) : T.startRun.noDue;
      const summary = fmt(T.assignTask.summary, { việc: quote(f.title, 120), người: f.to, hạn: due });
      return { summary, items: [f.description ? `${summary} ${fmt(T.assignTask.note, { 'nội dung': quote(f.description, 300) })}` : summary] };
    }
    case 'propose_create_process':
      return { summary: fmt(T.createProcess.summary, { tên: quote(f.name, 120), n: f.steps.length }), items: f.steps.map(stepSentence) };
    case 'propose_publish_process': {
      if (!f.run) {
        const summary = fmt(T.publishProcess.summary, { mẫu: quote(f.templateName, 120), k: f.version });
        return { summary, items: [summary] };
      }
      const past = f.run.rows.filter((r) => r.pastDue).length;
      const summary =
        fmt(T.publishProcess.summaryWithRun, { mẫu: quote(f.templateName, 120), k: f.version, tên: quote(f.run.title, 120), n: f.run.rows.length }) + (past > 0 ? ` ${fmt(T.startRun.pastDue, { k: past })}` : '');
      return { summary, items: runRowTexts(f.run.rows) };
    }
  }
}

// ───────────────────────── Dữ liệu lưu ở proposals.payload ─────────────────────────

/**
 * `payload` = tham số đã kiểm của tool (ProposalPayloadSchemas) cộng `display`: dữ kiện máy chủ lấy từ CSDL
 * lúc tạo (tên việc, tên lượt, người đang giữ, bản xem trước) để dựng lại câu chữ mà không phụ thuộc trạng thái về sau.
 * `display` không bao giờ đến từ LLM.
 */
const Stored = {
  save_note: ProposalPayloadSchemas.save_note.extend({ display: z.object({ runTitle: z.string().nullable() }) }),
  propose_nudge: ProposalPayloadSchemas.propose_nudge.extend({
    /** người dùng nêu đích danh: được đi thúc cả việc chưa quá hạn (SPEC 4.7) */
    named: z.boolean().optional(),
    display: z.object({ stepTitle: z.string(), runTitle: z.string(), runId: z.string(), lateWorkingDays: z.number().int(), overdue: z.boolean() }),
  }),
  propose_start_run: ProposalPayloadSchemas.propose_start_run.extend({
    display: z.object({ templateName: z.string(), preview: z.array(SimulationRowSchema), targetAt: z.string().nullable() }),
  }),
  propose_reassign: ProposalPayloadSchemas.propose_reassign.extend({
    display: z.object({ stepTitle: z.string(), runTitle: z.string(), runId: z.string(), fromUserId: z.string().nullable(), lateWorkingDays: z.number().int() }),
  }),
  propose_extend_due: ProposalPayloadSchemas.propose_extend_due.extend({
    display: z.object({
      stepTitle: z.string(),
      runTitle: z.string(),
      runId: z.string(),
      assigneeId: z.string().nullable(),
      currentDueAt: z.string().nullable(),
      lateWorkingDays: z.number().int(),
    }),
  }),
  propose_cancel_run: ProposalPayloadSchemas.propose_cancel_run.extend({ display: z.object({ runTitle: z.string(), openSteps: z.number().int() }) }),
  propose_assign_task: ProposalPayloadSchemas.propose_assign_task.extend({ display: z.object({ dueAt: z.string().nullable(), pastDue: z.boolean() }) }),
  /** các bước đã tra người nằm ngay trong payload; tên người và vai trò dựng lại từ danh bạ lúc hiển thị */
  propose_create_process: ProposalPayloadSchemas.propose_create_process,
  propose_publish_process: ProposalPayloadSchemas.propose_publish_process.extend({
    display: z.object({ templateName: z.string(), version: z.number().int(), preview: z.array(SimulationRowSchema).nullable(), targetAt: z.string().nullable() }),
  }),
} as const;

type StoredOf<T extends ProposalTool> = z.infer<(typeof Stored)[T]>;
type StoredPayload = { [T in ProposalTool]: { tool: T; data: StoredOf<T> } }[ProposalTool];

function readStored(row: Pick<ProposalRow, 'tool' | 'payload'>): StoredPayload {
  switch (row.tool) {
    case 'save_note':
      return { tool: 'save_note', data: Stored.save_note.parse(row.payload) };
    case 'propose_nudge':
      return { tool: 'propose_nudge', data: Stored.propose_nudge.parse(row.payload) };
    case 'propose_start_run':
      return { tool: 'propose_start_run', data: Stored.propose_start_run.parse(row.payload) };
    case 'propose_reassign':
      return { tool: 'propose_reassign', data: Stored.propose_reassign.parse(row.payload) };
    case 'propose_extend_due':
      return { tool: 'propose_extend_due', data: Stored.propose_extend_due.parse(row.payload) };
    case 'propose_cancel_run':
      return { tool: 'propose_cancel_run', data: Stored.propose_cancel_run.parse(row.payload) };
    case 'propose_assign_task':
      return { tool: 'propose_assign_task', data: Stored.propose_assign_task.parse(row.payload) };
    case 'propose_create_process':
      return { tool: 'propose_create_process', data: Stored.propose_create_process.parse(row.payload) };
    case 'propose_publish_process':
      return { tool: 'propose_publish_process', data: Stored.propose_publish_process.parse(row.payload) };
    default:
      throw new ApiError('internal_error');
  }
}

type ItemMeta = Omit<ProposalView['items'][number], 'text'>;

/** Bản xem trước lấy từ `simulate()` lúc tạo đề xuất, đổi id người thành thông tin hiển thị theo danh bạ hiện tại. */
function previewRowsOf(ctx: OrgContext, rows: readonly z.infer<typeof SimulationRowSchema>[]): SimulationRowView[] {
  return rows.map((r) => ({
    nodeId: r.nodeId,
    kind: r.kind,
    title: r.title,
    assignee: ctx.person(r.assigneeId),
    onBehalfOf: ctx.person(r.onBehalfOfId),
    dueAt: r.dueAt,
    pastDue: r.pastDue,
    order: r.order,
  }));
}

/** Dữ kiện và phần có cấu trúc của từng mục, dựng từ payload đã lưu. */
function describe(ctx: OrgContext, p: StoredPayload, editable: boolean): { facts: ProposalFacts; items: ItemMeta[]; preview: SimulationRowView[] | null } {
  const blank: ItemMeta = { stepId: null, runId: null, toUser: null, message: null, editable: false, lateWorkingDays: null };
  switch (p.tool) {
    case 'save_note':
      return {
        facts: { tool: 'save_note', text: p.data.text, runTitle: p.data.display.runTitle },
        items: [{ ...blank, runId: p.data.runId ?? null }],
        preview: null,
      };
    case 'propose_nudge': {
      const d = p.data.display;
      const to = ctx.person(p.data.toUserId);
      return {
        facts: { tool: 'propose_nudge', to: personLabel(to), stepTitle: d.stepTitle, runTitle: d.runTitle, lateWorkingDays: d.lateWorkingDays, overdue: d.overdue },
        items: [{ stepId: p.data.stepRunId, runId: d.runId, toUser: to, message: p.data.message, editable, lateWorkingDays: d.lateWorkingDays }],
        preview: null,
      };
    }
    case 'propose_start_run': {
      const d = p.data.display;
      const preview = previewRowsOf(ctx, d.preview);
      return {
        facts: {
          tool: 'propose_start_run',
          templateName: d.templateName,
          title: p.data.title,
          rows: preview.map((r) => ({ title: r.title, assignee: r.assignee ? personLabel(r.assignee) : null, dueAt: r.dueAt, pastDue: r.pastDue })),
        },
        items: preview.map((r) => ({ ...blank, toUser: r.assignee })),
        preview,
      };
    }
    case 'propose_reassign': {
      const d = p.data.display;
      const to = ctx.person(p.data.toUserId);
      return {
        facts: {
          tool: 'propose_reassign',
          stepTitle: d.stepTitle,
          runTitle: d.runTitle,
          from: d.fromUserId ? personLabel(ctx.person(d.fromUserId)) : null,
          to: personLabel(to),
          reason: p.data.reason,
        },
        items: [{ ...blank, stepId: p.data.stepRunId, runId: d.runId, toUser: to, lateWorkingDays: d.lateWorkingDays }],
        preview: null,
      };
    }
    case 'propose_extend_due': {
      const d = p.data.display;
      const holder = ctx.person(d.assigneeId);
      return {
        facts: {
          tool: 'propose_extend_due',
          stepTitle: d.stepTitle,
          runTitle: d.runTitle,
          holder: holder ? personLabel(holder) : null,
          currentDueAt: d.currentDueAt,
          newDueAt: p.data.newDue,
          reason: p.data.reason,
        },
        items: [{ ...blank, stepId: p.data.stepRunId, runId: d.runId, toUser: holder, lateWorkingDays: d.lateWorkingDays }],
        preview: null,
      };
    }
    case 'propose_cancel_run':
      return {
        facts: { tool: 'propose_cancel_run', runTitle: p.data.display.runTitle, openSteps: p.data.display.openSteps, reason: p.data.reason },
        items: [{ ...blank, runId: p.data.runId }],
        preview: null,
      };
    case 'propose_assign_task': {
      const to = ctx.person(p.data.assigneeId);
      return {
        facts: { tool: 'propose_assign_task', title: p.data.title, to: personLabel(to), description: p.data.description ?? null, dueAt: p.data.display.dueAt, pastDue: p.data.display.pastDue },
        items: [{ ...blank, toUser: to }],
        preview: null,
      };
    }
    case 'propose_create_process':
      return {
        facts: {
          tool: 'propose_create_process',
          name: p.data.name,
          steps: p.data.steps.map((s, i) => ({ n: i + 1, kind: s.kind, title: s.title, who: stepAssigneeLabel(ctx, s.assignee), dueDays: s.dueDays, parallel: s.parallel })),
        },
        // Người làm cụ thể mới có `toUser`; vai trò hay "người giao việc" không phải một người.
        items: p.data.steps.map((s) => ({ ...blank, toUser: s.assignee.kind === 'person' ? ctx.person(s.assignee.userId) : null })),
        preview: null,
      };
    case 'propose_publish_process': {
      const d = p.data.display;
      const run = p.data.startRun;
      const preview = run ? previewRowsOf(ctx, d.preview ?? []) : null;
      return {
        facts: {
          tool: 'propose_publish_process',
          templateName: d.templateName,
          version: d.version,
          run: run && preview ? { title: run.title, rows: preview.map((r) => ({ title: r.title, assignee: r.assignee ? personLabel(r.assignee) : null, dueAt: r.dueAt, pastDue: r.pastDue })) } : null,
        },
        items: preview ? preview.map((r) => ({ ...blank, toUser: r.assignee })) : [blank],
        preview,
      };
    }
  }
}

/** View của một đề xuất. `summary` là câu đã lưu lúc tạo; `items[].text` dựng lại từ payload bằng cùng bộ mẫu. */
export function proposalView(ctx: OrgContext, row: ProposalRow, now: Date = clock.now()): ProposalView {
  // Hết hạn tính theo đồng hồ: việc định kỳ chỉ chạy mỗi phút, người dùng không được thấy đề xuất quá hạn còn "đang chờ".
  const state: ProposalState = row.state === 'pending' && row.expiresAt <= now ? 'expired' : (row.state as ProposalState);
  const tool = row.tool as ProposalTool;
  const d = describe(ctx, readStored(row), state === 'pending');
  const texts = renderProposal(d.facts).items;
  const windowed = state === 'confirmed' && row.confirmedVia !== 'auto';
  return {
    id: row.id,
    batchId: row.batchId,
    tool,
    risk: row.risk as 0 | 1 | 2,
    summary: row.summary,
    items: d.items.map((meta, i) => ({ text: texts[i] ?? '', ...meta })),
    preview: d.preview,
    source: row.source as ProposalSource,
    createdBy: ctx.person(row.createdBy),
    state,
    requiresStepUp: row.risk === 2,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    effectiveAt: iso(row.effectiveAt),
    undoUntil: windowed ? iso(row.effectiveAt) : null,
    result: (row.result as Record<string, unknown> | null) ?? null,
  };
}

// ───────────────────────── Tạo đề xuất (bước 1 của vòng đời) ─────────────────────────

/** Kiểm tham số của một tool bằng Zod của nó; sai thì ném `input_invalid` kèm đường dẫn từng ô. */
export function parseToolArgs<S extends z.ZodType>(schemaDef: S, raw: unknown): z.infer<S> {
  // z.object bỏ mọi trường lạ: LLM có gửi kèm `summary` tự bịa thì cũng không đi tiếp (SPEC 6.5 điều 3).
  const res = schemaDef.safeParse(raw ?? {});
  if (!res.success) throw invalid(res.error.issues.slice(0, 50).map((i) => ({ path: ['args', ...i.path].join('.'), code: i.code })));
  return res.data;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isRealLocalDate(v: string): boolean {
  const m = LOCAL_DATE.exec(v);
  if (!m) return false;
  const back = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return back.toISOString().slice(0, 10) === v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (s: string) => stripDiacritics(normalizeText(s));

/** Đổi một giá trị dạng chuỗi về đúng kiểu ô biểu mẫu; không đổi được thì trả undefined. */
function coerceField(ctx: OrgContext, field: FormField, raw: string): unknown {
  switch (field.type) {
    case 'text':
      return raw;
    case 'date':
      return isRealLocalDate(raw) ? raw : undefined;
    case 'number': {
      const n = Number(raw.replace(',', '.'));
      if (Number.isFinite(n)) return n;
      return parseNumber(raw) ?? undefined;
    }
    case 'money': {
      const digits = raw.replace(/(đồng|vnd|đ)\s*$/iu, '').replace(/[\s.,]/g, '');
      if (/^\d+$/.test(digits)) {
        const n = Number(digits);
        return Number.isSafeInteger(n) ? n : undefined;
      }
      return parseMoney(raw) ?? undefined;
    }
    case 'longtext':
      return raw;
    case 'select': {
      if (!field.options || field.options.length === 0) return raw;
      const hit = field.options.find((o) => o.value === raw) ?? field.options.find((o) => plain(o.label) === plain(raw));
      return hit?.value;
    }
    case 'user': {
      const u = UUID.test(raw) ? ctx.users.get(raw.toLowerCase()) : undefined;
      return u && u.status !== 'disabled' ? u.id : undefined;
    }
    case 'users': {
      const ids = raw.split(/[\s,;]+/).filter(Boolean);
      const found = ids.map((id) => (UUID.test(id) ? ctx.users.get(id.toLowerCase()) : undefined));
      return ids.length > 0 && found.every((u) => u && u.status !== 'disabled') ? found.map((u) => u!.id) : undefined;
    }
    // Tệp không đính kèm được bằng giọng nói, và số văn bản do máy chủ cấp: trợ lý không điền hai loại ô này.
    case 'file':
    case 'autonumber':
      return undefined;
  }
}

/** `inputs` của tool là cặp khoá và chuỗi (schema strict không cho object tự do): đổi về đúng kiểu ô của biểu mẫu khởi chạy. */
function coerceInputs(ctx: OrgContext, def: ProcessDefinition, pairs: { key: string; value: string }[], now: Date): Record<string, unknown> {
  const errors: FieldError[] = [];
  const fields = new Map(def.inputs.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const { key, value } of pairs) {
    const field = fields.get(key);
    if (!field) {
      errors.push({ path: `args.inputs.${quote(key, 40)}`, code: 'unknown_field' });
      continue;
    }
    const raw = value.normalize('NFC').trim();
    if (raw === '') continue;
    const v = coerceField(ctx, field, raw);
    if (v === undefined) errors.push({ path: `args.inputs.${field.key}`, code: 'invalid_type' });
    else out[field.key] = v;
  }
  for (const f of def.inputs) {
    // Ô số văn bản do máy chủ cấp lúc khởi chạy nên không bao giờ bắt buộc nhập.
    if (f.type === 'autonumber') continue;
    if (f.required && out[f.key] === undefined && !errors.some((e) => e.path === `args.inputs.${f.key}`)) errors.push({ path: `args.inputs.${f.key}`, code: f.type === 'file' ? 'file_needs_app' : 'required' });
  }
  // Ngày mốc của lượt chạy không được ở quá khứ (SPEC 13.3 điều 4).
  const target = def.targetField ? out[def.targetField] : undefined;
  if (def.targetField && typeof target === 'string' && target < toLocalDate(now, ctx.calendar)) errors.push({ path: `args.inputs.${def.targetField}`, code: 'date_in_past' });
  if (errors.length) throw invalid(errors);
  return out;
}

async function pendingExtensionStepIds(tx: Tx, stepIds: string[]): Promise<Set<string>> {
  if (stepIds.length === 0) return new Set();
  const rows = await tx
    .select({ stepRunId: schema.extensionRequests.stepRunId })
    .from(schema.extensionRequests)
    .where(and(inArray(schema.extensionRequests.stepRunId, stepIds), eq(schema.extensionRequests.state, 'pending')));
  return new Set(rows.map((r) => r.stepRunId));
}

const lateDaysOf = (ctx: OrgContext, step: StepRow, now: Date) => (step.dueAt && now > step.dueAt ? lateWorkingDays(step.dueAt, now, ctx.calendar) : 0);

export type SkippedNudge = { stepRunId: string; reason: ThrottleReason; nextAllowedAt: string | null };
export type CreateProposalsResult = {
  proposals: ProposalView[];
  /** việc bị quy tắc chống làm phiền chặn: không tạo đề xuất, trả lý do cho tool (SPEC 4.7) */
  skipped: SkippedNudge[];
};
export type CreateProposalsOptions = { source: ProposalSource; createdBy?: string; conversationId?: string };

type Draft = { payload: Record<string, unknown>; summary: string };

function draftOf(ctx: OrgContext, stored: StoredPayload): Draft {
  return { payload: stored.data, summary: renderProposal(describe(ctx, stored, true).facts).summary };
}

/**
 * Tạo đề xuất từ một lời gọi tool. Kiểm Zod rồi kiểm thực thể (id tồn tại, thuộc tổ chức nhờ RLS, nằm trong
 * tầm nhìn của `forViewer`, ngày không ở quá khứ); lỗi thì ném ApiError có `code` và KHÔNG tạo dòng nào.
 * `summary` dựng bằng mẫu cố định; `risk` lấy từ PROPOSAL_RISK; hết hạn sau 10 phút.
 * `save_note` (mức 0): máy chủ tự xác nhận ngay và ghi chú vào lượt chạy.
 */
export async function createProposals(
  tx: Tx,
  ctx: OrgContext,
  forViewer: Viewer,
  tool: string,
  rawArgs: unknown,
  opts: CreateProposalsOptions,
): Promise<CreateProposalsResult> {
  if (!isProposalTool(tool)) throw invalid([{ path: 'tool', code: 'unknown_tool' }]);
  if (opts.source === 'office' && (tool === 'save_note' || tool === 'propose_cancel_run' || tool === 'propose_create_process' || tool === 'propose_publish_process' || tool === 'propose_assign_task')) {
    throw invalid([{ path: 'tool', code: 'tool_not_allowed' }]);
  }
  const forUser = ctx.users.get(forViewer.id);
  if (!forUser || forUser.status === 'disabled') throw new ApiError('forbidden');
  if (opts.conversationId) {
    const [conv] = await tx.select({ userId: schema.conversations.userId }).from(schema.conversations).where(eq(schema.conversations.id, opts.conversationId));
    if (!conv || conv.userId !== forViewer.id) throw invalid([{ path: 'conversationId', code: 'unknown_conversation' }]);
  }

  const now = clock.now();
  const drafts: Draft[] = [];
  const skipped: SkippedNudge[] = [];
  let batchId: string | null = null;

  switch (tool) {
    case 'save_note': {
      const args = parseToolArgs(TOOLS.save_note.args, rawArgs);
      const run = args.runId ? await findVisibleRun(tx, ctx, forViewer, args.runId) : null;
      drafts.push(draftOf(ctx, { tool: 'save_note', data: { text: args.text, ...(run ? { runId: run.id } : {}), display: { runTitle: run?.title ?? null } } }));
      break;
    }
    case 'propose_nudge': {
      const args = parseToolArgs(TOOLS.propose_nudge.args, rawArgs);
      const stepIds = [...new Set(args.stepRunIds)];
      // Kiểm mọi id trước; một id sai thì cả lời gọi lỗi và không có đề xuất nào được tạo.
      const found: { step: StepRow; run: RunRow }[] = [];
      for (const id of stepIds) found.push(await findVisibleStep(tx, ctx, forViewer, id));
      if (!can(forViewer, 'nudge.send')) throw new ApiError('forbidden');
      const pendingExt = await pendingExtensionStepIds(tx, stepIds);
      for (const { step, run } of found) {
        const t = checkNudgeThrottle(ctx, step, run, pendingExt.has(step.id), now, { allowNotOverdue: args.named === true });
        if (t.throttled || !step.assigneeId) {
          skipped.push({ stepRunId: step.id, reason: t.reason ?? 'not_open', nextAllowedAt: iso(t.nextAllowedAt) });
          continue;
        }
        // Lời nhắc soạn theo ma trận xưng hô của tổ chức (SPEC 4.7), không lấy chữ của LLM.
        const { message, relation, lateDays } = composeNudge(ctx, forViewer.id, step, now, args.tone);
        drafts.push(
          draftOf(ctx, {
            tool: 'propose_nudge',
            data: {
              stepRunId: step.id,
              toUserId: step.assigneeId,
              message,
              tone: relation,
              ...(args.named === true ? { named: true } : {}),
              display: { stepTitle: step.title, runTitle: run.title, runId: run.id, lateWorkingDays: lateDays, overdue: !!step.dueAt && now > step.dueAt },
            },
          }),
        );
      }
      if (drafts.length > 0) batchId = newId(now.getTime());
      break;
    }
    case 'propose_start_run': {
      const args = parseToolArgs(TOOLS.propose_start_run.args, rawArgs);
      const { template, version } = await latestPublishedVersion(tx, args.templateId);
      if (template.archivedAt) throw new ApiError('state_conflict', { currentState: 'archived' });
      if (!version) throw new ApiError('template_invalid');
      const def = await loadDefinition(tx, version.id);
      // Ai được khởi chạy do chính quy trình quy định (docs/DECISIONS.md, 06/10/2026).
      if (!canStartRun(def, forViewer.id, ctx.resolve)) throw new ApiError('forbidden');
      const inputs = coerceInputs(ctx, def, args.inputs, now);
      let sim: ReturnType<typeof simulate>;
      try {
        sim = simulate({ def, inputs, initiatorId: forViewer.id, ctx: ctx.resolve, now, templateId: template.id });
      } catch (err) {
        mapEngineError(err);
      }
      drafts.push(
        draftOf(ctx, {
          tool: 'propose_start_run',
          data: {
            templateId: template.id,
            title: args.title.normalize('NFC').trim(),
            inputs,
            display: { templateName: template.name, preview: sim.rows, targetAt: sim.targetAt },
          },
        }),
      );
      break;
    }
    case 'propose_reassign': {
      const args = parseToolArgs(TOOLS.propose_reassign.args, rawArgs);
      const { step, run } = await findVisibleStep(tx, ctx, forViewer, args.stepRunId);
      const toUser = ctx.users.get(args.toUserId);
      if (!toUser) throw new ApiError('not_found');
      if (run.state !== 'running' || !isOpenStep(step.state)) throw new ApiError('state_conflict', { currentState: run.state !== 'running' ? run.state : step.state });
      if (!allowedActions(ctx, forViewer, step, run, [], false).includes('reassign')) throw new ApiError('forbidden');
      if (toUser.status === 'disabled') throw invalid([{ path: 'args.toUserId', code: 'user_inactive' }]);
      if (step.assigneeId === toUser.id) throw invalid([{ path: 'args.toUserId', code: 'same_assignee' }]);
      // Việc trong quy trình chỉ về người được bổ nhiệm hoặc người được ủy quyền (docs/DECISIONS.md, 05/10/2026).
      if (!(await canTakeStep(tx, ctx, run, step.id, toUser.id))) throw invalid([{ path: 'args.toUserId', code: 'not_appointed' }]);
      drafts.push(
        draftOf(ctx, {
          tool: 'propose_reassign',
          data: {
            stepRunId: step.id,
            toUserId: toUser.id,
            reason: args.reason,
            display: { stepTitle: step.title, runTitle: run.title, runId: run.id, fromUserId: step.assigneeId, lateWorkingDays: lateDaysOf(ctx, step, now) },
          },
        }),
      );
      break;
    }
    case 'propose_extend_due': {
      const args = parseToolArgs(TOOLS.propose_extend_due.args, rawArgs);
      const { step, run } = await findVisibleStep(tx, ctx, forViewer, args.stepRunId);
      if (run.state !== 'running' || !isOpenStep(step.state)) throw new ApiError('state_conflict', { currentState: run.state !== 'running' ? run.state : step.state });
      if (!allowedActions(ctx, forViewer, step, run, [], false).includes('extend')) throw new ApiError('forbidden');
      if (!isRealLocalDate(args.newDue)) throw invalid([{ path: 'args.newDue', code: 'invalid_date' }]);
      // `newDue` là ngày lịch; hạn mới là hết giờ làm việc của ngày đó (SPEC 4.5).
      const newDueAt = endOfWorkday(args.newDue, ctx.calendar);
      if (newDueAt <= now) throw invalid([{ path: 'args.newDue', code: 'date_in_past' }]);
      if (step.dueAt && step.dueAt.getTime() === newDueAt.getTime()) throw invalid([{ path: 'args.newDue', code: 'same_due' }]);
      drafts.push(
        draftOf(ctx, {
          tool: 'propose_extend_due',
          data: {
            stepRunId: step.id,
            newDue: newDueAt.toISOString(),
            reason: args.reason,
            display: {
              stepTitle: step.title,
              runTitle: run.title,
              runId: run.id,
              assigneeId: step.assigneeId,
              currentDueAt: iso(step.dueAt),
              lateWorkingDays: lateDaysOf(ctx, step, now),
            },
          },
        }),
      );
      break;
    }
    case 'propose_cancel_run': {
      const args = parseToolArgs(TOOLS.propose_cancel_run.args, rawArgs);
      const run = await findVisibleRun(tx, ctx, forViewer, args.runId);
      if (!can(forViewer, 'run.cancel')) throw new ApiError('forbidden');
      if (run.state !== 'running') throw new ApiError('state_conflict', { currentState: run.state });
      const [{ open } = { open: 0 }] = await tx
        .select({ open: sql<number>`count(*)::int` })
        .from(schema.stepRuns)
        .where(and(eq(schema.stepRuns.runId, run.id), inArray(schema.stepRuns.kind, ['task', 'approval']), inArray(schema.stepRuns.state, ['pending', 'unassigned', 'ready', 'in_progress'])));
      drafts.push(draftOf(ctx, { tool: 'propose_cancel_run', data: { runId: run.id, reason: args.reason, display: { runTitle: run.title, openSteps: open } } }));
      break;
    }
    case 'propose_assign_task': {
      const args = parseToolArgs(TOOLS.propose_assign_task.args, rawArgs);
      if (!can(forViewer, 'task.assign')) throw new ApiError('forbidden');
      const task = checkTask(ctx, forViewer, args, 'args');
      const row = previewTask(ctx, forViewer, task);
      drafts.push(
        draftOf(ctx, {
          tool: 'propose_assign_task',
          data: {
            title: task.title,
            ...(task.description ? { description: task.description } : {}),
            assigneeId: task.assigneeId,
            dueDate: task.dueDate,
            display: { dueAt: row.dueAt, pastDue: row.pastDue },
          },
        }),
      );
      break;
    }
    case 'propose_create_process': {
      const args = parseToolArgs(TOOLS.propose_create_process.args, rawArgs);
      if (!can(forViewer, 'template.edit')) throw new ApiError('forbidden');
      const analysis = analyzeDraft(ctx, args);
      const problems = [...analysis.problems];
      if (analysis.name !== '' && (await nameTaken(tx, analysis.name))) problems.push({ step: null, field: 'name', code: 'name_taken' });
      if (problems.length > 0) throw invalid(problemErrors(problems));
      const issues = definitionIssues(ctx, definitionOf(analysis));
      if (issues.length > 0) throw new ApiError('template_invalid', { errors: issues.map((i) => ({ path: i.nodeId ?? i.edgeId ?? 'definition', code: i.code })) });
      const description = args.description?.normalize('NFC').trim();
      drafts.push(draftOf(ctx, { tool: 'propose_create_process', data: { name: analysis.name, ...(description ? { description } : {}), steps: analysis.steps } }));
      break;
    }
    case 'propose_publish_process': {
      const args = parseToolArgs(TOOLS.propose_publish_process.args, rawArgs);
      if (!can(forViewer, 'template.publish')) throw new ApiError('forbidden');
      // Kiểm đúng các điều kiện của lúc xuất bản thật, để báo lỗi ngay thay vì để người dùng bấm Đồng ý rồi mới thấy thất bại.
      const target = await previewPublish(tx, ctx, args.templateId);
      let run: { title: string; inputs: Record<string, unknown> } | undefined;
      let sim: ReturnType<typeof simulate> | null = null;
      if (args.startRun) {
        if (!canStartRun(target.definition, forViewer.id, ctx.resolve)) throw new ApiError('forbidden');
        const inputs = coerceInputs(ctx, target.definition, args.startRun.inputs ?? [], now);
        try {
          sim = simulate({ def: target.definition, inputs, initiatorId: forViewer.id, ctx: ctx.resolve, now, templateId: args.templateId });
        } catch (err) {
          mapEngineError(err);
        }
        run = { title: args.startRun.title.normalize('NFC').trim(), inputs };
      }
      drafts.push(
        draftOf(ctx, {
          tool: 'propose_publish_process',
          data: {
            templateId: args.templateId,
            ...(run ? { startRun: run } : {}),
            display: { templateName: target.templateName, version: target.version, preview: sim?.rows ?? null, targetAt: sim?.targetAt ?? null },
          },
        }),
      );
      break;
    }
  }

  const risk = PROPOSAL_RISK[tool];
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  const rows: ProposalRow[] = [];
  for (const d of drafts) {
    const [row] = await tx
      .insert(schema.proposals)
      .values({
        id: newId(now.getTime()),
        orgId: ctx.orgId,
        conversationId: opts.conversationId ?? null,
        forUserId: forViewer.id,
        batchId,
        tool,
        payload: d.payload,
        summary: d.summary,
        risk,
        source: opts.source,
        createdBy: opts.source === 'office' ? (opts.createdBy ?? null) : null,
        state: 'pending',
        // Hạn 10 phút [MỤC TIÊU, SPEC 6.5 điều 6]. [GIẢ ĐỊNH] áp cả cho đề xuất do Văn phòng trình vì SPEC 10.6 không nêu
        // hạn riêng; với "Trình" mười phút có thể quá ngắn (Chủ tịch chưa kịp mở app), chờ Mike quyết.
        expiresAt,
        createdAt: now,
      })
      .returning();
    await audit(tx, {
      orgId: ctx.orgId,
      action: 'proposal_created',
      actorType: opts.source === 'ai' ? 'ai_service' : 'user',
      actorUserId: opts.source === 'ai' ? forViewer.id : (opts.createdBy ?? null),
      targetType: 'proposal',
      targetId: row!.id,
      detail: { tool, risk, source: opts.source, batchId, forUserId: forViewer.id, conversationId: opts.conversationId ?? null },
    });
    rows.push(risk === 0 ? await autoConfirm(tx, ctx, forViewer, row!) : row!);
    await notifyProposal(tx, ctx.orgId, row!.id, forViewer.id);
  }
  return { proposals: rows.map((r) => proposalView(ctx, r, now)), skipped };
}

/** Mức 0 (ghi chép): máy chủ tự xác nhận ngay và thực hiện luôn; vẫn có dòng proposals để lưu vết (SPEC 6.5). */
async function autoConfirm(tx: Tx, ctx: OrgContext, viewer: Viewer, row: ProposalRow): Promise<ProposalRow> {
  const now = clock.now();
  const data = Stored.save_note.parse(row.payload);
  const eventId = deterministicId(`proposal:${row.id}`);
  if (data.runId) {
    await addRunNote(tx, ctx, viewer, data.runId, data.text, eventId, { type: 'ai', userId: viewer.id, proposalId: row.id });
  }
  const [updated] = await tx
    .update(schema.proposals)
    .set({
      state: 'confirmed',
      confirmedBy: viewer.id,
      confirmedAt: now,
      confirmedVia: 'auto',
      effectiveAt: now,
      result: { applied: true, at: now.toISOString(), runId: data.runId ?? null, eventId: data.runId ? eventId : null },
    })
    .where(eq(schema.proposals.id, row.id))
    .returning();
  await audit(tx, { orgId: ctx.orgId, action: 'proposal_confirmed', actorType: 'system', actorUserId: viewer.id, targetType: 'proposal', targetId: row.id, detail: { via: 'auto', risk: 0, tool: row.tool } });
  await audit(tx, { orgId: ctx.orgId, action: 'proposal_applied', actorType: 'system', actorUserId: viewer.id, targetType: 'proposal', targetId: row.id, detail: { tool: row.tool, runId: data.runId ?? null } });
  return updated!;
}

/**
 * "Trình" từ Văn phòng (Giai đoạn 3, SPEC 7.7): cùng kiểm tra và cùng cổng xác nhận như đề xuất của AI,
 * chỉ khác `source = 'office'` và `created_by`. Người nhận thấy thông báo `proposal.office`.
 */
export async function createOfficeProposals(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: { forUserId: string; tool: 'propose_nudge' | 'propose_start_run' | 'propose_reassign' | 'propose_extend_due'; payload: Record<string, unknown> },
): Promise<ProposalView[]> {
  if (!can(viewer, 'proposal.create_office')) throw new ApiError('forbidden');
  const forViewer = viewerForUser(ctx, body.forUserId);
  if (!forViewer) throw new ApiError('not_found');
  // Chỉ trình lên người điều hành (app Chủ tịch là nơi duy nhất có màn xác nhận).
  if (!isExecutive(forViewer.roles)) throw invalid([{ path: 'body.forUserId', code: 'not_executive' }]);
  const { proposals, skipped } = await createProposals(tx, ctx, forViewer, body.tool, body.payload, { source: 'office', createdBy: viewer.id });
  if (proposals.length === 0) {
    const first = skipped[0];
    throw new ApiError('nudge_throttled', { nextAllowedAt: first?.nextAllowedAt ?? undefined, errors: skipped.map((s) => ({ path: s.stepRunId, code: s.reason })) });
  }
  const first = proposals[0]!;
  // Đẩy "Văn phòng có 1 đề xuất xin Chủ tịch xem" tới thiết bị, mở tới M3 (SPEC 10.9).
  await createSystemNotification(tx, ctx, {
    id: deterministicId(`proposal-office:${first.batchId ?? first.id}`),
    userId: forViewer.id,
    push: true,
    kind: 'proposal.office',
    vars: { n: proposals.length },
    payload: { type: 'proposal.office', proposalId: first.id, batchId: first.batchId, count: proposals.length, link: `${env.appScheme}://proposal/${first.id}` },
  });
  return proposals;
}

// ───────────────────────── Xem ─────────────────────────

export async function listProposals(tx: Tx, ctx: OrgContext, viewer: Viewer, q: { state?: ProposalState; batchId?: string; limit?: number }): Promise<ProposalView[]> {
  const now = clock.now();
  const p = schema.proposals;
  const conds: SQL[] = [eq(p.forUserId, viewer.id)];
  if (q.batchId) conds.push(eq(p.batchId, q.batchId));
  if (q.state === 'pending') conds.push(eq(p.state, 'pending'), gt(p.expiresAt, now));
  else if (q.state === 'expired') conds.push(or(eq(p.state, 'expired'), and(eq(p.state, 'pending'), lte(p.expiresAt, now)))!);
  else if (q.state) conds.push(eq(p.state, q.state));
  const rows = await tx
    .select()
    .from(p)
    .where(and(...conds))
    .orderBy(desc(p.createdAt), desc(p.id))
    .limit(q.limit ?? 50);
  return rows.map((r) => proposalView(ctx, r, now));
}

/** Chỉ người phải xác nhận, hoặc người soạn khi `source = 'office'`. Người khác: 404, không lộ là có tồn tại. */
export async function getProposal(tx: Tx, ctx: OrgContext, viewer: Viewer, proposalId: string): Promise<ProposalView> {
  const [row] = await tx.select().from(schema.proposals).where(eq(schema.proposals.id, proposalId));
  if (!row) throw new ApiError('not_found');
  const mine = row.forUserId === viewer.id || (row.source === 'office' && row.createdBy === viewer.id);
  if (!mine) throw new ApiError('not_found');
  return proposalView(ctx, row);
}

/** Khoá hàng đề xuất của chính người gọi. Người soạn (Văn phòng) thấy được nhưng không thao tác được: 403. */
async function lockOwn(tx: Tx, viewer: Viewer, proposalId: string): Promise<ProposalRow> {
  const [row] = await tx.select().from(schema.proposals).where(eq(schema.proposals.id, proposalId)).for('update');
  if (!row) throw new ApiError('not_found');
  if (row.forUserId !== viewer.id) throw new ApiError(row.source === 'office' && row.createdBy === viewer.id ? 'forbidden' : 'not_found');
  return row;
}

// ───────────────────────── Kiểm lại quyền và trạng thái (SPEC 6.5 điều 5) ─────────────────────────

/**
 * Kiểm lại quyền HIỆN TẠI của người xác nhận và trạng thái HIỆN TẠI của việc. Trả mã lý do khi đề xuất không còn
 * làm được, null khi vẫn làm được. Gọi hai lần: lúc xác nhận và lúc worker áp (việc có thể đổi trong 30 giây).
 * Mã lý do chỉ là mã, không chứa tên người hay tên việc (CLAUDE.md luật 6).
 */
async function staleReason(tx: Tx, ctx: OrgContext, actor: Viewer | null, row: ProposalRow, now: Date): Promise<string | null> {
  if (!actor) return 'user_inactive';
  let p: StoredPayload;
  try {
    p = readStored(row);
  } catch {
    return 'payload_invalid';
  }
  const visibleStep = async (stepId: string) => {
    try {
      return await findVisibleStep(tx, ctx, actor, stepId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') return null;
      throw err;
    }
  };
  switch (p.tool) {
    case 'save_note':
      return null;
    case 'propose_nudge': {
      if (!can(actor, 'nudge.send')) return 'forbidden';
      const found = await visibleStep(p.data.stepRunId);
      if (!found) return 'not_found';
      const { step, run } = found;
      const pendingExt = await pendingExtensionStepIds(tx, [step.id]);
      const t = checkNudgeThrottle(ctx, step, run, pendingExt.has(step.id), now, { allowNotOverdue: p.data.named === true });
      if (t.throttled && t.reason === 'not_open') return 'step_not_open';
      // Lời nhắc soạn cho người cũ không được gửi cho người mới.
      if (step.assigneeId !== p.data.toUserId) return 'assignee_changed';
      return t.throttled ? (t.reason ?? 'nudge_throttled') : null;
    }
    case 'propose_start_run': {
      const [tpl] = await tx.select().from(schema.processTemplates).where(eq(schema.processTemplates.id, p.data.templateId));
      if (!tpl) return 'not_found';
      if (tpl.archivedAt) return 'template_archived';
      const { version } = await latestPublishedVersion(tx, tpl.id);
      if (!version) return 'template_invalid';
      return canStartRun(await loadDefinition(tx, version.id), actor.id, ctx.resolve) ? null : 'forbidden';
    }
    case 'propose_reassign': {
      const found = await visibleStep(p.data.stepRunId);
      if (!found) return 'not_found';
      const { step, run } = found;
      if (run.state !== 'running' || !isOpenStep(step.state)) return 'step_not_open';
      if (!allowedActions(ctx, actor, step, run, [], false).includes('reassign')) return 'forbidden';
      const to = ctx.users.get(p.data.toUserId);
      if (!to || to.status === 'disabled') return 'assignee_unavailable';
      if (step.assigneeId === to.id) return 'same_assignee';
      return (await canTakeStep(tx, ctx, run, step.id, to.id)) ? null : 'not_appointed';
    }
    case 'propose_extend_due': {
      const found = await visibleStep(p.data.stepRunId);
      if (!found) return 'not_found';
      const { step, run } = found;
      if (run.state !== 'running' || !isOpenStep(step.state)) return 'step_not_open';
      if (!allowedActions(ctx, actor, step, run, [], false).includes('extend')) return 'forbidden';
      return new Date(p.data.newDue) <= now ? 'due_in_past' : null;
    }
    case 'propose_cancel_run': {
      if (!can(actor, 'run.cancel')) return 'forbidden';
      const [run] = await tx.select().from(schema.processRuns).where(eq(schema.processRuns.id, p.data.runId));
      if (!run) return 'not_found';
      return run.state === 'running' ? null : 'run_not_running';
    }
    case 'propose_assign_task': {
      if (!can(actor, 'task.assign')) return 'forbidden';
      const to = ctx.users.get(p.data.assigneeId);
      if (!to || to.status === 'disabled') return 'assignee_unavailable';
      if (to.id === actor.id) return 'assignee_is_self';
      return p.data.dueDate < toLocalDate(now, ctx.calendar) ? 'due_in_past' : null;
    }
    case 'propose_create_process': {
      if (!can(actor, 'template.edit')) return 'forbidden';
      // Trong 10 phút chờ xác nhận, người khác có thể đã tạo quy trình trùng tên hoặc người trong bước đã nghỉ.
      if (await nameTaken(tx, p.data.name)) return 'name_taken';
      for (const s of p.data.steps) {
        if (s.assignee.kind !== 'person') continue;
        const user = ctx.users.get(s.assignee.userId);
        if (!user || user.status === 'disabled') return 'assignee_unavailable';
      }
      return null;
    }
    case 'propose_publish_process': {
      if (!can(actor, 'template.publish')) return 'forbidden';
      if (p.data.startRun && !can(actor, 'run.start')) return 'forbidden';
      try {
        await previewPublish(tx, ctx, p.data.templateId);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.code === 'not_found') return 'not_found';
        if (err.code === 'template_invalid') return 'template_invalid';
        return err.extra.currentState === 'archived' ? 'template_archived' : 'template_not_draft';
      }
      return null;
    }
  }
}

async function failProposal(tx: Tx, ctx: OrgContext, row: ProposalRow, reason: string, stage: 'confirm' | 'apply'): Promise<void> {
  const now = clock.now();
  await tx
    .update(schema.proposals)
    .set({ state: 'failed', result: { reason, stage, at: now.toISOString() } })
    .where(eq(schema.proposals.id, row.id));
  // Lúc xác nhận thì người dùng thấy ngay ở màn hình; lúc worker áp thì họ đã rời màn hình nên cần một tin (SPEC 10.6 bước 6).
  if (stage === 'apply' && row.confirmedBy) {
    // Đẩy "Có 1 việc trợ lý chưa làm được" tới thiết bị; app mở M3 và hiện lý do (SPEC 10.9).
    await createSystemNotification(tx, ctx, {
      id: deterministicId(`proposal-failed:${row.id}`),
      userId: row.confirmedBy,
      push: true,
      kind: 'proposal.failed',
      vars: { n: 1 },
      payload: { type: 'proposal.failed', proposalId: row.id, reason, link: `${env.appScheme}://proposal/${row.id}` },
    });
  }
  await audit(tx, {
    orgId: ctx.orgId,
    action: 'proposal_failed',
    actorType: 'system',
    actorUserId: row.confirmedBy ?? row.forUserId,
    targetType: 'proposal',
    targetId: row.id,
    detail: { reason, stage, tool: row.tool },
  });
  await notifyProposal(tx, ctx.orgId, row.id, row.forUserId);
}

/** Thời gian chờ tối đa để lấy kết nối thứ hai cho việc dọn; quá thì bỏ qua, không bao giờ treo yêu cầu. */
const SETTLE_TIMEOUT_MS = 3_000;

/**
 * Dọn các đề xuất không còn xác nhận được TRƯỚC khi giao dịch xác nhận khoá hàng: hết hạn thì sang `expired`,
 * việc hoặc quyền đã đổi thì sang `failed` kèm lý do (SPEC 6.5 điều 5 và 6).
 *
 * Vì sao cần giao dịch riêng: yêu cầu xác nhận sau đó trả lỗi (410, 409) nên giao dịch của nó bị hoàn lại; ghi chung
 * thì trạng thái `expired`, `failed` sẽ mất theo. Hàm này kiểm trước bằng giao dịch của yêu cầu (chỉ đọc, không khoá);
 * chỉ khi có việc phải dọn mới mở một giao dịch thứ hai và commit ngay. Đường xác nhận bình thường không tốn thêm kết nối.
 *
 * Lấy kết nối thứ hai trong lúc đang giữ kết nối thứ nhất có thể làm cạn pool khi nhiều yêu cầu cùng làm vậy, nên việc dọn
 * có giới hạn thời gian: quá hạn thì bỏ qua. Bỏ qua vẫn an toàn: đề xuất hết hạn vẫn bị từ chối 410 và việc định kỳ sẽ
 * chuyển trạng thái; đề xuất đã cũ vẫn bị worker kiểm lại lúc áp và chuyển `failed`.
 */
async function settleBeforeConfirm(tx: Tx, ctx: OrgContext, viewer: Viewer, selector: SQL): Promise<void> {
  const p = schema.proposals;
  const mine = and(selector, eq(p.forUserId, viewer.id), eq(p.state, 'pending'));
  const now = clock.now();
  let needed = false;
  for (const row of await tx.select().from(p).where(mine)) {
    if (row.expiresAt <= now || (await staleReason(tx, ctx, viewerForUser(ctx, row.forUserId), row, now)) !== null) {
      needed = true;
      break;
    }
  }
  if (!needed) return;

  const work = withOrg(ctx.orgId, async (own) => {
    // Kiểm lại dưới khoá hàng: giữa hai lần đọc, một yêu cầu khác có thể đã xác nhận hoặc đã dọn.
    const rows = await own.select().from(p).where(mine).orderBy(p.id).for('update');
    for (const row of rows) {
      if (row.expiresAt <= now) {
        await own.update(p).set({ state: 'expired' }).where(eq(p.id, row.id));
        await notifyProposal(own, ctx.orgId, row.id, row.forUserId);
        continue;
      }
      const reason = await staleReason(own, ctx, viewerForUser(ctx, row.forUserId), row, now);
      if (reason) await failProposal(own, ctx, row, reason, 'confirm');
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SETTLE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
    // Hết thời gian chờ: để việc dọn tự chạy xong khi có kết nối, không chặn yêu cầu này.
    if (outcome === 'timeout') work.catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── Xác nhận (bước 2 và 3) ─────────────────────────

export type ConfirmBody = {
  via: 'touch' | 'voice';
  transcript?: string;
  sttConfidence?: number;
  editedMessages?: Record<string, string>;
  dropProposalIds?: string[];
};
export type ConfirmOptions = { stepUpToken?: string; meta?: RequestMeta };
export type ConfirmResult = { state: 'confirmed' | 'rejected'; effectiveAt: string | null; undoUntil: string | null; proposalIds: string[] };

const reasonOf = (row: ProposalRow): string => {
  const r = (row.result as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? r : 'unknown';
};

async function markRejected(tx: Tx, ctx: OrgContext, viewer: Viewer, row: ProposalRow, why: 'touch' | 'voice' | 'dropped', extra: { note?: string; transcript?: string; sttConfidence?: number; meta?: RequestMeta } = {}): Promise<void> {
  await tx
    .update(schema.proposals)
    .set({
      state: 'rejected',
      result: extra.note ? { rejectNote: extra.note } : null,
      transcript: extra.transcript ?? null,
      sttConfidence: extra.sttConfidence ?? null,
    })
    .where(eq(schema.proposals.id, row.id));
  await audit(tx, {
    orgId: ctx.orgId,
    action: 'proposal_rejected',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'proposal',
    targetId: row.id,
    ip: extra.meta?.ip,
    userAgent: extra.meta?.userAgent,
    detail: { via: why, tool: row.tool, risk: row.risk },
  });
  await notifyProposal(tx, ctx.orgId, row.id, row.forUserId);
}

/** Phần cài đặt chung của xác nhận một đề xuất và xác nhận cả lô. `rows` đã được khoá và đều của `viewer`. */
async function confirmRows(tx: Tx, ctx: OrgContext, viewer: Viewer, rows: ProposalRow[], body: ConfirmBody, opts: ConfirmOptions, mode: 'single' | 'batch'): Promise<ConfirmResult> {
  const now = clock.now();
  // Mức 2 phải chạm từng mục kèm mã nâng quyền: không bao giờ đi theo lô.
  if (mode === 'batch' && rows.some((r) => r.risk === 2)) throw new ApiError('batch_not_allowed');

  const pending = rows.filter((r) => r.state === 'pending' && r.expiresAt > now);
  if (pending.length === 0) {
    // Xác nhận lần hai: trả đúng kết quả cũ, không tạo thêm effect (SPEC 6.5 điều 6).
    const confirmed = rows.filter((r) => r.state === 'confirmed');
    if (confirmed.length > 0) {
      const eff = confirmed.reduce<Date | null>((m, r) => (r.effectiveAt && (!m || r.effectiveAt > m) ? r.effectiveAt : m), null);
      return { state: 'confirmed', effectiveAt: iso(eff), undoUntil: iso(eff), proposalIds: confirmed.map((r) => r.id) };
    }
    if (rows.some((r) => r.state === 'expired' || r.state === 'pending')) throw new ApiError('proposal_expired');
    const failed = rows.find((r) => r.state === 'failed');
    throw new ApiError('proposal_not_pending', { currentState: (failed ?? rows[0]!).state, ...(failed ? { errors: [{ path: 'proposal', code: reasonOf(failed) }] } : {}) });
  }

  if (body.via === 'voice') {
    // Giọng nói chỉ dành cho mức 1 (SPEC 6.5 điều 10); máy chủ tự kiểm lại tập câu đóng và độ tin cậy, không tin app.
    if (pending.some((r) => r.risk !== 1)) throw invalid([{ path: 'body.via', code: 'voice_not_allowed' }]);
    if (body.sttConfidence === undefined || body.sttConfidence < env.voiceConfirmMinConfidence) throw invalid([{ path: 'body.sttConfidence', code: 'below_threshold' }]);
    const verdict = matchVoiceConfirm(body.transcript ?? '');
    if (verdict === null) throw invalid([{ path: 'body.transcript', code: 'not_in_closed_set' }]);
    if (verdict === 'reject') {
      for (const row of pending) await markRejected(tx, ctx, viewer, row, 'voice', { transcript: body.transcript, sttConfidence: body.sttConfidence, meta: opts.meta });
      return { state: 'rejected', effectiveAt: null, undoUntil: null, proposalIds: pending.map((r) => r.id) };
    }
  }

  if (pending.some((r) => r.risk === 2)) await requireStepUp(viewer, opts.stepUpToken);

  // `dropProposalIds` và `editedMessages` phải trỏ vào đề xuất của chính lô này. Mục không còn `pending`
  // (vừa hết hạn hoặc vừa bị dọn sang `failed`) thì bỏ qua, để các mục còn lại vẫn xác nhận được.
  const known = new Set(rows.map((r) => r.id));
  const drop = new Set<string>();
  for (const id of body.dropProposalIds ?? []) {
    if (!known.has(id)) throw invalid([{ path: 'body.dropProposalIds', code: 'not_in_batch' }]);
    drop.add(id);
  }
  const edits = new Map<string, string>();
  for (const [id, message] of Object.entries(body.editedMessages ?? {})) {
    if (!known.has(id)) throw invalid([{ path: 'body.editedMessages', code: 'not_in_batch' }]);
    const row = pending.find((r) => r.id === id);
    if (!row) continue;
    // Chỉ lời nhắc mới sửa được; các loại đề xuất khác không có chữ nào do người xác nhận gõ.
    if (row.tool !== 'propose_nudge') throw invalid([{ path: 'body.editedMessages', code: 'not_editable' }]);
    const text = message.normalize('NFC').trim();
    if (text === '' || text.length > 1000) throw invalid([{ path: 'body.editedMessages', code: 'invalid_message' }]);
    edits.set(id, text);
  }

  const effectiveAt = new Date(now.getTime() + PROPOSAL_UNDO_WINDOW_MS);
  const confirmedIds: string[] = [];
  const droppedIds: string[] = [];
  for (const row of pending) {
    if (drop.has(row.id)) {
      await markRejected(tx, ctx, viewer, row, 'dropped', { meta: opts.meta });
      droppedIds.push(row.id);
      continue;
    }
    let payload = row.payload;
    let evidence: { original: string; edited: string } | null = null;
    const edited = edits.get(row.id);
    if (edited !== undefined) {
      const stored = Stored.propose_nudge.parse(row.payload);
      if (edited !== stored.message) {
        // Lời người xác nhận tự sửa ghi đè lời máy chủ soạn; giữ cả hai làm bằng chứng (SPEC 10.6).
        evidence = { original: stored.message, edited };
        payload = { ...stored, message: edited };
      }
    }
    await tx
      .update(schema.proposals)
      .set({
        state: 'confirmed',
        confirmedBy: viewer.id,
        confirmedAt: now,
        confirmedVia: body.via,
        effectiveAt,
        transcript: body.via === 'voice' ? (body.transcript ?? null) : null,
        sttConfidence: body.via === 'voice' ? (body.sttConfidence ?? null) : null,
        editedMessages: evidence,
        payload,
      })
      .where(eq(schema.proposals.id, row.id));
    // Đúng MỘT effect cho mỗi đề xuất: dedupe_key UNIQUE chặn mọi lần chèn thứ hai (SPEC 10.6 bước 3).
    await insertEffect(tx, ctx.orgId, { kind: 'proposal.apply', dedupeKey: `proposal:${row.id}`, payload: { proposalId: row.id }, nextAttemptAt: effectiveAt });
    await audit(tx, {
      orgId: ctx.orgId,
      action: 'proposal_confirmed',
      actorUserId: viewer.id,
      actorDeviceId: viewer.deviceId,
      targetType: 'proposal',
      targetId: row.id,
      ip: opts.meta?.ip,
      userAgent: opts.meta?.userAgent,
      detail: { via: body.via, risk: row.risk, tool: row.tool, batchId: row.batchId, edited: evidence !== null, sttConfidence: body.via === 'voice' ? body.sttConfidence : undefined },
    });
    await notifyProposal(tx, ctx.orgId, row.id, row.forUserId);
    confirmedIds.push(row.id);
  }
  if (confirmedIds.length === 0) return { state: 'rejected', effectiveAt: null, undoUntil: null, proposalIds: droppedIds };
  return { state: 'confirmed', effectiveAt: effectiveAt.toISOString(), undoUntil: effectiveAt.toISOString(), proposalIds: confirmedIds };
}

/**
 * `POST /v1/proposals/:id/confirm`. Chỉ đúng người `for_user_id`, bằng phiên đăng nhập của họ. Mức 2 bắt buộc
 * mã nâng quyền và không nhận giọng nói. Thành công: `confirmed`, một dòng `effects` hẹn sau 30 giây.
 */
export async function confirmProposal(tx: Tx, ctx: OrgContext, viewer: Viewer, proposalId: string, body: ConfirmBody, opts: ConfirmOptions = {}): Promise<ConfirmResult> {
  await settleBeforeConfirm(tx, ctx, viewer, eq(schema.proposals.id, proposalId));
  const row = await lockOwn(tx, viewer, proposalId);
  return confirmRows(tx, ctx, viewer, [row], { ...body, dropProposalIds: undefined }, opts, 'single');
}

/** `POST /v1/proposal-batches/:batchId/confirm`: xác nhận cả lô mức 1 một lần; dùng chung phần cài đặt với xác nhận một đề xuất. */
export async function confirmBatch(tx: Tx, ctx: OrgContext, viewer: Viewer, batchId: string, body: ConfirmBody, opts: ConfirmOptions = {}): Promise<ConfirmResult> {
  const p = schema.proposals;
  await settleBeforeConfirm(tx, ctx, viewer, eq(p.batchId, batchId));
  const rows = await tx
    .select()
    .from(p)
    .where(and(eq(p.batchId, batchId), eq(p.forUserId, viewer.id)))
    .orderBy(p.id)
    .for('update');
  if (rows.length === 0) throw new ApiError('not_found');
  return confirmRows(tx, ctx, viewer, rows, body, opts, 'batch');
}

export async function rejectProposal(tx: Tx, ctx: OrgContext, viewer: Viewer, proposalId: string, body: { reason?: string } = {}, opts: { meta?: RequestMeta } = {}): Promise<ProposalView> {
  const row = await lockOwn(tx, viewer, proposalId);
  if (row.state !== 'rejected') {
    if (row.state !== 'pending') throw new ApiError('proposal_not_pending', { currentState: row.state });
    await markRejected(tx, ctx, viewer, row, 'touch', { note: body.reason?.trim() || undefined, meta: opts.meta });
  }
  return getProposal(tx, ctx, viewer, proposalId);
}

/**
 * Hoàn tác trong cửa 30 giây: xoá dòng effect nếu còn `pending`. Xoá được thì `undone`; không xoá được dòng nào
 * nghĩa là worker đã lấy việc: 409 undo_window_closed (SPEC 10.6 bước 4).
 */
export async function undoProposal(tx: Tx, ctx: OrgContext, viewer: Viewer, proposalId: string, opts: { meta?: RequestMeta } = {}): Promise<ProposalView> {
  const row = await lockOwn(tx, viewer, proposalId);
  if (row.state === 'undone') return proposalView(ctx, row);
  if (row.state === 'pending' || row.state === 'rejected' || row.state === 'expired') throw new ApiError('state_conflict', { currentState: row.state });
  if (row.state !== 'confirmed' || row.result !== null) throw new ApiError('undo_window_closed');
  const deleted = await tx
    .delete(schema.effects)
    .where(and(eq(schema.effects.dedupeKey, `proposal:${row.id}`), eq(schema.effects.state, 'pending')))
    .returning({ id: schema.effects.id });
  if (deleted.length === 0) throw new ApiError('undo_window_closed');
  await tx.update(schema.proposals).set({ state: 'undone' }).where(eq(schema.proposals.id, row.id));
  await audit(tx, { orgId: ctx.orgId, action: 'proposal_undone', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'proposal', targetId: row.id, ip: opts.meta?.ip, userAgent: opts.meta?.userAgent, detail: { tool: row.tool, risk: row.risk } });
  await notifyProposal(tx, ctx.orgId, row.id, row.forUserId);
  return getProposal(tx, ctx, viewer, proposalId);
}

/** Gửi ngay: bỏ phần còn lại của 30 giây. Mức 2 không có nút này (SPEC 6.5 điều 8). */
export async function sendNowProposal(tx: Tx, ctx: OrgContext, viewer: Viewer, proposalId: string, opts: { meta?: RequestMeta } = {}): Promise<ProposalView> {
  const row = await lockOwn(tx, viewer, proposalId);
  if (row.state !== 'confirmed') throw new ApiError('state_conflict', { currentState: row.state });
  if (row.risk === 2) throw new ApiError('state_conflict', { currentState: row.state, errors: [{ path: 'proposal', code: 'send_now_not_allowed' }] });
  if (row.result === null) {
    const now = clock.now();
    const moved = await tx
      .update(schema.effects)
      .set({ nextAttemptAt: now })
      .where(and(eq(schema.effects.dedupeKey, `proposal:${row.id}`), eq(schema.effects.state, 'pending')))
      .returning({ id: schema.effects.id });
    // Không còn dòng `pending` nghĩa là worker đã lấy việc: coi như đã gửi.
    if (moved.length > 0) {
      await tx.update(schema.proposals).set({ effectiveAt: now }).where(eq(schema.proposals.id, row.id));
      await audit(tx, { orgId: ctx.orgId, action: 'proposal_send_now', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'proposal', targetId: row.id, ip: opts.meta?.ip, userAgent: opts.meta?.userAgent, detail: { tool: row.tool } });
      await notifyProposal(tx, ctx.orgId, row.id, row.forUserId);
    }
  }
  return getProposal(tx, ctx, viewer, proposalId);
}

// ───────────────────────── Worker áp đề xuất (bước 5 và 6) ─────────────────────────

/** Gọi đúng sự kiện qua các hàm sẵn có; trả phần ghi vào `proposals.result` (chỉ id). */
async function execute(tx: Tx, ctx: OrgContext, viewer: Viewer, row: ProposalRow, p: StoredPayload): Promise<Record<string, unknown>> {
  // eventId tất định: worker chạy lại sau khi chết giữa chừng thì sự kiện vẫn chỉ có hiệu lực một lần.
  const eventId = deterministicId(`proposal:${row.id}`);
  const actor: EngineEvent['actor'] = { type: 'ai', userId: viewer.id, proposalId: row.id };
  switch (p.tool) {
    case 'save_note': {
      if (p.data.runId) await addRunNote(tx, ctx, viewer, p.data.runId, p.data.text, eventId, actor);
      return { runId: p.data.runId ?? null, eventId };
    }
    case 'propose_nudge': {
      const { nudgeId } = await sendOneNudge(tx, ctx, viewer, {
        stepId: p.data.stepRunId,
        message: p.data.message,
        eventId,
        aiDrafted: row.source === 'ai',
        actor,
        allowNotOverdue: p.data.named === true,
      });
      return { runId: p.data.display.runId, stepId: p.data.stepRunId, nudgeId, eventId };
    }
    case 'propose_start_run': {
      const run = await startRun(tx, ctx, viewer, { templateId: p.data.templateId, title: p.data.title, inputs: p.data.inputs }, eventId, actor);
      return { runId: run.id, eventId };
    }
    case 'propose_reassign': {
      await actOnStep(tx, ctx, viewer, p.data.stepRunId, eventId, { type: 'Reassign', toUserId: p.data.toUserId, reason: p.data.reason }, { actor });
      return { runId: p.data.display.runId, stepId: p.data.stepRunId, eventId };
    }
    case 'propose_extend_due': {
      await actOnStep(tx, ctx, viewer, p.data.stepRunId, eventId, { type: 'ExtendDue', newDueAt: p.data.newDue, reason: p.data.reason }, { actor });
      return { runId: p.data.display.runId, stepId: p.data.stepRunId, eventId };
    }
    case 'propose_cancel_run': {
      await findVisibleRun(tx, ctx, viewer, p.data.runId);
      await applyRunEvent(tx, ctx, p.data.runId, { type: 'CancelRun', eventId, at: clock.now().toISOString(), actor, reason: p.data.reason });
      return { runId: p.data.runId, eventId };
    }
    case 'propose_assign_task': {
      const res = await createAdhocTask(tx, ctx, viewer, { title: p.data.title, description: p.data.description, assigneeId: p.data.assigneeId, dueDate: p.data.dueDate }, eventId, actor);
      return { runId: res.run.id, stepId: res.step.id, eventId };
    }
    case 'propose_create_process': {
      // Chỉ tạo BẢN NHÁP: chưa xuất bản, chưa giao việc cho ai. Dựng lại từ các bước đã xác nhận, không từ chữ nào khác.
      const description = p.data.description ?? fmt(PROPOSAL_TEMPLATES.createProcess.defaultDescription, { ngày: formatDateFull(clock.now()) });
      const detail = await createTemplate(tx, ctx, viewer, { name: p.data.name, description, definition: definitionOf(p.data) });
      return { templateId: detail.id, name: p.data.name };
    }
    case 'propose_publish_process': {
      // Xuất bản rồi giao việc trong cùng một giao dịch con: giao việc lỗi thì xuất bản cũng được hoàn lại.
      const published = await publishTemplate(tx, ctx, viewer, p.data.templateId);
      if (!p.data.startRun) return { templateId: p.data.templateId, version: published.version };
      const run = await startRun(tx, ctx, viewer, { templateId: p.data.templateId, title: p.data.startRun.title, inputs: p.data.startRun.inputs }, eventId, actor);
      return { templateId: p.data.templateId, version: published.version, runId: run.id, eventId };
    }
  }
}

/**
 * Worker áp một đề xuất đã xác nhận (effect `proposal.apply`). Kiểm lại quyền và trạng thái một lần nữa, rồi gọi
 * `advance()` với actor `{ type: 'ai', userId: người xác nhận, proposalId }` để `run_events` mang `proposal_id`.
 * Thành công ghi `result`; không làm được thì `failed` kèm `result.reason` và báo người xác nhận.
 */
export async function applyProposal(tx: Tx, ctx: OrgContext, proposalId: string): Promise<EffectOutcome> {
  const [row] = await tx.select().from(schema.proposals).where(eq(schema.proposals.id, proposalId)).for('update');
  // Đã hoàn tác, đã áp, hoặc không còn: effect không còn việc gì để làm.
  if (!row || row.state !== 'confirmed' || row.result !== null) return { state: 'done' };
  const now = clock.now();
  const viewer = viewerForUser(ctx, row.confirmedBy);
  const stale = await staleReason(tx, ctx, viewer, row, now);
  if (stale || !viewer) {
    await failProposal(tx, ctx, row, stale ?? 'user_inactive', 'apply');
    return { state: 'done' };
  }
  let applied: Record<string, unknown>;
  try {
    // Savepoint: sự kiện lỗi giữa chừng không để lại dòng ghi dở trong giao dịch của worker.
    applied = await tx.transaction((sp) => execute(sp, ctx, viewer, row, readStored(row)));
  } catch (err) {
    // Lỗi nghiệp vụ (việc đã xong, đã đổi người, bị chặn làm phiền…): không thử lại, báo người xác nhận.
    // Lỗi khác (CSDL, lỗi mã) ném tiếp để hàng effect thử lại theo backoff.
    if (!(err instanceof ApiError) || err.status >= 500) throw err;
    await failProposal(tx, ctx, row, err.code, 'apply');
    return { state: 'done' };
  }
  await tx
    .update(schema.proposals)
    .set({ result: { applied: true, at: now.toISOString(), ...applied } })
    .where(eq(schema.proposals.id, row.id));
  await audit(tx, {
    orgId: ctx.orgId,
    action: 'proposal_applied',
    actorType: 'system',
    actorUserId: viewer.id,
    targetType: 'proposal',
    targetId: row.id,
    detail: { tool: row.tool, risk: row.risk, eventId: applied.eventId ?? null, runId: applied.runId ?? null, templateId: applied.templateId ?? null },
  });
  await notifyProposal(tx, ctx.orgId, row.id, row.forUserId);
  return { state: 'done' };
}

/** Handler của effect `proposal.apply` để đăng ký với worker. */
export const proposalApplyHandler: EffectHandler = (tx, ctx, effect) => {
  const proposalId = effect.payload.proposalId;
  if (typeof proposalId !== 'string') return Promise.resolve({ state: 'done' });
  return applyProposal(tx, ctx, proposalId);
};

// ───────────────────────── Việc định kỳ và dọn dẹp ─────────────────────────

/** Mỗi phút: đề xuất `pending` quá `expires_at` sang `expired` (SPEC 10.6 bước 7). Trả số dòng đã chuyển. */
export async function expireProposals(tx: Tx, ctx: OrgContext): Promise<number> {
  const p = schema.proposals;
  const rows = await tx
    .update(p)
    .set({ state: 'expired' })
    .where(and(eq(p.state, 'pending'), lte(p.expiresAt, clock.now())))
    .returning({ id: p.id, forUserId: p.forUserId });
  for (const r of rows) await notifyProposal(tx, ctx.orgId, r.id, r.forUserId);
  return rows.length;
}

/**
 * Nút "Xoá lịch sử hội thoại" ở M7: xoá `messages` của chính người gọi. Không xoá `run_events`, `audit_log`,
 * và giữ dòng `conversations`, `proposals` vì đó là dấu vết nghiệp vụ (SPEC 6.8, 10.6).
 */
export async function deleteMyConversations(tx: Tx, viewer: Viewer, opts: { meta?: RequestMeta } = {}): Promise<number> {
  const mine = tx.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.userId, viewer.id));
  const deleted = await tx.delete(schema.messages).where(inArray(schema.messages.conversationId, mine)).returning({ id: schema.messages.id });
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'conversations_deleted',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    ip: opts.meta?.ip,
    userAgent: opts.meta?.userAgent,
    detail: { messages: deleted.length },
  });
  return deleted.length;
}
