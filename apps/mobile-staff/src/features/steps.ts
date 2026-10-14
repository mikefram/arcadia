import type { Bucket, PersonRef, StepView } from '@mihato/domain';
import { fmt, formatDateWeekday, formatRelativeDay, formatTime, vi, vnDateKey, type DateInput } from '@mihato/i18n';
import type { ChipTone } from '../ui/Chip';
import type { GlyphName } from '../ui/Glyph';

/** Hàm thuần để dựng chữ và nhóm việc cho S1, S2, S8. Không phụ thuộc React Native; có test. */

const t = vi.staff;

/** "chị Nguyễn Thu Lan": xưng hô kèm họ tên (SPEC 7.5). Tài khoản dùng chung không có xưng hô thì chỉ có tên. */
export function personName(p: PersonRef | null | undefined): string | null {
  if (!p) return null;
  return p.honorific ? `${vi.common.honorific[p.honorific]} ${p.fullName}` : p.fullName;
}

/** "hôm nay, 17:00", "ngày mai, 17:00" hoặc "Thứ Năm 15/10/2026, 17:00". Giờ 24 giờ, theo giờ Việt Nam. */
export function dueText(dueAt: DateInput, now: DateInput): string {
  return fmt(t.format.dayTime, { ngày: formatRelativeDay(dueAt, now), giờ: formatTime(dueAt) });
}

/** Ngày giờ đầy đủ, không rút thành "hôm nay": dùng cho lịch sử và hạn gốc. */
export function dateTimeText(at: DateInput): string {
  return fmt(t.format.dayTime, { ngày: formatDateWeekday(at), giờ: formatTime(at) });
}

export const TODO_BUCKETS = ['overdue', 'today', 'upcoming'] as const satisfies readonly Bucket[];
export type TodoBucket = (typeof TODO_BUCKETS)[number];

export type StepGroup = { bucket: TodoBucket; title: string; steps: StepView[] };

function byDue(a: StepView, b: StepView): number {
  if (a.dueAt === b.dueAt) return a.id < b.id ? -1 : 1;
  if (a.dueAt === null) return 1;
  if (b.dueAt === null) return -1;
  return a.dueAt < b.dueAt ? -1 : 1;
}

/**
 * Tab Cần làm: chia nhóm Quá hạn, Hôm nay, Sắp tới theo `bucket` do MÁY CHỦ tính (theo lịch làm việc, SPEC 4.5),
 * trong mỗi nhóm sắp theo hạn, việc chưa có hạn xuống cuối. Nhóm trống thì không hiện.
 */
export function groupTodo(steps: readonly StepView[]): StepGroup[] {
  return TODO_BUCKETS.map((bucket) => ({
    bucket,
    title: t.myWork.groups[bucket],
    steps: steps.filter((s) => s.bucket === bucket).sort(byDue),
  })).filter((g) => g.steps.length > 0);
}

export type StepChip = { key: string; label: string; tone: ChipTone; glyph?: GlyphName };

/**
 * Chip trạng thái của một việc. Trạng thái luôn có chữ; quá hạn có thêm nền nâu đỏ nhạt và dấu cảnh báo,
 * xong có nền xanh nhạt và dấu tích, còn lại nền trắng viền xám, chỉ khác chữ (SPEC 7.3).
 */
export function stepChips(step: StepView, opts: { queued: boolean; awaitingOthers?: boolean }): StepChip[] {
  const chips: StepChip[] = [];
  if (opts.queued) chips.push({ key: 'queued', label: t.myWork.chips.queued, tone: 'waiting', glyph: 'send' });
  // Mình đã gửi phần của mình, việc còn mở vì người khác chưa gửi: không còn việc gì cho mình làm.
  if (opts.awaitingOthers) {
    chips.push({ key: 'awaiting', label: t.myWork.chips.awaitingOthers, tone: 'waiting' });
    return chips;
  }
  if (step.isOverdue) {
    chips.push({ key: 'late', label: step.lateWorkingDays > 0 ? fmt(t.myWork.card.late, { n: step.lateWorkingDays }) : t.myWork.card.lateToday, tone: 'late' });
  } else if (step.bucket === 'today') {
    chips.push({ key: 'today', label: t.myWork.card.dueToday, tone: 'warn' });
  }
  // Bước đóng góp không có "Đồng ý, Chưa đồng ý": mỗi người gửi phần của mình.
  const needs = step.action === 'contribute' ? t.myWork.card.needsContribution : t.myWork.card.needsApproval;
  if (step.state === 'done') chips.push({ key: 'state', label: vi.common.stepState.done, tone: 'done' });
  else if (step.kind === 'approval' && (step.state === 'ready' || step.state === 'in_progress')) chips.push({ key: 'state', label: needs, tone: 'neutral' });
  else chips.push({ key: 'state', label: vi.common.stepState[step.state], tone: 'neutral' });
  if (step.pendingExtension) chips.push({ key: 'extension', label: t.myWork.chips.awaitingExtension, tone: 'waiting' });
  if (step.blockedReason) chips.push({ key: 'blocked', label: t.myWork.chips.blocked, tone: 'neutral' });
  return chips;
}

