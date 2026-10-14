import {
  ADHOC_DUE_FIELD,
  ADHOC_TASK_NODE,
  ApiError,
  adhocDefinition,
  deterministicId,
  type AdhocLabels,
  type EngineEvent,
  type SimulationRow,
  type StepAssigneesResponse,
  type StepResult,
  type TaskCreate,
} from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { vi } from '@mihato/i18n';
import { appointedFor, simulate } from '@mihato/workflow-engine';
import { and, eq } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { createAndStartRun, isAdhocTemplate, loadRun, mapEngineError } from '../engine/runner';
import { buildRunSummaries, buildStepViews, type Viewer } from '../views';
import { searchPeople } from './org';
import { findVisibleStep } from './runs';

/**
 * Việc ngoài quy trình (docs/DECISIONS.md, 05/10/2026). Người giao (Chủ tịch, Giám đốc, Phó giám đốc, Văn phòng) giao một việc
 * bất kỳ cho bất kỳ ai còn hoạt động, không cần quy trình bao quanh. Để dùng lại nguyên engine (hạn, nhắc, đi thúc, báo cáo,
 * app nhân viên), mỗi việc là một lượt chạy của một mẫu một việc ẩn (`process_templates.kind = 'adhoc'`), dựng bằng hàm thuần
 * `adhocDefinition`. Mẫu ẩn khỏi mọi danh sách và API mẫu; ngược lại, việc là một `step_run` bình thường nên hiện ở "Việc của tôi",
 * được nhắc, bị đi thúc và tính vào báo cáo như mọi việc khác.
 */

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealLocalDate(v: string): boolean {
  const m = LOCAL_DATE.exec(v);
  if (!m) return false;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === v;
}

const labels = (): AdhocLabels => ({ start: vi.common.nodeKind.start, task: vi.common.nodeKind.task, end: vi.common.nodeKind.end, due: vi.server.adhoc.dueLabel });

/** Chữ do người nhập: chuẩn hoá NFC, bỏ khoảng trắng đầu cuối. Chữ rỗng thành undefined. */
const clean = (s: string | undefined): string | undefined => {
  const t = s?.normalize('NFC').trim();
  return t ? t : undefined;
};

export type CheckedTask = { title: string; description: string | undefined; assigneeId: string; dueDate: string };

/**
 * Kiểm một việc sắp giao. Ném `input_invalid` kèm mã từng ô; không ghi gì.
 * - người nhận phải còn hoạt động và không phải chính người giao (giao cho mình là ghi chú, không phải giao việc);
 * - ngày hạn là ngày lịch có thật, từ hôm nay trở đi (SPEC 13.3 điều 4).
 */
export function checkTask(ctx: OrgContext, viewer: Viewer, body: TaskCreate, pathPrefix = 'body'): CheckedTask {
  const errors: { path: string; code: string }[] = [];
  const title = clean(body.title);
  if (!title) errors.push({ path: `${pathPrefix}.title`, code: 'required' });
  const assignee = ctx.users.get(body.assigneeId);
  if (!assignee) errors.push({ path: `${pathPrefix}.assigneeId`, code: 'unknown_user' });
  else if (assignee.status === 'disabled') errors.push({ path: `${pathPrefix}.assigneeId`, code: 'user_inactive' });
  else if (assignee.id === viewer.id) errors.push({ path: `${pathPrefix}.assigneeId`, code: 'assignee_is_self' });
  if (!isRealLocalDate(body.dueDate)) errors.push({ path: `${pathPrefix}.dueDate`, code: 'invalid_date' });
  else if (body.dueDate < toLocalDate(clock.now(), ctx.calendar)) errors.push({ path: `${pathPrefix}.dueDate`, code: 'date_in_past' });
  if (errors.length > 0 || !title) throw new ApiError('input_invalid', { errors });
  return { title, description: clean(body.description), assigneeId: assignee!.id, dueDate: body.dueDate };
}

/** Hạn thật và cờ "đã qua" của việc sắp giao, tính bằng đúng `simulate()` mà lúc giao thật engine sẽ dùng. */
export function previewTask(ctx: OrgContext, viewer: Viewer, task: CheckedTask): SimulationRow {
  const def = adhocDefinition(task, labels());
  try {
    const sim = simulate({ def, inputs: { [ADHOC_DUE_FIELD]: task.dueDate }, initiatorId: viewer.id, ctx: ctx.resolve, now: clock.now() });
    const row = sim.rows.find((r) => r.nodeId === ADHOC_TASK_NODE);
    if (!row) throw new ApiError('internal_error');
    return row;
  } catch (err) {
    mapEngineError(err);
  }
}

