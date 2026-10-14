import { FakeEmail, ResendEmail } from '@mihato/providers/email';
import { FakePush } from '@mihato/providers/push';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, schema } from '../src/db/client';
import { clearEmailSettings, decryptSecret, encryptSecret, getEmailSettings, putEmailSettings, resolveEmailProvider, sendTestEmail } from '../src/services/email-settings';
import { createUser } from '../src/services/org';
import { createTestOrg, type TestOrg } from '../src/testing';
import { runWorkerTick } from '../src/worker';
import { auditRows, expectApiError } from './helpers';

let org: TestOrg;
let other: TestOrg;
// Ghép từ nhiều mảnh để công cụ quét bí mật không nhầm giá trị mẫu này với khoá thật.
const SECRET = ['re', 'live', 'ABCDEFGH12345678'].join('_');

beforeAll(async () => {
  org = await createTestOrg();
  other = await createTestOrg();
});
afterAll(closeDb);
afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function stubFetch(status: number): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: 'msg_1' }), { status });
  });
  return calls;
}

describe('mã hoá bí mật', () => {
  it('khứ hồi đúng, không lộ bản rõ, gắn với tổ chức', () => {
    const blob = encryptSecret(SECRET, org.orgId);
    expect(blob.toString('utf8')).not.toContain('ABCDEFGH');
    expect(decryptSecret(blob, org.orgId)).toBe(SECRET);
    expect(decryptSecret(blob, other.orgId)).toBeNull();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(decryptSecret(tampered, org.orgId)).toBeNull();
    expect(encryptSecret(SECRET, org.orgId).equals(blob)).toBe(false);
  });
});

