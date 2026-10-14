import type { AssigneeRule, DraftDefinition, DraftNode, FormField, RegisterView, StarterRule } from '@mihato/domain';
import { VALIDATION_CODES } from '@mihato/domain';
import { validate } from '@mihato/workflow-engine';
import { describe, expect, it } from 'vitest';
import { addStarter, cleanRegisterCode, newField, registerChoices, removeStarters, retypeField, sectionOf, tidyField } from '../src/features/templates/designer/form-model';
import { compileSources, defaultCompile, inputPersonFields, insertToken, moveItem, normalizeCompile, parseCompileRef, precedingNodeIds, stepFieldOptions, titleTokens } from '../src/features/templates/designer/form-sources';
import {
  addNodeAt,
  assigneeSummary,
  createNode,
  edgeLabel,
  estimateSize,
  firstFreeHandle,
  handleLabel,
  isContribute,
  kindLabel,
  nodeKindLabel,
  setApprovalAction,
  sourceHandleOf,
  sourceHandles,
  startersMode,
  startersSummary,
  type Lookups,
} from '../src/features/templates/designer/model';
import { collect, isSkippedInSimulation } from '../src/features/templates/designer/simulate-input';

const NO_LOOKUPS: Lookups = { person: () => undefined, unitName: () => undefined };
const field = (key: string, label: string, type: FormField['type'], extra: Partial<FormField> = {}): FormField => ({ key, label, type, ...extra });

/**
 * Chỉ thị của Chủ tịch: Bắt đầu → s1 Tiếp nhận (Giám đốc chọn người chủ trì, người phối hợp) → s2 Góp nội dung (những người phối hợp)
 * → s3 Soạn văn bản (người chủ trì, xuất tệp Word) → Hoàn tất.
 */
function directive(): DraftDefinition {
  const due = { anchor: 'activation', offset: { value: 3, unit: 'working_day' } } as const;
  return {
    schemaVersion: 1,
    name: 'Chỉ thị',
    inputs: [field('trichYeu', 'Trích yếu', 'longtext', { required: true }), field('nguoiNhan', 'Người nhận', 'user'), field('dongGui', 'Những người nhận', 'users'), field('soChiThi', 'Số chỉ thị', 'autonumber', { register: 'CT' })],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      {
        id: 's1',
        type: 'task',
        label: 'Tiếp nhận',
        title: 'Tiếp nhận chỉ thị',
        assignee: { kind: 'initiator' },
        due,
        form: [field('chuTri', 'Người chủ trì', 'user', { required: true }), field('phoiHop', 'Người phối hợp', 'users')],
      },
      {
        id: 's2',
        type: 'approval',
        label: 'Góp nội dung',
        title: 'Góp nội dung',
        approvers: [{ kind: 'step_field', node: 's1', field: 'phoiHop' }],
        mode: 'all',
        action: 'contribute',
        due,
        form: [field('noiDung', 'Nội dung', 'longtext', { required: true })],
      },
      {
        id: 's3',
        type: 'task',
        label: 'Soạn',
        title: 'Soạn văn bản',
        assignee: { kind: 'step_field', node: 's1', field: 'chuTri' },
        due,
        form: [field('ban', 'Bản thảo', 'longtext')],
        compile: {
          layout: 'official',
          title: 'Chỉ thị {trichYeu}',
          sections: [
            { heading: 'Nội dung', ref: 'inputs.trichYeu' },
            { heading: 'Ý kiến các phòng', ref: 'responses.s2.noiDung' },
            { heading: 'Bản thảo', ref: 'steps.s3.ban' },
            { heading: 'Lời kết', text: 'Đề nghị thực hiện.' },
          ],
          includeAttachments: true,
          required: true,
        },
      },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 's1' },
      { id: 'e2', from: 's1', to: 's2' },
      { id: 'e3', from: 's2', to: 's3', outcome: 'approved' },
      { id: 'e4', from: 's3', to: 'end' },
    ],
  };
}

const errorCodes = (def: DraftDefinition): string[] => validate(def).errors.map((e) => e.code);

