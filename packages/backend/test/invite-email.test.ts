import { FakeEmail } from '@mihato/providers/email';
import { FakePush } from '@mihato/providers/push';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../src/auth/service';
import { closeDb, schema } from '../src/db/client';
import { composeInviteEmail, INVITE_EMAIL_EFFECT } from '../src/services/invites';
import { createUser, disableUser, importUsers, resendInviteEmail } from '../src/services/org';
import { createTestOrg, type TestOrg } from '../src/testing';
import { runWorkerTick } from '../src/worker';
import { auditRows, expectApiError } from './helpers';

let org: TestOrg;
const push = new FakePush();

beforeAll(async () => {
  org = await createTestOrg();
});
afterAll(closeDb);

const newUser = (email: string | null, suffix: string) => ({
  fullName: `Trần Thị Mai ${suffix}`,
  givenName: 'Mai',
  honorific: 'chi' as const,
  email,
  phone: null,
  unitId: null,
  managerId: null,
  uiProfile: 'standard' as const,
  displayOrder: 0,
  roles: [{ role: 'employee' as const, unitId: null }],
});

async function pendingInviteEffects(userId: string) {
  return org.run((tx) =>
    tx
      .select({ id: schema.effects.id, state: schema.effects.state, payload: schema.effects.payload })
      .from(schema.effects)
      .where(and(eq(schema.effects.kind, INVITE_EMAIL_EFFECT), eq(schema.effects.state, 'pending')))
      .then((rows) => rows.filter((r) => (r.payload as { userId: string }).userId === userId)),
  );
}

