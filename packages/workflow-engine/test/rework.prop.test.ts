import { deterministicId, stepRunId, type EngineEvent, type ProcessDefinition } from '@mihato/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advance, replay, validate } from '../src';
import { drive, fcParams, holdersOf, latestSteps, loopScenarioArb, rawLoopDefinitionArb } from './support/arb';
import { U } from './support/world';

/**
 * Vòng làm lại qua cạnh rejected (giai đoạn 3): các thuộc tính của SPEC 4.10 phải đứng vững cả khi
 * định nghĩa có cạnh "Chưa đồng ý" quay về nút đứng trước.
 */
const OPEN = ['unassigned', 'ready', 'in_progress'];
const TERMINAL = ['done', 'rejected', 'skipped', 'cancelled'];

describe('vòng làm lại: thuộc tính', () => {
  it('bộ sinh cho định nghĩa hợp lệ và thật sự có vòng làm lại', () => {
    let withLoop = 0;
    fc.assert(
      fc.property(rawLoopDefinitionArb, (raw) => {
        const result = validate(raw as ProcessDefinition);
        expect(result.errors).toEqual([]);
        const def = raw as ProcessDefinition;
        if (def.edges.some((e) => e.outcome === 'rejected' && def.nodes.find((n) => n.id === e.to)?.type !== 'end')) withLoop++;
      }),
      fcParams,
    );
    expect(withLoop).toBeGreaterThan(0);
  });

  it('phát lại đúng từng bit, lặp sự kiện không đổi gì, id của mọi lần thử là duy nhất và tất định', () => {
    let reworked = 0;
    fc.assert(
      fc.property(loopScenarioArb, (scenario) => {
        const trace = drive(scenario, ({ event, out }) => {
          const again = advance({ def: scenario.def, run: out.run, event, ctx: scenario.ctx, now: new Date(event.at) });
          expect(again).toEqual({ run: out.run, effects: [], events: [] });
        });
        const replayed = replay({ def: scenario.def, initial: trace.initial, events: trace.records, ctx: scenario.ctx });
        expect(JSON.stringify(replayed)).toBe(JSON.stringify(trace.final));

        const byNode = new Map<string, number[]>();
        for (const step of trace.final.steps) {
          expect(step.id).toBe(stepRunId(trace.final.id, step.nodeId, step.attempt));
          byNode.set(step.nodeId, [...(byNode.get(step.nodeId) ?? []), step.attempt]);
        }
        expect(new Set(trace.final.steps.map((s) => s.id)).size).toBe(trace.final.steps.length);
        for (const attempts of byNode.values()) {
          expect(attempts).toEqual(attempts.map((_, i) => i + 1)); // 1, 2, 3… liên tục
          if (attempts.length > 1) reworked++;
        }
      }),
      fcParams,
    );
    expect(reworked).toBeGreaterThan(0);
  });

  it('chỉ lần thử mới nhất của một nút mới có thể còn dở; timer chỉ thuộc về việc đang mở; hoàn tất đúng điều kiện', () => {
    fc.assert(
      fc.property(loopScenarioArb, (scenario) => {
        drive(scenario, ({ out, timers }) => {
          const latest = latestSteps(out.run);
          const latestIds = new Set(latest.map((s) => s.id));
          for (const step of out.run.steps) if (!latestIds.has(step.id)) expect(TERMINAL).toContain(step.state);
          const open = new Set(latest.filter((s) => OPEN.includes(s.state)).map((s) => s.id));
          for (const t of timers.values()) expect(t.stepId !== null && open.has(t.stepId)).toBe(true);

          const ends = latest.filter((s) => s.kind === 'end');
          const allEndsReached = ends.length > 0 && ends.every((s) => s.state === 'done');
          if (out.run.state === 'running') expect(!allEndsReached && open.size > 0).toBe(true);
          if (out.run.state === 'completed') {
            expect(latest.filter((s) => !TERMINAL.includes(s.state))).toEqual([]);
            expect(out.run.outcome).toBe(latest.some((s) => s.kind === 'approval' && s.state === 'rejected') ? 'rejected' : 'success');
          }
        });
      }),
      fcParams,
    );
  });

  it('không bao giờ kẹt: cứ làm xong và đồng ý mọi việc đang mở thì lượt chạy hoàn tất', () => {
    fc.assert(
      fc.property(loopScenarioArb, (scenario) => {
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
