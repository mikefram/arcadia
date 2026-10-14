import { describe, expect, it } from 'vitest';
import { FakeEmail, ResendEmail, type EmailMessage } from '../src/email';

const msg: EmailMessage = { to: 'nguoi.moi@example.test', subject: 'Kích hoạt', text: 'chữ thuần', html: '<p>html</p>' };

describe('FakeEmail', () => {
  it('ghi lại thư, trả mã; failNext cho lỗi tạm; rejected cho lỗi vĩnh viễn', async () => {
    const fake = new FakeEmail();
    expect(await fake.send(msg)).toEqual({ ok: true, messageId: 'fake-email-1' });
    expect(fake.to('NGUOI.MOI@example.test')).toHaveLength(1);

    fake.failNext = 1;
    expect(await fake.send(msg)).toMatchObject({ ok: false, error: 'transient' });
    expect(await fake.send(msg)).toMatchObject({ ok: true });

    fake.rejected.add('sai@example.test');
    expect(await fake.send({ ...msg, to: 'sai@example.test' })).toMatchObject({ ok: false, error: 'permanent' });
    expect(fake.sent).toHaveLength(2);
  });
});

type Call = { url: string; init: RequestInit };

function fetchReturning(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('ResendEmail', () => {
  it('thiếu khoá hay địa chỉ gửi thì không khởi tạo', () => {
    expect(() => new ResendEmail({ apiKey: '', from: 'A <a@b.test>' })).toThrow(/RESEND_API_KEY/);
    expect(() => new ResendEmail({ apiKey: 're_x', from: '' })).toThrow(/EMAIL_FROM/);
  });

  it('gọi POST /emails với Bearer và thân JSON đúng, trả id', async () => {
    const calls: Call[] = [];
    const resend = new ResendEmail({ apiKey: 're_test_key', from: 'MIHATO <thu@mihato.test>', fetch: fetchReturning(200, { id: 'msg_1' }, calls) });
    expect(await resend.send(msg)).toEqual({ ok: true, messageId: 'msg_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: 'MIHATO <thu@mihato.test>', to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html });
  });

  it('429 và 5xx là lỗi tạm; 4xx khác là lỗi vĩnh viễn; thông điệp không chứa địa chỉ', async () => {
    const calls: Call[] = [];
    const at = (status: number) => new ResendEmail({ apiKey: 'k', from: 'a@b.test', fetch: fetchReturning(status, { message: 'x' }, calls) });
    expect(await at(429).send(msg)).toEqual({ ok: false, error: 'transient', message: 'Resend HTTP 429' });
    expect(await at(503).send(msg)).toEqual({ ok: false, error: 'transient', message: 'Resend HTTP 503' });
    expect(await at(403).send(msg)).toEqual({ ok: false, error: 'permanent', message: 'Resend HTTP 403' });
    expect(await at(422).send(msg)).toEqual({ ok: false, error: 'permanent', message: 'Resend HTTP 422' });
  });

  it('lỗi mạng là lỗi tạm', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const resend = new ResendEmail({ apiKey: 'k', from: 'a@b.test', fetch: failing });
    expect(await resend.send(msg)).toEqual({ ok: false, error: 'transient', message: 'TypeError' });
  });
});
