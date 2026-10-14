import { z } from 'zod';
import { IdSchema } from './enums';
import type { AssigneeRule, DraftDefinition, DraftNode, Edge } from './process';

/**
 * Quy trình soạn bằng hội thoại với Trợ lý AI (docs/DECISIONS.md, 04/10/2026; mở rộng SPEC 6.5).
 *
 * Người dùng đọc từng bước; mỗi bước chỉ có bốn thông tin: tên việc, người làm (hoặc người duyệt), hạn tính bằng số ngày
 * làm việc, và có làm cùng lúc với bước trước không. Máy chủ đổi danh sách bước thành bản nháp `ProcessDefinition`
 * bằng hàm thuần ở đây; engine vẫn là nơi `validate()` quyết định bản nháp có xuất bản được không.
 * Tệp này thuần: không I/O, không chữ giao diện (nhãn nút do nơi gọi truyền vào).
 */

export const PROCESS_DRAFT_MAX_STEPS = 30;

/** Vai trò có thể ghi vào một bước khi người dùng nói "Văn phòng làm", "Giám đốc duyệt". */
export const DRAFT_ASSIGNABLE_ROLES = ['chairman', 'director', 'deputy', 'office_admin'] as const;
export type DraftAssignableRole = (typeof DRAFT_ASSIGNABLE_ROLES)[number];

/**
 * Một bước như AI gửi lên (đã nghe từ người dùng). Cố ý lỏng: thiếu người hay thiếu hạn thì máy chủ báo từng lỗi
 * để AI hỏi lại, thay vì cả lời gọi bị từ chối.
 */
export const DraftStepArgsSchema = z.object({
  title: z.string().max(200),
  kind: z.enum(['task', 'approval']).optional(),
  assignee: z
    .object({
      /** `unknown`: người dùng chưa nói ai làm; schema gửi cho Claude có giá trị này để model không phải đoán */
      kind: z.enum(['person', 'role', 'initiator', 'unknown']),
      personId: IdSchema.optional(),
      role: z.enum(DRAFT_ASSIGNABLE_ROLES).optional(),
    })
    .optional(),
  /** 0 hoặc vắng mặt nghĩa là người dùng chưa nói hạn */
  dueDays: z.number().int().optional(),
  parallel: z.boolean().optional(),
});
export type DraftStepArgs = z.infer<typeof DraftStepArgsSchema>;

/** Một bước đã kiểm đủ và đã tra người: dạng lưu ở `proposals.payload` và đưa vào bộ dựng. */
export const ResolvedDraftStepSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(['task', 'approval']),
  assignee: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('person'), userId: IdSchema }),
    z.object({ kind: z.literal('role'), role: z.enum(DRAFT_ASSIGNABLE_ROLES) }),
    z.object({ kind: z.literal('initiator') }),
  ]),
  /** số ngày làm việc kể từ lúc bước này bắt đầu */
  dueDays: z.number().int().min(1).max(365),
  /** làm cùng lúc với bước đứng ngay trước */
  parallel: z.boolean(),
});
export type ResolvedDraftStep = z.infer<typeof ResolvedDraftStepSchema>;

export const ProcessDraftPayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  steps: z.array(ResolvedDraftStepSchema).min(1).max(PROCESS_DRAFT_MAX_STEPS),
});
export type ProcessDraftPayload = z.infer<typeof ProcessDraftPayloadSchema>;

/** Lỗi của một bước (hoặc của cả quy trình khi `step` là null) để AI hỏi lại đúng chỗ còn thiếu. */
export type DraftProblem = {
  /** thứ tự bước tính từ 1; null khi lỗi của cả quy trình */
  step: number | null;
  field: 'name' | 'steps' | 'title' | 'assignee' | 'dueDays';
  code: string;
};

export function assigneeRuleOf(a: ResolvedDraftStep['assignee']): AssigneeRule {
  switch (a.kind) {
    case 'person':
      return { kind: 'user', userId: a.userId };
    case 'role':
      return { kind: 'role', role: a.role };
    case 'initiator':
      return { kind: 'initiator' };
  }
}

/** Mã nút của bước thứ `n` (tính từ 1). */
export const draftNodeId = (n: number): string => `s${n}`;

const COLUMN_WIDTH = 300;
/** khoảng cách giữa tâm hai thẻ xếp dọc; thẻ việc cao khoảng 115 px nên chừa khoảng thở cho nhãn cạnh */
const ROW_HEIGHT = 170;
/** đường giữa: nút Bắt đầu và Hoàn tất (thấp) đặt ở đây; thẻ việc (cao) đặt lệch lên để tâm hai loại thẳng hàng */
const MIDDLE = 240;
const TASK_OFFSET = 40;

/**
 * Dựng bản nháp từ danh sách bước. Các bước nối tiếp nhau theo thứ tự đọc; bước `parallel` cùng nhóm với bước trước nó và
 * cùng bắt đầu khi nhóm trước xong. Mỗi bước của nhóm sau chờ MỌI bước của nhóm trước (join mặc định "all").
 * Cạnh đi ra khỏi nút duyệt mang `outcome: 'approved'`. Toạ độ xếp theo cột (mỗi nhóm một cột) để trình thiết kế mở ra đọc được ngay.
 */
export function buildDraftDefinition(draft: { name: string; steps: readonly ResolvedDraftStep[] }, labels: { start: string; end: string }): DraftDefinition {
  const groups: number[][] = [];
  draft.steps.forEach((step, i) => {
    const last = groups.at(-1);
    if (step.parallel && last) last.push(i);
    else groups.push([i]);
  });

  const layout: Record<string, { x: number; y: number }> = { start: { x: 0, y: MIDDLE } };
  const nodes: DraftNode[] = [{ id: 'start', type: 'start', label: labels.start }];
  groups.forEach((group, g) => {
    group.forEach((i, k) => {
      const step = draft.steps[i] as ResolvedDraftStep;
      const id = draftNodeId(i + 1);
      const due = { anchor: 'activation' as const, offset: { value: step.dueDays, unit: 'working_day' as const } };
      const rule = assigneeRuleOf(step.assignee);
      nodes.push(
        step.kind === 'approval'
          ? { id, type: 'approval', label: step.title, title: step.title, approvers: [rule], mode: 'any', due }
          : { id, type: 'task', label: step.title, title: step.title, assignee: rule, due },
      );
      layout[id] = { x: (g + 1) * COLUMN_WIDTH, y: MIDDLE - TASK_OFFSET + (k - (group.length - 1) / 2) * ROW_HEIGHT };
    });
  });
  nodes.push({ id: 'end', type: 'end', label: labels.end });
  layout.end = { x: (groups.length + 1) * COLUMN_WIDTH, y: MIDDLE };

  const edges: Edge[] = [];
  const connect = (from: string, to: string, approved: boolean) => edges.push({ id: `e${edges.length + 1}`, from, to, ...(approved ? { outcome: 'approved' as const } : {}) });
  let previous: { id: string; approved: boolean }[] = [{ id: 'start', approved: false }];
  for (const group of groups) {
    for (const i of group) for (const p of previous) connect(p.id, draftNodeId(i + 1), p.approved);
    previous = group.map((i) => ({ id: draftNodeId(i + 1), approved: (draft.steps[i] as ResolvedDraftStep).kind === 'approval' }));
  }
  for (const p of previous) connect(p.id, 'end', p.approved);

  return { schemaVersion: 1, name: draft.name, inputs: [], layout, nodes, edges };
}
