import type { ApprovalNode, ReminderStep, ResolveContext, TaskNode, TimerData, WorkCalendar } from '@mihato/domain';
import { addDuration } from '@mihato/domain/calendar';

/**
 * Bộ nhắc việc (SPEC 4.6). Mốc tính theo hạn và lịch làm việc.
 *
 * Bộ `standard` [MỤC TIÊU]:
 *   −1 ngày làm việc 08:30  người nhận              "Ngày mai đến hạn"
 *    0 ngày          08:30  người nhận              "Hôm nay đến hạn"
 *   +1 ngày          08:30  người nhận, người giao  "Đã quá hạn 1 ngày"
 *   +2 ngày          08:30  cấp trên trực tiếp      leo thang cấp 1
 *   +3 ngày          08:30  Văn phòng               leo thang cấp 2 (không tự nhắn thẳng cho Chủ tịch)
 */
const due = (value: number, to: ReminderStep['to'], kind: ReminderStep['kind']): ReminderStep => ({
  at: { anchor: 'due', offset: { value, unit: 'working_day' }, atTime: '08:30' },
  to,
  kind,
});

export const STANDARD_REMINDERS: readonly ReminderStep[] = [
  due(-1, 'assignee', 'reminder'),
  due(0, 'assignee', 'reminder'),
  due(1, 'assignee', 'overdue'),
  due(1, 'assigner', 'overdue'),
  due(2, 'assignee_manager', 'escalation'),
  due(3, 'office_admin', 'escalation'),
];

/**
 * Bộ `strict` [GIẢ ĐỊNH, SPEC không định nghĩa]: nhắc sớm hơn một ngày và leo thang nhanh hơn một ngày.
 *   −2, −1, 0 ngày 08:30  người nhận
 *   +1 ngày   08:30       người nhận, người giao (quá hạn) và cấp trên trực tiếp (leo thang cấp 1)
 *   +2 ngày   08:30       Văn phòng (leo thang cấp 2)
 */
export const STRICT_REMINDERS: readonly ReminderStep[] = [
  due(-2, 'assignee', 'reminder'),
  due(-1, 'assignee', 'reminder'),
  due(0, 'assignee', 'reminder'),
  due(1, 'assignee', 'overdue'),
  due(1, 'assigner', 'overdue'),
  due(1, 'assignee_manager', 'escalation'),
  due(2, 'office_admin', 'escalation'),
];

/**
 * Các mốc nhắc của một nút: `none` thì không nhắc; có `overrides` thì dùng đúng danh sách đó;
 * ngược lại dùng bộ của tổ chức (`ctx.reminderPresets`), thiếu thì bộ mặc định ở trên.
 */
export function reminderStepsFor(node: TaskNode | ApprovalNode, ctx: ResolveContext): readonly ReminderStep[] {
  const preset = node.reminders?.preset ?? ctx.defaultReminderPreset ?? 'standard';
  if (preset === 'none') return [];
  if (node.reminders?.overrides) return node.reminders.overrides;
  if (preset === 'strict') return ctx.reminderPresets?.strict ?? STRICT_REMINDERS;
  return ctx.reminderPresets?.standard ?? STANDARD_REMINDERS;
}

export type PlannedTimer = {
  fireAt: Date;
  timerKind: 'reminder' | 'overdue' | 'escalation';
  data: TimerData;
};

const SEVERITY: Record<ReminderStep['kind'], number> = { reminder: 0, overdue: 1, escalation: 2 };

/**
 * Đổi các mốc nhắc thành danh sách timer, sắp theo thời điểm. Các mốc trùng thời điểm được gom vào
 * MỘT timer (trường `data.recipients`) để quy tắc "tối đa một nhắc tự động mỗi ngày làm việc" không
 * nuốt mất tin của người giao khi người nhận và người giao cùng nhận tin quá hạn.
 * Mốc tính theo hạn bị bỏ khi việc không có hạn. Hàm trả mọi mốc, kể cả mốc đã qua; nơi gọi tự lọc.
 */
export function planReminderTimers(
  steps: readonly ReminderStep[],
  anchors: { dueAt: Date | null; assignedAt: Date },
  cal: WorkCalendar,
): PlannedTimer[] {
  type Item = { fireMs: number; step: ReminderStep };
  const items: Item[] = [];
  for (const step of steps) {
    const anchor = step.at.anchor === 'due' ? anchors.dueAt : anchors.assignedAt;
    if (anchor === null) continue;
    items.push({ fireMs: addDuration(anchor, step.at.offset, cal, step.at.atTime).getTime(), step });
  }
  const times = [...new Set(items.map((i) => i.fireMs))].sort((a, b) => a - b);
  const escalationTimes = [...new Set(items.filter((i) => i.step.kind === 'escalation').map((i) => i.fireMs))].sort((a, b) => a - b);

  return times.map((fireMs, index) => {
    const group = items.filter((i) => i.fireMs === fireMs);
    const first = (group[0] as Item).step;
    let timerKind: PlannedTimer['timerKind'] = 'reminder';
    const recipients: NonNullable<TimerData['recipients']> = [];
    for (const { step } of group) {
      if (SEVERITY[step.kind] > SEVERITY[timerKind]) timerKind = step.kind;
      if (recipients.some((r) => r.to === step.to && r.kind === step.kind)) continue;
      recipients.push(step.kind === 'escalation' ? { to: step.to, kind: step.kind, level: escalationTimes.indexOf(fireMs) + 1 } : { to: step.to, kind: step.kind });
    }
    const data: TimerData = { to: first.to, index, recipients };
    if (first.at.anchor === 'due' && first.at.offset.unit === 'working_day') data.offsetWorkingDays = first.at.offset.value;
    return { fireAt: new Date(fireMs), timerKind, data };
  });
}
