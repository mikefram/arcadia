import { EngineError, type AssigneeRule, type ProcessDefinition, type ResolveContext, type RunState, type StepState } from '@mihato/domain';
import { buildDirectory, byId, delegatesOf, resolveRuleMany, usableUser, type RuleEnv } from './directory';

/**
 * "Người được bổ nhiệm" của một việc nằm trong quy trình (Mike quyết 04/10/2026): việc phát sinh từ quy trình phải về
 * đúng người mà quy trình chỉ định, nên người giao KHÔNG chọn người tuỳ ý. Những người được nhận là:
 * - người quy tắc của nút trỏ tới (quy tắc `role`: mọi người đang giữ vai trò đó, trong đơn vị nếu quy tắc nêu đơn vị);
 * - người đang được ủy quyền thay họ (SPEC 4.8).
 * `open` = true khi quy tắc không trỏ được tới ai (vai trò chưa có người, người được chỉ định đã nghỉ): lúc đó Văn phòng
 * bổ nhiệm bất kỳ ai còn hoạt động, nếu không việc kẹt mãi ở "Cần giao người".
 * Việc ngoài quy trình (không có quy tắc nào) không dùng hàm này: người giao chọn tự do.
 */
export type Appointed = { open: boolean; userIds: string[] };

function rulesOf(def: ProcessDefinition, step: StepState): AssigneeRule[] {
  const node = def.nodes.find((n) => n.id === step.nodeId);
  if (!node) return [];
  if (node.type === 'task') return [node.assignee];
  if (node.type === 'approval') return node.approvers;
  return [];
}

export function appointedFor(def: ProcessDefinition, run: RunState, step: StepState, ctx: ResolveContext, now: Date): Appointed {
  const dir = buildDirectory(ctx);
  const latest = new Map<string, StepState>();
  for (const s of run.steps) {
    const prev = latest.get(s.nodeId);
    if (!prev || s.attempt > prev.attempt) latest.set(s.nodeId, s);
  }
  const env: RuleEnv = { dir, initiatorId: run.initiatorId, inputs: run.inputs, stepResult: (nodeId) => latest.get(nodeId)?.result ?? null };
  const ids = new Set<string>();
  for (const rule of rulesOf(def, step)) {
    const roles = rule.kind === 'role' ? [rule.role] : [];
    for (const base of resolveRuleMany(rule, env)) {
      ids.add(base);
      for (const delegate of delegatesOf(dir, base, now, run.templateId, roles)) ids.add(delegate);
    }
  }
  const userIds = [...ids].filter((id) => usableUser(dir, id) !== null).sort(byId);
  return { open: userIds.length === 0, userIds };
}

/** Ném `invalid_input` (mã `not_appointed`) khi `toUserId` không phải người được bổ nhiệm của việc. */
export function assertAppointed(def: ProcessDefinition, run: RunState, step: StepState, toUserId: string, ctx: ResolveContext, now: Date): void {
  const appointed = appointedFor(def, run, step, ctx, now);
  if (appointed.open || appointed.userIds.includes(toUserId)) return;
  throw new EngineError('invalid_input', 'Việc nằm trong quy trình chỉ giao được cho người được bổ nhiệm (hoặc người được ủy quyền)', {
    stepId: step.id,
    errors: [{ path: 'body.toUserId', code: 'not_appointed' }],
  });
}
