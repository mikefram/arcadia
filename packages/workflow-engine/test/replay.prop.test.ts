import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { replay } from '../src';
import { drive, fcParams, scenarioArb } from './support/arb';

/**
 * Thuộc tính 3 (SPEC 4.10), Phát lại: áp lại toàn bộ run_events từ lượt chạy draft cho đúng
 * trạng thái hiện tại, từng bit.
 */
describe('thuộc tính 3: phát lại', () => {
  it('replay(initial, run_events) = trạng thái hiện tại, so cả đối tượng lẫn chuỗi JSON', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const trace = drive(scenario);
        const replayed = replay({ def: scenario.def, initial: trace.initial, events: trace.records, ctx: scenario.ctx });
        expect(replayed).toEqual(trace.final);
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(trace.final));
      }),
      fcParams,
    );
  });

  it('phát lại một phần đầu của nhật ký cho đúng trạng thái tại thời điểm đó; thứ tự mảng đầu vào không quan trọng', () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(), (scenario, cut) => {
        const trace = drive(scenario);
        if (trace.steps.length === 0) return;
        const upTo = trace.steps[cut % trace.steps.length];
        if (!upTo) return;
        const prefix = trace.records.filter((r) => r.seq <= upTo.out.run.seq);
        const shuffled = [...prefix].reverse();
        const replayed = replay({ def: scenario.def, initial: trace.initial, events: shuffled, ctx: scenario.ctx });
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(upTo.out.run));
      }),
      fcParams,
    );
  });

  it('nhật ký tự nó đủ để dựng lại: mỗi sự kiện có hiệu lực đúng một dòng, seq liên tục, version đi cùng seq', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const trace = drive(scenario, ({ out, before, event, now }) => {
          expect(out.events).toHaveLength(1);
          expect(out.events[0]).toMatchObject({ id: event.eventId, runId: before.id, seq: before.seq + 1, type: event.type, at: now.toISOString() });
          expect(out.events[0]?.payload.event).toEqual(event);
          expect(out.run.seq).toBe(before.seq + 1);
          expect(out.run.version).toBe(before.version + 1);
          expect(out.run.appliedEventIds).toEqual([...before.appliedEventIds, event.eventId]);
        });
        expect(trace.records.map((r) => r.seq)).toEqual(trace.records.map((_, i) => i + 1));
        // mọi id của step_runs là duy nhất và tất định
        expect(new Set(trace.final.steps.map((s) => s.id)).size).toBe(trace.final.steps.length);
      }),
      fcParams,
    );
  });
});
