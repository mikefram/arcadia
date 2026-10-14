import {
  DEFAULT_CALENDAR,
  DraftDefinitionSchema,
  ProcessDefinitionSchema,
  VALIDATION_CODES,
  type DefinitionIssue,
  type DraftDefinition,
  type Edge,
  type ProcessDefinition,
  type ValidateResult,
  type WorkCalendar,
} from '@mihato/domain';
import { addWorkingDays, atLocalTime, toLocalDate } from '@mihato/domain/calendar';
import { exprRefs, parseRef } from './expr';
import { findBackEdges, reachable } from './graph';
import { planSchedule } from './plan';

/**
 * `validate()`: kiểm một định nghĩa quy trình trước khi xuất bản (SPEC 4.2).
 * Sáu điều chặn xuất bản (errors) và một điều chỉ cảnh báo (warnings). Mỗi mục có `code` ổn định ở
 * `VALIDATION_CODES`, `nodeId`/`edgeId` để trình thiết kế tô đỏ đúng chỗ, và `message` tiếng Việt cho người vẽ.
 */

/** Khi không truyền `now`: một sáng Thứ Hai cố định, chỉ để so các hạn với nhau (kết quả không phụ thuộc ngày thật). */
const SAMPLE_NOW = new Date('2026-01-05T01:00:00.000Z');
/** Mốc đích mẫu cho điều 7: cách lúc khởi chạy 10 ngày làm việc [GIẢ ĐỊNH]. */
const SAMPLE_LEAD_WORKING_DAYS = 10;

type LooseNode = { id: string; type: string; label: string } & Record<string, unknown>;

const FIELD_NAMES: Record<string, string> = {
  id: 'mã bước',
  type: 'loại bước',
  label: 'tên bước',
  title: 'tên việc',
  description: 'mô tả',
  join: 'cách hợp nhánh',
  mode: 'cách duyệt',
  wait: 'thời gian chờ',
  branches: 'các nhánh',
  to: 'người nhận tin',
  template: 'nội dung tin',
  url: 'địa chỉ gọi tới',
  bodyTemplate: 'nội dung gửi đi',
  form: 'biểu mẫu kết quả',
  action: 'cách xử lý (duyệt hoặc đóng góp)',
  compile: 'cấu hình xuất tệp tổng hợp',
  checklist: 'danh sách kiểm',
  reminders: 'cách nhắc',
  escalateTo: 'người nhận khi leo thang',
};

