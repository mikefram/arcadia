import { ProcessDefinitionSchema, type ProcessDefinition } from './process';

/**
 * Việc ngoài quy trình (docs/DECISIONS.md, 05/10/2026): người giao giao một việc bất kỳ, không cần quy trình bao quanh.
 * Để dùng lại toàn bộ engine (hạn, nhắc, đi thúc, báo cáo, app nhân viên), mỗi việc là một lượt chạy của một mẫu một việc
 * ẩn (`process_templates.kind = 'adhoc'`) do máy chủ dựng bằng hàm thuần này: Bắt đầu → Việc → Hoàn tất.
 * Người nhận là chính người mà người giao chọn (quy tắc `user`); hạn lấy từ ô ngày `due` của biểu mẫu khởi chạy.
 * Tệp này thuần: không I/O, không chữ giao diện (nhãn do nơi gọi truyền vào).
 */
export const ADHOC_TASK_NODE = 'task';
export const ADHOC_DUE_FIELD = 'due';

export type AdhocLabels = { start: string; task: string; end: string; due: string };

export function adhocDefinition(input: { title: string; description?: string | null; assigneeId: string }, labels: AdhocLabels): ProcessDefinition {
  const description = input.description?.trim();
  return ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    name: input.title,
    inputs: [{ key: ADHOC_DUE_FIELD, label: labels.due, type: 'date', required: true }],
    targetField: ADHOC_DUE_FIELD,
    nodes: [
      { id: 'start', type: 'start', label: labels.start },
      {
        id: ADHOC_TASK_NODE,
        type: 'task',
        label: labels.task,
        title: input.title,
        ...(description ? { description } : {}),
        assignee: { kind: 'user', userId: input.assigneeId },
        // Hạn = hết giờ làm việc của ngày chọn; rơi vào ngày nghỉ thì lùi về ngày làm việc liền trước (SPEC 4.10 thuộc tính 5).
        due: { anchor: 'run_target', offset: { value: 0, unit: 'working_day' } },
      },
      { id: 'end', type: 'end', label: labels.end },
    ],
    edges: [
      { id: 'e1', from: 'start', to: ADHOC_TASK_NODE },
      { id: 'e2', from: ADHOC_TASK_NODE, to: 'end' },
    ],
  });
}
