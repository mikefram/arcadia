import { deterministicId, newId, type RunDetail, type StepResult, type StepView } from '@mihato/domain';
import { addWorkingDays, atLocalTime, isWorkingDay, toLocalDate } from '@mihato/domain/calendar';
import { FakePush, type PushProvider } from '@mihato/providers/push';
import { signToken } from '../auth/crypto';
import { clock, setFakeNow } from '../clock';
import { loadOrgContext, type OrgContext } from '../context';
import { withOrg, type Tx } from '../db/client';
import { sendNudges } from '../services/nudges';
import { actOnStep, getRun, startRun } from '../services/runs';
import type { Viewer } from '../views';
import { runWorkerTick } from '../worker';
import { seedViewer, type SeedIds, type UserCode } from './org';

/**
 * Diễn lại kịch bản "Đón đoàn nhà đầu tư thăm KCN" (SPEC 13.2) bằng chính các service của hệ thống:
 * mọi thay đổi đi qua advance(), không ghi thẳng vào bảng (SPEC 15.4). Dùng cho script seed và cho test.
 */
export class Scenario {
  readonly push: PushProvider;
  constructor(
    readonly ids: SeedIds,
    push?: PushProvider,
  ) {
    this.push = push ?? new FakePush();
  }

  as<T>(code: UserCode, fn: (tx: Tx, ctx: OrgContext, viewer: Viewer) => Promise<T>): Promise<T> {
    return withOrg(this.ids.ORG, async (tx) => fn(tx, await loadOrgContext(tx, this.ids.ORG), seedViewer(this.ids, code)));
  }

  /**
   * Đưa đồng hồ giả tới `when` rồi cho worker chạy mọi timer và effect đã đến hạn. Nếu nhảy qua nhiều ngày thì
   * dừng ở 08:31 giờ Việt Nam của từng ngày ở giữa, để các mốc nhắc 08:30 bắn đúng ngày của chúng.
   */
  async at(when: Date | string): Promise<void> {
    const target = new Date(when);
    if (clock.fakeIso()) {
      const DAY = 86_400_000;
      const OFFSET = 7 * 3_600_000;
      const cur = clock.now().getTime();
      let cand = Math.floor((cur + OFFSET) / DAY) * DAY + (8 * 60 + 31) * 60_000 - OFFSET;
      if (cand <= cur) cand += DAY;
      for (; cand < target.getTime(); cand += DAY) {
        setFakeNow(new Date(cand));
        await runWorkerTick({ push: this.push }, { orgId: this.ids.ORG });
      }
    }
    setFakeNow(target);
    await runWorkerTick({ push: this.push }, { orgId: this.ids.ORG });
  }

  async tick(): Promise<void> {
    await runWorkerTick({ push: this.push }, { orgId: this.ids.ORG });
  }

  async start(by: UserCode, input: { title: string; delegation: string; visitDate: string }, eventId = newId(clock.now().getTime())): Promise<RunDetail> {
    const run = await this.as(by, (tx, ctx, viewer) =>
      startRun(tx, ctx, viewer, { templateId: this.ids.TEMPLATE_DON_DOAN, title: input.title, inputs: { delegation: input.delegation, visitDate: input.visitDate } }, eventId),
    );
    await this.tick();
    return run;
  }

  run(runId: string, as: UserCode = 'U_ADMIN'): Promise<RunDetail> {
    return this.as(as, (tx, ctx, viewer) => getRun(tx, ctx, viewer, runId));
  }

  async step(runId: string, nodeId: string): Promise<StepView> {
    const run = await this.run(runId);
    const step = run.steps.find((s) => s.nodeId === nodeId);
    if (!step) throw new Error(`Không thấy việc ${nodeId} trong lượt chạy`);
    return step;
  }

  async accept(by: UserCode, runId: string, nodeId: string): Promise<StepResult> {
    const step = await this.step(runId, nodeId);
    const res = await this.as(by, (tx, ctx, viewer) => actOnStep(tx, ctx, viewer, step.id, newId(clock.now().getTime()), { type: 'AcceptStep' }));
    await this.tick();
    return res;
  }

  async complete(by: UserCode, runId: string, nodeId: string, result?: Record<string, unknown>, eventId = newId(clock.now().getTime())): Promise<StepResult> {
    const step = await this.step(runId, nodeId);
    const res = await this.as(by, (tx, ctx, viewer) => actOnStep(tx, ctx, viewer, step.id, eventId, { type: 'CompleteStep', result }));
    await this.tick();
    return res;
  }

  /** Duyệt một việc; việc có số tiền thì kèm mã nâng quyền như app sẽ làm sau khi mở khoá. */
  async approve(by: UserCode, runId: string, nodeId: string, opts: { withStepUp?: boolean } = { withStepUp: true }): Promise<StepResult> {
    const step = await this.step(runId, nodeId);
    const viewer = seedViewer(this.ids, by);
    const stepUpToken = opts.withStepUp ? (await signToken('stepup', { sub: viewer.id, org: viewer.orgId }, 60)).token : undefined;
    const res = await this.as(by, (tx, ctx, v) => actOnStep(tx, ctx, v, step.id, newId(clock.now().getTime()), { type: 'ApproveStep' }, { stepUpToken }));
    await this.tick();
    return res;
  }

