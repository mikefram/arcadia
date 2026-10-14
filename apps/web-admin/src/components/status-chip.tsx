import { Ban, Check, Circle, CircleDot, CircleSlash, Hourglass, Play, SkipForward, TriangleAlert, UserRoundX, X, type LucideIcon } from 'lucide-react';
import type { RunSummary, StepStateName, StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';

const t = vi.admin.shell.status;

const chip = 'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-sm font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0';
const plain = 'border border-line bg-surface text-ink';
const done = 'bg-primary-tint text-on-primary-tint';
const late = 'bg-late-bg text-late font-semibold';

/** Mỗi trạng thái một hình riêng: phân biệt bằng chữ và hình, không chỉ bằng màu (SPEC 7.3). */
const STEP_ICON: Record<StepStateName, LucideIcon> = {
  pending: Hourglass,
  unassigned: UserRoundX,
  ready: Circle,
  in_progress: CircleDot,
  done: Check,
  rejected: X,
  skipped: SkipForward,
  cancelled: Ban,
};

export type StatusChipProps = {
  /** truyền cả việc, hoặc từng trường */
  step?: Pick<StepView, 'state' | 'isOverdue' | 'lateWorkingDays'>;
  state?: StepStateName;
  isOverdue?: boolean;
  lateWorkingDays?: number;
  className?: string;
};

/**
 * Trạng thái của một việc. Xong: nền xanh nhạt, dấu tích. Quá hạn: nền nâu đỏ nhạt, dấu cảnh báo,
 * chữ "Quá hạn n ngày". Còn lại: nền trắng viền xám, khác nhau ở chữ và hình.
 */
export function StatusChip({ step, state = step?.state, isOverdue = step?.isOverdue ?? false, lateWorkingDays = step?.lateWorkingDays ?? 0, className }: StatusChipProps) {
  if (!state) return null;
  if (isOverdue) {
    return (
      <span className={cn(chip, late, className)}>
        <TriangleAlert aria-hidden="true" />
        {lateWorkingDays > 0 ? fmt(t.late, { n: lateWorkingDays }) : t.lateToday}
      </span>
    );
  }
  const Icon = STEP_ICON[state];
  return (
    <span className={cn(chip, state === 'done' ? done : plain, className)}>
      <Icon aria-hidden="true" />
      {vi.common.stepState[state]}
    </span>
  );
}

export type RunStatusChipProps = { run: Pick<RunSummary, 'state' | 'outcome' | 'schedule'>; className?: string };

/** Trạng thái của một lượt chạy; đang chạy mà có việc quá hạn thì hiện "Chậm n ngày". */
export function RunStatusChip({ run, className }: RunStatusChipProps) {
  if (run.state === 'running' && run.schedule.status === 'late') {
    return (
      <span className={cn(chip, late, className)}>
        <TriangleAlert aria-hidden="true" />
        {run.schedule.lateWorkingDays > 0 ? fmt(t.runLate, { n: run.schedule.lateWorkingDays }) : vi.common.schedule.lateToday}
      </span>
    );
  }
  if (run.state === 'completed') {
    const rejected = run.outcome === 'rejected';
    return (
      <span className={cn(chip, rejected ? plain : done, className)}>
        {rejected ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
        {rejected ? vi.common.runOutcome.rejected : vi.common.runState.completed}
      </span>
    );
  }
  const Icon = run.state === 'running' ? Play : run.state === 'cancelled' ? Ban : run.state === 'failed' ? CircleSlash : Circle;
  return (
    <span className={cn(chip, plain, className)}>
      <Icon aria-hidden="true" />
      {vi.common.runState[run.state]}
    </span>
  );
}