describe('bước đứng trước và người được chọn ở bước trước', () => {
  const def = directive();

  it('liệt kê đúng các bước đứng trước, không tính chính nó', () => {
    expect([...precedingNodeIds(def, 's3')].sort()).toEqual(['s1', 's2', 'start']);
    expect([...precedingNodeIds(def, 's1')]).toEqual(['start']);
    expect(precedingNodeIds(def, 'start').size).toBe(0);
  });

  it('đường "Chưa đồng ý" quay lại không biến bước thành bước đứng trước của chính nó', () => {
    const loop: DraftDefinition = { ...def, edges: [...def.edges, { id: 'e5', from: 's2', to: 's1', outcome: 'rejected' }] };
    const ids = precedingNodeIds(loop, 's2');
    expect(ids.has('s2')).toBe(false);
    expect(ids.has('s1')).toBe(true);
  });

  it('việc chỉ nhận ô "Chọn một người"; bước duyệt, góp nội dung và thông báo nhận cả "Chọn nhiều người"', () => {
    expect(stepFieldOptions(def, 's3', false).map((o) => `${o.node.id}.${o.field.key}`)).toEqual(['s1.chuTri']);
    expect(stepFieldOptions(def, 's2', true).map((o) => `${o.node.id}.${o.field.key}`)).toEqual(['s1.chuTri', 's1.phoiHop']);
  });

  it('chỉ lấy ô của các bước đứng trước, không lấy bước đứng sau hay chính bước đó', () => {
    expect(stepFieldOptions(def, 's1', true)).toEqual([]);
    const afterwards = { ...def, nodes: def.nodes.map((n): DraftNode => (n.id === 's3' ? { ...n, form: [field('khac', 'Người khác', 'user')] } : n)) };
    expect(stepFieldOptions(afterwards, 's2', true).some((o) => o.node.id === 's3')).toBe(false);
    expect(stepFieldOptions(afterwards, 's3', true).some((o) => o.node.id === 's3')).toBe(false);
  });

  it('ô của bước duyệt và góp nội dung không dùng để giao việc', () => {
    const withPerson = { ...def, nodes: def.nodes.map((n): DraftNode => (n.id === 's2' ? { ...n, form: [field('nguoi', 'Người', 'user')] } : n)) };
    expect(stepFieldOptions(withPerson, 's3', true).some((o) => o.node.id === 's2')).toBe(false);
  });

  it('ô chọn người của biểu mẫu khởi chạy theo nơi nhận một hay nhiều người', () => {
    expect(inputPersonFields(def, false).map((f) => f.key)).toEqual(['nguoiNhan']);
    expect(inputPersonFields(def, true).map((f) => f.key)).toEqual(['nguoiNhan', 'dongGui']);
  });

  it('mọi lựa chọn bộ chỉnh đưa ra đều qua được validate() của engine', () => {
    expect(errorCodes(def)).toEqual([]);
    for (const option of stepFieldOptions(def, 's3', false)) {
      const rule: AssigneeRule = { kind: 'step_field', node: option.node.id, field: option.field.key };
      const next = { ...def, nodes: def.nodes.map((n): DraftNode => (n.id === 's3' ? { ...n, assignee: rule } : n)) };
      expect(errorCodes(next)).toEqual([]);
    }
  });

  it('engine từ chối ô "Chọn nhiều người" cho việc, đúng điều bộ chỉnh không cho chọn', () => {
    const bad = { ...def, nodes: def.nodes.map((n): DraftNode => (n.id === 's3' ? { ...n, assignee: { kind: 'step_field', node: 's1', field: 'phoiHop' } } : n)) };
    expect(errorCodes(bad)).toContain(VALIDATION_CODES.stepFieldInvalid);
  });
});