  async nudge(by: UserCode, runId: string, nodeId: string, message: string) {
    const step = await this.step(runId, nodeId);
    const key = newId(clock.now().getTime());
    const res = await this.as(by, (tx, ctx, viewer) => sendNudges(tx, ctx, viewer, { items: [{ stepId: step.id, message }] }, key));
    await this.tick();
    return res;
  }
}

/** Ngày làm việc gần nhất không sau hôm nay. */
function lastWorkingDay(ctx: OrgContext, now: Date): string {
  let t = now.getTime();
  let day = toLocalDate(new Date(t), ctx.calendar);
  for (let i = 0; i < 30 && !isWorkingDay(day, ctx.calendar); i++) {
    t -= 86_400_000;
    day = toLocalDate(new Date(t), ctx.calendar);
  }
  return day;
}

/**
 * Ba lượt chạy mẫu so với hôm nay để dashboard có dữ liệu sống: một lượt đang chậm (đúng trạng thái
 * bước 8 của kịch bản vàng), một lượt vừa khởi chạy, một lượt đã hoàn tất. Kết thúc thì trả đồng hồ thật.
 */
export async function seedDemoRuns(ids: SeedIds): Promise<void> {
  const s = new Scenario(ids);
  const realNow = new Date();
  const ctx = await withOrg(ids.ORG, (tx) => loadOrgContext(tx, ids.ORG));
  const cal = ctx.calendar;
  const d0 = lastWorkingDay(ctx, realNow);
  const at = (day: string, time: string) => atLocalTime(day, time, cal);
  const wd = (day: string, n: number) => addWorkingDays(day, n, cal);
  const before = (t: Date) => (t < realNow ? t : new Date(realNow.getTime() - 60_000));
  try {
    // Lượt đã hoàn tất: mốc đích hai ngày làm việc trước; một việc xong trễ một ngày để báo cáo có số.
    const tC = wd(d0, -2);
    await s.at(at(wd(tC, -9), '09:00'));
    const c = await s.start('U_ADMIN', { title: 'Đón đoàn nhà đầu tư Singapore', delegation: 'Đoàn nhà đầu tư Singapore', visitDate: tC }, deterministicId(`seed-run:${ids.ORG}:C`));
    await s.at(at(wd(tC, -8), '11:00'));
    await s.complete('U_LAN', c.id, 's1');
    await s.at(at(wd(tC, -8), '14:00'));
    await s.complete('U_PHUONG', c.id, 's4', { amount: 35_000_000 });
    await s.at(at(wd(tC, -7), '09:00'));
    await s.approve('U_HUY', c.id, 's6');
    await s.at(at(wd(tC, -6), '10:00'));
    await s.complete('U_NGOCANH', c.id, 's2');
    await s.at(at(wd(tC, -5), '10:00'));
    await s.complete('U_TUAN', c.id, 's3');
    await s.at(at(wd(tC, -5), '15:00'));
    await s.complete('U_HUNG', c.id, 's5');

    // Lượt đang chậm: trạng thái bước 8 của kịch bản vàng, dời theo hôm nay.
    const tA = wd(d0, 5);
    await s.at(at(wd(tA, -9), '09:00'));
    const a = await s.start('U_ADMIN', { title: 'Đón đoàn nhà đầu tư Nhật Bản', delegation: 'Đoàn nhà đầu tư Nhật Bản', visitDate: tA }, deterministicId(`seed-run:${ids.ORG}:A`));
    await s.at(at(wd(tA, -8), '11:00'));
    await s.complete('U_LAN', a.id, 's1');
    await s.at(at(wd(tA, -8), '14:00'));
    await s.complete('U_PHUONG', a.id, 's4', { amount: 20_000_000 });
    await s.at(at(wd(tA, -6), '09:00'));
    await s.approve('U_HUY', a.id, 's6');
    await s.at(before(at(wd(tA, -6), '10:00')));
    await s.complete('U_NGOCANH', a.id, 's2');

    // Lượt vừa khởi chạy, còn đúng tiến độ.
    const tB = wd(d0, 12);
    await s.at(before(at(d0, '09:00')));
    const b = await s.start('U_ADMIN', { title: 'Đón đoàn nhà đầu tư Hàn Quốc', delegation: 'Đoàn nhà đầu tư Hàn Quốc', visitDate: tB }, deterministicId(`seed-run:${ids.ORG}:B`));
    await s.at(before(at(d0, '10:30')));
    await s.accept('U_LAN', b.id, 's1');

    // Về hiện tại: bắn các timer đã qua hạn theo đúng quy tắc chống làm phiền, rồi trả đồng hồ thật.
    await s.at(new Date(realNow.getTime() - 30_000));
  } finally {
    setFakeNow(null);
  }
}
