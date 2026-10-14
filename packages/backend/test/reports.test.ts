import { newId } from '@mihato/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { putHoliday } from '../src/services/org';
import { getOverview } from '../src/services/overview';
import { getReport } from '../src/services/reports';
import { createTestOrg, type TestOrg } from '../src/testing';
import { expectApiError, twoTaskDefinition } from './helpers';

/**
 * Báo cáo trên dữ liệu nhỏ, số đối chiếu tay (SPEC 9.6). Lịch mặc định: Thứ Hai đến Thứ Sáu, giờ Việt Nam (UTC+7).
 * "Bây giờ" là Thứ Sáu 16/10/2026 10:00 giờ Việt Nam. Kỳ báo cáo: 05/10 (Thứ Hai) đến 12/10 (Thứ Hai).
 *
 * Việc đã xong:
 *   A  Lan   bước n1  tới lượt T2 05/10, xong T4 07/10, hạn gốc T5 08/10              đúng hạn, 2 ngày làm việc
 *   B  Lan   bước n2  tới lượt T2 05/10, xong T6 09/10, hạn gốc T4 07/10, gia hạn T6  trễ hạn gốc, kịp hạn mới, 4 ngày
 *   C  Tuấn  bước n1  tới lượt T3 06/10, xong T2 12/10, hạn gốc T6 09/10              trễ, 4 ngày (T4, T5, T6, T2)
 *   H  Bảo   bước n6  tới lượt và xong T5 08/10, không có hạn                         không tính đúng hạn, 0 ngày
 *   D  Hạnh  bước n3  xong 30/09: ngoài kỳ.   I  Tuấn  xong 13/10 00:30 giờ Việt Nam: ngoài kỳ.
 * Việc đang mở:
 *   E  Lan   đang làm, hạn 14/10: quá hạn.    F  Tuấn  mới giao, hạn 20/10.    G  chưa có người, hạn 13/10: quá hạn.
 *   Một việc quá hạn nằm trong lượt chạy đã huỷ: không tính.
 */
const NOW = '2026-10-16T03:00:00.000Z';

let org: TestOrg;
let templateId: string;
const stepIds: Record<string, string> = {};