describe('tóm tắt người nhận', () => {
  const def = directive();
  it('người được chọn ở bước trước', () => {
    expect(assigneeSummary(def, { kind: 'step_field', node: 's1', field: 'chuTri' }, NO_LOOKUPS)).toBe('Người chọn ở ô “Người chủ trì” của bước “Tiếp nhận”');
    expect(assigneeSummary(def, { kind: 'step_field', node: 's1', field: 'phoiHop' }, NO_LOOKUPS)).toBe('Những người chọn ở ô “Người phối hợp” của bước “Tiếp nhận”');
  });
  it('bước hoặc ô không còn', () => {
    expect(assigneeSummary(def, { kind: 'step_field', node: 'zz', field: 'chuTri' }, NO_LOOKUPS)).toBe('Ô không còn trong biểu mẫu');
  });
  it('ô khởi chạy chọn nhiều người', () => {
    expect(assigneeSummary(def, { kind: 'form_field', field: 'dongGui' }, NO_LOOKUPS)).toBe('Những người chọn ở ô “Những người nhận”');
    expect(assigneeSummary(def, { kind: 'form_field', field: 'nguoiNhan' }, NO_LOOKUPS)).toBe('Người chọn ở ô “Người nhận”');
  });
});

describe('dữ liệu đưa vào tệp Word tổng hợp', () => {
  const def = directive();

  it('gom ô khởi chạy, kết quả của chính việc, của việc trước và phần của từng người', () => {
    const sources = compileSources(def, 's3');
    expect(sources.map((s) => s.ref)).toEqual([
      'inputs.trichYeu',
      'inputs.nguoiNhan',
      'inputs.dongGui',
      'inputs.soChiThi',
      'steps.s3.ban',
      'steps.s1.chuTri',
      'steps.s1.phoiHop',
      'responses.s2.noiDung',
    ]);
    expect(sources.find((s) => s.ref === 'steps.s3.ban')?.group).toBe('self');
    expect(sources.find((s) => s.ref === 'steps.s1.chuTri')?.group).toBe('steps');
    expect(sources.find((s) => s.ref === 'responses.s2.noiDung')?.group).toBe('responses');
  });

  it('nhãn nói rõ nguồn', () => {
    const label = (ref: string) => compileSources(def, 's3').find((s) => s.ref === ref)?.label;
    expect(label('inputs.trichYeu')).toBe('Khởi chạy: Trích yếu');
    expect(label('steps.s3.ban')).toBe('Việc này: Bản thảo');
    expect(label('steps.s1.chuTri')).toBe('Tiếp nhận: Người chủ trì');
    expect(label('responses.s2.noiDung')).toBe('Phần của từng người ở “Góp nội dung”: Nội dung');
  });

  it('không liệt kê bước đứng sau', () => {
    const sources = compileSources(def, 's1');
    expect(sources.some((s) => s.ref.startsWith('responses.s2') || s.ref.startsWith('steps.s3'))).toBe(false);
  });

  it('mọi nguồn được liệt kê đều qua được validate() của engine', () => {
    for (const s of compileSources(def, 's3')) {
      const next = {
        ...def,
        nodes: def.nodes.map((n): DraftNode => (n.id === 's3' && n.compile ? { ...n, compile: { ...n.compile, sections: [{ heading: 'Mục', ref: s.ref }] } } : n)),
      };
      expect(errorCodes(next), s.ref).toEqual([]);
    }
  });

  it('engine từ chối nguồn không có, và cấu hình mặc định hợp lệ', () => {
    const bad = { ...def, nodes: def.nodes.map((n): DraftNode => (n.id === 's3' && n.compile ? { ...n, compile: { ...n.compile, sections: [{ heading: 'Mục', ref: 'steps.s9.xx' }] } } : n)) };
    expect(errorCodes(bad)).toContain(VALIDATION_CODES.compileInvalid);
    const plain = { ...def, nodes: def.nodes.map((n): DraftNode => (n.id === 's3' ? { ...n, compile: defaultCompile() } : n)) };
    expect(errorCodes(plain)).toEqual([]);
  });

  it('tách tham chiếu', () => {
    expect(parseCompileRef('inputs.trichYeu')).toEqual({ root: 'inputs', field: 'trichYeu' });
    expect(parseCompileRef('steps.s1.chuTri')).toEqual({ root: 'steps', node: 's1', field: 'chuTri' });
    expect(parseCompileRef('responses.s2.noiDung')).toEqual({ root: 'responses', node: 's2', field: 'noiDung' });
    expect(parseCompileRef('inputs')).toBeNull();
    expect(parseCompileRef('steps.s1')).toBeNull();
    expect(parseCompileRef('steps.s1.a.b')).toBeNull();
    expect(parseCompileRef('khac.a.b')).toBeNull();
  });

  it('gợi ý chèn vào tiêu đề dùng mã ô, hiện tên ô', () => {
    expect(titleTokens(def)).toContainEqual({ token: '{trichYeu}', label: 'Trích yếu' });
    expect(titleTokens(def)).toHaveLength(def.inputs.length);
  });

  it('chèn vào tiêu đề tại con trỏ hoặc cuối chữ', () => {
    expect(insertToken('Chỉ thị', '{trichYeu}')).toEqual({ text: 'Chỉ thị {trichYeu}', caret: 18 });
    expect(insertToken('', '{a}')).toEqual({ text: '{a}', caret: 3 });
    expect(insertToken('Chỉ thịcuối', '{a}', 7)).toEqual({ text: 'Chỉ thị {a} cuối', caret: 11 });
    expect(insertToken('Chỉ thị cuối', '{a}', 8)).toEqual({ text: 'Chỉ thị {a} cuối', caret: 11 });
    expect(insertToken('abc ', '{a}', 4)).toEqual({ text: 'abc {a}', caret: 7 });
    expect(insertToken('abc', '{a}', 99).text).toBe('abc {a}');
  });

  it('đổi thứ tự mục', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('cấu hình thiếu phần (nháp lỏng) được điền mặc định để bộ sửa không vỡ', () => {
    const loose = { layout: 'khac', title: 'T' } as unknown as Parameters<typeof normalizeCompile>[0];
    expect(normalizeCompile(loose)).toEqual({ layout: 'official', title: 'T', sections: [] });
    const spec = defaultCompile();
    expect(normalizeCompile(spec)).toEqual(spec);
  });

  it('mục lấy từ nguồn hoặc chữ nhập tay, không giữ khoá rỗng', () => {
    expect(sectionOf('Mục', { ref: 'inputs.a' })).toEqual({ heading: 'Mục', ref: 'inputs.a' });
    expect(sectionOf('Mục', { text: 'Chữ' })).toEqual({ heading: 'Mục', text: 'Chữ' });
    expect(sectionOf('Mục', { text: '' })).toEqual({ heading: 'Mục' });
  });
});

describe('bước Góp nội dung', () => {
  it('nút mới tạo có một ô nhiều dòng bắt buộc, mọi người phải góp, và qua được validate() khi đã nối và có người', () => {
    const base = directive();
    const node = createNode(base, 'contribute');
    expect(node).toMatchObject({ type: 'approval', action: 'contribute', mode: 'all' });
    expect(node.form).toEqual([{ key: 'noiDung', label: 'Nội dung', type: 'longtext', required: true }]);
    expect(isContribute(node)).toBe(true);
    expect(nodeKindLabel(node)).toBe('Góp nội dung');
    expect(kindLabel('contribute')).toBe('Góp nội dung');
    expect(kindLabel('approval')).toBe('Duyệt');
  });

  it('thêm nhanh từ khối nút rồi nối vẫn validate được', () => {
    const base: DraftDefinition = {
      schemaVersion: 1,
      name: 'Góp ý',
      inputs: [],
      nodes: [
        { id: 'start', type: 'start', label: 'Bắt đầu' },
        { id: 'end', type: 'end', label: 'Hoàn tất' },
      ],
      edges: [],
    };
    const added = addNodeAt(base, 'contribute', { x: 0, y: 0 }, { nodeId: 'start', handle: null });
    const withEnd = { ...added.def, edges: [...added.def.edges, { id: 'e9', from: added.nodeId, to: 'end', outcome: 'approved' as const }] };
    const node = withEnd.nodes.find((n) => n.id === added.nodeId) as DraftNode;
    const done: DraftDefinition = { ...withEnd, nodes: withEnd.nodes.map((n) => (n.id === node.id ? { ...node, title: 'Góp ý', approvers: [{ kind: 'initiator' }] } : n)) };
    expect(errorCodes(done)).toEqual([]);
  });

  it('chỉ có một cổng ra "Đã góp đủ", không có "Chưa đồng ý"', () => {
    const node = createNode(directive(), 'contribute');
    expect(sourceHandles(node)).toEqual(['approved']);
    expect(sourceHandles(createNode(directive(), 'approval'))).toEqual(['approved', 'rejected']);
    const def: DraftDefinition = { ...directive(), nodes: [...directive().nodes, { ...node, id: 'c1' }] };
    const c1 = def.nodes.find((n) => n.id === 'c1') as DraftNode;
    expect(handleLabel(def, c1, 'approved')).toBe('Đã góp đủ');
    expect(edgeLabel(def, { id: 'x', from: 'c1', to: 'end', outcome: 'approved' })).toBe('Đã góp đủ');
    expect(firstFreeHandle(def, c1)).toBe('approved');
  });

  it('đường "Chưa đồng ý" còn sót ở bước góp nội dung đi vào cổng tạm để người vẽ thấy', () => {
    const def: DraftDefinition = { ...directive(), edges: [...directive().edges, { id: 'e8', from: 's2', to: 'end', outcome: 'rejected' }] };
    const edge = def.edges.find((e) => e.id === 'e8');
    expect(edge && sourceHandleOf(def, edge)).toBe('__none');
    expect(errorCodes(def)).toContain(VALIDATION_CODES.schema);
  });

  it('đổi sang Góp nội dung: bỏ đường Chưa đồng ý, mọi người phải góp, thêm ô mẫu, đổi tên mặc định', () => {
    const def: DraftDefinition = {
      ...directive(),
      nodes: directive().nodes.map((n): DraftNode => (n.id === 's2' ? { id: 's2', type: 'approval', label: 'Bước duyệt mới', title: 'Duyệt', approvers: [{ kind: 'initiator' }], mode: 'any', due: n.due as never } : n)),
      edges: [...directive().edges, { id: 'e7', from: 's2', to: 'end', outcome: 'rejected' }],
    };
    const next = setApprovalAction(def, 's2', 'contribute');
    const s2 = next.nodes.find((n) => n.id === 's2') as DraftNode;
    expect(s2).toMatchObject({ action: 'contribute', mode: 'all', label: 'Bước góp nội dung mới' });
    expect(s2.form).toHaveLength(1);
    expect(next.edges.some((e) => e.outcome === 'rejected')).toBe(false);
    expect(next.edges.some((e) => e.outcome === 'approved')).toBe(true);
    expect(errorCodes(next)).toEqual([]);
  });

  it('đổi lại sang Duyệt: bỏ khoá action, giữ biểu mẫu, đổi lại tên mặc định; đổi cùng cách thì giữ nguyên bản vẽ', () => {
    const def = directive();
    const fresh: DraftDefinition = { ...def, nodes: [...def.nodes, { ...createNode(def, 'contribute'), id: 'c1' }] };
    const back = setApprovalAction(fresh, 'c1', 'approve');
    const c1 = back.nodes.find((n) => n.id === 'c1') as DraftNode;
    expect('action' in c1).toBe(false);
    expect(c1.label).toBe('Bước duyệt mới');
    expect(c1.form).toHaveLength(1);
    expect(setApprovalAction(fresh, 'c1', 'contribute')).toBe(fresh);
    expect(setApprovalAction(def, 's1', 'contribute')).toBe(def);
  });

  it('giữ ô của người dùng khi đổi sang Góp nội dung, và tên do người vẽ đặt', () => {
    const def: DraftDefinition = {
      ...directive(),
      nodes: directive().nodes.map((n): DraftNode => (n.id === 's2' ? { id: 's2', type: 'approval', label: 'Lấy ý kiến', title: 'Lấy ý kiến', approvers: [{ kind: 'initiator' }], mode: 'any', due: n.due as never, form: [field('yKien', 'Ý kiến', 'text')] } : n)),
    };
    const s2 = setApprovalAction(def, 's2', 'contribute').nodes.find((n) => n.id === 's2') as DraftNode;
    expect(s2.label).toBe('Lấy ý kiến');
    expect(s2.form).toEqual([field('yKien', 'Ý kiến', 'text')]);
  });

  it('bước Góp nội dung thấp hơn bước Duyệt, việc có xuất tệp cao hơn việc thường', () => {
    const def = directive();
    expect(estimateSize(createNode(def, 'contribute')).height).toBeLessThan(estimateSize(createNode(def, 'approval')).height);
    expect(estimateSize(def.nodes.find((n) => n.id === 's3') as DraftNode).height).toBeGreaterThan(estimateSize(createNode(def, 'task')).height);
  });
});

describe('loại ô của biểu mẫu', () => {
  it('ô mới bắt buộc, trừ số văn bản tự cấp', () => {
    expect(newField('a', 'A', 'longtext')).toEqual({ key: 'a', label: 'A', type: 'longtext', required: true });
    expect(newField('b', 'B', 'autonumber')).toEqual({ key: 'b', label: 'B', type: 'autonumber' });
    expect(newField('c', 'C', 'select')).toMatchObject({ options: [], required: true });
  });

  it('đổi loại thì bỏ thuộc tính của loại cũ', () => {
    const file = field('f', 'Tệp', 'file', { multiple: true, required: true });
    expect(retypeField(file, 'text')).toEqual({ key: 'f', label: 'Tệp', type: 'text', required: true });
    const auto = field('n', 'Số', 'autonumber', { register: 'VBDEN' });
    expect(retypeField(auto, 'text')).toEqual({ key: 'n', label: 'Số', type: 'text' });
    expect(retypeField(field('t', 'T', 'text', { required: true }), 'autonumber')).toEqual({ key: 't', label: 'T', type: 'autonumber' });
    const select = field('s', 'S', 'select', { options: [{ value: 'a', label: 'a' }] });
    expect(retypeField(select, 'select').options).toEqual([{ value: 'a', label: 'a' }]);
    expect(retypeField(select, 'longtext').options).toBeUndefined();
    expect('options' in retypeField(select, 'longtext')).toBe(false);
  });

  it('bỏ khoá rỗng nhưng giữ tên ô đang gõ dở', () => {
    expect(tidyField({ key: 'a', label: '', type: 'text', hint: '', multiple: undefined })).toEqual({ key: 'a', label: '', type: 'text' });
    expect(tidyField({ key: 'a', label: 'A', type: 'text', hint: 'Gợi ý' }).hint).toBe('Gợi ý');
  });

  it('ô số văn bản chưa chọn sổ bị engine báo, chọn rồi thì qua', () => {
    const def = directive();
    const missing: DraftDefinition = { ...def, inputs: def.inputs.map((f) => (f.key === 'soChiThi' ? newField('soChiThi', 'Số chỉ thị', 'autonumber') : f)) };
    expect(errorCodes(missing)).toContain(VALIDATION_CODES.formFieldInvalid);
    expect(errorCodes(def)).toEqual([]);
  });

  it('mã sổ nhập tay được làm sạch theo luật của máy chủ', () => {
    expect(cleanRegisterCode('vb den!')).toBe('vbden');
    expect(cleanRegisterCode('1VBDEN')).toBe('VBDEN');
    expect(cleanRegisterCode('VB-DEN_1')).toBe('VB-DEN_1');
    expect(cleanRegisterCode('   ')).toBeUndefined();
    expect(cleanRegisterCode('A'.repeat(40))).toHaveLength(32);
  });

  it('danh sách sổ để chọn: bỏ sổ đã lưu trữ, trừ sổ đang chọn', () => {
    const reg = (code: string, name: string, archivedAt: string | null): RegisterView => ({
      code,
      name,
      direction: 'incoming',
      pattern: '{seq}',
      resetPolicy: 'yearly',
      columns: [],
      entryCount: 0,
      nextNumber: '1',
      archivedAt,
    });
    const all = [reg('VBDEN', 'Văn bản đến', null), reg('CU', 'Sổ cũ', '2026-01-01T00:00:00.000Z')];
    expect(registerChoices(all, undefined)).toEqual([{ value: 'VBDEN', label: 'Văn bản đến (VBDEN)' }]);
    expect(registerChoices(all, 'CU').map((o) => o.value)).toEqual(['VBDEN', 'CU']);
    expect(registerChoices(all, 'CU')[1]?.label).toContain('đã lưu trữ');
    expect(registerChoices(all, 'KHAC').at(-1)).toEqual({ value: 'KHAC', label: 'KHAC' });
  });
});

describe('ai được khởi chạy', () => {
  const lookups: Lookups = {
    person: (id) => (id === 'u1' ? { fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi' } : undefined),
    unitName: (id) => (id === 'p1' ? 'Phòng Kế toán' : undefined),
  };

  it('nhận ra ba cách chọn', () => {
    expect(startersMode(undefined)).toBe('default');
    expect(startersMode([])).toBe('default');
    expect(startersMode([{ kind: 'permission' }])).toBe('default');
    expect(startersMode([{ kind: 'everyone' }])).toBe('everyone');
    expect(startersMode([{ kind: 'role', role: 'chairman' }])).toBe('custom');
    expect(startersMode([{ kind: 'permission' }, { kind: 'user', userId: 'u1' }])).toBe('custom');
  });

  it('tóm tắt bằng chữ', () => {
    expect(startersSummary(undefined, lookups)).toBe('Người có quyền khởi chạy (Văn phòng, lãnh đạo)');
    expect(startersSummary([{ kind: 'everyone' }], lookups)).toBe('Mọi cán bộ');
    expect(startersSummary([{ kind: 'role', role: 'chairman' }], lookups)).toBe('Chỉ Chủ tịch');
    expect(startersSummary([{ kind: 'role', role: 'chairman' }, { kind: 'role', role: 'director' }], lookups)).toBe('Chỉ Chủ tịch, Giám đốc');
    expect(startersSummary([{ kind: 'user', userId: 'u1' }], lookups)).toBe('Chỉ chị Nguyễn Thu Lan');
    expect(startersSummary([{ kind: 'unit', unitId: 'p1' }, { kind: 'permission' }], lookups)).toBe('Mọi người thuộc Phòng Kế toán, Người có quyền khởi chạy');
    expect(startersSummary([{ kind: 'unit', unitId: 'zz' }], lookups)).toBe('Mọi người thuộc Một đơn vị đã chọn');
  });

  it('thêm không trùng, bỏ theo điều kiện', () => {
    const one: StarterRule = { kind: 'role', role: 'office_admin' };
    expect(addStarter(undefined, one)).toEqual([one]);
    expect(addStarter([one], { kind: 'role', role: 'office_admin' })).toEqual([one]);
    expect(addStarter([one], { kind: 'everyone' })).toHaveLength(2);
    expect(removeStarters([one, { kind: 'permission' }], (r) => r.kind === 'permission')).toEqual([one]);
    expect(removeStarters(undefined, () => true)).toEqual([]);
  });
});

describe('chạy thử', () => {
  it('ô chọn nhiều người gửi danh sách mã người, ô số văn bản và tệp không cần nhập', () => {
    const fields = [field('a', 'A', 'users', { required: true }), field('n', 'Số', 'autonumber'), field('f', 'Tệp', 'file', { required: true }), field('t', 'Trích yếu', 'longtext', { required: true })];
    expect(fields.filter(isSkippedInSimulation).map((f) => f.key)).toEqual(['n', 'f']);
    const person = (id: string) => ({ id, fullName: id, givenName: id, honorific: null, unitName: null, roleTitle: null });
    expect(collect(fields, { t: ' Nội dung ' }, { a: [person('u1'), person('u2')] })).toEqual({ inputs: { a: ['u1', 'u2'], t: 'Nội dung' }, errors: {} });
    const missing = collect(fields, {}, {});
    expect(Object.keys(missing.errors).sort()).toEqual(['a', 't']);
  });
});
