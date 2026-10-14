import type { PersonRef, RunEventView } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { personName } from './person';

const t = vi.admin.shell.timeline;
const tr = vi.admin.runs.timeline;
const tl = vi.timeline;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Tham số của sự kiện có thể nằm thẳng trong payload hoặc trong payload.event (dòng run_events gốc). */
function param(payload: Record<string, unknown>, name: string): unknown {
  if (name in payload) return payload[name];
  const event = payload.event;
  return isRecord(event) ? event[name] : undefined;
}

function isPerson(v: unknown): v is PersonRef {
  return isRecord(v) && typeof v.fullName === 'string' && typeof v.givenName === 'string';
}

/** `payload.people`: id → PersonRef của mọi người được nhắc tới trong sự kiện. */
function peopleOf(payload: Record<string, unknown>): Map<string, PersonRef> {
  const out = new Map<string, PersonRef>();
  if (isRecord(payload.people)) for (const [id, p] of Object.entries(payload.people)) if (isPerson(p)) out.set(id, p);
  return out;
}

/** `payload.stepTitles`: id việc → tên việc, cho các việc được nhắc tới trong thay đổi dẫn xuất. */
function titlesOf(payload: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  if (isRecord(payload.stepTitles)) for (const [id, title] of Object.entries(payload.stepTitles)) if (typeof title === 'string') out.set(id, title);
  return out;
}

function changesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(payload.changes) ? payload.changes.filter(isRecord) : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function instant(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** "anh Tuấn", "anh Tuấn và chị Lan", "anh Tuấn, chị Lan và ông Huy" */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${tr.and} ${names[names.length - 1]}`;
}

export type TimelineText = {
  /** chủ thể đứng đầu câu: "Chị Lan", "Hệ thống" */
  actor: string;
  /** hành động: "báo hoàn thành việc" */
  action: string;
  /** tên việc, nếu sự kiện gắn với một việc */
  stepTitle: string | null;
  /** phần đuôi: "đến 15/10/2026 17:00", "cho chị Lan" */
  tail: string | null;
};

type TimelineEvent = Pick<RunEventView, 'type' | 'actorType' | 'actor' | 'stepTitle' | 'payload'>;

/**
 * Dựng câu chữ cho một dòng hoạt động từ `type` và `payload` (máy chủ không gửi câu dựng sẵn).
 * Dùng cho "Hoạt động gần đây" ở Tổng quan và dòng thời gian của lượt chạy.
 * Người được nhắc tới (giao lại cho ai, đi thúc ai, nhắc tới ai) lấy ở `payload.people`.
 */
export function describeEvent(ev: TimelineEvent): TimelineText {
  let actor: string;
  if (ev.actorType === 'system') actor = t.system;
  else if (ev.actorType === 'ai') actor = ev.actor ? fmt(t.viaAssistant, { tên: personName(ev.actor, 'short', true) }) : t.assistant;
  else actor = ev.actor ? personName(ev.actor, 'short', true) : t.someone;

  let action: string = t.unknown;
  let tail: string | null = null;

  if (ev.type === 'TimerFired') {
    const kind = param(ev.payload, 'kind');
    action = typeof kind === 'string' && kind in t.timer ? t.timer[kind as keyof typeof t.timer] : t.timer.reminder;
  } else if (ev.type === 'ApproveStep' && isRecord(param(ev.payload, 'result')) && Object.keys(param(ev.payload, 'result') as object).length > 0) {
    // Có biểu mẫu kèm theo: người này gửi phần của mình ở bước đóng góp, không chỉ "đồng ý".
    action = t.contributed;
  } else if (ev.type in t.events) {
    action = t.events[ev.type as keyof typeof t.events];
  }

  const people = peopleOf(ev.payload);
  const short = (id: unknown): string | null => {
    const person = typeof id === 'string' ? people.get(id) : undefined;
    return person ? personName(person, 'short') : null;
  };

  if (ev.type === 'ExtendDue' || ev.type === 'RequestExtension') {
    const due = instant(param(ev.payload, ev.type === 'ExtendDue' ? 'newDueAt' : 'proposedDueAt'));
    if (due) tail = fmt(t.until, { ngày: formatDateTime(due) });
  } else if (ev.type === 'Reassign' || ev.type === 'AssignStep') {
    const to = short(param(ev.payload, 'toUserId'));
    if (to) tail = fmt(tr.toPerson, { tên: to });
  } else if (ev.type === 'NudgeSent') {
    const to = short(param(ev.payload, 'toUserId'));
    if (to) tail = fmt(tr.sentTo, { tên: to });
  } else if (ev.type === 'ReportBlocked') {
    const code = param(ev.payload, 'reasonCode');
    if (typeof code === 'string' && code in vi.common.blockReason) {
      tail = fmt(tr.because, { 'lý do': vi.common.blockReason[code as keyof typeof vi.common.blockReason] });
    }
  } else if (ev.type === 'TimerFired') {
    // Lời nhắc tự động gửi tới ai: lấy ở thay đổi dẫn xuất `reminder.sent`.
    const names: string[] = [];
    for (const change of changesOf(ev.payload)) {
      if (change.type !== 'reminder.sent' || !Array.isArray(change.toUserIds)) continue;
      for (const id of change.toUserIds) {
        const name = short(id);
        if (name && !names.includes(name)) names.push(name);
      }
    }
    if (names.length > 0) tail = fmt(tr.sentTo, { tên: joinNames(names) });
  }

  return { actor, action, stepTitle: ev.stepTitle, tail };
}

/**
 * Các thay đổi dẫn xuất đáng nói thêm dưới câu chính của một sự kiện: việc nào vừa được giao cho ai và hạn nào,
 * hạn đổi từ đâu sang đâu, lượt chạy kết thúc ra sao. Câu lấy ở `vi.timeline`; tên người ở `payload.people`,
 * tên việc ở `payload.stepTitles`. Thay đổi mà câu chính đã nói rồi thì bỏ qua.
 */
export function describeChanges(ev: TimelineEvent & Partial<Pick<RunEventView, 'stepId'>>): string[] {
  const people = peopleOf(ev.payload);
  const titles = titlesOf(ev.payload);
  const eventStepId = ev.stepId ?? str(param(ev.payload, 'stepId'));

  const person = (id: unknown): string => {
    const found = typeof id === 'string' ? people.get(id) : undefined;
    return found ? personName(found, 'short') : tr.unknownPerson;
  };
  const title = (id: unknown): string => (typeof id === 'string' ? titles.get(id) : undefined) ?? (id === eventStepId ? ev.stepTitle : null) ?? tr.unknownStep;
  const stateLabel = (state: unknown): string | null =>
    typeof state === 'string' && state in vi.common.stepState ? vi.common.stepState[state as keyof typeof vi.common.stepState] : null;

  const lines: string[] = [];
  for (const c of changesOf(ev.payload)) {
    switch (c.type) {
      case 'step.activated': {
        // Nút không giao cho người (bắt đầu, rẽ nhánh, hẹn giờ) không có trong danh sách tên việc.
        if (typeof c.stepId !== 'string' || !titles.has(c.stepId)) break;
        const due = instant(c.dueAt);
        const việc = title(c.stepId);
        if (typeof c.assigneeId !== 'string') {
          if (c.state === 'unassigned') lines.push(fmt(tl.detail.stepActivated.unassigned, { việc }));
        } else if (typeof c.onBehalfOfId === 'string' && due) {
          lines.push(fmt(tl.detail.stepActivated.onBehalfOf, { việc, người: person(c.assigneeId), 'người ủy quyền': person(c.onBehalfOfId), hạn: formatDateTime(due) }));
        } else if (due) {
          lines.push(fmt(tl.detail.stepActivated.assigned, { việc, người: person(c.assigneeId), hạn: formatDateTime(due) }));
        } else {
          lines.push(fmt(tl.detail.stepActivated.assignedNoDue, { việc, người: person(c.assigneeId) }));
        }
        break;
      }
      case 'step.state': {
        // Chỉ nói khi một việc KHÁC việc của sự kiện bị bỏ qua hoặc chưa được đồng ý do lan truyền.
        if (c.stepId === eventStepId || (c.to !== 'skipped' && c.to !== 'rejected')) break;
        if (typeof c.stepId !== 'string' || !titles.has(c.stepId)) break;
        const from = stateLabel(c.from);
        const to = stateLabel(c.to);
        if (from && to) lines.push(fmt(tl.change['step.state'], { việc: title(c.stepId), từ: from, đến: to }));
        break;
      }
      case 'step.assignee': {
        const việc = title(c.stepId);
        if (typeof c.onBehalfOfId === 'string' && typeof c.to === 'string') {
          lines.push(fmt(tl.detail.stepAssignee.onBehalfOf, { việc, đến: person(c.to), 'người ủy quyền': person(c.onBehalfOfId) }));
        } else if (ev.type !== 'Reassign' && ev.type !== 'AssignStep' && ev.type !== 'UnassignStep') {
          if (typeof c.from === 'string' && typeof c.to === 'string') lines.push(fmt(tl.detail.stepAssignee.changed, { việc, từ: person(c.from), đến: person(c.to) }));
          else if (typeof c.to === 'string') lines.push(fmt(tl.detail.stepAssignee.assigned, { việc, đến: person(c.to) }));
          else if (typeof c.from === 'string') lines.push(fmt(tl.detail.stepAssignee.cleared, { việc, từ: person(c.from) }));
        }
        break;
      }
      case 'step.due': {
        const to = instant(c.to);
        if (!to) break;
        const from = instant(c.from);
        const việc = title(c.stepId);
        lines.push(from ? fmt(tl.detail.stepDue.changed, { việc, từ: formatDateTime(from), đến: formatDateTime(to) }) : fmt(tl.detail.stepDue.set, { việc, đến: formatDateTime(to) }));
        break;
      }
      case 'run.completed': {
        if (c.outcome === 'success' || c.outcome === 'rejected') lines.push(tl.detail.runCompleted[c.outcome]);
        break;
      }
      case 'extension.decided': {
        if (ev.type === 'ExtendDue' && c.decision === 'approved') lines.push(fmt(tl.detail.extensionDecided.approved, { việc: title(c.stepId) }));
        break;
      }
      case 'nudge.replied': {
        if (c.reply === 'done' || c.reply === 'need_time' || c.reply === 'blocked') {
          const người = ev.actor ? personName(ev.actor, 'short', true) : t.someone;
          lines.push(fmt(tl.detail.nudgeReplied[c.reply], { người, việc: title(c.stepId) }));
        }
        break;
      }
      case 'reminder.suppressed': {
        if (typeof c.why === 'string' && c.why in tl.detail.reminderSuppressed) {
          lines.push(fmt(tl.detail.reminderSuppressed[c.why as keyof typeof tl.detail.reminderSuppressed], { việc: title(c.stepId) }));
        }
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

/** Chữ do người nhập kèm sự kiện: lý do, ghi chú, ý kiến, lời đi thúc. Không có thì trả null. */
export function eventNote(ev: Pick<RunEventView, 'payload'>): string | null {
  for (const key of ['reason', 'note', 'comment', 'text', 'message'] as const) {
    const value = str(param(ev.payload, key));
    if (value) return value;
  }
  return null;
}
