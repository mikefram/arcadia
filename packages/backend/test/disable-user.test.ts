import { deterministicId, newId } from '@mihato/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/auth/crypto';
import { closeDb, schema } from '../src/db/client';
import { disableUser, enableUser, getUser, searchPeople } from '../src/services/org';
import { actOnStep, startRun } from '../src/services/runs';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { createTestOrg, type TestOrg } from '../src/testing';
import { auditRows, expectApiError, twoTaskDefinition } from './helpers';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg();
});
afterAll(closeDb);

async function publishedTemplate(name: string, first: string, second: string): Promise<string> {
  const designer = org.viewer('process_designer');
  const tpl = await org.run((tx, ctx) => createTemplate(tx, ctx, designer, { name, description: null, definition: twoTaskDefinition(name, first, second) }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, designer, tpl.id));
  return tpl.id;
}

describe('vô hiệu hoá người đang giữ việc', () => {
  it('thu hồi thiết bị, xoá phiên web, chuyển việc đang giữ sang "Cần giao người" bằng UnassignStep', async () => {
    const office = org.viewer('office_admin');
    const itAdmin = org.viewer('it_admin');
    const lan = org.users.employee;
    const tuan = org.users.employee2;

    // Lượt 1: Lan giữ cả hai việc (một việc đã nhận). Lượt 2: Lan giữ một việc, Tuấn giữ việc còn lại.
    const allLan = await publishedTemplate('Hồ sơ A', lan, lan);
    const mixed = await publishedTemplate('Hồ sơ B', lan, tuan);
    const run1 = await org.run((tx, ctx) => startRun(tx, ctx, office, { templateId: allLan, title: 'Lượt một', inputs: {} }, newId()));
    const run2 = await org.run((tx, ctx) => startRun(tx, ctx, office, { templateId: mixed, title: 'Lượt hai', inputs: {} }, newId()));
    expect(run1.steps.map((s) => [s.nodeId, s.state, s.assignee?.id])).toEqual([
      ['t1', 'ready', lan],
      ['t2', 'ready', lan],
    ]);
    const accepted = run1.steps[0]!;
    await org.run((tx, ctx) => actOnStep(tx, ctx, org.viewer('employee'), accepted.id, newId(), { type: 'AcceptStep' }));
    const lanSteps = [run1.steps[0]!.id, run1.steps[1]!.id, run2.steps.find((s) => s.nodeId === 't1')!.id];
    const tuanStep = run2.steps.find((s) => s.nodeId === 't2')!.id;

    const deviceId = newId();
    await org.run(async (tx) => {
      await tx.insert(schema.devices).values({ id: deviceId, orgId: org.orgId, userId: lan, platform: 'ios', name: 'Máy của Lan', pushToken: 'ExponentPushToken[lan]' });
      await tx.insert(schema.sessions).values({ id: newId(), orgId: org.orgId, userId: lan, tokenHash: sha256(`phien-${newId()}`), csrfToken: 'csrf', expiresAt: new Date(Date.now() + 3_600_000) });
      await tx.insert(schema.sessions).values({ id: newId(), orgId: org.orgId, userId: tuan, tokenHash: sha256(`phien-${newId()}`), csrfToken: 'csrf', expiresAt: new Date(Date.now() + 3_600_000) });
    });

    const key = newId();
    const view = await org.run((tx) => disableUser(tx, itAdmin, lan, key));
    expect(view).toMatchObject({ id: lan, status: 'disabled', deviceCount: 0 });

    const after = await org.run(async (tx) => ({
      devices: await tx.select().from(schema.devices).where(eq(schema.devices.userId, lan)),
      lanSessions: await tx.select().from(schema.sessions).where(eq(schema.sessions.userId, lan)),
      tuanSessions: await tx.select().from(schema.sessions).where(eq(schema.sessions.userId, tuan)),
      steps: await tx.select().from(schema.stepRuns).where(inArray(schema.stepRuns.id, [...lanSteps, tuanStep])),
      events: await tx.select().from(schema.runEvents).where(and(eq(schema.runEvents.type, 'UnassignStep'), inArray(schema.runEvents.runId, [run1.id, run2.id]))),
    }));
    expect(after.devices).toHaveLength(1);
    expect(after.devices[0]!.revokedAt).not.toBeNull();
    expect(after.devices[0]!.pushToken).toBeNull();
    expect(after.lanSessions).toEqual([]);
    expect(after.tuanSessions).toHaveLength(1);

    for (const id of lanSteps) {
      const step = after.steps.find((s) => s.id === id)!;
      expect(step).toMatchObject({ state: 'unassigned', assigneeId: null });
    }
    // Việc của người khác không bị đụng tới.
    expect(after.steps.find((s) => s.id === tuanStep)).toMatchObject({ state: 'ready', assigneeId: tuan });

    // Mỗi việc một sự kiện của hệ thống, eventId tất định theo (người, việc, Idempotency-Key).
    expect(after.events.map((e) => e.id).sort()).toEqual(lanSteps.map((id) => deterministicId(`disable:${lan}:${id}:${key}`)).sort());
    for (const e of after.events) expect(e).toMatchObject({ actorType: 'system', actorId: null });

    const [entry] = await org.run((tx) => auditRows(tx, 'user_disabled'));
    expect(entry).toMatchObject({ targetType: 'user', targetId: lan, actorUserId: itAdmin.id });
    expect(entry!.detail).toEqual({ devicesRevoked: 1, stepsUnassigned: 3 });
    expect((await org.run((tx) => auditRows(tx, 'device_revoked'))).map((e) => e.targetId)).toEqual([deviceId]);

    // Người đã vô hiệu hoá không còn trong ô chọn người.
    expect(await org.run(async (_tx, ctx) => searchPeople(ctx, 'Lan').map((p) => p.id))).not.toContain(lan);

    // Văn phòng giao lại việc "Cần giao người" cho người khác.
    const reassigned = await org.run((tx, ctx) => actOnStep(tx, ctx, office, lanSteps[1]!, newId(), { type: 'Reassign', toUserId: tuan, reason: 'Người cũ đã nghỉ' }));
    expect(reassigned.step).toMatchObject({ state: 'ready' });
    expect(reassigned.step.assignee!.id).toBe(tuan);

    // Vô hiệu hoá lần nữa là sai trạng thái; bật lại thì việc cũ vẫn chờ Văn phòng giao.
    const again = await expectApiError(org.run((tx) => disableUser(tx, itAdmin, lan, newId())), 'state_conflict');
    expect(again.extra.currentState).toBe('disabled');
    const enabled = await org.run((tx) => enableUser(tx, itAdmin, lan));
    expect(enabled).toMatchObject({ status: 'active', deviceCount: 0 });
    expect((await org.run((tx) => auditRows(tx, 'user_enabled')))[0]).toMatchObject({ targetId: lan });
    const [still] = await org.run((tx) => tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.id, lanSteps[0]!)));
    expect(still).toMatchObject({ state: 'unassigned', assigneeId: null });
  });

  it('người duyệt chưa quyết cũng là người đang giữ việc, dù chưa tới lượt mình', async () => {
    const designer = org.viewer('process_designer');
    const name = 'Duyệt hai người';
    const definition = {
      schemaVersion: 1 as const,
      name,
      inputs: [],
      nodes: [
        { id: 'start', type: 'start' as const, label: 'Bắt đầu' },
        {
          id: 'a1',
          type: 'approval' as const,
          label: 'Duyệt',
          title: 'Duyệt hồ sơ',
          approvers: [
            { kind: 'user', userId: org.users.employee2 },
            { kind: 'user', userId: org.users.head },
          ],
          mode: 'all',
          due: { anchor: 'activation', offset: { value: 2, unit: 'working_day' } },
        },
        { id: 'end', type: 'end' as const, label: 'Hoàn tất' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'a1' },
        { id: 'e2', from: 'a1', to: 'end', outcome: 'approved' as const },
      ],
    };
    const tpl = await org.run((tx, ctx) => createTemplate(tx, ctx, designer, { name, description: null, definition }));
    await org.run((tx, ctx) => publishTemplate(tx, ctx, designer, tpl.id));
    const run = await org.run((tx, ctx) => startRun(tx, ctx, org.viewer('office_admin'), { templateId: tpl.id, title: 'Lượt duyệt', inputs: {} }, newId()));
    const approval = run.steps[0]!;
    // Con trỏ người nhận đang ở người duyệt thứ nhất; người bị vô hiệu hoá là người duyệt thứ hai.
    expect(approval).toMatchObject({ kind: 'approval', state: 'ready' });
    expect(approval.assignee!.id).toBe(org.users.employee2);

    await org.run((tx) => disableUser(tx, org.viewer('it_admin'), org.users.head, newId()));
    const [step] = await org.run((tx) => tx.select().from(schema.stepRuns).where(eq(schema.stepRuns.id, approval.id)));
    // Chỉ gỡ người bị vô hiệu hoá (rà soát 07/10/2026, engine-2): người duyệt còn lại vẫn giữ việc.
    expect(step).toMatchObject({ state: 'ready', assigneeId: org.users.employee2 });
    const rows = await org.run((tx) => tx.select().from(schema.stepApprovals).where(eq(schema.stepApprovals.stepRunId, approval.id)));
    expect(rows.map((r) => r.approverId)).toEqual([org.users.employee2]);
    expect((await org.run((tx) => auditRows(tx, 'user_disabled')))[0]!.detail).toEqual({ devicesRevoked: 0, stepsUnassigned: 1 });
    await org.run((tx) => enableUser(tx, org.viewer('it_admin'), org.users.head));
  });

  it('không vô hiệu hoá được it_admin cuối cùng', async () => {
    const itAdmin = org.viewer('it_admin');
    const err = await expectApiError(org.run((tx) => disableUser(tx, itAdmin, itAdmin.id, newId())), 'state_conflict');
    expect(err.extra.errors).toEqual([{ path: 'params.id', code: 'last_it_admin' }]);
    expect((await org.run((tx) => getUser(tx, itAdmin.id))).status).toBe('active');
  });

  it('người không giữ việc nào: chỉ đổi trạng thái', async () => {
    const view = await org.run((tx) => disableUser(tx, org.viewer('it_admin'), org.users.designer, newId()));
    expect(view.status).toBe('disabled');
    const [entry] = await org.run((tx) => auditRows(tx, 'user_disabled'));
    expect(entry!.detail).toEqual({ devicesRevoked: 0, stepsUnassigned: 0 });
    // chưa từng có thiết bị hay mật khẩu: bật lại thì về `invited`, chờ kích hoạt
    expect((await org.run((tx) => enableUser(tx, org.viewer('it_admin'), org.users.designer))).status).toBe('invited');
  });
});
