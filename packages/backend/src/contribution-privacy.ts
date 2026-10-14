import { can, type RunEventView, type StepView } from '@mihato/domain';
import { and, eq, inArray, or } from 'drizzle-orm';
import { schema, type Tx } from './db/client';
import { loadDefinition } from './engine/runner';
import { COMPILED_FIELD } from './file-view';
import type { Viewer } from './views';

/**
 * Phần của người đóng góp chỉ những người có việc khác trong lượt chạy mới thấy hết (docs/DECISIONS.md, 06/10/2026).
 *
 * Ở bước góp nội dung, mỗi người gửi phần của mình. Người chỉ đứng trong danh sách người góp của một bước như vậy (không khởi chạy lượt,
 * không giữ hay duyệt việc nào khác trong lượt, không có quyền xem mọi lượt chạy) chỉ thấy phần của chính mình: chữ, ý kiến và tệp.
 * Người khác trong danh sách vẫn hiện tên và "đã gửi" hay "chưa gửi". Người khởi chạy, người chủ trì tổng hợp, người duyệt, người giao
 * việc và người có quyền xem mọi lượt chạy thấy hết, vì họ cần đọc để làm việc.
 *
 * Mọi đường đọc đi qua đây: chi tiết lượt chạy và việc, danh sách tệp, tải tệp, dòng thời gian và hoạt động.
 */

/** Phần bị che của một người xem: các việc góp nội dung chỉ thấy phần của mình, và các lượt chạy chứa chúng. */
export type HiddenParts = { steps: ReadonlySet<string>; runs: ReadonlySet<string> };

/**
 * Việc góp nội dung mà `viewer` chỉ được thấy phần của chính mình, trong các lượt chạy đã cho. Người có `run.view_all` luôn trả tập rỗng.
 *
 * Quy tắc áp cho MỌI người xem còn lại, kể cả người không có tên trong danh sách người góp (cấp trên trực tiếp của người góp, trưởng đơn vị,
 * người được chia sẻ): ai không phải người khởi chạy, không giữ việc thường nào và không duyệt việc duyệt thường nào của lượt thì chỉ thấy
 * phần của chính mình (không có phần nào thì không thấy nội dung nào). Audit runs-1: trước đây chỉ xét người đứng trong danh sách.
 */
export async function hiddenParts(tx: Tx, viewer: Viewer, runIds: readonly string[]): Promise<HiddenParts> {
  const out = new Set<string>();
  const outRuns = new Set<string>();
  const result = (): HiddenParts => ({ steps: out, runs: outRuns });
  if (runIds.length === 0 || can(viewer, 'run.view_all')) return result();
  const ids = [...new Set(runIds)];

  const runs = await tx
    .select({ id: schema.processRuns.id, initiatorId: schema.processRuns.initiatorId, versionId: schema.processRuns.templateVersionId })
    .from(schema.processRuns)
    .where(inArray(schema.processRuns.id, ids));
  const contributeByVersion = new Map<string, ReadonlySet<string>>();
  for (const versionId of new Set(runs.map((r) => r.versionId))) {
    const def = await loadDefinition(tx, versionId);
    contributeByVersion.set(versionId, new Set(def.nodes.filter((n) => n.type === 'approval' && n.action === 'contribute').map((n) => n.id)));
  }
  // Chỉ những lượt có nút góp nội dung và người xem không phải người khởi chạy mới cần xét tiếp.
  const candidates = runs.filter((r) => r.initiatorId !== viewer.id && (contributeByVersion.get(r.versionId)?.size ?? 0) > 0);
  if (candidates.length === 0) return result();
  const candidateIds = candidates.map((r) => r.id);

  const steps = await tx
    .select({ id: schema.stepRuns.id, runId: schema.stepRuns.runId, nodeId: schema.stepRuns.nodeId, assigneeId: schema.stepRuns.assigneeId, onBehalfOfId: schema.stepRuns.onBehalfOfId })
    .from(schema.stepRuns)
    .where(inArray(schema.stepRuns.runId, candidateIds));
  // Các việc duyệt mà người xem nằm trong danh sách (kể cả được ủy quyền hoặc thay mặt người khác).
  const mine = await tx
    .select({ runId: schema.stepRuns.runId, nodeId: schema.stepRuns.nodeId })
    .from(schema.stepApprovals)
    .innerJoin(schema.stepRuns, eq(schema.stepRuns.id, schema.stepApprovals.stepRunId))
    .where(and(inArray(schema.stepRuns.runId, candidateIds), or(eq(schema.stepApprovals.approverId, viewer.id), eq(schema.stepApprovals.onBehalfOfId, viewer.id))));

  for (const run of candidates) {
    const contribute = contributeByVersion.get(run.versionId) ?? new Set<string>();
    // Có việc khác (giữ việc làm, hoặc duyệt một việc duyệt thường) thì là người cần đọc để làm việc.
    const otherRole =
      steps.some((s) => s.runId === run.id && !contribute.has(s.nodeId) && (s.assigneeId === viewer.id || s.onBehalfOfId === viewer.id)) ||
      mine.some((m) => m.runId === run.id && !contribute.has(m.nodeId));
    if (otherRole) continue;
    for (const s of steps) if (s.runId === run.id && contribute.has(s.nodeId)) out.add(s.id);
    outRuns.add(run.id);
  }
  return result();
}

