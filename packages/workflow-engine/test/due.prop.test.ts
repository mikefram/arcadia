import type { StepState } from '@mihato/domain';
import { isWorkingDay, toLocalDate } from '@mihato/domain/calendar';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asUser, Harness } from './support/harness';
import { drive, fcParams, scenarioArb } from './support/arb';
import { defOf, edge, END, makeCtx, runInput, START, task, U, VN, vn } from './support/world';

/**
 * Thuộc tính 5 (SPEC 4.10), Hạn: mọi due_at tính ra đều là ngày làm việc, và khớp bộ vector ở mục 4.5.
 */
describe('thuộc tính 5: hạn', () => {
  it('mọi hạn engine tính ra lúc kích hoạt đều rơi vào ngày làm việc của lịch, và hạn gốc bằng hạn lúc kích hoạt', () => {
    let checked = 0;
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const cal = scenario.ctx.calendar;
        drive(scenario, ({ out }) => {
          for (const change of out.events[0]?.payload.changes ?? []) {
            if (change.type !== 'step.activated') continue;
            const step = out.run.steps.find((s) => s.id === change.stepId) as StepState;
            expect(step.dueOriginalAt).toBe(change.dueAt);
            expect(step.dueAt).toBe(change.dueAt);
            if (change.dueAt === null) continue;
            expect(new Date(change.dueAt).toISOString()).toBe(change.dueAt); // chuỗi ISO UTC chuẩn
            expect(isWorkingDay(toLocalDate(change.dueAt, cal), cal), `hạn ${change.dueAt} của nút ${change.nodeId} không rơi vào ngày làm việc`).toBe(true);
            checked++;
          }
        });
      }),
      fcParams,
    );
    expect(checked).toBeGreaterThan(0);
  });

  it('hạn gốc không bao giờ đổi sau khi việc đã kích hoạt, kể cả khi gia hạn', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const original = new Map<string, string | null>();
        drive(scenario, ({ out }) => {
          for (const change of out.events[0]?.payload.changes ?? []) if (change.type === 'step.activated') original.set(change.stepId, change.dueAt);
          for (const step of out.run.steps) {
            const first = original.get(step.id);
            if (first === undefined) continue;
            // việc lúc đầu không có hạn thì lần đặt hạn đầu tiên trở thành hạn gốc
            if (first === null) {
              if (step.dueOriginalAt !== null) original.set(step.id, step.dueOriginalAt);
            } else {
              expect(step.dueOriginalAt).toBe(first);
            }
          }
        });
      }),
      fcParams,
    );
  });

  // Bộ vector ở SPEC 4.5: mốc đích Thứ Năm 15/10/2026, lịch Thứ Hai đến Thứ Sáu, không ngày lễ; hạn lúc 17:00 giờ Việt Nam.
  it.each([
    [-4, '2026-10-09T10:00:00.000Z'], // Thứ Sáu 09/10: đếm 14, 13, 12, 09, nhảy qua cuối tuần
    [-5, '2026-10-08T10:00:00.000Z'], // Thứ Năm 08/10
    [-6, '2026-10-07T10:00:00.000Z'], // Thứ Tư 07/10
    [-7, '2026-10-06T10:00:00.000Z'], // Thứ Ba 06/10
    [1, '2026-10-16T10:00:00.000Z'], // Thứ Sáu 16/10
    [2, '2026-10-19T10:00:00.000Z'], // Thứ Hai 19/10: nhảy qua cuối tuần
  ])('vector SPEC 4.5 qua engine: offset %i từ mốc đích 15/10/2026 → %s', (offset, expected) => {
    const def = defOf({
      inputs: [{ key: 'day', label: 'Ngày', type: 'date', required: true }],
      targetField: 'day',
      nodes: [START, task('a', U.LAN, { due: { anchor: 'run_target', offset: { value: offset, unit: 'working_day' } } }), END],
      edges: [edge('start', 'a'), edge('a', 'end')],
    });
    const h = new Harness(def, makeCtx({ calendar: VN }), runInput(U.ADMIN, { day: '2026-10-15' }));
    h.dispatch({ type: 'StartRun', actor: asUser(U.ADMIN) }, vn('2026-10-02', '09:00'));
    expect(h.step('a').dueAt).toBe(expected);
    expect(h.step('a').dueOriginalAt).toBe(expected);
  });
});