/** Câu đọc cho trình đọc màn hình của một thẻ việc: tên việc, trạng thái, hạn. */
/** Dòng cho biết việc thuộc đâu: tên lượt chạy, hoặc "Việc giao riêng" khi không thuộc quy trình nào. */
export function runLine(step: Pick<StepView, 'adhoc' | 'runTitle'>): string {
  return step.adhoc ? t.myWork.card.adhoc : fmt(t.myWork.card.run, { lượt: step.runTitle });
}

export function stepA11yLabel(step: StepView, now: DateInput, queued: boolean, awaitingOthers = false): string {
  return fmt(t.myWork.a11yCard, {
    việc: step.title,
    'trạng thái': stepChips(step, { queued, awaitingOthers })
      .map((c) => c.label)
      .join(', '),
    hạn: step.dueAt ? dueText(step.dueAt, now) : t.myWork.card.noDue,
  });
}

/**
 * Việc duyệt hoặc đóng góp còn mở mà người này đã gửi phần của mình (còn chờ người khác). Máy chủ không đưa loại việc này vào
 * "Cần làm" (không còn việc cho mình) cũng chưa phải "Đã xong", nên app tự lọc từ các việc duyệt đang mở mà người này thấy được.
 */
export function awaitingOthers(steps: readonly StepView[], myId: string | null | undefined): StepView[] {
  if (!myId) return [];
  return steps
    .filter(
      (s) =>
        s.kind === 'approval' &&
        (s.state === 'ready' || s.state === 'in_progress') &&
        (s.participants ?? []).some((p) => p.person.id === myId && p.decision === 'approved'),
    )
    .sort(byDue);
}

/**
 * Người giao việc để hiện ở thẻ và chi tiết: việc thường thì người giao; việc duyệt hoặc đóng góp thì người đề nghị (người làm việc
 * đứng ngay trước), không có thì người khởi chạy. `label` nói đúng vai: "Người giao" hay "Người đề nghị".
 */
export function giverOf(step: Pick<StepView, 'kind' | 'action' | 'assignedBy' | 'requestedBy'>): { person: PersonRef | null; label: 'assignedBy' | 'requestedBy' } {
  if (step.kind !== 'approval') return { person: step.assignedBy, label: 'assignedBy' };
  return { person: step.requestedBy ?? step.assignedBy, label: step.action === 'contribute' ? 'assignedBy' : 'requestedBy' };
}

/** Việc có ô bắt buộc trong biểu mẫu kết quả: báo hoàn thành phải điền trước khi gửi. */
export function hasRequiredForm(step: StepView): boolean {
  return step.form.some((f) => f.required);
}

/** Thời điểm UTC của một ngày lịch Việt Nam (YYYY-MM-DD) vào giờ `HH:mm` Việt Nam. */
export function vnInstant(dateKey: string, time: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, (hh ?? 0) - 7, mm ?? 0)).toISOString();
}

/** Hạn mới đề nghị: ngày được chọn, giữ giờ trong ngày của hạn hiện tại; chưa có hạn thì giờ tan làm (mặc định 17:00). */
export function proposedDueAt(dateKey: string, currentDueAt: string | null, endOfDay = '17:00'): string {
  return vnInstant(dateKey, currentDueAt ? formatTime(currentDueAt) : endOfDay);
}

/** Ngày sớm nhất được chọn khi xin thêm thời gian: sau hạn hiện tại và không trước hôm nay. */
export function minExtensionDate(currentDueAt: string | null, now: DateInput): string {
  const today = vnDateKey(now);
  if (!currentDueAt) return today;
  const next = vnDateKey(Date.parse(currentDueAt) + 86_400_000);
  return next > today ? next : today;
}
