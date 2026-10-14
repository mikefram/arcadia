import {
  deterministicId,
  EngineError,
  EngineEventSchema,
  type Actor,
  type AdvanceOutput,
  type Effect,
  type EngineEvent,
  type NewRunInput,
  type NotifyEffect,
  type NotifyKind,
  type ProcessDefinition,
  type ResolveContext,
  type RunEventRecord,
  type RunState,
  type ScheduleTimerEffect,
  type StepState,
} from '@mihato/domain';
import { advance, createRun, replay } from '../../src';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Sự kiện không cần ghi `eventId`, `at`: harness tự điền theo đồng hồ giả. */
export type EventInput = DistributiveOmit<EngineEvent, 'eventId' | 'at'> & { eventId?: string };

export const asUser = (userId: string): Actor => ({ type: 'user', userId });
export const SYSTEM: Actor = { type: 'system' };

export type Sent = { at: Date; effect: NotifyEffect };

/** Chạy `fn` và trả mã lỗi của EngineError nó ném ra; null khi không ném. Lỗi loại khác được ném tiếp. */
export function errorCode(fn: () => unknown): EngineError['code'] | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
  return null;
}

/**
 * Mô phỏng tầng lưu trữ và worker trong bộ nhớ, đủ để chạy kịch bản bằng đồng hồ giả:
 * - áp `advance()`, giữ lượt chạy mới và các dòng run_events;
 * - áp effect THEO THỨ TỰ trong mảng: schedule_timer thêm timer, cancel_timers xoá timer đang chờ,
 *   notify vào hộp thư; `dedupeKey` trùng là lỗi (ràng buộc UNIQUE ở CSDL);
 * - `advanceTo(t)` bắn TimerFired cho mọi timer tới giờ, đúng giờ hẹn, theo thứ tự thời gian.
 */
export class Harness {
  run: RunState;
  readonly initial: RunState;
  readonly records: RunEventRecord[] = [];
  readonly timers = new Map<string, ScheduleTimerEffect>();
  readonly outbox: Sent[] = [];
  readonly effects: Effect[] = [];
  private readonly keys = new Set<string>();
  private counter = 0;

  constructor(
    readonly def: ProcessDefinition,
    public ctx: ResolveContext,
    input: NewRunInput,
  ) {
    this.run = createRun(def, input);
    this.initial = this.run;
  }

  nextEventId(): string {
    return deterministicId(`test-event:${this.run.id}:${++this.counter}`);
  }

  dispatch(input: EventInput, now: Date): AdvanceOutput {
    const event = EngineEventSchema.parse({ ...input, eventId: input.eventId ?? this.nextEventId(), at: now.toISOString() });
    const out = advance({ def: this.def, run: this.run, event, ctx: this.ctx, now });
    this.run = out.run;
    this.records.push(...out.events);
    for (const effect of out.effects) {
      if (this.keys.has(effect.dedupeKey)) throw new Error(`dedupeKey trùng: ${effect.dedupeKey}`);
      this.keys.add(effect.dedupeKey);
      this.effects.push(effect);
      if (effect.kind === 'schedule_timer') {
        this.timers.set(effect.dedupeKey, effect);
      } else if (effect.kind === 'cancel_timers') {
        for (const [key, timer] of this.timers) if (effect.stepId === null || timer.stepId === effect.stepId) this.timers.delete(key);
      } else if (effect.kind !== 'webhook') {
        this.outbox.push({ at: now, effect });
      }
    }
    return out;
  }

  /** Bắn mọi timer có giờ hẹn không muộn hơn `until`. Trả về số timer đã bắn. */
  advanceTo(until: Date): number {
    let fired = 0;
    for (;;) {
      let next: ScheduleTimerEffect | null = null;
      for (const t of this.timers.values()) {
        if (new Date(t.fireAt).getTime() > until.getTime()) continue;
        if (next === null || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && t.dedupeKey < next.dedupeKey)) next = t;
      }
      if (next === null) return fired;
      this.timers.delete(next.dedupeKey);
      this.dispatch(
        { type: 'TimerFired', actor: SYSTEM, timerKey: next.dedupeKey, stepId: next.stepId, kind: next.timerKind, data: next.data, eventId: deterministicId(`timer:${next.dedupeKey}`) },
        new Date(next.fireAt),
      );
      fired++;
    }
  }

  /** Lần thử mới nhất của một nút. */
  step(nodeId: string): StepState {
    const found = this.run.steps.filter((s) => s.nodeId === nodeId).sort((a, b) => b.attempt - a.attempt)[0];
    if (!found) throw new Error(`không có nút ${nodeId}`);
    return found;
  }

  /** Thông báo đã gửi kể từ mốc `from` (chỉ số trong hộp thư), lọc theo loại và người nhận. */
  sent(filter: { kind?: NotifyKind; to?: string; nodeId?: string; from?: number } = {}): Sent[] {
    return this.outbox.slice(filter.from ?? 0).filter((s) => {
      if (filter.kind && s.effect.kind !== filter.kind) return false;
      if (filter.to && s.effect.toUserId !== filter.to) return false;
      if (filter.nodeId && s.effect.data['nodeId'] !== filter.nodeId) return false;
      return true;
    });
  }

  mark(): number {
    return this.outbox.length;
  }

  timersOf(nodeId: string): ScheduleTimerEffect[] {
    const ids = new Set(this.run.steps.filter((s) => s.nodeId === nodeId).map((s) => s.id));
    return [...this.timers.values()].filter((t) => t.stepId !== null && ids.has(t.stepId)).sort((a, b) => (a.fireAt < b.fireAt ? -1 : 1));
  }

  replayed(): RunState {
    return replay({ def: this.def, initial: this.initial, events: this.records, ctx: this.ctx });
  }
}