/** Chỉ các việc góp nội dung bị che (cho nơi không cần biết lượt nào). */
export async function ownPartOnlySteps(tx: Tx, viewer: Viewer, runIds: readonly string[]): Promise<ReadonlySet<string>> {
  return (await hiddenParts(tx, viewer, runIds)).steps;
}

/** Phần chi tiết của nội dung đã gửi, bỏ khỏi sự kiện mà người xem không được đọc. */
const CONTENT_KEYS = ['result', 'comment', 'fileIds'] as const;

/** Che phần của người khác trong một việc góp nội dung; phần của chính người xem giữ nguyên. */
export function redactStepView(view: StepView, viewerId: string): StepView {
  const mine = (p: NonNullable<StepView['participants']>[number]) => p.person.id === viewerId || p.onBehalfOf?.id === viewerId;
  const participants = view.participants?.map((p) => (mine(p) ? p : { ...p, comment: null, result: null, fileIds: [], contentHidden: true }));
  // `result.responses` ghi người gửi theo người được thay mặt nếu có.
  const ownUserIds = new Set((view.participants ?? []).filter(mine).map((p) => p.onBehalfOf?.id ?? p.person.id));
  let result = view.result;
  if (result) {
    const responses = Array.isArray(result['responses']) ? (result['responses'] as { userId?: string }[]).filter((r) => typeof r.userId === 'string' && ownUserIds.has(r.userId)) : undefined;
    result = { ...(result['decision'] !== undefined ? { decision: result['decision'] } : {}), ...(responses ? { responses } : {}) };
  }
  return { ...view, ...(participants ? { participants } : {}), result, files: (view.files ?? []).filter((f) => f.uploadedBy?.id === viewerId) };
}

/** Sự kiện gửi phần của người khác ở việc bị che: giữ ai, lúc nào, bỏ nội dung. */
export function redactEvent(event: RunEventView, hidden: ReadonlySet<string>, viewerId: string, actorId: string | null): RunEventView {
  if (event.type !== 'ApproveStep' || !event.stepId || !hidden.has(event.stepId) || actorId === viewerId) return event;
  const payload = { ...event.payload };
  for (const k of CONTENT_KEYS) delete payload[k];
  return { ...event, payload };
}

/**
 * Tệp thuộc một việc bị che và không do chính người xem tải lên thì không hiện và không tải được.
 * Tệp tổng hợp (Word, PDF) gom phần của mọi người góp, nên người đang bị che phần của người khác ở lượt đó cũng không thấy và không tải
 * được tệp tổng hợp, dù nó gắn vào việc tổng hợp chứ không phải việc góp (audit files-3).
 */
export function fileHidden(
  file: { stepRunId: string | null; runId?: string | null; ownerUserId: string | null; fieldKey?: string | null },
  hidden: HiddenParts,
  viewerId: string,
): boolean {
  if (file.fieldKey === COMPILED_FIELD && file.runId && hidden.runs.has(file.runId)) return true;
  return file.stepRunId !== null && hidden.steps.has(file.stepRunId) && file.ownerUserId !== viewerId;
}
