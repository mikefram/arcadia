import type { FormField, PersonRef, RunDetail, StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { resultValueText } from './history';
import { personName } from './steps';

/**
 * Thông tin của lượt chạy cần để làm một việc (docs/DECISIONS.md, 06/10/2026): dữ liệu người khởi chạy đã điền, kết quả các
 * việc đã xong trước đó (ví dụ ý kiến chỉ đạo, người chủ trì) và phần của từng người ở các bước đóng góp đã xong.
 * Nguồn là `GET /v1/runs/:id` (máy chủ chỉ trả lượt chạy mà người này thấy được). Hàm thuần, có test.
 */
const t = vi.staff.stepDetail;

/** Một dòng "nhãn: giá trị". Ô tệp chỉ nói số tệp: danh sách tệp mở được nằm ở mục Tệp đính kèm của việc. */
export type ValueRow = { key: string; label: string; text: string };

/** Một khối dòng có tiêu đề: kết quả của một việc, hoặc phần của một người ở bước đóng góp. */
export type PartGroup = { key: string; title: string; rows: ValueRow[] };

export type RunContext = {
  startedBy: string | null;
  inputs: ValueRow[];
  previous: PartGroup[];
};

type RowContext = { people: ReadonlyMap<string, PersonRef> };

/** Mọi người có tên trong lượt chạy, theo id: người khởi chạy và những người ở các việc. Dùng để đọc ô chọn người. */
export function peopleOfRun(run: Pick<RunDetail, 'initiator' | 'steps'>): Map<string, PersonRef> {
  const people = new Map<string, PersonRef>();
  const add = (p: PersonRef | null | undefined) => {
    if (p) people.set(p.id, p);
  };
  add(run.initiator);
  for (const s of run.steps) {
    add(s.assignee);
    add(s.assignedBy);
    add(s.onBehalfOf);
    add(s.requestedBy);
    for (const p of s.participants ?? []) {
      add(p.person);
      add(p.onBehalfOf);
    }
  }
  return people;
}

/** Các dòng của một biểu mẫu đã điền, theo thứ tự ô; ô trống bị bỏ. Ô chọn người đọc tên theo `ctx.people`. */
export function valueRows(form: readonly FormField[], values: Record<string, unknown> | null | undefined, ctx: RowContext): ValueRow[] {
  if (!values) return [];
  const rows: ValueRow[] = [];
  for (const field of form) {
    const text = resultValueText(field, values[field.key], ctx.people);
    if (text !== null) rows.push({ key: field.key, label: field.label, text });
  }
  return rows;
}

/**
 * Bối cảnh của việc `currentStepId` trong lượt `run`: dữ liệu khởi chạy, kết quả các việc đã xong khác, và phần của từng người
 * ở bước đóng góp đã xong. Việc thường chỉ lấy kết quả của việc `task`; bước duyệt "Đồng ý, Chưa đồng ý" không có phần để đọc.
 */
export function buildRunContext(run: RunDetail, currentStepId: string): RunContext {
  const ctx: RowContext = { people: peopleOfRun(run) };
  const inputs = valueRows(run.inputForm ?? [], run.inputs, ctx);
  const previous: PartGroup[] = [];
  for (const step of run.steps) {
    if (step.id === currentStepId || step.state !== 'done') continue;
    if (step.kind === 'task') {
      const rows = valueRows(step.form, step.result, ctx);
      if (rows.length > 0) previous.push({ key: step.id, title: step.title, rows });
    } else if (step.action === 'contribute') {
      for (const part of step.participants ?? []) {
        if (part.decision !== 'approved') continue;
        const rows = valueRows(step.form, part.result, ctx);
        if (part.comment) rows.push({ key: 'comment', label: t.comment, text: part.comment });
        if (rows.length > 0) previous.push({ key: `${step.id}:${part.person.id}`, title: fmt(t.previousPart, { việc: step.title, người: personName(part.person) ?? t.unknownPerson }), rows });
      }
    }
  }
  return { startedBy: personName(run.initiator), inputs, previous };
}

/** Phần mà chính người xem đã gửi ở một bước đóng góp: biểu mẫu, ý kiến và tệp. Null khi chưa gửi hoặc không tìm thấy. */
export function myPartRows(step: Pick<StepView, 'form' | 'participants'>, myId: string | null | undefined, ctx: RowContext): ValueRow[] | null {
  if (!myId) return null;
  const mine = (step.participants ?? []).find((p) => (p.person.id === myId || p.onBehalfOf?.id === myId) && p.decision === 'approved');
  if (!mine) return null;
  const rows = valueRows(step.form, mine.result, ctx);
  if (mine.comment) rows.push({ key: 'comment', label: t.comment, text: mine.comment });
  return rows;
}