describe('thư kích hoạt tài khoản', () => {
  it('thêm người có email thì xếp effect; worker gửi thư có đường dẫn đặt mật khẩu dùng được', async () => {
    const email = new FakeEmail();
    const it_ = org.viewer('it_admin');
    const created = await org.run((tx) => createUser(tx, it_, newUser('Mai.Moi@Example.test', 'A')));
    expect(created.status).toBe('invited');

    const pending = await pendingInviteEffects(created.id);
    expect(pending).toHaveLength(1);
    // payload không mang mã đường dẫn: mã chỉ được tạo lúc gửi
    expect(JSON.stringify(pending[0]!.payload)).not.toMatch(/token|dat-mat-khau/);
    const [queued] = await org.run((tx) => auditRows(tx, 'invite_email_queued'));
    expect(queued).toMatchObject({ actorUserId: it_.id, targetType: 'user', targetId: created.id });
    expect(JSON.stringify(queued!.detail)).not.toMatch(/Mai|example/i);

    await runWorkerTick({ push, email }, { orgId: org.orgId });
    const sent = email.to('mai.moi@example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('Kích hoạt tài khoản');
    expect(sent[0]!.text).toContain('chị Trần Thị Mai A');
    expect(sent[0]!.html).toContain('dat-mat-khau?token=');
    const url = sent[0]!.text.split('\n').find((l) => l.includes('dat-mat-khau?token='));
    expect(url).toBeDefined();
    expect(await pendingInviteEffects(created.id)).toHaveLength(0);

    const [sentAudit] = await org.run((tx) => auditRows(tx, 'invite_email_sent'));
    expect(sentAudit).toMatchObject({ actorType: 'system', targetId: created.id });

    // Đường dẫn trong thư đặt được mật khẩu và chuyển người sang active.
    const token = new URL(url!).searchParams.get('token')!;
    await setPassword({ token, password: 'MatKhauManh-2026!' });
    const [row] = await org.run((tx) => tx.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, created.id)));
    expect(row!.status).toBe('active');
  });

  it('không có email thì không xếp effect', async () => {
    const created = await org.run((tx) => createUser(tx, org.viewer('it_admin'), newUser(null, 'B')));
    expect(await pendingInviteEffects(created.id)).toHaveLength(0);
    const err = await expectApiError(org.run((tx) => resendInviteEmail(tx, org.viewer('it_admin'), created.id)), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'user.email', code: 'required' }]);
  });

  it('gửi lỗi tạm thì giao dịch hoàn lại (không để mã chưa dùng), effect thử lại và lần sau gửi được', async () => {
    const email = new FakeEmail();
    const created = await org.run((tx) => createUser(tx, org.viewer('it_admin'), newUser('mai.c@example.test', 'C')));
    email.failNext = 1;
    await runWorkerTick({ push, email }, { orgId: org.orgId });
    expect(email.to('mai.c@example.test')).toHaveLength(0);
    const tokens = () => org.run((tx) => tx.select({ id: schema.passwordTokens.id }).from(schema.passwordTokens).where(eq(schema.passwordTokens.userId, created.id)));
    expect(await tokens()).toHaveLength(0);
    const [eff] = await org.run((tx) => tx.select().from(schema.effects).where(eq(schema.effects.kind, INVITE_EMAIL_EFFECT)).then((rows) => rows.filter((r) => (r.payload as { userId: string }).userId === created.id)));
    expect(eff).toMatchObject({ state: 'pending', attempts: 1 });
    expect(eff!.lastError).toMatch(/invite_email_transient/);
    expect(eff!.lastError).not.toMatch(/example/);

    // Tới hạn thử lại: đặt next_attempt_at về quá khứ rồi quét lại.
    await org.run((tx) => tx.update(schema.effects).set({ nextAttemptAt: new Date(0) }).where(eq(schema.effects.id, eff!.id)));
    await runWorkerTick({ push, email }, { orgId: org.orgId });
    expect(email.to('mai.c@example.test')).toHaveLength(1);
    expect(await tokens()).toHaveLength(1);
  });

  it('gửi lại: xếp hàng một lần mỗi phút, người bị vô hiệu hoá thì 409 và worker bỏ qua', async () => {
    const email = new FakeEmail();
    const it_ = org.viewer('it_admin');
    const created = await org.run((tx) => createUser(tx, it_, newUser('mai.d@example.test', 'D')));
    await runWorkerTick({ push, email }, { orgId: org.orgId });
    expect(email.to('mai.d@example.test')).toHaveLength(1);

    expect(await org.run((tx) => resendInviteEmail(tx, it_, created.id))).toEqual({ queued: true });
    expect(await org.run((tx) => resendInviteEmail(tx, it_, created.id))).toEqual({ queued: false });
    await runWorkerTick({ push, email }, { orgId: org.orgId });
    expect(email.to('mai.d@example.test')).toHaveLength(2);

    // Người bị vô hiệu hoá: không gửi lại được, và effect đang chờ (nếu có) bị bỏ qua chứ không gửi.
    const other = await org.run((tx) => createUser(tx, it_, newUser('mai.e@example.test', 'E')));
    await org.run((tx) => disableUser(tx, it_, other.id, 'idem-disable-e'));
    await expectApiError(org.run((tx) => resendInviteEmail(tx, it_, other.id)), 'state_conflict');
    await runWorkerTick({ push, email }, { orgId: org.orgId });
    expect(email.to('mai.e@example.test')).toHaveLength(0);
    expect(await pendingInviteEffects(other.id)).toHaveLength(0);
  });

  it('nhập CSV cũng xếp thư cho từng người có email', async () => {
    const email = new FakeEmail();
    const csv = ['fullName,givenName,honorific,email,role', 'Lê Văn Hùng Nhập,Hùng,anh,hung.nhap@example.test,employee', 'Phạm Thu Hà Nhập,Hà,chi,,employee'].join('\n');
    const res = await org.run((tx) => importUsers(tx, org.viewer('it_admin'), csv, false));
    expect(res.created).toBe(2);
    await runWorkerTick({ push, email }, { orgId: org.orgId });
    expect(email.to('hung.nhap@example.test')).toHaveLength(1);
    expect(email.sent.filter((m) => m.subject.includes('Nhập'))).toHaveLength(1);
  });

  it('thư dựng từ mẫu i18n: có tên, tổ chức, hạn và đường dẫn; HTML được thoát ký tự', () => {
    const m = composeInviteEmail({
      to: 'a@b.test',
      orgName: 'Tập đoàn <Thử>',
      recipient: { fullName: 'Nguyễn Văn An', honorific: 'anh' },
      url: 'http://localhost:5273/dat-mat-khau?token=abc&x=1',
      expiresAt: new Date('2026-10-15T03:00:00Z'),
    });
    expect(m.subject).toBe('[Tập đoàn <Thử>] Kích hoạt tài khoản của anh Nguyễn Văn An');
    expect(m.text).toContain('Kính gửi anh Nguyễn Văn An,');
    expect(m.text).toContain('http://localhost:5273/dat-mat-khau?token=abc&x=1');
    expect(m.text).toMatch(/15\/10\/2026/);
    expect(m.html).toContain('Tập đoàn &lt;Thử&gt;');
    expect(m.html).toContain('href="http://localhost:5273/dat-mat-khau?token=abc&amp;x=1"');
  });
});
