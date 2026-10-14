import { EXECUTIVE_ROLES } from '@mihato/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { drive, fcParams, scenarioArb } from './support/arb';

/**
 * Bất biến bổ sung ngoài bảy thuộc tính của SPEC 4.10: những điều tầng lưu trữ và worker dựa vào.
 */
const ASSIGNER_KINDS = ['notify.accepted', 'notify.completed', 'notify.extension_requested', 'notify.run_completed'];

describe('bất biến của effect và trạng thái', () => {
  it('dedupeKey không bao giờ trùng trong suốt một lượt chạy và luôn chứa runId', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const keys = new Set<string>();
        drive(scenario, ({ out, before }) => {
          for (const effect of out.effects) {
            expect(keys.has(effect.dedupeKey)).toBe(false);
            keys.add(effect.dedupeKey);
            expect(effect.dedupeKey.startsWith(`${before.id}:`)).toBe(true);
            expect(effect.runId).toBe(before.id);
            if ('toUserId' in effect) expect(effect.dedupeKey.endsWith(`:${effect.toUserId}`)).toBe(true);
          }
        });
      }),
      fcParams,
    );
  });

  it('timer chỉ được hẹn ở tương lai; việc không còn mở thì không còn timer của nó', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        drive(scenario, ({ out, now, timers }) => {
          for (const effect of out.effects) {
            if (effect.kind === 'schedule_timer' && effect.timerKind !== 'wait') expect(new Date(effect.fireAt).getTime()).toBeGreaterThan(now.getTime());
          }
          const open = new Set(out.run.steps.filter((s) => ['ready', 'in_progress'].includes(s.state)).map((s) => s.id));
          for (const t of timers.values()) expect(t.stepId !== null && open.has(t.stepId), `còn timer của một việc không còn mở`).toBe(true);
        });
      }),
      fcParams,
    );
  });

  it('người khởi chạy là điều hành không bao giờ nhận tin dành cho "người giao"; tin đó chỉ tới Văn phòng', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const initiator = scenario.ctx.users.find((u) => u.id === scenario.initiatorId);
        const executive = initiator?.roles.some((r) => (EXECUTIVE_ROLES as readonly string[]).includes(r.role)) ?? false;
        const offices = new Set(scenario.ctx.users.filter((u) => u.status === 'active' && u.roles.some((r) => r.role === 'office_admin')).map((u) => u.id));
        drive(scenario, ({ out }) => {
          for (const effect of out.effects) {
            if (!('toUserId' in effect)) continue;
            const forAssigner = ASSIGNER_KINDS.includes(effect.kind) || (effect.kind === 'notify.overdue' && effect.data['audience'] === 'assigner');
            if (!forAssigner) continue;
            if (executive) expect(offices.has(effect.toUserId)).toBe(true);
            else expect(effect.toUserId).toBe(scenario.initiatorId);
          }
        });
      }),
      fcParams,
    );
  });

  it('không ai nhận tin về chính thao tác mình vừa làm (trừ việc mới giao cho chính mình)', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        drive(scenario, ({ out, event }) => {
          const actor = event.actor.userId;
          if (!actor) return;
          for (const effect of out.effects) {
            if (!('toUserId' in effect) || effect.toUserId !== actor) continue;
            expect(['notify.assigned', 'notify.custom', 'notify.nudge']).toContain(effect.kind);
          }
        });
      }),
      fcParams,
    );
  });

  it('việc ở trạng thái ready hoặc in_progress luôn có người nhận; việc unassigned thì không', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        drive(scenario, ({ out }) => {
          for (const step of out.run.steps) {
            if (step.kind !== 'task' && step.kind !== 'approval') continue;
            if (step.state === 'ready' || step.state === 'in_progress') {
              expect(step.assigneeId).not.toBeNull();
              if (step.kind === 'approval') expect(step.approvals.some((a) => a.decision === null)).toBe(true);
            }
            if (step.state === 'unassigned') expect(step.assigneeId).toBeNull();
            if (['done', 'rejected', 'skipped', 'cancelled'].includes(step.state)) expect(step.blockedReason).toBeNull();
          }
        });
      }),
      fcParams,
    );
  });
});
