import { describe, expect, it } from 'vitest';
import { ProcessDefinitionSchema } from '../src/process';
import { buildDraftDefinition, type ResolvedDraftStep } from '../src/process-draft';

const LABELS = { start: 'Bắt đầu', end: 'Hoàn tất' };
const U1 = '01a10586-60e3-78dc-83fa-b29c2d5a7c3f';

const task = (title: string, extra: Partial<ResolvedDraftStep> = {}): ResolvedDraftStep => ({
  title,
  kind: 'task',
  assignee: { kind: 'person', userId: U1 },
  dueDays: 3,
  parallel: false,
  ...extra,
});

const pairs = (def: ReturnType<typeof buildDraftDefinition>) => def.edges.map((e) => `${e.from}>${e.to}${e.outcome ? `:${e.outcome}` : ''}`);

describe('buildDraftDefinition: bản nháp dựng từ các bước đọc bằng giọng nói', () => {
  it('các bước nối tiếp: Bắt đầu → 1 → 2 → 3 → Hoàn tất; mỗi bước hạn tính từ lúc bước đó bắt đầu', () => {
    const def = buildDraftDefinition({ name: 'Họp hội đồng', steps: [task('Soạn tài liệu'), task('Gửi giấy mời', { dueDays: 1 }), task('Chuẩn bị phòng họp', { assignee: { kind: 'initiator' } })] }, LABELS);
    expect(def.name).toBe('Họp hội đồng');
    expect(pairs(def)).toEqual(['start>s1', 's1>s2', 's2>s3', 's3>end']);
    const s2 = def.nodes.find((n) => n.id === 's2');
    expect(s2).toMatchObject({ type: 'task', title: 'Gửi giấy mời', assignee: { kind: 'user', userId: U1 }, due: { anchor: 'activation', offset: { value: 1, unit: 'working_day' } } });
    expect(def.nodes.find((n) => n.id === 's3')).toMatchObject({ assignee: { kind: 'initiator' } });
    // Đủ để xuất bản: qua được schema chặt (validate() của engine kiểm thêm ở packages/backend).
    expect(ProcessDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('bước làm cùng lúc: cùng nhóm với bước trước, bước sau chờ cả nhóm', () => {
    const def = buildDraftDefinition({ name: 'Đón đoàn', steps: [task('Chương trình'), task('Tạm ứng', { parallel: true }), task('Báo giá', { parallel: true }), task('Tổng kết')] }, LABELS);
    expect(pairs(def)).toEqual(['start>s1', 'start>s2', 'start>s3', 's1>s4', 's2>s4', 's3>s4', 's4>end']);
    // Ba bước cùng nhóm đứng chung một cột, xếp dọc, cách đều quanh đường giữa.
    const xs = ['s1', 's2', 's3'].map((id) => def.layout?.[id]?.x);
    expect(new Set(xs).size).toBe(1);
    expect(['s1', 's2', 's3'].map((id) => def.layout?.[id]?.y)).toEqual([30, 200, 370]);
    expect(def.layout?.s4?.x).toBeGreaterThan(xs[0] as number);
    expect(ProcessDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('bước duyệt có người duyệt và cạnh đi ra mang outcome approved', () => {
    const def = buildDraftDefinition(
      { name: 'Tạm ứng', steps: [task('Lập đề nghị'), task('Duyệt đề nghị', { kind: 'approval', assignee: { kind: 'role', role: 'director' }, dueDays: 2 }), task('Chi tiền')] },
      LABELS,
    );
    expect(def.nodes.find((n) => n.id === 's2')).toMatchObject({ type: 'approval', mode: 'any', approvers: [{ kind: 'role', role: 'director' }] });
    expect(pairs(def)).toEqual(['start>s1', 's1>s2', 's2>s3:approved', 's3>end']);
    expect(ProcessDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('bước duyệt là bước cuối thì nối thẳng tới Hoàn tất bằng cạnh approved', () => {
    const def = buildDraftDefinition({ name: 'Duyệt', steps: [task('Duyệt', { kind: 'approval' })] }, LABELS);
    expect(pairs(def)).toEqual(['start>s1', 's1>end:approved']);
  });

  it('bước đầu tiên đánh dấu làm cùng lúc vẫn là nhóm đầu; mã nút và toạ độ không trùng', () => {
    const def = buildDraftDefinition({ name: 'A', steps: [task('Một', { parallel: true }), task('Hai')] }, LABELS);
    expect(pairs(def)).toEqual(['start>s1', 's1>s2', 's2>end']);
    const ids = def.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const at = def.layout?.[id];
      expect(Number.isFinite(at?.x) && Number.isFinite(at?.y), id).toBe(true);
    }
    expect(def.nodes.map((n) => n.label)).toEqual(['Bắt đầu', 'Một', 'Hai', 'Hoàn tất']);
  });
});
