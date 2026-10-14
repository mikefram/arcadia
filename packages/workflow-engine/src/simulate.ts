import {
  VALIDATION_CODES,
  type AssigneeRule,
  type DefinitionIssue,
  type SimulateInput,
  type SimulateResult,
  type SimulationRow,
} from '@mihato/domain';
import { targetInstant } from './create-run';
import { buildDirectory, findDelegation, resolveRule, usableUser, type RuleEnv } from './directory';
import { buildGraph } from './graph';
import { planSchedule } from './plan';

/**
 * Bảng dự kiến "ai làm gì, hạn nào" trước khi khởi chạy (SPEC 4.5, 9.3). Không ghi gì.
 * Giả định mỗi việc xong đúng hạn của nó để tính lúc việc sau tới lượt.
 * Hạn đã qua so với `now` được BÁO TRƯỚC bằng cảnh báo `due_in_past`; hạn không bao giờ bị tự dịch.
 */
export function simulate(input: SimulateInput): SimulateResult {
  const { def, inputs, initiatorId, ctx, now } = input;
  const graph = buildGraph(def);
  const dir = buildDirectory(ctx);
  const env: RuleEnv = { dir, initiatorId, inputs };
  const targetAt = targetInstant(def, inputs, ctx.calendar.utcOffsetMinutes);
  const plan = planSchedule(def, { now, targetAt: targetAt ? new Date(targetAt) : null, cal: ctx.calendar, inputs });

  const rows: SimulationRow[] = [];
  const warnings: DefinitionIssue[] = [];
  plan.forEach((p, order) => {
    const node = graph.nodes.get(p.nodeId);
    if (!node || (node.type !== 'task' && node.type !== 'approval')) return;

    // Người nhận: người được chỉ định lúc khởi chạy ưu tiên; ủy quyền xét tại lúc việc dự kiến tới lượt.
    const override = input.assigneeOverrides?.[p.nodeId];
    const rules: AssigneeRule[] = node.type === 'task' ? [node.assignee] : node.approvers;
    let assigneeId: string | null = null;
    let onBehalfOfId: string | null = null;
    const candidates: { baseId: string | null; roles: string[] }[] =
      override !== undefined
        ? [{ baseId: override, roles: [] }]
        : rules.map((rule) => ({ baseId: resolveRule(rule, env), roles: rule.kind === 'role' ? [rule.role] : [] }));
    for (const c of candidates) {
      const base = usableUser(dir, c.baseId);
      if (!base) continue;
      const delegation = findDelegation(dir, base.id, p.activationAt, input.templateId ?? null, c.roles);
      assigneeId = delegation ? delegation.toUserId : base.id;
      onBehalfOfId = delegation ? base.id : null;
      break;
    }

    const pastDue = p.dueAt !== null && p.dueAt.getTime() < now.getTime();
    // Người nhận do bước đứng trước chọn lúc chạy: chưa biết được ở đây, và cũng không phải lỗi thiếu người.
    const chosenLater = override === undefined && rules.length > 0 && rules.every((r) => r.kind === 'step_field');
    rows.push({
      nodeId: p.nodeId,
      kind: p.kind,
      title: p.title,
      assigneeId,
      onBehalfOfId,
      dueAt: p.dueAt ? p.dueAt.toISOString() : null,
      pastDue,
      order,
      ...(node.type === 'approval' && node.action === 'contribute' ? { action: 'contribute' as const } : {}),
      ...(chosenLater ? { assigneeChosenLater: true } : {}),
    });

    if (pastDue) {
      warnings.push({
        code: VALIDATION_CODES.dueInPast,
        nodeId: p.nodeId,
        message: `Hạn của việc “${p.title}” đã qua ngay lúc khởi chạy. Hạn được giữ nguyên, không tự dời; cần đổi ngày mốc hoặc gia hạn sau khi khởi chạy.`,
      });
    }
    if (p.dueAt === null) {
      warnings.push({
        code: VALIDATION_CODES.dueMissing,
        nodeId: p.nodeId,
        message: `Chưa tính được hạn của việc “${p.title}” vì chưa có ngày mốc của lượt chạy.`,
      });
    }
    if (assigneeId === null && !chosenLater) {
      warnings.push({
        code: VALIDATION_CODES.assigneeMissing,
        nodeId: p.nodeId,
        message: `Chưa xác định được người nhận của việc “${p.title}”. Khi tới lượt, Văn phòng sẽ phải giao người.`,
      });
    }
  });
  return { rows, warnings, targetAt };
}
