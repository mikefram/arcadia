import {
  DEFAULT_CALENDAR,
  stepRunId,
  VN_UTC_OFFSET_MINUTES,
  type NewRunInput,
  type ProcessDefinition,
  type ProcessNode,
  type RunState,
  type StepState,
} from '@mihato/domain';
import { atLocalTime, toLocalDate } from '@mihato/domain/calendar';
import { assertFormValues, isLocalDateString } from './forms';

/** Một dòng step_runs mới ở trạng thái `pending`. ID dẫn xuất từ (lượt chạy, nút, lần thử) để phát lại đúng từng bit. */
export function newStep(runId: string, node: ProcessNode, attempt: number): StepState {
  const isWork = node.type === 'task' || node.type === 'approval';
  return {
    id: stepRunId(runId, node.id, attempt),
    nodeId: node.id,
    attempt,
    kind: node.type,
    title: isWork ? node.title : node.label,
    description: isWork ? (node.description ?? null) : null,
    state: 'pending',
    assigneeId: null,
    onBehalfOfId: null,
    assignedBy: null,
    dueAt: null,
    dueOriginalAt: null,
    activatedAt: null,
    startedAt: null,
    completedAt: null,
    result: null,
    reason: null,
    blockedReason: null,
    approvals: [],
    lastReminderOn: null,
    lastNudgedAt: null,
  };
}

/**
 * Mốc đích: 00:00 giờ địa phương của ngày ở ô `targetField`. Ô nhận 'YYYY-MM-DD' (ngày theo giờ địa phương)
 * hoặc một thời điểm ISO (lấy ngày địa phương của thời điểm đó). Trả null khi định nghĩa không có mốc đích
 * hoặc ô để trống.
 */
export function targetInstant(def: ProcessDefinition, inputs: Record<string, unknown>, utcOffsetMinutes: number): string | null {
  if (!def.targetField) return null;
  const raw = Object.prototype.hasOwnProperty.call(inputs, def.targetField) ? inputs[def.targetField] : undefined;
  if (typeof raw !== 'string' || raw === '') return null;
  const cal = { ...DEFAULT_CALENDAR, utcOffsetMinutes };
  let localDay: string;
  if (isLocalDateString(raw)) {
    localDay = raw;
  } else {
    if (Number.isNaN(new Date(raw).getTime())) return null;
    localDay = toLocalDate(raw, cal);
  }
  return atLocalTime(localDay, '00:00', cal).toISOString();
}

/**
 * Dựng lượt chạy ở trạng thái `draft`: một dòng `pending` cho MỌI nút (lần thử 1), chưa có sự kiện nào.
 * Kiểm `inputs` theo biểu mẫu khởi chạy của định nghĩa; sai thì ném `EngineError('invalid_input')`.
 */
export function createRun(def: ProcessDefinition, input: NewRunInput): RunState {
  assertFormValues(def.inputs, input.inputs, 'Biểu mẫu khởi chạy');
  return {
    id: input.id,
    orgId: input.orgId,
    templateId: input.templateId,
    templateVersionId: input.templateVersionId,
    title: input.title,
    initiatorId: input.initiatorId,
    state: 'draft',
    outcome: null,
    inputs: { ...input.inputs },
    targetAt: targetInstant(def, input.inputs, input.utcOffsetMinutes ?? VN_UTC_OFFSET_MINUTES),
    startedAt: null,
    completedAt: null,
    version: 0,
    seq: 0,
    appliedEventIds: [],
    steps: def.nodes.map((node) => newStep(input.id, node, 1)),
  };
}
