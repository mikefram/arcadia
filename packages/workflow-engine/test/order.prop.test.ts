import type { Edge, ProcessDefinition, ProcessNode, RunState, StepState } from '@mihato/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validate } from '../src';
import { definitionArb, drive, fcParams, latestSteps, rawDefinitionArb, scenarioArb } from './support/arb';

/**
 * Thuộc tính 1 (SPEC 4.10), Thứ tự: không việc nào tới lượt khi còn cạnh đến chưa giải quyết
 * (trừ nút `join: 'any'`, chỉ cần một cạnh đến đã xong).
 *
 * Trạng thái cạnh được tính lại ở đây một cách độc lập với mã của engine.
 */
type Status = 'open' | 'done' | 'skipped';

function statusOf(edge: Edge, source: ProcessNode, step: StepState): Status {
  const asDone = (): Status => {
    if (source.type === 'approval') return edge.outcome === 'rejected' ? 'skipped' : 'done';
    if (source.type === 'condition') return (edge.branch ?? 'else') === step.result?.['branch'] ? 'done' : 'skipped';
    return 'done';
  };
  if (step.state === 'done') return asDone();
  if (step.state === 'rejected') return edge.outcome === 'rejected' ? 'done' : 'skipped';
  if (step.state === 'skipped') {
    // Văn phòng cho qua: cạnh ra tính là xong kể từ khi luồng đi tới việc đó; bỏ qua do rẽ nhánh: cạnh bị bỏ qua
    if (step.result?.['skippedManually'] === true) return step.activatedAt !== null ? asDone() : 'open';
    return 'skipped';
  }
  return 'open';
}

function incomingStatuses(def: ProcessDefinition, run: RunState, nodeId: string): Status[] {
  const latest = new Map(latestSteps(run).map((s) => [s.nodeId, s]));
  return def.edges
    .filter((e) => e.to === nodeId)
    .map((e) => statusOf(e, def.nodes.find((n) => n.id === e.from) as ProcessNode, latest.get(e.from) as StepState));
}

describe('thuộc tính 1: thứ tự', () => {
  it('bộ sinh luôn cho định nghĩa hợp lệ theo validate(), không quá 12 nút', () => {
    fc.assert(
      fc.property(rawDefinitionArb, (raw) => {
        const result = validate(raw as ProcessDefinition);
        expect(result.errors).toEqual([]);
        expect(result.definition?.nodes.length).toBeLessThanOrEqual(12);
      }),
      fcParams,
    );
  });

  it('bộ sinh phủ đủ các dạng: song song, join all và any, condition, timer, approval có cạnh rejected tới kết thúc', () => {
    const seen = { parallel: false, joinAny: false, joinAll: false, condition: false, timer: false, rejectedToEnd: false, twelve: false };
    fc.assert(
      fc.property(definitionArb, (def) => {
        const outCount = new Map<string, number>();
        const inCount = new Map<string, number>();
        for (const e of def.edges) {
          outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
          inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
        }
        for (const n of def.nodes) {
          if (n.type !== 'condition' && (outCount.get(n.id) ?? 0) > 1) seen.parallel = true;
          if (n.join === 'any') seen.joinAny = true;
          if (n.join !== 'any' && (inCount.get(n.id) ?? 0) > 1) seen.joinAll = true;
          if (n.type === 'condition') seen.condition = true;
          if (n.type === 'timer') seen.timer = true;
        }
        if (def.edges.some((e) => e.outcome === 'rejected' && def.nodes.find((n) => n.id === e.to)?.type === 'end')) seen.rejectedToEnd = true;
        if (def.nodes.length === 12) seen.twelve = true;
      }),
      { ...fcParams, numRuns: Math.max(fcParams.numRuns, 300) },
    );
    expect(seen).toEqual({ parallel: true, joinAny: true, joinAll: true, condition: true, timer: true, rejectedToEnd: true, twelve: true });
  });

  it('không việc nào tới lượt khi còn cạnh đến chưa giải quyết; nút join any cần ít nhất một cạnh đã xong', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        drive(scenario, ({ out }) => {
          for (const step of latestSteps(out.run)) {
            const node = scenario.def.nodes.find((n) => n.id === step.nodeId) as ProcessNode;
            if (node.type === 'start') continue;
            const reached = ['unassigned', 'ready', 'in_progress', 'done', 'rejected'].includes(step.state);
            const statuses = incomingStatuses(scenario.def, out.run, node.id);
            const done = statuses.filter((s) => s === 'done').length;
            const open = statuses.filter((s) => s === 'open').length;
            if (reached) {
              expect(done, `nút ${node.id} tới lượt khi chưa có cạnh đến nào xong`).toBeGreaterThan(0);
              if (node.join !== 'any') expect(open, `nút ${node.id} (join all) tới lượt khi còn cạnh đến chưa giải quyết`).toBe(0);
            }
            // chiều ngược lại: lượt chạy đang chạy thì không còn nút nào đủ điều kiện mà engine bỏ quên
            if (out.run.state === 'running' && step.state === 'pending') {
              const satisfied = node.join === 'any' ? done > 0 : done > 0 && open === 0;
              expect(satisfied, `nút ${node.id} đủ điều kiện mà chưa được kích hoạt`).toBe(false);
              expect(statuses.length > 0 && statuses.every((s) => s === 'skipped'), `nút ${node.id} đáng lẽ đã bị bỏ qua`).toBe(false);
            }
          }
        });
      }),
      fcParams,
    );
  });

  it('nút bị bỏ qua do rẽ nhánh không bao giờ phát thông báo giao việc hay hẹn timer', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const everActivated = new Set<string>();
        const trace = drive(scenario, ({ out }) => {
          for (const change of out.events[0]?.payload.changes ?? []) if (change.type === 'step.activated') everActivated.add(change.stepId);
          for (const effect of out.effects) {
            if (effect.kind === 'schedule_timer' && effect.timerKind !== 'wait' && effect.stepId) expect(everActivated.has(effect.stepId)).toBe(true);
          }
        });
        for (const step of trace.final.steps) {
          if (step.state === 'skipped' && step.activatedAt === null) expect(everActivated.has(step.id)).toBe(false);
        }
      }),
      fcParams,
    );
  });
});
