import { FakePush } from '@mihato/providers/push';
import { newId } from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clock, setFakeNow } from '../src/clock';
import { closeDb, schema } from '../src/db/client';
import { briefingId, buildBriefing } from '../src/services/briefing';
import { createSystemNotification, deliverNotification, draftFromEffect, draftFromNotification, pushDataOf } from '../src/services/notifications';
import { actOnStep, getRun, startRun } from '../src/services/runs';
import { createTemplate, publishTemplate } from '../src/services/templates';
import { createTestOrg, type TestOrg, type TestUserKey } from '../src/testing';

/**
 * Tin đẩy đi qua Expo, Apple và Google (SPEC 11.5, CLAUDE.md luật 6): `data` chỉ có mã và id, không bao giờ có chữ của báo cáo.
 * Và quyết định "Chủ tịch không nhận tin đẩy riêng về việc quá hạn" (SPEC 4.6, 10.9).
 */
let org: TestOrg;
const asV = (who: TestUserKey) => org.viewer(who);

beforeAll(async () => {
  setFakeNow('2026-10-07T03:00:00.000Z'); // Thứ Tư 10:00 giờ Việt Nam
  org = await createTestOrg({ name: 'Công ty thử tin đẩy' });
  const DUE = { anchor: 'activation', offset: { value: 1, unit: 'working_day' } };
  const def = {
    schemaVersion: 1,
    name: 'Việc nhiều tên',
    starters: [{ kind: 'everyone' }],
    inputs: [],
    nodes: [
      { id: 'start', type: 'start', label: 'Bắt đầu' },
      { id: 'a', type: 'task', label: 'A', title: 'Gửi hợp đồng cho ông Nguyễn Văn Bí Mật', assignee: { kind: 'user', userId: org.users.employee }, due: DUE },
      { id: 'b', type: 'approval', label: 'B', title: 'Chủ tịch xem văn bản tuyệt mật', approvers: [{ kind: 'user', userId: org.users.chairman }], mode: 'any', due: DUE },
      { id: 'end', type: 'end', label: 'Hoàn tất' },
    ],
    edges: [
      { id: 's>a', from: 'start', to: 'a' },
      { id: 'a>b', from: 'a', to: 'b' },
      { id: 'b>e', from: 'b', to: 'end', outcome: 'approved' },
    ],
  };
  const created = await org.run((tx, ctx) => createTemplate(tx, ctx, asV('designer'), { name: def.name, description: null, definition: def as never }));
  await org.run((tx, ctx) => publishTemplate(tx, ctx, asV('designer'), created.id));
  const run = await org.run((tx, ctx) => startRun(tx, ctx, asV('designer'), { templateId: created.id, title: 'Hợp đồng Bí Mật', inputs: {} }, newId()));
  await org.run((tx, ctx) => actOnStep(tx, ctx, asV('employee'), run.steps.find((s) => s.nodeId === 'a')!.id, newId(), { type: 'CompleteStep' }));
  await org.run(async (tx, ctx) => void (await getRun(tx, ctx, asV('designer'), run.id)));
  for (const who of ['chairman', 'director'] as TestUserKey[]) {
    await org.run((tx) => tx.insert(schema.devices).values({ id: newId(), orgId: org.orgId, userId: org.users[who], platform: 'ios', name: `Máy ${who}`, pushToken: `ExponentPushToken[${who}]` }));
  }
});
afterAll(async () => {
  setFakeNow(null);
  await closeDb();
});