beforeAll(async () => {
  setFakeNow(NOW);
  org = await createTestOrg();
  templateId = newId();
  const versionId = newId();
  const runs = { r1: newId(), r2: newId(), cancelled: newId() };
  const at = (iso: string | null) => (iso ? new Date(iso) : null);
  const { employee: lan, employee2: tuan, head: bao, officeAdmin: hanh } = org.users;

  type StepSeed = { key: string; run: keyof typeof runs; node: string; kind?: string; state: string; who: string | null; activated: string; completed?: string; dueOriginal?: string | null; due?: string | null };
  const steps: StepSeed[] = [
    { key: 'A', run: 'r1', node: 'n1', state: 'done', who: lan, activated: '2026-10-05T01:00:00Z', completed: '2026-10-07T03:00:00Z', dueOriginal: '2026-10-08T10:00:00Z', due: '2026-10-08T10:00:00Z' },
    { key: 'B', run: 'r1', node: 'n2', state: 'done', who: lan, activated: '2026-10-05T01:00:00Z', completed: '2026-10-09T04:00:00Z', dueOriginal: '2026-10-07T10:00:00Z', due: '2026-10-09T10:00:00Z' },
    { key: 'C', run: 'r2', node: 'n1', state: 'done', who: tuan, activated: '2026-10-06T01:00:00Z', completed: '2026-10-12T02:00:00Z', dueOriginal: '2026-10-09T10:00:00Z', due: '2026-10-09T10:00:00Z' },
    { key: 'D', run: 'r2', node: 'n3', state: 'done', who: hanh, activated: '2026-09-28T01:00:00Z', completed: '2026-09-30T03:00:00Z', dueOriginal: '2026-09-30T10:00:00Z', due: '2026-09-30T10:00:00Z' },
    { key: 'E', run: 'r1', node: 'n4', state: 'in_progress', who: lan, activated: '2026-10-12T01:00:00Z', dueOriginal: '2026-10-14T10:00:00Z', due: '2026-10-14T10:00:00Z' },
    { key: 'F', run: 'r2', node: 'n5', state: 'ready', who: tuan, activated: '2026-10-12T01:00:00Z', dueOriginal: '2026-10-20T10:00:00Z', due: '2026-10-20T10:00:00Z' },
    { key: 'G', run: 'r1', node: 'n7', state: 'unassigned', who: null, activated: '2026-10-12T01:00:00Z', dueOriginal: '2026-10-13T10:00:00Z', due: '2026-10-13T10:00:00Z' },
    { key: 'H', run: 'r1', node: 'n6', state: 'done', who: bao, activated: '2026-10-08T01:00:00Z', completed: '2026-10-08T03:00:00Z', dueOriginal: null, due: null },
    { key: 'I', run: 'r2', node: 'n8', state: 'done', who: tuan, activated: '2026-10-12T01:00:00Z', completed: '2026-10-12T17:30:00Z', dueOriginal: '2026-10-14T10:00:00Z', due: '2026-10-14T10:00:00Z' },
    // Không phải việc của người: nút bắt đầu, và việc trong lượt chạy đã huỷ.
    { key: 'S', run: 'r1', node: 'start', kind: 'start', state: 'done', who: null, activated: '2026-10-05T01:00:00Z', completed: '2026-10-05T01:00:00Z' },
    { key: 'X', run: 'cancelled', node: 'n1', state: 'cancelled', who: lan, activated: '2026-10-05T01:00:00Z', dueOriginal: '2026-10-06T10:00:00Z', due: '2026-10-06T10:00:00Z' },
  ];
  for (const s of steps) stepIds[s.key] = newId();

  await org.run(async (tx) => {
    await tx.insert(schema.processTemplates).values({ id: templateId, orgId: org.orgId, name: 'Đón đoàn', createdBy: org.users.designer });
    await tx.insert(schema.processTemplateVersions).values({
      id: versionId,
      orgId: org.orgId,
      templateId,
      version: 1,
      definition: twoTaskDefinition('Đón đoàn', lan, tuan),
      status: 'published',
      publishedAt: at('2026-10-01T01:00:00Z'),
      publishedBy: org.users.designer,
    });
    await tx.insert(schema.processRuns).values(
      (Object.keys(runs) as (keyof typeof runs)[]).map((k) => ({
        id: runs[k],
        orgId: org.orgId,
        templateId,
        templateVersionId: versionId,
        title: `Lượt ${k}`,
        initiatorId: hanh,
        state: k === 'cancelled' ? 'cancelled' : 'running',
        startedAt: at('2026-10-05T01:00:00Z'),
      })),
    );
    await tx.insert(schema.stepRuns).values(
      steps.map((s) => ({
        id: stepIds[s.key]!,
        orgId: org.orgId,
        runId: runs[s.run],
        nodeId: s.node,
        kind: s.kind ?? 'task',
        title: `Việc ${s.node}`,
        state: s.state,
        assigneeId: s.who,
        activatedAt: at(s.activated),
        completedAt: at(s.completed ?? null),
        dueOriginalAt: at(s.dueOriginal ?? null),
        dueAt: at(s.due ?? null),
      })),
    );
    const nudge = (step: string, to: string, sent: string, replied: string | null) => ({
      id: newId(),
      orgId: org.orgId,
      stepRunId: stepIds[step]!,
      fromUserId: hanh,
      toUserId: to,
      message: 'Nhắc việc',
      sentAt: new Date(sent),
      reply: replied ? 'done' : null,
      repliedAt: at(replied),
    });
    await tx.insert(schema.nudges).values([
      nudge('E', lan, '2026-10-06T02:00:00Z', '2026-10-07T02:00:00Z'), // T3 → T4: kịp
      nudge('E', lan, '2026-10-08T02:00:00Z', '2026-10-12T03:00:00Z'), // T5 → T2 tuần sau: 2 ngày làm việc, không kịp
      nudge('F', tuan, '2026-10-09T09:00:00Z', '2026-10-12T01:00:00Z'), // T6 → T2: qua cuối tuần vẫn là 1 ngày làm việc
      nudge('F', tuan, '2026-10-09T02:00:00Z', null),
      nudge('F', tuan, '2026-10-13T02:00:00Z', '2026-10-13T03:00:00Z'), // ngoài kỳ
    ]);
  });
});

afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

const PERIOD = { from: '2026-10-05', to: '2026-10-12' };

describe('báo cáo', () => {
  it('các chỉ số toàn tổ chức khớp số tính tay', async () => {
    const office = org.viewer('office_admin');
    const report = await org.run((tx, ctx) => getReport(tx, ctx, office, PERIOD));

    expect(report).toMatchObject({ from: '2026-10-05', to: '2026-10-12', asOf: NOW });
    expect(report.completedCount).toBe(4); // A, B, C, H
    expect(report.onTimeRate).toBe(0.25); // chỉ A
    expect(report.onTimeRateAfterExtension).toBe(0.5); // A và B
    expect(report.overdueNow).toBe(2); // E và G
    expect(report.avgHandlingWorkingDays).toBe(2.5); // (2 + 4 + 4 + 0) / 4

    expect(report.byUser.map((u) => [u.user.fullName, u.unitName, u.open, u.overdue, u.completed, u.onTimeRate])).toEqual([
      ['Nguyễn Thu Lan', 'Phòng Kinh doanh', 1, 1, 2, 0.5],
      ['Bùi Quốc Tuấn', 'Phòng Kinh doanh', 1, 0, 1, 0],
      ['Đặng Quốc Bảo', 'Phòng Kinh doanh', 0, 0, 1, 0],
    ]);
    expect(report.byUnit).toEqual([{ unitId: org.units.sales, unitName: 'Phòng Kinh doanh', open: 2, overdue: 1, completed: 4, onTimeRate: 0.25 }]);

    // Trong một mẫu, bước chậm nhất đứng đầu.
    expect(report.byTemplateStep).toEqual([
      { templateId, templateName: 'Đón đoàn', nodeId: 'n2', title: 'Việc n2', count: 1, avgWorkingDays: 4, overdueRate: 1 },
      { templateId, templateName: 'Đón đoàn', nodeId: 'n1', title: 'Việc n1', count: 2, avgWorkingDays: 3, overdueRate: 0.5 },
      { templateId, templateName: 'Đón đoàn', nodeId: 'n6', title: 'Việc n6', count: 1, avgWorkingDays: 0, overdueRate: 0 },
    ]);

    expect(report.nudges.map((n) => [n.user.fullName, n.received, n.repliedWithinOneWorkingDay, n.replyRate])).toEqual([
      ['Bùi Quốc Tuấn', 2, 1, 0.5],
      ['Nguyễn Thu Lan', 2, 1, 0.5],
    ]);
  });

  it('cùng nguồn với Tổng quan: số việc quá hạn khớp nhau', async () => {
    const office = org.viewer('office_admin');
    const overview = await org.run((tx, ctx) => getOverview(tx, ctx, office));
    const report = await org.run((tx, ctx) => getReport(tx, ctx, office, PERIOD));
    expect(overview.overdue).toBe(report.overdueNow);
  });

  it('lọc theo người, theo đơn vị, theo mẫu', async () => {
    const office = org.viewer('office_admin');

    const tuan = await org.run((tx, ctx) => getReport(tx, ctx, office, { ...PERIOD, userId: org.users.employee2 }));
    expect(tuan).toMatchObject({ completedCount: 1, onTimeRate: 0, onTimeRateAfterExtension: 0, overdueNow: 0, avgHandlingWorkingDays: 4 });
    expect(tuan.byUser.map((u) => u.user.id)).toEqual([org.users.employee2]);
    expect(tuan.byTemplateStep).toEqual([{ templateId, templateName: 'Đón đoàn', nodeId: 'n1', title: 'Việc n1', count: 1, avgWorkingDays: 4, overdueRate: 1 }]);
    expect(tuan.nudges.map((n) => n.user.id)).toEqual([org.users.employee2]);

    // Văn phòng chỉ có việc D, xong 30/09: phải nới kỳ mới thấy.
    const officeInPeriod = await org.run((tx, ctx) => getReport(tx, ctx, office, { ...PERIOD, unitId: org.units.office }));
    expect(officeInPeriod).toMatchObject({ completedCount: 0, onTimeRate: null, onTimeRateAfterExtension: null, overdueNow: 0, avgHandlingWorkingDays: null, byUser: [], byUnit: [], byTemplateStep: [], nudges: [] });
    const officeWide = await org.run((tx, ctx) => getReport(tx, ctx, office, { from: '2026-09-28', to: '2026-10-12', unitId: org.units.office }));
    expect(officeWide).toMatchObject({ completedCount: 1, onTimeRate: 1, avgHandlingWorkingDays: 2 });
    expect(officeWide.byUnit).toEqual([{ unitId: org.units.office, unitName: 'Văn phòng', open: 0, overdue: 0, completed: 1, onTimeRate: 1 }]);

    const sameTemplate = await org.run((tx, ctx) => getReport(tx, ctx, office, { ...PERIOD, templateId }));
    expect(sameTemplate.completedCount).toBe(4);
    const otherTemplate = await org.run((tx, ctx) => getReport(tx, ctx, office, { ...PERIOD, templateId: newId() }));
    expect(otherTemplate).toMatchObject({ completedCount: 0, overdueNow: 0, onTimeRate: null, byUser: [], nudges: [] });
  });

  it('ranh giới kỳ theo ngày lịch giờ Việt Nam', async () => {
    const office = org.viewer('office_admin');
    // I xong lúc 00:30 ngày 13/10 giờ Việt Nam (17:30 UTC ngày 12/10): thuộc ngày 13, không thuộc ngày 12.
    const day13 = await org.run((tx, ctx) => getReport(tx, ctx, office, { from: '2026-10-13', to: '2026-10-13' }));
    expect(day13.completedCount).toBe(1);
    expect(day13.byTemplateStep.map((s) => s.nodeId)).toEqual(['n8']);
    // C xong 09:00 ngày 12/10: thuộc ngày 12.
    const day12 = await org.run((tx, ctx) => getReport(tx, ctx, office, { from: '2026-10-12', to: '2026-10-12' }));
    expect(day12.completedCount).toBe(1);
    expect(day12.byTemplateStep.map((s) => s.nodeId)).toEqual(['n1']);
    await expectApiError(org.run((tx, ctx) => getReport(tx, ctx, office, { from: '2026-10-13', to: '2026-10-12' })), 'input_invalid');
  });

  it('người không phải điều phối chỉ được tính trên việc trong tầm nhìn của mình', async () => {
    const lan = org.viewer('employee');
    const report = await org.run((tx, ctx) => getReport(tx, ctx, lan, PERIOD));
    expect(report.completedCount).toBe(2); // A và B
    expect(report.overdueNow).toBe(1); // E; việc chưa có người (G) không thuộc tầm nhìn
    expect(report.byUser.map((u) => u.user.id)).toEqual([lan.id]);
  });

  it('ngày làm việc tính theo lịch và ngày nghỉ của tổ chức', async () => {
    const office = org.viewer('office_admin');
    // Thứ Ba 06/10 thành ngày nghỉ: A còn 1 ngày (T4), B còn 3 (T4, T5, T6), C vẫn 4, H vẫn 0.
    await org.run((tx) => putHoliday(tx, office, '2026-10-06', { name: 'Nghỉ riêng của công ty', kind: 'company' }));
    const report = await org.run((tx, ctx) => getReport(tx, ctx, office, PERIOD));
    expect(report.avgHandlingWorkingDays).toBe(2); // (1 + 3 + 4 + 0) / 4
    expect(report.byTemplateStep.find((s) => s.nodeId === 'n1')!.avgWorkingDays).toBe(2.5); // (1 + 4) / 2
    // Lời nhắc gửi T5 08/10, trả lời T2 12/10 vẫn là 2 ngày làm việc: không đổi.
    expect(report.nudges.map((n) => n.repliedWithinOneWorkingDay)).toEqual([1, 1]);
  });
});