describe('cấu hình gửi thư của tổ chức', () => {
  it('chưa đặt thì không có khoá; đặt xong thì chỉ trả 4 ký tự cuối, khoá nằm mã hoá trong CSDL', async () => {
    const it_ = org.viewer('it_admin');
    expect(await org.run((tx) => getEmailSettings(tx, org.orgId))).toMatchObject({ hasApiKey: false, apiKeyHint: null, updatedAt: null, active: 'fake' });

    const view = await org.run((tx) => putEmailSettings(tx, it_, { provider: 'resend', fromAddress: ' MIHATO <thu@mihato.test> ', apiKey: SECRET }));
    expect(view).toMatchObject({ provider: 'resend', fromAddress: 'MIHATO <thu@mihato.test>', hasApiKey: true, apiKeyHint: '5678', active: 'org' });
    expect(JSON.stringify(view)).not.toContain('ABCDEFGH');

    const [row] = await org.run((tx) => tx.select().from(schema.orgEmailSettings).where(eq(schema.orgEmailSettings.orgId, org.orgId)));
    expect(row!.apiKeyEnc!.toString('latin1')).not.toContain('ABCDEFGH');
    expect(decryptSecret(row!.apiKeyEnc!, org.orgId)).toBe(SECRET);

    const [entry] = await org.run((tx) => auditRows(tx, 'email_settings_changed'));
    expect(entry).toMatchObject({ actorUserId: it_.id, targetType: 'org' });
    expect(entry!.detail).toEqual({ fields: ['fromAddress', 'apiKey'] });
    expect(JSON.stringify(entry)).not.toMatch(/ABCDEFGH|mihato\.test/);
  });

  it('bỏ trống khoá thì giữ khoá cũ; chưa có khoá thì bắt buộc; địa chỉ gửi sai bị từ chối', async () => {
    const it_ = org.viewer('it_admin');
    const kept = await org.run((tx) => putEmailSettings(tx, it_, { provider: 'resend', fromAddress: 'doi@mihato.test' }));
    expect(kept).toMatchObject({ fromAddress: 'doi@mihato.test', hasApiKey: true, apiKeyHint: '5678' });
    const [row] = await org.run((tx) => tx.select().from(schema.orgEmailSettings).where(eq(schema.orgEmailSettings.orgId, org.orgId)));
    expect(decryptSecret(row!.apiKeyEnc!, org.orgId)).toBe(SECRET);

    const err = await expectApiError(other.run((tx) => putEmailSettings(tx, other.viewer('it_admin'), { provider: 'resend', fromAddress: 'a@b.test' })), 'input_invalid');
    expect(err.extra.errors).toEqual([{ path: 'body.apiKey', code: 'required' }]);
    for (const bad of ['khong-co-a-cong', 'Tên <thiếu-tên-miền>', 'a b@c.test', '']) {
      const e = await expectApiError(org.run((tx) => putEmailSettings(tx, it_, { provider: 'resend', fromAddress: bad })), 'input_invalid');
      expect(e.extra.errors).toEqual([{ path: 'body.fromAddress', code: 'invalid' }]);
    }
  });

  it('cô lập theo tổ chức: tổ chức khác không thấy cấu hình', async () => {
    expect(await other.run((tx) => getEmailSettings(tx, other.orgId))).toMatchObject({ hasApiKey: false, fromAddress: '' });
    const seen = await other.run((tx) => tx.select().from(schema.orgEmailSettings));
    expect(seen).toEqual([]);
  });

  it('gửi thư thử bằng cấu hình của tổ chức: dùng đúng khoá và địa chỉ gửi; lỗi trả trong kết quả', async () => {
    const it_ = org.viewer('it_admin');
    const calls = stubFetch(200);
    expect(await org.run((tx) => sendTestEmail(tx, it_, 'nguoi.nhan@example.test'))).toEqual({ ok: true, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0]!.body).toMatchObject({ from: 'doi@mihato.test', to: ['nguoi.nhan@example.test'] });

    stubFetch(403);
    expect(await org.run((tx) => sendTestEmail(tx, it_, 'nguoi.nhan@example.test'))).toEqual({ ok: false, error: 'permanent' });
    stubFetch(503);
    expect(await org.run((tx) => sendTestEmail(tx, it_, 'nguoi.nhan@example.test'))).toEqual({ ok: false, error: 'transient' });

    const rows = await org.run((tx) => auditRows(tx, 'email_test_sent'));
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows.map((r) => r.detail))).not.toMatch(/example|ABCDEFGH/);
  });

  it('worker gửi thư kích hoạt bằng cấu hình của tổ chức, không dùng nhà cung cấp dự phòng', async () => {
    const fallback = new FakeEmail();
    const calls = stubFetch(200);
    const created = await org.run((tx) =>
      createUser(tx, org.viewer('it_admin'), { fullName: 'Vũ Thị Lan', givenName: 'Lan', honorific: 'chi', email: 'lan.vu@example.test', phone: null, unitId: null, managerId: null, uiProfile: 'standard', displayOrder: 0, roles: [{ role: 'employee', unitId: null }] }),
    );
    await runWorkerTick({ push: new FakePush(), email: fallback }, { orgId: org.orgId });
    expect(fallback.sent).toHaveLength(0);
    const call = calls.find((c) => (c.body.to as string[])[0] === 'lan.vu@example.test');
    expect(call).toBeDefined();
    expect(call!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(call!.body.from).toBe('doi@mihato.test');
    expect(String(call!.body.text)).toContain('dat-mat-khau?token=');
    expect(created.status).toBe('invited');
  });

  it('xoá cấu hình thì quay về nhà cung cấp dự phòng', async () => {
    const it_ = org.viewer('it_admin');
    const view = await org.run((tx) => clearEmailSettings(tx, it_));
    expect(view).toMatchObject({ hasApiKey: false, updatedAt: null, active: 'fake' });
    expect(await org.run((tx) => auditRows(tx, 'email_settings_cleared'))).toHaveLength(1);
    const fallback = new FakeEmail();
    const resolved = await org.run((tx) => resolveEmailProvider(tx, org.orgId, fallback));
    expect(resolved).toEqual({ provider: fallback, source: 'fake' });
    expect(resolved!.provider).not.toBeInstanceOf(ResendEmail);
    // xoá lần hai không ghi thêm nhật ký
    await org.run((tx) => clearEmailSettings(tx, it_));
    expect(await org.run((tx) => auditRows(tx, 'email_settings_cleared'))).toHaveLength(1);
  });

  it('khoá không giải mã được (đổi khoá mã hoá) thì coi như chưa có và rơi về dự phòng', async () => {
    const it_ = org.viewer('it_admin');
    await org.run((tx) => putEmailSettings(tx, it_, { provider: 'resend', fromAddress: 'a@mihato.test', apiKey: SECRET }));
    await org.run((tx) => tx.update(schema.orgEmailSettings).set({ apiKeyEnc: Buffer.alloc(64, 7) }).where(eq(schema.orgEmailSettings.orgId, org.orgId)));
    const fallback = new FakeEmail();
    expect(await org.run((tx) => resolveEmailProvider(tx, org.orgId, fallback))).toEqual({ provider: fallback, source: 'fake' });
  });
});
