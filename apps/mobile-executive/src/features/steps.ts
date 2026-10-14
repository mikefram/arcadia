import type { RunSummary, StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';

const t = vi.executive;

export type ChipInfo = { kind: 'done' | 'late' | 'open'; label: string };

/**
 * Trạng thái một việc ở M5 (SPEC 7.3): Xong (dấu tích), Quá hạn (dấu cảnh báo, "Đã quá hạn n ngày làm việc"),
 * còn lại nền trắng viền xám, chỉ khác chữ. Số ngày trễ do máy chủ tính theo lịch làm việc.
 */
export function stepChip(step: Pick<StepView, 'state' | 'isOverdue' | 'lateWorkingDays'>): ChipInfo {
  if (step.state === 'done') return { kind: 'done', label: vi.common.stepState.done };
  if (step.isOverdue) {
    return { kind: 'late', label: step.lateWorkingDays > 0 ? fmt(t.runDetail.step.late, { n: step.lateWorkingDays }) : t.runDetail.step.lateToday };
  }
  return { kind: 'open', label: vi.common.stepState[step.state] };
}

export type ScheduleInfo = { late: boolean; done: boolean; label: string };

/** Dòng trạng thái của một lượt ở M4: "Đúng tiến độ", "Chậm 2 ngày làm việc". */
export function scheduleLine(run: Pick<RunSummary, 'state' | 'schedule'>): ScheduleInfo {
  const c = t.progress.card;
  if (run.state === 'cancelled') return { late: false, done: true, label: c.cancelled };
  if (run.state === 'completed' || run.schedule.status === 'done') return { late: false, done: true, label: c.completed };
  if (run.schedule.status === 'late') {
    return { late: true, done: false, label: run.schedule.lateWorkingDays > 0 ? fmt(c.late, { n: run.schedule.lateWorkingDays }) : c.lateToday };
  }
  return { late: false, done: false, label: c.onTrack };
}

/** Việc đang chậm của một lượt: nút "Nhờ trợ lý đi thúc những việc chậm" chỉ có nghĩa khi có ít nhất một việc. */
export function lateSteps<T extends Pick<StepView, 'isOverdue' | 'state'>>(steps: readonly T[]): T[] {
  return steps.filter((s) => s.isOverdue && s.state !== 'done');
}

/** Lượt chậm nhiều nhất đứng trước, rồi tới lượt mới bắt đầu (SPEC 7.5: danh sách việc chậm sắp theo số ngày trễ). */
export function sortRuns<T extends Pick<RunSummary, 'schedule' | 'startedAt'>>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => {
    const lateA = a.schedule.status === 'late' ? 1 : 0;
    const lateB = b.schedule.status === 'late' ? 1 : 0;
    if (lateA !== lateB) return lateB - lateA;
    if (a.schedule.lateWorkingDays !== b.schedule.lateWorkingDays) return b.schedule.lateWorkingDays - a.schedule.lateWorkingDays;
    return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
  });
}

/** Mục Cần Chủ tịch biết chỉ hiện chừng này việc chậm nhất; còn lại mở bằng một chạm (nhiều việc chậm không được đẩy thẻ lượt khỏi màn hình đầu). */
export const ATTENTION_PREVIEW = 2;

/** Việc chậm nhất đứng trước. Trả về các dòng sẽ hiện và số việc đang ẩn. */
export function attentionPreview<T extends Pick<StepView, 'lateWorkingDays'>>(steps: readonly T[], showAll: boolean): { shown: T[]; hidden: number } {
  const sorted = [...steps].sort((a, b) => b.lateWorkingDays - a.lateWorkingDays);
  if (showAll || sorted.length <= ATTENTION_PREVIEW) return { shown: sorted, hidden: 0 };
  return { shown: sorted.slice(0, ATTENTION_PREVIEW), hidden: sorted.length - ATTENTION_PREVIEW };
}