const q = (s: string): string => `“${s}”`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validate(draft: DraftDefinition | ProcessDefinition, opts: { now?: Date; calendar?: WorkCalendar } = {}): ValidateResult {
  const errors: DefinitionIssue[] = [];
  const warnings: DefinitionIssue[] = [];
  const seen = new Set<string>();
  const add = (list: DefinitionIssue[], issue: DefinitionIssue): void => {
    const key = `${issue.code}|${issue.nodeId ?? ''}|${issue.edgeId ?? ''}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(issue);
  };
  const error = (code: string, message: string, at: { nodeId?: string; edgeId?: string } = {}): void => add(errors, { code, message, ...at });

  // Bản lỏng: đủ để đọc được nút và cạnh. Hỏng tới mức này thì không kiểm tiếp được.
  const loose = DraftDefinitionSchema.safeParse(draft);
  if (!loose.success) {
    error(VALIDATION_CODES.schema, 'Bản vẽ quy trình bị hỏng hoặc thiếu phần bắt buộc (tên, các bước, các đường nối). Hãy mở lại bản vẽ và lưu lại.');
    return { errors, warnings, definition: null };
  }
  const nodes = loose.data.nodes as LooseNode[];
  const edges = loose.data.edges;
  const inputs = loose.data.inputs;
  const labelOf = (id: string): string => {
    const n = nodes.find((x) => x.id === id);
    return n && n.label.trim() !== '' ? n.label : id;
  };

  // ── Bản chặt: mọi trường của từng nút. Lỗi schema được đổi thành lỗi gắn với nút hoặc cạnh. ──
  const strict = ProcessDefinitionSchema.safeParse(draft);
  if (!strict.success) {
    for (const issue of strict.error.issues) {
      const [root, index, field] = issue.path;
      if (root === 'nodes' && typeof index === 'number' && nodes[index]) {
        const node = nodes[index];
        const label = labelOf(node.id);
        if (field === 'assignee' || field === 'approvers') {
          error(
            VALIDATION_CODES.assigneeMissing,
            node.type === 'approval'
              ? node['action'] === 'contribute'
                ? `Bước góp nội dung ${q(label)} chưa chọn người tham gia.`
                : `Bước duyệt ${q(label)} chưa chọn người duyệt.`
              : `Việc ${q(label)} chưa chọn người nhận.`,
            { nodeId: node.id },
          );
        } else if (field === 'due') {
          error(VALIDATION_CODES.dueMissing, `Việc ${q(label)} chưa đặt hạn.`, { nodeId: node.id });
        } else {
          const name = typeof field === 'string' ? (FIELD_NAMES[field] ?? field) : 'thông tin';
          error(VALIDATION_CODES.schema, `Bước ${q(label)} còn thiếu hoặc sai phần ${q(name)}.`, { nodeId: node.id });
        }
      } else if (root === 'edges' && typeof index === 'number' && edges[index]) {
        error(VALIDATION_CODES.schema, 'Có một đường nối chưa hợp lệ. Hãy xoá đường nối này và nối lại.', { edgeId: edges[index].id });
      } else if (root === 'name') {
        error(VALIDATION_CODES.schema, 'Quy trình chưa có tên.');
      } else if (root === 'inputs') {
        error(VALIDATION_CODES.schema, 'Biểu mẫu khởi chạy có ô chưa hợp lệ (thiếu tên ô, sai loại ô hoặc mã ô có ký tự lạ).');
      } else {
        error(VALIDATION_CODES.schema, 'Bản vẽ quy trình có phần chưa hợp lệ. Hãy kiểm tra lại các bước và đường nối.');
      }
    }
  }

  // ── Mã trùng, cạnh trỏ tới nút không tồn tại ──
  const nodeById = new Map<string, LooseNode>();
  for (const n of nodes) {
    if (nodeById.has(n.id)) error(VALIDATION_CODES.duplicateId, `Có hai bước dùng chung mã ${q(n.id)}. Mỗi bước phải có mã riêng.`, { nodeId: n.id });
    else nodeById.set(n.id, n);
  }
  const edgeIds = new Set<string>();
  const validEdges: Edge[] = [];
  for (const e of edges) {
    if (edgeIds.has(e.id)) {
      error(VALIDATION_CODES.duplicateId, `Có hai đường nối dùng chung mã ${q(e.id)}.`, { edgeId: e.id });
      continue;
    }
    edgeIds.add(e.id);
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) {
      error(VALIDATION_CODES.edgeUnknownNode, 'Có một đường nối tới bước không còn tồn tại. Hãy xoá đường nối này.', { edgeId: e.id });
      continue;
    }
    validEdges.push(e);
  }
  const inputKeys = new Map<string, { type: string; required: boolean }>();
  for (const f of inputs) {
    if (inputKeys.has(f.key)) error(VALIDATION_CODES.duplicateId, `Biểu mẫu khởi chạy có hai ô dùng chung mã ${q(f.key)}.`);
    else inputKeys.set(f.key, { type: f.type, required: f.required === true });
  }

  const outOf = (id: string): Edge[] => validEdges.filter((e) => e.from === id);
  const backEdgeIds = findBackEdges(validEdges);
  const forwardEdges = validEdges.filter((e) => !backEdgeIds.has(e.id));

  // ── Điều 1: đúng một nút bắt đầu, ít nhất một nút kết thúc ──
  const starts = nodes.filter((n) => n.type === 'start');
  const ends = nodes.filter((n) => n.type === 'end');
  if (starts.length === 0) error(VALIDATION_CODES.startCount, 'Quy trình chưa có ô “Bắt đầu”. Cần có đúng một ô.');
  else if (starts.length > 1) {
    error(VALIDATION_CODES.startCount, `Quy trình đang có ${starts.length} ô “Bắt đầu”. Chỉ được có một ô.`, { nodeId: (starts[1] as LooseNode).id });
  }
  if (ends.length === 0) error(VALIDATION_CODES.endMissing, 'Quy trình chưa có ô “Kết thúc”. Cần có ít nhất một ô.');

  // ── Cạnh sai chỗ ──
  for (const e of validEdges) {
    const from = nodeById.get(e.from) as LooseNode;
    const to = nodeById.get(e.to) as LooseNode;
    if (e.from === e.to) {
      error(VALIDATION_CODES.cycle, `Bước ${q(labelOf(e.from))} đang nối vào chính nó.`, { nodeId: e.from, edgeId: e.id });
    }
    if (to.type === 'start') error(VALIDATION_CODES.schema, 'Không được nối đường nào đi vào ô “Bắt đầu”.', { edgeId: e.id });
    if (from.type === 'end') error(VALIDATION_CODES.schema, 'Không được nối đường nào đi ra từ ô “Kết thúc”.', { edgeId: e.id });
    if (e.outcome !== undefined && from.type !== 'approval') {
      error(VALIDATION_CODES.schema, 'Đường “Đồng ý” hoặc “Chưa đồng ý” chỉ được đi ra từ một bước duyệt.', { edgeId: e.id });
    }
    if (e.branch !== undefined && from.type !== 'condition') {
      error(VALIDATION_CODES.schema, 'Đường theo nhánh chỉ được đi ra từ một bước rẽ nhánh.', { edgeId: e.id });
    }
  }

  // ── Điều 2: mọi nút đến được từ bắt đầu và đi tới được một kết thúc ──
  // "Đến được từ Bắt đầu" chỉ tính cạnh tiến: engine không tính cạnh quay lại ("Chưa đồng ý") vào điều kiện đến của nút đích.
  // Nút chỉ tới được qua cạnh quay lại sẽ không bao giờ tới lượt, còn nút duyệt phía sau nó thì chờ mãi rồi bị bỏ qua.
  const forwardAdj = new Map<string, string[]>();
  const forwardOnlyAdj = new Map<string, string[]>();
  const backwardAdj = new Map<string, string[]>();
  /** bảng kề ngược chỉ theo cạnh tiến: "các bước đứng trước" theo đúng nghĩa của engine */
  const forwardBackwardAdj = new Map<string, string[]>();
  for (const e of validEdges) {
    forwardAdj.set(e.from, [...(forwardAdj.get(e.from) ?? []), e.to]);
    backwardAdj.set(e.to, [...(backwardAdj.get(e.to) ?? []), e.from]);
    if (!backEdgeIds.has(e.id)) {
      forwardOnlyAdj.set(e.from, [...(forwardOnlyAdj.get(e.from) ?? []), e.to]);
      forwardBackwardAdj.set(e.to, [...(forwardBackwardAdj.get(e.to) ?? []), e.from]);
    }
  }
  if (starts.length > 0) {
    const fromStart = new Set<string>();
    const fromStartForward = new Set<string>();
    for (const s of starts) {
      for (const id of reachable(s.id, forwardAdj)) fromStart.add(id);
      for (const id of reachable(s.id, forwardOnlyAdj)) fromStartForward.add(id);
    }
    for (const n of nodeById.values()) {
      if (!fromStart.has(n.id)) {
        error(VALIDATION_CODES.unreachable, `Bước ${q(labelOf(n.id))} chưa được nối từ ô “Bắt đầu” nên sẽ không bao giờ tới lượt.`, { nodeId: n.id });
      } else if (!fromStartForward.has(n.id)) {
        error(
          VALIDATION_CODES.onlyViaReturn,
          `Bước ${q(labelOf(n.id))} chỉ tới được qua đường “Chưa đồng ý” quay lại, không có đường đi tiến nào từ ô “Bắt đầu” tới nó. Khi chạy thật, bước này không bao giờ tới lượt và bước duyệt nối sau nó sẽ bị bỏ qua. Hãy nối bước này vào đường chính, hoặc nối đường “Chưa đồng ý” về một bước đã nằm sẵn trên đường chính.`,
          { nodeId: n.id },
        );
      }
    }
  }
  if (ends.length > 0) {
    const toEnd = new Set<string>();
    for (const s of ends) for (const id of reachable(s.id, backwardAdj)) toEnd.add(id);
    for (const n of nodeById.values()) {
      if (!toEnd.has(n.id)) {
        error(VALIDATION_CODES.deadEnd, `Từ bước ${q(labelOf(n.id))} chưa có đường nào đi tới ô “Kết thúc”.`, { nodeId: n.id });
      }
    }
  }

  // ── Điều 3: không có chu trình, trừ đường "Chưa đồng ý" quay về bước đứng trước nút duyệt ──
  {
    const adj = new Map<string, Edge[]>();
    for (const e of forwardEdges) adj.set(e.from, [...(adj.get(e.from) ?? []), e]);
    const color = new Map<string, 1 | 2>();
    const visit = (id: string): void => {
      color.set(id, 1);
      for (const e of adj.get(id) ?? []) {
        if (e.from === e.to) continue;
        const c = color.get(e.to);
        if (c === 1) {
          error(
            VALIDATION_CODES.cycle,
            `Các bước đang nối thành vòng quay lại ${q(labelOf(e.to))}. Chỉ được quay lại bước trước bằng đường “Chưa đồng ý” của một bước duyệt.`,
            { nodeId: e.to, edgeId: e.id },
          );
        } else if (c === undefined) {
          visit(e.to);
        }
      }
      color.set(id, 2);
    };
    for (const n of nodeById.values()) if (!color.has(n.id)) visit(n.id);
  }

  // ── Điều 4, 5, 6 và các kiểm tra theo từng nút ──
  // Các bước đứng trước một bước (chỉ theo cạnh tiến, không tính vòng "Chưa đồng ý" quay lại), để kiểm quy tắc `step_field` và tham chiếu của tệp tổng hợp.
  const ancestorCache = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    const hit = ancestorCache.get(id);
    if (hit) return hit;
    const set = reachable(id, forwardBackwardAdj);
    set.delete(id);
    ancestorCache.set(id, set);
    return set;
  };
  const formOf = (nodeId: string): Record<string, unknown>[] => {
    const f = nodeById.get(nodeId)?.['form'];
    return Array.isArray(f) ? (f as unknown[]).filter(isRecord) : [];
  };
  /** `single`: nơi chỉ nhận một người (nút task, người leo thang), nên ô phải là kiểu `user`; nơi nhận nhiều người nhận cả `users`. */
  const checkRule = (rule: unknown, nodeId: string, single = false): void => {
    if (!isRecord(rule)) return;
    if (rule['kind'] === 'step_field') {
      const src = typeof rule['node'] === 'string' ? (rule['node'] as string) : '';
      const key = typeof rule['field'] === 'string' ? (rule['field'] as string) : '';
      const srcNode = nodeById.get(src);
      if (!srcNode || !ancestorsOf(nodeId).has(src)) {
        error(
          VALIDATION_CODES.stepFieldInvalid,
          `Bước ${q(labelOf(nodeId))} lấy người từ kết quả của một bước không đứng trước nó. Chỉ chọn được bước đã xong trước khi bước này tới lượt.`,
          { nodeId },
        );
        return;
      }
      const field = formOf(src).find((f) => f['key'] === key);
      const type = field && typeof field['type'] === 'string' ? (field['type'] as string) : '';
      if (!field || (type !== 'user' && type !== 'users')) {
        error(
          VALIDATION_CODES.stepFieldInvalid,
          `Bước ${q(labelOf(nodeId))} lấy người từ một ô của bước ${q(labelOf(src))}, nhưng bước đó không có ô chọn người nào như vậy.`,
          { nodeId },
        );
      } else if (single && type === 'users') {
        error(
          VALIDATION_CODES.stepFieldInvalid,
          `Việc ${q(labelOf(nodeId))} chỉ giao cho một người, nhưng ô được chọn của bước ${q(labelOf(src))} cho chọn nhiều người. Hãy dùng bước đóng góp hoặc bước duyệt để giao cho nhiều người.`,
          { nodeId },
        );
      }
      return;
    }
    if (rule['kind'] !== 'form_field') return;
    const field = rule['field'];
    const input = typeof field === 'string' ? inputKeys.get(field) : undefined;
    if (!input || (input.type !== 'user' && input.type !== 'users')) {
      error(
        VALIDATION_CODES.formFieldUnknown,
        `Bước ${q(labelOf(nodeId))} lấy người nhận từ một ô của biểu mẫu khởi chạy, nhưng biểu mẫu không có ô chọn người đó.`,
        { nodeId },
      );
    } else if (single && input.type === 'users') {
      error(
        VALIDATION_CODES.formFieldUnknown,
        `Việc ${q(labelOf(nodeId))} chỉ giao cho một người, nhưng ô được chọn của biểu mẫu khởi chạy cho chọn nhiều người. Hãy dùng bước đóng góp hoặc bước duyệt để giao cho nhiều người.`,
        { nodeId },
      );
    }
  };
  const usesTarget = (due: unknown): boolean => isRecord(due) && due['anchor'] === 'run_target';

  for (const n of nodeById.values()) {
    const label = labelOf(n.id);
    const out = outOf(n.id);

    if (n.type === 'condition') {
      if (!out.some((e) => e.branch === 'else')) {
        error(
          VALIDATION_CODES.conditionElse,
          `Bước rẽ nhánh ${q(label)} chưa có đường “Trường hợp còn lại” (đường đi khi không điều kiện nào đúng).`,
          { nodeId: n.id },
        );
      }
      const branches = Array.isArray(n['branches']) ? (n['branches'] as unknown[]).filter(isRecord) : [];
      const branchIds = new Set<string>();
      for (const b of branches) {
        const id = typeof b['id'] === 'string' ? b['id'] : '';
        if (id === 'else') {
          error(VALIDATION_CODES.schema, `Bước rẽ nhánh ${q(label)} có một nhánh đặt mã là “else”. Mã này dành riêng cho “Trường hợp còn lại”.`, { nodeId: n.id });
        } else if (branchIds.has(id)) {
          error(VALIDATION_CODES.duplicateId, `Bước rẽ nhánh ${q(label)} có hai nhánh dùng chung mã ${q(id)}.`, { nodeId: n.id });
        }
        branchIds.add(id);
        if (!out.some((e) => e.branch === id)) {
          error(VALIDATION_CODES.schema, `Bước rẽ nhánh ${q(label)} có một nhánh chưa nối tới bước nào.`, { nodeId: n.id });
        }
      }
      for (const e of out) {
        if (e.branch === undefined || (e.branch !== 'else' && !branchIds.has(e.branch))) {
          error(VALIDATION_CODES.schema, `Một đường đi ra từ bước rẽ nhánh ${q(label)} chưa gắn với nhánh nào.`, { edgeId: e.id });
        }
      }
    }

    if (n.type === 'approval' && !out.some((e) => e.outcome === 'approved')) {
      error(VALIDATION_CODES.approvalApproved, `Bước duyệt ${q(label)} chưa có đường đi tiếp khi “Đồng ý”.`, { nodeId: n.id });
    }
    if (n.type === 'approval') {
      // Khi "Chưa đồng ý" quay lại bước trước, nút duyệt được làm lại nên đường "Chưa đồng ý" đi tiếp sẽ không bao giờ chạy.
      const rejected = out.filter((e) => e.outcome === 'rejected');
      if (rejected.some((e) => backEdgeIds.has(e.id)) && rejected.some((e) => !backEdgeIds.has(e.id))) {
        error(
          VALIDATION_CODES.schema,
          `Bước duyệt ${q(label)} vừa có đường “Chưa đồng ý” quay lại bước trước, vừa có đường “Chưa đồng ý” đi tiếp. Chỉ được chọn một trong hai cách.`,
          { nodeId: n.id },
        );
      }
    }

    if (n.type === 'approval' && n['finalApproval'] === true) {
      // Sau nút duyệt cuối không được còn nút duyệt nào khác trên đường tiến. Bỏ qua cạnh quay lại và mọi đường
      // "Chưa đồng ý" (đường đó nghĩa là văn bản chưa được duyệt xong). Nút việc (task), thông báo... thì được.
      const adj = new Map<string, string[]>();
      for (const e of forwardEdges) {
        if (e.outcome === 'rejected') continue;
        adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      }
      const after = reachable(n.id, adj);
      after.delete(n.id);
      for (const id of [...after].sort()) {
        const later = nodeById.get(id);
        if (later?.type !== 'approval') continue;
        error(
          VALIDATION_CODES.finalApprovalNotLast,
          `Bước duyệt ${q(label)} được đặt là bước duyệt cuối, nhưng phía sau còn bước duyệt ${q(labelOf(id))}. Hãy chuyển bước ${q(labelOf(id))} lên trước, hoặc bỏ dấu “duyệt cuối” ở bước ${q(label)}.`,
          { nodeId: n.id },
        );
      }
    }

    if (n.type === 'task') {
      if (!isRecord(n['assignee'])) error(VALIDATION_CODES.assigneeMissing, `Việc ${q(label)} chưa chọn người nhận.`, { nodeId: n.id });
      checkRule(n['assignee'], n.id, true);
      checkRule(n['escalateTo'], n.id, true);
    }
    if (n.type === 'approval') {
      const approvers = Array.isArray(n['approvers']) ? (n['approvers'] as unknown[]) : [];
      if (approvers.length === 0) {
        error(
          VALIDATION_CODES.assigneeMissing,
          n['action'] === 'contribute' ? `Bước góp nội dung ${q(label)} chưa chọn người tham gia.` : `Bước duyệt ${q(label)} chưa chọn người duyệt.`,
          { nodeId: n.id },
        );
      }
      for (const r of approvers) checkRule(r, n.id);
    }
    if (n.type === 'notify' && Array.isArray(n['to'])) for (const r of n['to'] as unknown[]) checkRule(r, n.id);
    if (n.type === 'task' || n.type === 'approval') {
      if (!isRecord(n['due'])) error(VALIDATION_CODES.dueMissing, `Việc ${q(label)} chưa đặt hạn.`, { nodeId: n.id });
      else if (usesTarget(n['due']) && !loose.data.targetField) {
        error(
          VALIDATION_CODES.targetFieldInvalid,
          `Hạn của việc ${q(label)} tính theo ngày mốc của lượt chạy, nhưng quy trình chưa chọn ô ngày nào làm ngày mốc.`,
          { nodeId: n.id },
        );
      }
    }
    if ((n.type === 'task' || n.type === 'approval') && Array.isArray(n['form'])) {
      const keys = new Set<string>();
      for (const f of (n['form'] as unknown[]).filter(isRecord)) {
        const key = typeof f['key'] === 'string' ? f['key'] : '';
        if (keys.has(key)) error(VALIDATION_CODES.duplicateId, `Biểu mẫu kết quả của việc ${q(label)} có hai ô dùng chung mã ${q(key)}.`, { nodeId: n.id });
        keys.add(key);
        if (f['type'] === 'autonumber' && (typeof f['register'] !== 'string' || f['register'] === '')) {
          error(VALIDATION_CODES.formFieldInvalid, `Ô cấp số ${q(typeof f['label'] === 'string' ? (f['label'] as string) : key)} của việc ${q(label)} chưa chọn sổ văn bản để cấp số.`, { nodeId: n.id });
        }
      }
    }
    if (n.type === 'approval' && n['action'] === 'contribute') {
      if (out.some((e) => e.outcome === 'rejected')) {
        error(VALIDATION_CODES.schema, `Bước đóng góp ${q(label)} không có “Chưa đồng ý” nên không được nối đường “Chưa đồng ý”.`, { nodeId: n.id });
      }
      if (!Array.isArray(n['form']) || (n['form'] as unknown[]).length === 0) {
        error(VALIDATION_CODES.schema, `Bước đóng góp ${q(label)} chưa có ô nào để người tham gia điền (nội dung, ý kiến, tệp).`, { nodeId: n.id });
      }
    }
    if (n.type === 'timer' && isRecord(n['wait']) && typeof n['wait']['value'] === 'number' && n['wait']['value'] <= 0) {
      error(VALIDATION_CODES.schema, `Bước chờ ${q(label)} phải có thời gian chờ lớn hơn 0.`, { nodeId: n.id });
    }

    if (n['join'] === 'any' && forwardEdges.filter((e) => e.to === n.id).length < 2) {
      error(
        VALIDATION_CODES.joinAny,
        `Bước ${q(label)} được đặt “chỉ cần một nhánh xong là đi tiếp” nên phải có ít nhất hai đường nối tới.`,
        { nodeId: n.id },
      );
    }
  }

  // ── Ô cấp số ở biểu mẫu khởi chạy ──
  for (const f of inputs) {
    if (f.type === 'autonumber' && (typeof (f as Record<string, unknown>)['register'] !== 'string' || (f as Record<string, unknown>)['register'] === '')) {
      error(VALIDATION_CODES.formFieldInvalid, `Ô cấp số ${q(f.label)} của biểu mẫu khởi chạy chưa chọn sổ văn bản để cấp số.`);
    }
  }

  // ── Cấu hình xuất tệp tổng hợp: mỗi mục phải trỏ tới dữ liệu có thật ──
  for (const n of nodeById.values()) {
    const compile = n.type === 'task' && isRecord(n['compile']) ? n['compile'] : null;
    if (!compile) continue;
    const sections = Array.isArray(compile['sections']) ? (compile['sections'] as unknown[]).filter(isRecord) : [];
    for (const sec of sections) {
      const ref = typeof sec['ref'] === 'string' ? (sec['ref'] as string) : '';
      if (ref === '') continue;
      const [root, a, b] = ref.split('.');
      let ok = false;
      if (root === 'inputs') ok = a !== undefined && inputKeys.has(a);
      else if (root === 'steps' || root === 'responses') {
        // Được trỏ tới các bước đứng trước, và tới chính việc đang tổng hợp (phần người làm gõ ngay ở việc này).
        ok = a !== undefined && b !== undefined && (ancestorsOf(n.id).has(a) || a === n.id) && formOf(a).some((f) => f['key'] === b);
      }
      if (!ok) {
        error(
          VALIDATION_CODES.compileInvalid,
          `Tệp tổng hợp của việc ${q(labelOf(n.id))} có mục ${q(typeof sec['heading'] === 'string' ? (sec['heading'] as string) : ref)} lấy dữ liệu từ nơi không có hoặc chưa tới lượt (${ref}).`,
          { nodeId: n.id },
        );
      }
    }
  }

  // ── Ô ngày mốc ──
  const targetField = loose.data.targetField;
  if (targetField !== undefined) {
    const input = inputKeys.get(targetField);
    if (!input || input.type !== 'date') {
      error(VALIDATION_CODES.targetFieldInvalid, 'Ô được chọn làm ngày mốc phải là một ô kiểu ngày có trong biểu mẫu khởi chạy.');
    } else if (!input.required && nodes.some((n) => usesTarget(n['due']))) {
      error(VALIDATION_CODES.targetFieldInvalid, 'Ô ngày mốc phải là ô bắt buộc, vì có việc tính hạn theo ngày này.');
    }
  }

  // ── Tham chiếu trong điều kiện rẽ nhánh (chỉ kiểm khi bản chặt đọc được) ──
  if (strict.success) {
    for (const n of strict.data.nodes) {
      if (n.type !== 'condition') continue;
      for (const ref of n.branches.flatMap((b) => exprRefs(b.when))) {
        const parsed = parseRef(ref);
        const ok = parsed !== null && (parsed.kind === 'input' ? inputKeys.has(parsed.key) : nodeById.has(parsed.nodeId));
        if (!ok) {
          error(
            VALIDATION_CODES.formFieldUnknown,
            `Điều kiện của bước rẽ nhánh ${q(n.label)} dùng một ô không có trong biểu mẫu khởi chạy hoặc một bước không tồn tại.`,
            { nodeId: n.id },
          );
        }
      }
    }
  }

  if (errors.length > 0 || !strict.success) return { errors, warnings, definition: null };

  // ── Điều 7 (chỉ cảnh báo): chạy thử với một mốc đích mẫu ──
  const definition = strict.data;
  const cal = opts.calendar ?? DEFAULT_CALENDAR;
  const now = opts.now ?? SAMPLE_NOW;
  const sampleTarget = definition.targetField
    ? atLocalTime(addWorkingDays(toLocalDate(now, cal), SAMPLE_LEAD_WORKING_DAYS, cal), '00:00', cal)
    : null;
  for (const row of planSchedule(definition, { now, targetAt: sampleTarget, cal, inputs: null })) {
    if (row.dueAt === null) continue;
    if (row.predecessorDueAt !== null && row.predecessorNodeId !== null && row.dueAt.getTime() < row.predecessorDueAt.getTime()) {
      add(warnings, {
        code: VALIDATION_CODES.dueBeforePredecessor,
        nodeId: row.nodeId,
        message: `Hạn của việc ${q(labelOf(row.nodeId))} sớm hơn hạn của việc đứng trước nó là ${q(labelOf(row.predecessorNodeId))}.`,
      });
    }
    if (row.dueAt.getTime() < now.getTime()) {
      add(warnings, {
        code: VALIDATION_CODES.dueInPast,
        nodeId: row.nodeId,
        message: sampleTarget
          ? `Nếu khởi chạy trước ngày mốc ${SAMPLE_LEAD_WORKING_DAYS} ngày làm việc thì hạn của việc ${q(labelOf(row.nodeId))} đã qua ngay lúc khởi chạy. Quy trình này cần được khởi chạy sớm hơn.`
          : `Hạn của việc ${q(labelOf(row.nodeId))} rơi vào trước lúc khởi chạy.`,
      });
    }
  }
  return { errors, warnings, definition };
}
