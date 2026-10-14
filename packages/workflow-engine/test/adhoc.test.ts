import { adhocDefinition, ADHOC_DUE_FIELD, ADHOC_TASK_NODE, ProcessDefinitionSchema, type AdhocLabels } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { simulate, validate } from '../src';
import { asUser, Harness } from './support/harness';
import { makeCtx, runInput, U, vn } from './support/world';

/** Mẫu một việc của việc ngoài quy trình (docs/DECISIONS.md, 05/10/2026): hàm thuần dựng, engine chạy như mọi quy trình. */
const LABELS: AdhocLabels = { start: 'Bắt đầu', task: 'Việc', end: 'Hoàn tất', due: 'Hạn xong' };
const def = (over: { title?: string; description?: string | null; assigneeId?: string } = {}) =>
  adhocDefinition({ title: 'Gửi báo giá cho công ty Sakura', assigneeId: U.LAN, ...over }, LABELS);

const NOW = vn('2026-10-05', '09:00'); // Thứ Hai

describe('adhocDefinition', () => {
  it('là một định nghĩa hợp lệ: validate() không báo lỗi, đọc lại bằng schema vẫn nguyên', () => {
    const d = def({ description: '  Kèm bảng giá quý bốn  ' });
    expect(validate(d, { now: NOW }).errors).toEqual([]);
    expect(ProcessDefinitionSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(d.targetField).toBe(ADHOC_DUE_FIELD);
    const task = d.nodes.find((n) => n.id === ADHOC_TASK_NODE);
    expect(task).toMatchObject({ type: 'task', title: 'Gửi báo giá cho công ty Sakura', description: 'Kèm bảng giá quý bốn', assignee: { kind: 'user', userId: U.LAN } });
  });

  it('không có mô tả thì không ghi trường description', () => {
    const task = def({ description: '   ' }).nodes.find((n) => n.id === ADHOC_TASK_NODE) as Record<string, unknown>;
    expect(task).not.toHaveProperty('description');
  });

  it('hạn là hết giờ làm việc của ngày chọn; ngày nghỉ thì lùi về ngày làm việc liền trước', () => {
    const ctx = makeCtx();
    const dueOf = (day: string) => simulate({ def: def(), inputs: { [ADHOC_DUE_FIELD]: day }, initiatorId: U.ADMIN, ctx, now: NOW }).rows[0]!.dueAt;
    expect(dueOf('2026-10-09')).toBe(vn('2026-10-09', '17:00').toISOString()); // Thứ Sáu
    expect(dueOf('2026-10-10')).toBe(vn('2026-10-09', '17:00').toISOString()); // Thứ Bảy → Thứ Sáu
    expect(dueOf('2026-10-11')).toBe(vn('2026-10-09', '17:00').toISOString()); // Chủ Nhật → Thứ Sáu
  });

  it('chạy trọn vòng đời: giao, nhận, báo xong thì lượt chạy hoàn tất; phát lại ra đúng trạng thái đó', () => {
    const d = def();
    const h = new Harness(d, makeCtx(), runInput(U.ADMIN, { [ADHOC_DUE_FIELD]: '2026-10-09' }));
    h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN) }, NOW);
    expect(h.step(ADHOC_TASK_NODE)).toMatchObject({ state: 'ready', assigneeId: U.LAN, assignedBy: U.ADMIN, dueAt: vn('2026-10-09', '17:00').toISOString() });
    expect(h.sent({ kind: 'notify.assigned' }).map((s) => s.effect.toUserId)).toEqual([U.LAN]);
    h.dispatch({ type: 'AcceptStep', actor: asUser(U.LAN), stepId: h.step(ADHOC_TASK_NODE).id }, vn('2026-10-05', '10:00'));
    h.dispatch({ type: 'CompleteStep', actor: asUser(U.LAN), stepId: h.step(ADHOC_TASK_NODE).id }, vn('2026-10-06', '10:00'));
    expect(h.run).toMatchObject({ state: 'completed', outcome: 'success' });
    expect(h.replayed()).toEqual(h.run);
  });

  it('thiếu ngày hạn thì không khởi tạo được (ô date bắt buộc)', () => {
    expect(() => new Harness(def(), makeCtx(), runInput(U.ADMIN, {}))).toThrow();
  });
});
