import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advance } from '../src';
import { drive, fcParams, scenarioArb } from './support/arb';

/**
 * Thuộc tính 4 (SPEC 4.10), Lặp sự kiện: áp cùng một eventId hai lần cho kết quả giống áp một lần.
 */
describe('thuộc tính 4: lặp sự kiện', () => {
  it('áp lại ngay sự kiện vừa áp: lượt chạy giữ nguyên, không effect, không dòng sự kiện mới', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        drive(scenario, ({ event, out, now }) => {
          const later = new Date(now.getTime() + 5 * 60_000);
          const again = advance({ def: scenario.def, run: out.run, event, ctx: scenario.ctx, now: later });
          expect(again.run).toBe(out.run);
          expect(again.effects).toEqual([]);
          expect(again.events).toEqual([]);
        });
      }),
      fcParams,
    );
  });

  it('áp lại một sự kiện cũ bất kỳ ở cuối kịch bản: không đổi gì', () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(), (scenario, pick) => {
        const trace = drive(scenario);
        const old = trace.steps[pick % Math.max(trace.steps.length, 1)];
        if (!old) return;
        const frozen = JSON.stringify(trace.final);
        const again = advance({ def: scenario.def, run: trace.final, event: old.event, ctx: scenario.ctx, now: new Date(old.now.getTime() + 86_400_000) });
        expect(again).toEqual({ run: trace.final, effects: [], events: [] });
        expect(JSON.stringify(again.run)).toBe(frozen);
      }),
      fcParams,
    );
  });

  it('gửi mỗi sự kiện hai lần liên tiếp cho cùng trạng thái cuối và cùng nhật ký như gửi một lần', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const once = drive(scenario);
        let run = once.initial;
        const records = [];
        for (const step of once.steps) {
          for (let k = 0; k < 2; k++) {
            const out = advance({ def: scenario.def, run, event: step.event, ctx: scenario.ctx, now: step.now });
            run = out.run;
            records.push(...out.events);
          }
        }
        expect(JSON.stringify(run)).toBe(JSON.stringify(once.final));
        expect(records).toEqual(once.records);
      }),
      fcParams,
    );
  });
});
