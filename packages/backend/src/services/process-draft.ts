import {
  PROCESS_DRAFT_MAX_STEPS,
  buildDraftDefinition,
  type DefinitionIssue,
  type DraftDefinition,
  type DraftProblem,
  type DraftStepArgs,
  type ResolvedDraftStep,
} from '@mihato/domain';
import { normalizeText, stripDiacritics } from '@mihato/domain/vi-normalize';
import { vi } from '@mihato/i18n';
import { validate } from '@mihato/workflow-engine';
import { and, eq, isNull } from 'drizzle-orm';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';

/**
 * Quy trình soạn bằng hội thoại (docs/DECISIONS.md, 04/10/2026): kiểm các bước AI gửi lên, tra người, rồi dựng bản nháp.
 * Không có chữ nào của LLM đi vào câu xác nhận: tên việc và tên quy trình chỉ là dữ liệu nằm trong ngoặc ở câu do máy chủ dựng.
 */

/** Chữ người dùng nói: dạng NFC, bỏ ký tự điều khiển, gộp khoảng trắng. Chỉ là dữ liệu, không bao giờ là chỉ thị. */
const clean = (s: string): string => s.normalize('NFC').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const fold = (s: string): string => stripDiacritics(normalizeText(s));

export type DraftAnalysis = {
  name: string;
  /** các bước đã kiểm đủ và đã tra người; rỗng khi còn lỗi (chưa đủ để dựng) */
  steps: ResolvedDraftStep[];
  problems: DraftProblem[];
};

/**
 * Kiểm danh sách bước theo tầm nhìn của danh bạ tổ chức. Lỗi trả theo từng bước và từng ô (thiếu hạn, thiếu người…) để trợ lý hỏi
 * đúng chỗ còn thiếu; không ném lỗi. Người phải còn dùng được: id lạ hay người đã bị vô hiệu hoá là `person_unavailable`.
 */
export function analyzeDraft(ctx: OrgContext, input: { name: string; steps: readonly DraftStepArgs[] }): DraftAnalysis {
  const problems: DraftProblem[] = [];
  const name = clean(input.name);
  if (name === '') problems.push({ step: null, field: 'name', code: 'name_missing' });
  if (input.steps.length === 0) problems.push({ step: null, field: 'steps', code: 'no_steps' });
  if (input.steps.length > PROCESS_DRAFT_MAX_STEPS) problems.push({ step: null, field: 'steps', code: 'too_many_steps' });

  const steps: ResolvedDraftStep[] = [];
  input.steps.slice(0, PROCESS_DRAFT_MAX_STEPS).forEach((raw, i) => {
    const n = i + 1;
    let complete = true;
    const fail = (field: DraftProblem['field'], code: string) => {
      problems.push({ step: n, field, code });
      complete = false;
    };

    const title = clean(raw.title);
    if (title === '') fail('title', 'title_missing');

    let assignee: ResolvedDraftStep['assignee'] | null = null;
    const a = raw.assignee;
    if (!a) fail('assignee', 'assignee_missing');
    else if (a.kind === 'person') {
      if (!a.personId) fail('assignee', 'assignee_missing');
      else {
        const user = ctx.users.get(a.personId);
        if (!user || user.status === 'disabled') fail('assignee', 'person_unavailable');
        else assignee = { kind: 'person', userId: user.id };
      }
    } else if (a.kind === 'role') {
      if (!a.role) fail('assignee', 'assignee_missing');
      else assignee = { kind: 'role', role: a.role };
    } else if (a.kind === 'initiator') assignee = { kind: 'initiator' };
    else fail('assignee', 'assignee_missing'); // unknown: chưa nói ai làm

    // 0 là giá trị quy ước của schema gửi cho Claude: người dùng chưa nói hạn.
    if (raw.dueDays === undefined || raw.dueDays === 0) fail('dueDays', 'due_missing');
    else if (raw.dueDays < 1 || raw.dueDays > 365) fail('dueDays', 'due_invalid');

    if (complete && assignee && raw.dueDays !== undefined) steps.push({ title, kind: raw.kind ?? 'task', assignee, dueDays: raw.dueDays, parallel: raw.parallel === true });
  });

  return { name, steps: problems.length === 0 ? steps : [], problems };
}

/** Đã có quy trình chưa lưu trữ trùng tên (không phân biệt hoa thường và dấu): hai mẫu trùng tên làm `search_templates` mơ hồ. */
export async function nameTaken(tx: Tx, name: string): Promise<boolean> {
  const rows = await tx.select({ name: schema.processTemplates.name }).from(schema.processTemplates).where(and(isNull(schema.processTemplates.archivedAt), eq(schema.processTemplates.kind, 'process')));
  const target = fold(name);
  return rows.some((r) => fold(r.name) === target);
}

/** Bản nháp dựng từ các bước đã kiểm; nhãn nút Bắt đầu và Hoàn tất lấy từ kho chuỗi chung như mẫu trống ở trình thiết kế. */
export function definitionOf(draft: { name: string; steps: readonly ResolvedDraftStep[] }): DraftDefinition {
  return buildDraftDefinition(draft, { start: vi.common.nodeKind.start, end: vi.common.nodeKind.end });
}

/** `validate()` của engine trên bản nháp vừa dựng. Bộ dựng luôn ra đúng cấu trúc, nên lỗi ở đây là lỗi mã, không phải lỗi người nói. */
export function definitionIssues(ctx: OrgContext, def: DraftDefinition): DefinitionIssue[] {
  return validate(def, { now: clock.now(), calendar: ctx.calendar }).errors;
}

/** Lỗi theo bước đổi thành `errors[]` của ApiError: `args.steps.<chỉ số từ 0>.<ô>`. */
export const problemErrors = (problems: readonly DraftProblem[]): { path: string; code: string }[] =>
  problems.map((p) => ({ path: p.step === null ? `args.${p.field}` : `args.steps.${p.step - 1}.${p.field}`, code: p.code }));