describe('data của tin đẩy (audit worker-1)', () => {
  it('báo cáo đầu ngày: data chỉ có type, link, notificationId; không có text, sections hay tên người, và nhỏ hơn 4 KiB', async () => {
    const built = await org.run((tx, ctx) => buildBriefing(tx, ctx, org.users.chairman));
    expect(built?.text.length).toBeGreaterThan(50);
    const day = toLocalDate(clock.now(), (await org.run((_tx, ctx) => Promise.resolve(ctx))).calendar);
    const push = new FakePush();
    await org.run(async (tx, ctx) => {
      const draft = (await draftFromNotification(tx, briefingId(org.users.chairman, day)))!;
      // Payload lưu trong CSDL vẫn có chữ (app đọc ra bằng GET /v1/briefings/latest); chỉ tin đẩy mới bị lọc.
      expect(Object.keys(draft.payload)).toEqual(expect.arrayContaining(['text', 'sections']));
      await deliverNotification(tx, ctx, draft, push);
    });
    expect(push.sent).toHaveLength(1);
    const msg = push.sent[0]!;
    expect(Object.keys(msg.data).sort()).toEqual(['link', 'notificationId', 'type']);
    const wire = JSON.stringify(msg);
    expect(wire.length).toBeLessThan(4096);
    for (const secret of ['Bí Mật', 'tuyệt mật', 'Hợp đồng', 'Nguyễn', 'Trần Đức Minh']) expect(wire).not.toContain(secret);
  });

  it('mọi loại: chỉ trường trong danh sách trắng, giá trị là mã hoặc id ngắn; chữ tự do bị bỏ', () => {
    const data = pushDataOf('proposal.failed', { type: 'proposal.failed', link: 'mihato://proposal/abc', proposalId: 'p1', reason: 'Việc đã được giao cho người khác rồi nhé', text: 'tên người', sections: [1], extra: 'x' }, 'n1');
    expect(data).toEqual({ type: 'proposal.failed', link: 'mihato://proposal/abc', proposalId: 'p1', notificationId: 'n1' });
    expect(pushDataOf('nudge', { type: 'nudge', nudgeId: 'u1', aiDrafted: true, message: 'Nhắc anh Bình nộp tiền 5.000.000 đồng' }, 'n2')).toEqual({ type: 'nudge', nudgeId: 'u1', aiDrafted: true, notificationId: 'n2' });
    expect(pushDataOf('overdue', { type: 'overdue', link: 'mihato://step/abc', stepTitle: 'Tên việc' }, 'n3')).toEqual({ type: 'overdue', link: 'mihato://step/abc', notificationId: 'n3' });
    expect(pushDataOf('briefing', { type: 'briefing', link: 'javascript:alert(1)' }, 'n4')).toEqual({ type: 'briefing', notificationId: 'n4' });
  });

  it('thông báo hệ thống đẩy được vẫn tới máy kèm data tối thiểu', async () => {
    const push = new FakePush();
    const id = newId();
    await org.run(async (tx, ctx) => {
      await createSystemNotification(tx, ctx, { id, userId: org.users.director, kind: 'proposal.office', vars: { n: 1 }, payload: { type: 'proposal.office', proposalId: newId(), count: 2, link: 'mihato://proposal/x', note: 'Chữ tự do' }, push: true });
      await deliverNotification(tx, ctx, (await draftFromNotification(tx, id))!, push);
    });
    expect(Object.keys(push.sent[0]!.data).sort()).toEqual(['count', 'link', 'notificationId', 'proposalId', 'type']);
  });
});

describe('Chủ tịch không nhận tin đẩy về việc quá hạn (audit worker-2)', () => {
  const effect = (kind: string, toUserId: string) =>
    org.run(async (tx, ctx) => draftFromEffect(tx, ctx, newId(), { kind, toUserId, data: { stepTitle: 'Xem văn bản', runTitle: 'Lượt thử', lateWorkingDays: 1, dueAt: '2026-10-07T10:00:00.000Z' } }));

  it('quá hạn và leo thang tới Chủ tịch chỉ lưu để hiện trong app; người khác vẫn được đẩy', async () => {
    expect((await effect('notify.overdue', org.users.chairman))?.channel).toBe('inapp');
    expect((await effect('notify.escalation', org.users.chairman))?.channel).toBe('inapp');
    expect((await effect('notify.overdue', org.users.director))?.channel).toBe('push');
    expect((await effect('notify.escalation', org.users.director))?.channel).toBe('push');
  });

  it('việc cần Chủ tịch quyết và nhắc trước hạn vẫn được đẩy', async () => {
    expect((await effect('notify.assigned', org.users.chairman))?.channel).toBe('push');
    expect((await effect('notify.reminder', org.users.chairman))?.channel).toBe('push');
    // Tin inapp không gọi Expo: gửi thử qua deliverNotification, FakePush không nhận gì nhưng dòng thông báo vẫn có.
    const push = new FakePush();
    await org.run(async (tx, ctx) => {
      const draft = (await draftFromEffect(tx, ctx, newId(), { kind: 'notify.overdue', toUserId: org.users.chairman, data: { stepTitle: 'x', runTitle: 'y', lateWorkingDays: 2 } }))!;
      await deliverNotification(tx, ctx, draft, push);
    });
    expect(push.sent.filter((m) => m.to === 'ExponentPushToken[chairman]' && m.data.type === 'overdue')).toHaveLength(0);
  });
});
