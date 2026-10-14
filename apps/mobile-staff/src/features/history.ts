import { PersonRefSchema, type FormField, type NudgeView, type PersonRef, type StepDetail, type StepHistoryItem } from '@mihato/domain';
import { fmt, formatDate, formatMoney, vi } from '@mihato/i18n';
import { dateTimeText, personName } from './steps';

/**
 * Câu chữ của lịch sử một việc (S2): sự kiện, lời nhắc tự động, đi thúc và trả lời. Câu lấy từ `vi.timeline`,
 * cùng bộ câu với dòng thời gian trên web. Hàm thuần, có test.
 */
const tl = vi.timeline;
const t = vi.staff.stepDetail;

export type HistoryLine = {
  key: string;
  at: string;
  /** câu chính: ai làm gì */
  text: string;
  /** nội dung kèm theo: lý do, ghi chú, lời nhắc */
  quote: string | null;
  /** dòng nhỏ "do Trợ lý AI soạn" (SPEC 6.8, 11.7) */
  aiNote: string | null;
};

function actorName(item: StepHistoryItem): string {
  const name = personName(item.actor);
  if (item.actorType === 'system') return tl.actor.system;
  if (item.actorType === 'ai') return name ? fmt(tl.actor.ai, { người: name }) : vi.common.assistantLabel;
  return name ?? tl.actor.unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stateLabel(value: unknown): string {
  const states: Record<string, string> = vi.common.stepState;
  return (typeof value === 'string' ? states[value] : undefined) ?? tl.actor.unknown;
}

/** Tên của một người được nhắc tới trong sự kiện: `data.people` là bảng id → PersonRef do máy chủ kèm theo. */
function mentioned(data: Record<string, unknown>, id: unknown): string | null {
  const people = data.people;
  if (typeof id !== 'string' || typeof people !== 'object' || people === null) return null;
  const parsed = PersonRefSchema.safeParse((people as Record<string, unknown>)[id]);
  return parsed.success ? personName(parsed.data) : null;
}

function eventLine(item: StepHistoryItem, step: Pick<StepDetail, 'title' | 'runTitle'>): string {
  const vars: Record<string, string> = { người: actorName(item), việc: step.title, lượt: step.runTitle };
  const data = item.data;

  switch (item.code) {
    case 'step.activated': {
      const due = text(data.dueAt);
      const assignee = mentioned(data, data.assigneeId);
      const principal = mentioned(data, data.onBehalfOfId);
      if (data.assigneeId === null) return fmt(tl.detail.stepActivated.unassigned, vars);
      // Thiếu tên người nhận (bản lưu cũ chưa có `people`): nói gọn là việc tới lượt.
      if (!assignee) return due ? fmt(t.historyActivated, { hạn: dateTimeText(due) }) : t.historyActivatedNoDue;
      const who = { ...vars, người: assignee };
      if (!due) return fmt(tl.detail.stepActivated.assignedNoDue, who);
      if (principal) return fmt(tl.detail.stepActivated.onBehalfOf, { ...who, 'người ủy quyền': principal, hạn: dateTimeText(due) });
      return fmt(tl.detail.stepActivated.assigned, { ...who, hạn: dateTimeText(due) });
    }
    case 'step.state':
      return fmt(tl.change['step.state'], { ...vars, từ: stateLabel(data.from), đến: stateLabel(data.to) });
    case 'RequestExtension': {
      const due = text(data.proposedDueAt);
      return due ? fmt(tl.event.RequestExtension, { ...vars, hạn: dateTimeText(due) }) : fmt(t.historyGeneric, vars);
    }
    case 'ExtendDue': {
      const due = text(data.newDueAt);
      return due ? fmt(tl.event.ExtendDue, { ...vars, hạn: dateTimeText(due) }) : fmt(t.historyGeneric, vars);
    }
    case 'Reassign':
    case 'AssignStep': {
      const to = mentioned(data, data.toUserId);
      // Thiếu tên người nhận mới (bản lưu cũ chưa có `people`): nói gọn là đã đổi người nhận.
      return to ? fmt(tl.event[item.code], { ...vars, 'người nhận': to }) : fmt(t.historyReassigned, vars);
    }
    case 'AcceptStep':
    case 'CompleteStep':
    case 'ApproveStep':
    case 'RejectStep':
    case 'DeclineExtension':
    case 'SkipStep':
    case 'ReportBlocked':
    case 'UnassignStep':
    case 'CancelRun':
    case 'AddNote':
      return fmt(tl.event[item.code], vars);
    default:
      return fmt(t.historyGeneric, vars);
  }
}

export function historyLines(step: Pick<StepDetail, 'title' | 'runTitle' | 'history' | 'nudges'>): HistoryLine[] {
  const nudges = new Map<string, NudgeView>(step.nudges.map((n) => [n.id, n]));
  return step.history.map((item, index) => {
    const base = { key: `${item.at}-${index}`, at: item.at, aiNote: null as string | null };
    switch (item.type) {
      case 'reminder':
        return { ...base, text: item.text ?? fmt(tl.change['reminder.sent'], { việc: step.title }), quote: null };
      case 'nudge': {
        const nudge = nudges.get(text(item.data.nudgeId) ?? '');
        const sender = nudge?.senderName ?? tl.actor.system;
        return {
          ...base,
          text: fmt(t.nudge.from, { 'người gửi': sender }),
          quote: item.text,
          aiNote: nudge?.aiDisclosure ?? (item.data.aiDrafted === true ? tl.aiDrafted : null),
        };
      }
      case 'nudge_reply': {
        const replies: Record<string, string> = tl.detail.nudgeReplied;
        const template = replies[item.code];
        const vars = { người: actorName(item), việc: step.title };
        return { ...base, text: template ? fmt(template, vars) : fmt(t.historyGeneric, vars), quote: null };
      }
      case 'event':
        return { ...base, text: eventLine(item, step), quote: item.text };
    }
  });
}

/** Giá trị một ô trong biểu mẫu kết quả, viết ra chữ để đọc lại ở S2. */
export function resultValueText(field: FormField, value: unknown, people?: ReadonlyMap<string, PersonRef>): string | null {
  if (value === undefined || value === null || value === '') return null;
  switch (field.type) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value) : String(value);
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(`${value.slice(0, 10)}T00:00:00+07:00`) : String(value);
    case 'select':
      return field.options?.find((o) => o.value === value)?.label ?? String(value);
    // Người chưa tra được tên thì nói chung chung, không để lộ mã nội bộ.
    case 'user':
      return typeof value === 'string' ? (personName(people?.get(value)) ?? t.unknownPerson) : null;
    case 'users':
      return Array.isArray(value) && value.length > 0 ? value.map((id) => (typeof id === 'string' ? (personName(people?.get(id)) ?? t.unknownPerson) : t.unknownPerson)).join(', ') : null;
    case 'file':
      return Array.isArray(value) && value.length > 0 ? fmt(vi.staff.files.count, { n: value.length }) : null;
    case 'text':
    case 'longtext':
    case 'number':
    case 'autonumber':
      return String(value);
  }
}
