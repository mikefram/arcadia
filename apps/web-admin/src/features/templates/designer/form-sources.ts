import type { DocSpec, DraftDefinition, DraftNode, FormField } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { nodeTitle } from './model';

/**
 * Các hàm thuần tra nguồn dữ liệu của bản vẽ: người được chọn ở bước trước (`step_field`, `form_field`) và dữ liệu đưa vào
 * tệp Word tổng hợp (`compile`). Cùng luật với validate() của engine, để trình thiết kế chỉ cho chọn những gì hợp lệ.
 */

const c = vi.admin.designer.editor.panel.task.compile;

// ───────────────────────── Bước đứng trước ─────────────────────────

/**
 * Các bước đứng trước một bước: mọi bước đi ngược theo đường nối tới được, không tính chính nó.
 * Đi ngược cả đường "Chưa đồng ý" quay lại (giống validate() của engine).
 */
export function precedingNodeIds(def: DraftDefinition, nodeId: string): Set<string> {
  const ids = new Set(def.nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const e of def.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(nodeId) ?? [])];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(incoming.get(id) ?? []));
  }
  seen.delete(nodeId);
  return seen;
}

// ───────────────────────── Người được chọn ở bước trước ─────────────────────────

/** Một ô chọn người của một bước đứng trước, dùng làm nguồn cho quy tắc `step_field`. */
export type StepFieldOption = { node: DraftNode; field: FormField };

const isPersonField = (f: FormField, multi: boolean): boolean => f.type === 'user' || (multi && f.type === 'users');

/**
 * Các ô chọn người của những việc đứng trước `nodeId`. Nơi nhận một người (việc, người nhận khi leo thang) chỉ nhận ô `user`;
 * nơi nhận nhiều người (bước duyệt, bước góp nội dung, thông báo) nhận cả ô `users`.
 * Chỉ lấy biểu mẫu kết quả của việc: kết quả của bước duyệt và góp nội dung được gom theo từng người nên không dùng để giao việc.
 */
export function stepFieldOptions(def: DraftDefinition, nodeId: string, multi: boolean): StepFieldOption[] {
  const before = precedingNodeIds(def, nodeId);
  const out: StepFieldOption[] = [];
  for (const node of def.nodes) {
    if (node.type !== 'task' || !before.has(node.id)) continue;
    for (const field of node.form ?? []) if (isPersonField(field, multi)) out.push({ node, field });
  }
  return out;
}

/** Các ô chọn người của biểu mẫu khởi chạy, cho quy tắc `form_field`. */
export function inputPersonFields(def: DraftDefinition, multi: boolean): FormField[] {
  return def.inputs.filter((f) => isPersonField(f, multi));
}

// ───────────────────────── Dữ liệu đưa vào tệp Word tổng hợp ─────────────────────────

export type CompileSourceGroup = 'inputs' | 'self' | 'steps' | 'responses';
export type CompileSource = { ref: string; label: string; group: CompileSourceGroup; field: FormField };

/**
 * Các nguồn một mục của tệp Word tổng hợp lấy được, theo thứ tự hiện trên danh sách chọn: ô của biểu mẫu khởi chạy,
 * ô kết quả của chính việc đang tổng hợp, ô kết quả của các việc đứng trước, và phần của từng người ở các bước duyệt hoặc góp nội dung đứng trước.
 */
export function compileSources(def: DraftDefinition, nodeId: string): CompileSource[] {
  const out: CompileSource[] = [];
  for (const field of def.inputs) out.push({ ref: `inputs.${field.key}`, label: fmt(c.sourceInput, { tên: field.label }), group: 'inputs', field });
  const before = precedingNodeIds(def, nodeId);
  const self = def.nodes.find((n) => n.id === nodeId);
  for (const node of self ? [self, ...def.nodes.filter((n) => before.has(n.id))] : def.nodes.filter((n) => before.has(n.id))) {
    if (node.type === 'task') {
      for (const field of node.form ?? []) {
        const mine = node.id === nodeId;
        out.push({
          ref: `steps.${node.id}.${field.key}`,
          label: fmt(mine ? c.sourceSelf : c.sourceStep, { tên: field.label, việc: nodeTitle(node) }),
          group: mine ? 'self' : 'steps',
          field,
        });
      }
    } else if (node.type === 'approval') {
      for (const field of node.form ?? []) {
        out.push({ ref: `responses.${node.id}.${field.key}`, label: fmt(c.sourceResponses, { tên: field.label, việc: nodeTitle(node) }), group: 'responses', field });
      }
    }
  }
  return out;
}

/** Tách `inputs.<ô>`, `steps.<bước>.<ô>`, `responses.<bước>.<ô>`; null khi không đúng dạng. */
export function parseCompileRef(ref: string): { root: 'inputs' | 'steps' | 'responses'; node?: string; field: string } | null {
  const [root, a, b, extra] = ref.split('.');
  if (extra !== undefined || !a) return null;
  if (root === 'inputs' && b === undefined) return { root, field: a };
  if ((root === 'steps' || root === 'responses') && b) return { root, node: a, field: b };
  return null;
}

/** Dòng gợi ý chèn vào tiêu đề: mỗi ô của biểu mẫu khởi chạy là một `{mã ô}`. */
export function titleTokens(def: DraftDefinition): { token: string; label: string }[] {
  return def.inputs.map((f) => ({ token: `{${f.key}}`, label: f.label }));
}

/** Chèn `token` vào `text` tại vị trí con trỏ (hoặc cuối chữ), thêm dấu cách ngăn với chữ liền trước và liền sau nếu cần. */
export function insertToken(text: string, token: string, caret?: number): { text: string; caret: number } {
  const at = caret === undefined || caret < 0 || caret > text.length ? text.length : caret;
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const tail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  const inserted = `${before}${lead}${token}`;
  return { text: `${inserted}${tail}${after}`, caret: inserted.length };
}

/** Cấu hình tệp tổng hợp khi mới bật: khổ công văn, chưa có mục nào. */
export function defaultCompile(): DocSpec {
  return { layout: 'official', title: c.defaultTitle, sections: [] };
}

/** Cấu hình tệp tổng hợp đọc từ nháp lỏng có thể thiếu phần: điền mặc định để bộ sửa không vỡ. Chỉ ghi lại khi người vẽ sửa. */
export function normalizeCompile(spec: DocSpec): DocSpec {
  return {
    ...spec,
    layout: spec.layout === 'report' ? 'report' : 'official',
    title: typeof spec.title === 'string' ? spec.title : '',
    sections: Array.isArray(spec.sections) ? spec.sections : [],
  };
}

/** Đổi chỗ phần tử `index` đi `delta` bước; ra ngoài mảng thì giữ nguyên. */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}
