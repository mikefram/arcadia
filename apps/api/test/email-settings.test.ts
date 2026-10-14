import { closeDb, type SeedIds } from '@mihato/backend';
import type { EmailSettingsView } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;
// Ghép từ nhiều mảnh để công cụ quét bí mật không nhầm giá trị mẫu này với khoá thật.
const SECRET = ['re', 'live', 'ZZZZYYYYXXXX9876'].join('_');

beforeAll(async () => {
  ids = await freshOrg('mail');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe('cấu hình gửi thư qua HTTP', () => {
  it('chỉ người có quyền org.settings; nhân viên thường 403', async () => {
    expect((await call('U_LAN', 'GET', '/v1/org/email-settings')).status).toBe(403);
    expect((await call('U_LAN', 'PUT', '/v1/org/email-settings', { fromAddress: 'a@b.test', apiKey: SECRET })).status).toBe(403);
    expect((await call('U_LAN', 'DELETE', '/v1/org/email-settings')).status).toBe(403);
    expect((await call('U_LAN', 'POST', '/v1/org/email-settings/test', { to: 'a@b.test' })).status).toBe(403);
  });

  it('đặt cấu hình: phản hồi, đọc lại và nhật ký không bao giờ chứa khoá', async () => {
    const put = await call<EmailSettingsView>('U_IT', 'PUT', '/v1/org/email-settings', { provider: 'resend', fromAddress: 'MIHATO <thu@mihato.test>', apiKey: SECRET });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ provider: 'resend', fromAddress: 'MIHATO <thu@mihato.test>', hasApiKey: true, apiKeyHint: '9876', active: 'org' });
    const get = await call<EmailSettingsView>('U_IT', 'GET', '/v1/org/email-settings');
    expect(get.body).toEqual(put.body);
    expect(JSON.stringify([put.body, get.body])).not.toContain('ZZZZYYYY');

    const audit = await call<{ items: unknown[] }>('U_IT', 'GET', '/v1/admin/audit-log?action=email_settings_changed');
    expect(audit.status).toBe(200);
    expect(audit.body.items).toHaveLength(1);
    expect(JSON.stringify(audit.body)).not.toMatch(/ZZZZYYYY|mihato\.test/);
  });

  it('đầu vào sai: địa chỉ gửi sai là 422, khoá quá ngắn là 422', async () => {
    const bad = await call<{ errors?: { path: string; code: string }[] }>('U_IT', 'PUT', '/v1/org/email-settings', { fromAddress: 'khong-hop-le' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([{ path: 'body.fromAddress', code: 'invalid' }]);
    expect((await call('U_IT', 'PUT', '/v1/org/email-settings', { fromAddress: 'a@b.test', apiKey: 'ngan' })).status).toBe(422);
  });

  it('xoá cấu hình thì không còn khoá', async () => {
    const del = await call<EmailSettingsView>('U_IT', 'DELETE', '/v1/org/email-settings');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ hasApiKey: false, apiKeyHint: null, updatedAt: null });
  });
});
