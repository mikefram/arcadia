import { deterministicId, type EngineEvent } from '@mihato/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advance } from '../src';
import { drive, fcParams, holdersOf, latestSteps, scenarioArb } from './support/arb';
import { U } from './support/world';

/**
 * Thuộc tính 2 (SPEC 4.10), Kết thúc: lượt chạy `completed` khi và chỉ khi mọi nút kết thúc đã tới,
 * hoặc không còn nút nào kích hoạt được (không còn việc nào mở).
 */
const OPEN = ['unassigned', 'ready', 'in_progress'];

describe('thuộc tính 2: kết thúc', () => {
  it('completed ⇔ (mọi nút end đã tới) hoặc (không còn việc nào mở)', () => {
    let completedRuns = 0;
    let rejectedRuns = 0;
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const trace = drive(scenario, ({ out, now, before, timers }) => {
          const run = out.run;
          const latest = latestSteps(run);
          const ends = latest.filter((s) => s.kind === 'end');
          const allEndsReached = ends.length > 0 && ends.every((s) => s.state === 'done');
          const anyOpen = latest.some((s) => OPEN.includes(s.state));

          if (run.state === 'running') {
            expect(allEndsReached, 'mọi nút kết thúc đã tới mà lượt chạy chưa hoàn tất').toBe(false);
            expect(anyOpen, 'không còn việc nào mở mà lượt chạy chưa hoàn tất').toBe(true);
            expect(run.completedAt).toBeNull();
            expect(run.outcome).toBeNull();
          }
          if (run.state === 'completed') {
            expect(allEndsReached || !anyOpen).toBe(true);
            // không còn việc dở, không còn timer chờ
            expect(latest.filter((s) => OPEN.includes(s.state) || s.state === 'pending')).toEqual([]);
            expect([...timers.keys()]).toEqual([]);
            const rejected = latest.some((s) => s.kind === 'approval' && s.state === 'rejected');
            expect(run.outcome).toBe(rejected ? 'rejected' : 'success');
            if (before.state === 'running') {
              expect(run.completedAt).toBe(now.toISOString());
              expect(out.events[0]?.payload.changes.filter((c) => c.type === 'run.completed')).toHaveLength(1);
            }
          }
          if (run.state === 'cancelled') {
            expect(run.steps.filter((s) => OPEN.includes(s.state) || s.state === 'pending')).toEqual([]);
            expect([...timers.keys()]).toEqual([]);
            expect(run.outcome).toBeNull();
          }
          // đã kết thúc thì không chạy lại
          if (before.state === 'completed' || before.state === 'cancelled') {
            expect(run.state).toBe(before.state);
            expect(run.steps).toEqual(before.steps);
            expect(out.effects).toEqual([]);
          }
        });
        if (trace.final.state === 'completed') completedRuns++;
        if (trace.final.outcome === 'rejected') rejectedRuns++;
      }),
      fcParams,
    );
    // bộ sinh phải thật sự đưa được lượt chạy tới đích, nếu không thuộc tính trên chỉ đúng một cách rỗng
    expect(completedRuns).toBeGreaterThan(0);
    expect(rejectedRuns).toBeGreaterThanOrEqual(0);
  });

  it('không bao giờ kẹt: từ mọi trạng thái đang chạy, cứ xử lý xong các việc đang mở thì lượt chạy hoàn tất', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const trace = drive(scenario);
        let run = trace.final;
        if (run.state !== 'running') return;
        let now = (trace.steps.at(-1)?.now ?? scenario.startAt).getTime();
        const limit = scenario.def.nodes.length * 5;
        let guard = 0;
        while (run.state === 'running') {
          expect(++guard, 'lượt chạy không hoàn tất dù mọi việc mở đều được xử lý').toBeLessThanOrEqual(limit);
          const open = latestSteps(run).find((s) => OPEN.includes(s.state));
          expect(open, 'lượt chạy đang chạy mà không còn việc nào mở').toBeDefined();
          if (!open) return;
          now += 60_000;
          const base = { eventId: deterministicId(`finish:${guard}`), at: new Date(now).toISOString() };
          const node = scenario.def.nodes.find((n) => n.id === open.nodeId);
          const holder = holdersOf(open)[0] ?? U.ADMIN;
          let event: EngineEvent;
          if (open.kind === 'timer') {
            event = { ...base, type: 'TimerFired', actor: { type: 'system' }, timerKey: `finish:${guard}`, stepId: open.id, kind: 'wait', data: {} };
          } else if (open.state === 'unassigned') {
            event = { ...base, type: 'AssignStep', actor: { type: 'user', userId: U.ADMIN }, stepId: open.id, toUserId: U.LAN2 };
          } else if (open.kind === 'approval') {
            event = { ...base, type: 'ApproveStep', actor: { type: 'user', userId: holder }, stepId: open.id };
          } else {
            const needsAmount = node?.type === 'task' && (node.form ?? []).length > 0;
            event = { ...base, type: 'CompleteStep', actor: { type: 'user', userId: holder }, stepId: open.id, ...(needsAmount ? { result: { amount: 0 } } : {}) };
          }
          run = advance({ def: scenario.def, run, event, ctx: scenario.ctx, now: new Date(now) }).run;
        }
        expect(run.state).toBe('completed');
      }),
      fcParams,
    );
  });
});
