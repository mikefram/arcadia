import type { ProposalView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { createNamer } from './address';

const t = vi.executive.review;
const undoText = vi.executive.undo;

/**
 * Lý do một đề xuất không thực hiện được (`proposals.result.reason`), đổi thành câu tiếng Việt.
 * Mã lạ thì dùng câu dự phòng; app không bao giờ hiện mã của máy chủ.
 */
const REASON_GROUP: Record<string, keyof typeof t.failedReasons> = {
  step_not_open: 'alreadyDone',
  not_open: 'alreadyDone',
  run_not_running: 'alreadyDone',
  already_nudged_today: 'throttled',
  nudge_throttled: 'throttled',
  quiet_hours: 'throttled',
  extension_pending: 'throttled',
  not_overdue: 'throttled',
  assignee_changed: 'changed',
  assignee_unavailable: 'personGone',
  assignee_is_self: 'changed',
  // Việc trong quy trình chỉ giao lại cho người được bổ nhiệm; ủy quyền bị thu hồi trong lúc chờ xác nhận thì không còn làm được.
  not_appointed: 'notAppointed',
  same_assignee: 'changed',
  due_in_past: 'changed',
  template_archived: 'changed',
  template_invalid: 'templateNotUsable',
  not_found: 'changed',
  forbidden: 'noPermission',
  user_inactive: 'noPermission',
  // Soạn quy trình: trong lúc chờ xác nhận, người khác đã tạo quy trình trùng tên, hoặc bản nháp đã được xuất bản.
  name_taken: 'nameTaken',
  template_not_draft: 'notDraft',
};

export function failedReasonText(reason: unknown): string {
  const group = typeof reason === 'string' ? REASON_GROUP[reason] : undefined;
  return t.failedReasons[group ?? 'other'];
}

export function failedReasonOf(proposal: Pick<ProposalView, 'result'>): string {
  return failedReasonText(proposal.result?.reason);
}

/**
 * Câu báo kết quả khi máy chủ đã thực hiện xong việc soạn quy trình (M3b, và M3 khi mở lại đề xuất đã xong).
 * `null` với các loại đề xuất khác: nơi gọi giữ câu như trước ("Đã gửi.", "Đã thực hiện.").
 * Xuất bản mà kết quả có `runId` nghĩa là đã giao việc ngay trong cùng lần áp; chỉ xuất bản thì không có.
 */
export function processAppliedText(tool: string | undefined, proposals: readonly Pick<ProposalView, 'result'>[]): string | null {
  switch (tool) {
    case 'propose_create_process':
      return undoText.createdProcess;
    case 'propose_publish_process':
      return proposals.some((p) => typeof p.result?.runId === 'string') ? undoText.publishedAndAssigned : undoText.publishedProcess;
    case 'propose_assign_task':
      return undoText.assignedTask;
    default:
      return null;
  }
}

export type ReviewLabels = { confirm: string; reject: string; heading: string | null };

/** Xuất bản kèm giao việc ngay thì `preview` là các việc sẽ giao; chỉ xuất bản thì `preview` là null. */
const assignsWork = (proposal: Pick<ProposalView, 'preview'> | undefined): boolean => (proposal?.preview ?? null) !== null;

/**
 * Chữ trên hai nút của M3 theo loại đề xuất. Luôn nói rõ đồng ý việc gì; không có nút "Hủy" (SPEC 7.5).
 * Xuất bản có hai dạng nên cần thêm đề xuất để phân biệt: chỉ xuất bản, hoặc xuất bản và giao việc (có `preview`).
 */
export function reviewLabels(tool: ProposalView['tool'], proposal?: Pick<ProposalView, 'preview'>): ReviewLabels {
  switch (tool) {
    case 'propose_start_run':
      return { confirm: t.startRun.confirm, reject: t.startRun.reject, heading: t.startRun.title };
    case 'propose_create_process':
      return { confirm: t.createProcess.confirm, reject: t.createProcess.reject, heading: t.createProcess.title };
    case 'propose_publish_process':
      return assignsWork(proposal)
        ? { confirm: t.publishAndAssign.confirm, reject: t.publishAndAssign.reject, heading: t.publishAndAssign.title }
        : { confirm: t.publishProcess.confirm, reject: t.publishProcess.reject, heading: null };
    case 'propose_assign_task':
      return { confirm: t.assignTask.confirm, reject: t.assignTask.reject, heading: t.assignTask.title };
    case 'propose_reassign':
      return { confirm: t.reassign.confirm, reject: t.reassign.reject, heading: t.reassign.title };
    case 'propose_extend_due':
      return { confirm: t.extendDue.confirm, reject: t.extendDue.reject, heading: t.extendDue.title };
    case 'propose_cancel_run':
      return { confirm: t.cancelRun.confirm, reject: t.cancelRun.reject, heading: t.cancelRun.title };
    default:
      return { confirm: t.confirm, reject: t.reject, heading: null };
  }
}

export type ReviewBody =
  /** các việc sẽ giao, kèm người nhận và hạn (giao việc mới, hoặc xuất bản kèm giao việc) */
  | 'runPreview'
  /** các bước của bản nháp quy trình, mỗi bước một thẻ */
  | 'processSteps'
  /** chỉ xuất bản: câu đầu màn hình đã nói đủ, không có thẻ nào thêm */
  | 'summaryOnly'
  /** danh sách mục của cổng xác nhận: lời nhắc, đổi người, đổi hạn, dừng lượt */
  | 'items';

/**
 * Phần thân của M3 theo loại đề xuất. Chỉ đề xuất lẻ mới có thân riêng; nhiều đề xuất cùng lô luôn là danh sách mục.
 * Một đề xuất là một khối: Chủ tịch đồng ý hoặc không cả khối, không có nút bỏ từng bước hay từng việc.
 */
export function reviewBody(pending: readonly Pick<ProposalView, 'tool' | 'preview'>[]): ReviewBody {
  const only = pending.length === 1 ? pending[0] : undefined;
  switch (only?.tool) {
    case 'propose_start_run':
      return 'runPreview';
    case 'propose_create_process':
      return 'processSteps';
    case 'propose_publish_process':
      return assignsWork(only) ? 'runPreview' : 'summaryOnly';
    default:
      return 'items';
  }
}

/**
 * Tên người làm của từng bước trong bản nháp quy trình (cùng thứ tự với `items`), theo cách gọi ở SPEC 7.5: người xuất hiện
 * lần đầu viết đủ ("anh Bùi Quốc Tuấn"), các bước sau viết gọn ("anh Tuấn"). `null` khi người làm là vai trò (Giám đốc,
 * Văn phòng) hoặc "người giao việc": tên vai trò đã nằm trong câu của máy chủ, không có người để gọi tên.
 */
export function draftStepAssignees(items: readonly Pick<ProposalView['items'][number], 'toUser'>[]): (string | null)[] {
  const name = createNamer(items.map((item) => item.toUser));
  return items.map((item) => (item.toUser ? name(item.toUser) : null));
}

/**
 * Câu đầu thẻ của một mục ở M3. Luôn là câu do MÁY CHỦ dựng (`summary`, `items[].text`), không phải chữ của trợ lý.
 * - Nhiều mục: dùng `summary`, vì chỉ `summary` có tên lượt: hai lời nhắc cùng người, cùng tên việc ở hai lượt khác nhau
 *   sẽ giống hệt nhau nếu chỉ có `items[].text`.
 * - Một mục: `summary` đã hiện làm câu đầu màn hình nên thẻ không nhắc lại. Lời nhắc đã có riêng người nhận, số ngày trễ và
 *   câu sẽ gửi; mục khác chỉ giữ phần chữ nối thêm sau `summary` (ví dụ "Lý do ghi lại: …").
 */
export function reviewItemText(proposal: Pick<ProposalView, 'tool' | 'summary' | 'items'>, multi: boolean): string | null {
  if (multi) return proposal.summary;
  if (proposal.tool === 'propose_nudge') return null;
  const text = proposal.items[0]?.text ?? proposal.summary;
  if (text === proposal.summary) return null;
  if (text.startsWith(proposal.summary)) return text.slice(proposal.summary.length).trim() || null;
  return text;
}

/** Mức rủi ro cao nhất của nhóm: mức 2 thì chạm từng mục, cần nâng quyền, không giọng nói, không Gửi ngay. */
export function groupRisk(proposals: readonly Pick<ProposalView, 'risk'>[]): 0 | 1 | 2 {
  return proposals.reduce<0 | 1 | 2>((max, p) => (p.risk > max ? p.risk : max), 0);
}

export type ProposalGroup = { key: string; batchId: string | null; source: ProposalView['source']; proposals: ProposalView[] };

/** Gom đề xuất đang chờ theo lô: một lô là một việc cần xem ở M6 và mở thành một màn M3. */
export function groupPendingProposals(list: readonly ProposalView[]): ProposalGroup[] {
  const groups = new Map<string, ProposalGroup>();
  for (const p of list) {
    const key = p.batchId ?? p.id;
    const group = groups.get(key) ?? { key, batchId: p.batchId, source: p.source, proposals: [] };
    group.proposals.push(p);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type GroupState = 'pending' | 'expired' | 'failed' | 'confirmed' | 'applied' | 'rejected' | 'undone';

/**
 * Tình trạng của cả nhóm để M3 chọn nội dung: còn mục chờ thì là `pending`; đã đồng ý mà còn trong cửa hoàn tác
 * thì `confirmed` (mở M3b); đã thực hiện thì `applied`.
 */
export function groupState(proposals: readonly ProposalView[], nowMs: number): GroupState {
  if (proposals.length === 0) return 'expired';
  const pending = proposals.filter((p) => p.state === 'pending');
  if (pending.some((p) => Date.parse(p.expiresAt) > nowMs)) return 'pending';
  if (proposals.some((p) => p.state === 'failed')) return 'failed';
  const confirmed = proposals.filter((p) => p.state === 'confirmed');
  if (confirmed.length > 0) return confirmed.some((p) => p.result === null) ? 'confirmed' : 'applied';
  if (proposals.some((p) => p.state === 'undone')) return 'undone';
  if (pending.length > 0 || proposals.some((p) => p.state === 'expired')) return 'expired';
  return 'rejected';
}

export type ConfirmCall =
  | { kind: 'batch'; batchId: string; body: { via: 'touch' | 'voice'; transcript?: string; sttConfidence?: number; dropProposalIds?: string[]; editedMessages?: Record<string, string> } }
  | { kind: 'single'; proposalId: string; body: { via: 'touch' | 'voice'; transcript?: string; sttConfidence?: number; editedMessages?: Record<string, string> } };

export type Voice = { transcript: string; sttConfidence: number };

/**
 * Dựng lời gọi xác nhận (SPEC 10.6). Lô mức 1: một lần `proposal-batches/:batchId/confirm` kèm `dropProposalIds` và
 * `editedMessages`. Đề xuất lẻ, và mọi đề xuất mức 2: từng lời gọi `proposals/:id/confirm` (mức 2 không đi theo lô).
 * `edits` chỉ gửi lời đã thật sự khác lời máy chủ soạn.
 */
export function buildConfirmCalls(proposals: readonly ProposalView[], dropped: ReadonlySet<string>, edits: ReadonlyMap<string, string>, voice: Voice | null): ConfirmCall[] {
  const pending = proposals.filter((p) => p.state === 'pending');
  const via = voice ? 'voice' : 'touch';
  const evidence = voice ? { transcript: voice.transcript, sttConfidence: voice.sttConfidence } : {};
  const editedFor = (ids: readonly string[]): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const p = pending.find((x) => x.id === id);
      const text = edits.get(id)?.trim();
      if (!p || !text || dropped.has(id)) continue;
      if (text !== (p.items[0]?.message ?? '')) out[id] = text;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const batchId = pending[0]?.batchId ?? null;
  const sameBatch = batchId !== null && pending.every((p) => p.batchId === batchId);
  if (sameBatch && groupRisk(pending) < 2) {
    const ids = pending.map((p) => p.id);
    const drop = ids.filter((id) => dropped.has(id));
    return [{ kind: 'batch', batchId, body: { via, ...evidence, ...(drop.length > 0 ? { dropProposalIds: drop } : {}), ...(editedFor(ids) ? { editedMessages: editedFor(ids) } : {}) } }];
  }
  return pending
    .filter((p) => !dropped.has(p.id))
    .map((p) => ({ kind: 'single' as const, proposalId: p.id, body: { via, ...evidence, ...(editedFor([p.id]) ? { editedMessages: editedFor([p.id]) } : {}) } }));
}