/**
 * Giao việc: dựng mẫu một việc ẩn cùng bản xuất bản duy nhất, rồi khởi chạy. `eventId` là Idempotency-Key và cũng là gốc của id mẫu,
 * nên gửi lại bao nhiêu lần cũng chỉ ra đúng một việc. Trả bước vừa tạo và lượt chạy của nó.
 */
export async function createAdhocTask(
  tx: Tx,
  ctx: OrgContext,
  viewer: Viewer,
  body: TaskCreate,
  eventId: string,
  actor: EngineEvent['actor'] = { type: 'user', userId: viewer.id },
): Promise<StepResult> {
  const task = checkTask(ctx, viewer, body);
  const now = clock.now();
  const templateId = deterministicId(`adhoc-template:${eventId}`);
  const versionId = deterministicId(`adhoc-version:${eventId}`);
  const definition = adhocDefinition(task, labels());
  await tx
    .insert(schema.processTemplates)
    .values({ id: templateId, orgId: viewer.orgId, name: task.title, description: task.description ?? null, kind: 'adhoc', createdBy: viewer.id, createdAt: now })
    .onConflictDoNothing();
  await tx
    .insert(schema.processTemplateVersions)
    .values({ id: versionId, orgId: viewer.orgId, templateId, version: 1, definition, status: 'published', draftRev: 0, updatedAt: now, publishedAt: now, publishedBy: viewer.id })
    .onConflictDoNothing();
  const res = await createAndStartRun(tx, ctx, {
    templateId,
    templateVersionId: versionId,
    title: task.title,
    inputs: { [ADHOC_DUE_FIELD]: task.dueDate },
    initiatorId: viewer.id,
    eventId,
    actor,
  });
  const [row] = await tx
    .select({ step: schema.stepRuns, run: schema.processRuns })
    .from(schema.stepRuns)
    .innerJoin(schema.processRuns, eq(schema.processRuns.id, schema.stepRuns.runId))
    .where(and(eq(schema.stepRuns.runId, res.run.id), eq(schema.stepRuns.nodeId, ADHOC_TASK_NODE)));
  if (!row) throw new ApiError('internal_error');
  const [step] = await buildStepViews(tx, ctx, viewer, [row]);
  const [run] = await buildRunSummaries(tx, ctx, [row.run]);
  return { step: step!, run: run! };
}

/** `toUserId` có được nhận việc này khi giao lại không: việc ngoài quy trình thì ai cũng được; việc trong quy trình thì phải là người được bổ nhiệm. */
export async function canTakeStep(tx: Tx, ctx: OrgContext, run: { id: string; templateId: string }, stepId: string, toUserId: string): Promise<boolean> {
  if (await isAdhocTemplate(tx, run.templateId)) return true;
  const loaded = await loadRun(tx, run.id);
  const step = loaded?.run.steps.find((s) => s.id === stepId);
  if (!loaded || !step) return false;
  const appointed = appointedFor(loaded.def, loaded.run, step, ctx.resolve, clock.now());
  return appointed.open || appointed.userIds.includes(toUserId);
}

/**
 * Những người mà các việc này được giao lại cho. Việc trong quy trình chỉ về người được bổ nhiệm và người được ủy quyền
 * (docs/DECISIONS.md, 05/10/2026); việc ngoài quy trình, hoặc việc mà quy trình không trỏ được tới ai, thì ai còn hoạt động cũng được.
 * Nhiều việc: lấy phần chung của các việc bị giới hạn (`anyone` chỉ true khi MỌI việc cho phép bất kỳ ai).
 */
export async function stepAssignees(tx: Tx, ctx: OrgContext, viewer: Viewer, stepIds: string[]): Promise<StepAssigneesResponse> {
  const now = clock.now();
  let allowed: Set<string> | null = null;
  for (const stepId of [...new Set(stepIds)]) {
    const { run: runRow } = await findVisibleStep(tx, ctx, viewer, stepId);
    if (await isAdhocTemplate(tx, runRow.templateId)) continue;
    const loaded = await loadRun(tx, runRow.id);
    const step = loaded?.run.steps.find((s) => s.id === stepId);
    if (!loaded || !step) throw new ApiError('not_found');
    const appointed = appointedFor(loaded.def, loaded.run, step, ctx.resolve, now);
    if (appointed.open) continue;
    allowed = allowed === null ? new Set(appointed.userIds) : new Set(appointed.userIds.filter((id) => allowed!.has(id)));
  }
  if (allowed === null) return { anyone: true, people: [] };
  const ids = allowed;
  return { anyone: false, people: searchPeople(ctx, '', ctx.users.size).filter((p) => ids.has(p.id)) };
}
