import { ApiError } from '@mihato/domain';
import { compactVerify, importJWK, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { parseActivationInput, resolveApiBaseUrl } from '../src/session/activation-link';
import { IDLE_LOCK_MS, SessionController, type SessionEndReason, type TokenPair } from '../src/session/controller';
import { ALL_KV_KEYS, KV_KEYS, createMemoryKV } from '../src/session/kv';
import { isWeakPin, type PinHasher } from '../src/session/pin';
import { reauthStore, requestReauth } from '../src/session/reauth';
import { NobleStepUpSigner, UnsupportedStepUpSigner, WebCryptoStepUpSigner, base64Url, createStepUpSigner, fromBase64Url, type RandomBytes } from '../src/session/step-up';

/** SHA-256 thật của nền tảng (WebCrypto của Node), giống expo-crypto trên máy. */
const hasher: PinHasher = {
  randomSalt: () => base64Url(globalThis.crypto.getRandomValues(new Uint8Array(16))),
  sha256Hex: async (text) => {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};

const API = 'https://api.demo.mihato.local';
const DEVICE = '0199c000-0000-7000-8000-000000000001';

function setup(refreshCall?: (base: string, token: string) => Promise<TokenPair>) {
  const kv = createMemoryKV();
  const ended: SessionEndReason[] = [];
  const locked: number[] = [];
  const clock = { now: Date.parse('2026-10-15T03:00:00Z') };
  const calls: string[] = [];
  const make = () =>
    new SessionController({
      kv,
      hasher,
      now: () => clock.now,
      refreshCall:
        refreshCall ??
        (async (_base, token) => {
          calls.push(token);
          return { accessToken: `access-after-${token}`, refreshToken: `refresh-after-${token}` };
        }),
      onEnded: (reason) => {
        ended.push(reason);
      },
      onLocked: () => {
        locked.push(clock.now);
      },
    });
  return { kv, ended, locked, clock, calls, make, session: make() };
}

async function activated() {
  const s = setup();
  await s.session.load();
  await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
  await s.session.setPin('271828');
  s.session.finishOnboarding();
  return s;
}

describe('M0: phiên trên máy (SPEC 10.2, 11.2)', () => {
  it('máy mới: chưa có phiên thì về màn kích hoạt', async () => {
    const { session } = setup();
    expect(session.getSnapshot().status).toBe('loading');
    await session.load();
    expect(session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: null });
  });

  it('kích hoạt rồi đặt PIN: token và địa chỉ máy chủ vào kho an toàn; PIN chỉ lưu băm có muối, không gửi đi đâu', async () => {
    const { session, kv } = await activated();
    expect(session.getSnapshot()).toMatchObject({ status: 'unlocked', apiBaseUrl: API, deviceId: DEVICE, pinSet: true });
    const stored = kv.dump();
    expect(stored[KV_KEYS.accessToken]).toBe('a1');
    expect(stored[KV_KEYS.refreshToken]).toBe('r1');
    expect(stored[KV_KEYS.pin]).not.toContain('271828');
    expect((JSON.parse(stored[KV_KEYS.pin] ?? '{}') as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mở lại app thì phải mở khoá; đúng PIN thì vào', async () => {
    const { make } = await activated();
    const reopened = make();
    await reopened.load();
    expect(reopened.getSnapshot().status).toBe('locked');
    expect(await reopened.unlockWithPin('271828')).toEqual({ ok: true });
    expect(reopened.getSnapshot().status).toBe('unlocked');
  });

  it('tắt app giữa chừng trước khi đặt PIN: mở lại quay về bước đặt PIN', async () => {
    const s = setup();
    await s.session.load();
    await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
    const reopened = s.make();
    await reopened.load();
    expect(reopened.getSnapshot()).toMatchObject({ status: 'onboarding', pinSet: false });
  });

  it('quá 5 lần sai PIN: xoá mọi thứ của phiên trên máy và về màn kích hoạt kèm lý do', async () => {
    const { make, kv, ended } = await activated();
    await kv.set(KV_KEYS.assistantConsent, '1');
    await kv.set(KV_KEYS.localProfile, '{"address":"Chủ tịch"}');
    const session = make();
    await session.load();
    for (let left = 4; left >= 1; left--) {
      expect(await session.unlockWithPin('000000')).toEqual({ ok: false, attemptsLeft: left, wiped: false });
    }
    expect(session.getSnapshot().status).toBe('locked');
    expect(await session.unlockWithPin('000000')).toEqual({ ok: false, attemptsLeft: 0, wiped: true });
    expect(session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: 'pin_attempts' });
    expect(session.getAccessToken()).toBeNull();
    expect(kv.dump()).toEqual({});
    expect(ended).toEqual(['pin_attempts']);
  });

  it('số lần sai PIN không mất khi tắt app; nhập đúng thì đếm lại từ đầu', async () => {
    const { make } = await activated();
    const first = make();
    await first.load();
    await first.unlockWithPin('111112');
    await first.unlockWithPin('111113');
    const second = make();
    await second.load();
    expect(second.getSnapshot().pinFailures).toBe(2);
    expect(await second.unlockWithPin('271828')).toEqual({ ok: true });
    expect(second.getSnapshot().pinFailures).toBe(0);
  });

  it('PIN hỏi lại trước việc quan trọng dùng chung bộ đếm với màn khoá', async () => {
    const { session } = await activated();
    expect(await session.checkPin('000001')).toEqual({ ok: false, attemptsLeft: 4, wiped: false });
    expect(session.getSnapshot().status).toBe('unlocked');
    expect(await session.checkPin('271828')).toEqual({ ok: true });
  });

  it('mã PIN dễ đoán bị từ chối lúc đặt', () => {
    for (const weak of ['111111', '123456', '987654', '12345', 'abcdef']) expect(isWeakPin(weak), weak).toBe(true);
    for (const fine of ['271828', '135790', '112233']) expect(isWeakPin(fine), fine).toBe(false);
  });
});

describe('khoá lại sau 2 phút không dùng (SPEC 7.8)', () => {
  it('ở nền từ 2 phút thì khoá; dưới 2 phút thì không', async () => {
    const { session, clock, locked } = await activated();
    session.noteBackground();
    clock.now += IDLE_LOCK_MS - 1000;
    session.noteForeground();
    expect(session.getSnapshot().status).toBe('unlocked');
    session.noteBackground();
    clock.now += IDLE_LOCK_MS;
    session.noteForeground();
    expect(session.getSnapshot().status).toBe('locked');
    expect(locked).toHaveLength(1);
  });

  it('đang mở mà 2 phút không chạm thì khoá; mỗi lần chạm (hoặc trợ lý đang đọc) tính lại từ đầu', async () => {
    const { session, clock, locked } = await activated();
    clock.now += IDLE_LOCK_MS - 5000;
    expect(session.lockIfIdle()).toBe(false);
    session.noteActivity();
    clock.now += IDLE_LOCK_MS - 5000;
    expect(session.lockIfIdle()).toBe(false);
    clock.now += 5000;
    expect(session.lockIfIdle()).toBe(true);
    expect(session.getSnapshot().status).toBe('locked');
    // Khoá thì báo để đóng micro và dừng đọc.
    expect(locked).toHaveLength(1);
    expect(session.lockIfIdle()).toBe(false);
    // Mở khoá xong được tính lại đủ 2 phút.
    await session.unlockWithPin('271828');
    clock.now += IDLE_LOCK_MS - 1;
    expect(session.lockIfIdle()).toBe(false);
  });

  it('"Khoá ứng dụng ngay" ở Cài đặt', async () => {
    const { session } = await activated();
    session.lock();
    expect(session.getSnapshot().status).toBe('locked');
  });
});

describe('token (SPEC 10.2)', () => {
  it('làm mới: nhiều yêu cầu cùng gặp token_expired chỉ gọi máy chủ MỘT lần, rồi lưu cặp token mới', async () => {
    const { session, calls, kv } = await activated();
    const results = await Promise.all([session.refresh(), session.refresh(), session.refresh()]);
    expect(results).toEqual([true, true, true]);
    expect(calls).toEqual(['r1']);
    expect(session.getAccessToken()).toBe('access-after-r1');
    expect(kv.dump()[KV_KEYS.refreshToken]).toBe('refresh-after-r1');
  });

  it('máy chủ báo thiết bị bị thu hồi: xoá phiên, về màn kích hoạt kèm lý do', async () => {
    const s = setup(async () => {
      throw new ApiError('device_revoked');
    });
    await s.session.load();
    await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
    await s.session.setPin('271828');
    s.session.finishOnboarding();
    expect(await s.session.refresh()).toBe(false);
    expect(s.session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: 'device_revoked' });
    expect(s.kv.dump()).toEqual({});
  });

  it('mất mạng lúc làm mới: giữ phiên, lần sau thử lại', async () => {
    const s = setup(async () => {
      throw new TypeError('Network request failed');
    });
    await s.session.load();
    await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
    expect(await s.session.refresh()).toBe(false);
    expect(s.session.getAccessToken()).toBe('a1');
    expect(s.session.getSnapshot().status).toBe('onboarding');
  });

  it('đăng xuất xoá mọi khoá của app trong kho an toàn', async () => {
    const { session, kv } = await activated();
    for (const key of ALL_KV_KEYS) await kv.set(key, 'x');
    await session.end('signed_out');
    expect(kv.dump()).toEqual({});
    expect(session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: 'signed_out' });
  });
});

describe('đường dẫn kích hoạt', () => {
  const TOKEN = '01a100ff-b888-7fc6-9829-6caf4e09d750.k4QzRyrsBuPYn0YaRpuJECrJBL1og7Y09ED';

  it('nhận scheme của app này (mihato-exec) và cả đường dẫn mihato:// khi dán hoặc quét', () => {
    const link = `mihato-exec://activate?token=${TOKEN}&api=http%3A%2F%2Flocalhost%3A3100`;
    expect(parseActivationInput(link)).toEqual({ token: TOKEN, apiBaseUrl: 'http://localhost:3100' });
    expect(parseActivationInput(link.replace('mihato-exec://', 'mihato://'))).toEqual({ token: TOKEN, apiBaseUrl: 'http://localhost:3100' });
  });

  it('chỉ dán mã thì chưa có địa chỉ máy chủ; chuỗi lạ thì không nhận', () => {
    expect(parseActivationInput(`  ${TOKEN}  `)).toEqual({ token: TOKEN, apiBaseUrl: null });
    expect(parseActivationInput('xin chào')).toBeNull();
    expect(parseActivationInput('mihato-exec://activate?token=ngan')).toBeNull();
  });

  it('bản phát hành ghim địa chỉ máy chủ: mã QR giả không dẫn app sang máy chủ khác; http chỉ cho máy phát triển', () => {
    expect(resolveApiBaseUrl('https://gia-mao.example', 'https://api.mihato.vn')).toBe('https://api.mihato.vn');
    expect(resolveApiBaseUrl('http://localhost:3100', null)).toBe('http://localhost:3100');
    expect(resolveApiBaseUrl('http://gia-mao.example', null)).toBeNull();
    expect(resolveApiBaseUrl(null, null)).toBeNull();
  });
});

describe('ký nâng quyền ES256 [GIẢ ĐỊNH, Q16]', () => {
  const CHALLENGE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiZGlkIjoiZGV2aWNlIiwibm9uY2UiOiJ4In0.chu-ky-cua-may-chu';
  const randomBytes: RandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

  /** Kiểm đúng như máy chủ làm ở `stepUp` (packages/backend/src/auth/service.ts): importJWK(jwk, 'ES256') rồi compactVerify. */
  async function verifyLikeServer(assertion: string, jwk: Record<string, unknown> | null) {
    const { payload } = await compactVerify(assertion, await importJWK(jwk as JWK, 'ES256'), { algorithms: ['ES256'] });
    return new TextDecoder().decode(payload);
  }

  it('iOS và Android ký bằng @noble/curves; bản web ký bằng crypto.subtle; không có cả hai thì báo chưa hỗ trợ', () => {
    expect(createStepUpSigner(createMemoryKV(), { platform: 'ios', randomBytes })).toBeInstanceOf(NobleStepUpSigner);
    expect(createStepUpSigner(createMemoryKV(), { platform: 'android', randomBytes })).toBeInstanceOf(NobleStepUpSigner);
    expect(createStepUpSigner(createMemoryKV(), { platform: 'web', randomBytes })).toBeInstanceOf(WebCryptoStepUpSigner);
    expect(new UnsupportedStepUpSigner().supported).toBe(false);
  });

  it('bộ ký noble: khoá công khai là JWK P-256 (x, y 32 byte); chữ ký r||s 64 byte kiểm được bằng jose như máy chủ', async () => {
    const kv = createMemoryKV();
    const signer = new NobleStepUpSigner(kv, randomBytes);
    const jwk = await signer.publicJwk();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(fromBase64Url(String(jwk.x))).toHaveLength(32);
    expect(fromBase64Url(String(jwk.y))).toHaveLength(32);

    const assertion = await signer.sign(CHALLENGE);
    const [header, payload, signature] = assertion.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(header ?? '') ?? new Uint8Array()))).toEqual({ alg: 'ES256' });
    expect(new TextDecoder().decode(fromBase64Url(payload ?? '') ?? new Uint8Array())).toBe(CHALLENGE);
    expect(fromBase64Url(signature ?? '')).toHaveLength(64);
    expect(await verifyLikeServer(assertion, jwk)).toBe(CHALLENGE);

    // Khoá riêng nằm trong kho an toàn của máy và được dùng lại ở lần sau.
    expect(kv.dump()[KV_KEYS.stepUpKey]).toBeDefined();
    expect(await new NobleStepUpSigner(kv, randomBytes).publicJwk()).toEqual(jwk);
  });

  it('chữ ký của máy khác, hoặc thử thách bị sửa, không qua được bước kiểm của máy chủ', async () => {
    const mine = new NobleStepUpSigner(createMemoryKV(), randomBytes);
    const other = new NobleStepUpSigner(createMemoryKV(), randomBytes);
    const assertion = await other.sign(CHALLENGE);
    await expect(verifyLikeServer(assertion, await mine.publicJwk())).rejects.toThrow();
    const [h, , sig] = (await mine.sign(CHALLENGE)).split('.');
    const forged = `${h}.${base64Url(new TextEncoder().encode('thu-thach-khac'))}.${sig}`;
    await expect(verifyLikeServer(forged, await mine.publicJwk())).rejects.toThrow();
  });

  it('bộ ký web (crypto.subtle) cũng cho chữ ký kiểm được bằng jose', async () => {
    const signer = createStepUpSigner(createMemoryKV(), { platform: 'web' });
    expect(signer).toBeInstanceOf(WebCryptoStepUpSigner);
    expect(await verifyLikeServer(await signer.sign(CHALLENGE), await signer.publicJwk())).toBe(CHALLENGE);
  });
});

describe('hỏi lại vân tay, khuôn mặt hoặc PIN trước việc quan trọng', () => {
  it('một lần hỏi chờ tới khi màn xác thực báo kết quả', async () => {
    const asked = requestReauth('Việc này có số tiền.');
    expect(reauthStore.getSnapshot()).toMatchObject({ title: 'Việc này có số tiền.' });
    reauthStore.settle(true);
    expect(await asked).toBe(true);
    expect(reauthStore.getSnapshot()).toBeNull();
  });

  it('lần hỏi mới thay lần cũ; lần cũ coi như chưa xác thực', async () => {
    const first = requestReauth('một');
    const second = requestReauth('hai');
    expect(await first).toBe(false);
    reauthStore.settle(false);
    expect(await second).toBe(false);
    // Không còn ai chờ: báo kết quả thừa không gây lỗi.
    reauthStore.settle(true);
  });
});

describe('ghim máy chủ ở bản phân phối (rà soát 07/10/2026, exec-1)', () => {
  const EVIL = 'https://gia-mao.example';
  const PINNED = 'https://api.vrg.example';

  it('đã ghim: địa chỉ trong đường dẫn hay mã QR (`api=`) KHÔNG bao giờ được nhận, kể cả http mạng nội bộ', () => {
    for (const fromLink of [EVIL, 'http://192.168.1.4:3100', 'http://localhost:3100', null]) {
      expect(resolveApiBaseUrl(fromLink, PINNED, true), String(fromLink)).toBe(PINNED);
    }
  });

  it('bản phân phối chưa ghim (cấu hình dựng sai): từ chối, không rơi về địa chỉ trong đường dẫn', () => {
    expect(resolveApiBaseUrl(EVIL, null, true)).toBeNull();
    expect(resolveApiBaseUrl('http://localhost:3100', null, true)).toBeNull();
    expect(resolveApiBaseUrl(null, null, true)).toBeNull();
  });

  it('bản phân phối ghim địa chỉ http: không dùng (token không được đi trần)', () => {
    expect(resolveApiBaseUrl(EVIL, 'http://api.vrg.example', true)).toBeNull();
    expect(resolveApiBaseUrl(null, 'http://192.168.1.4:3100', true)).toBeNull();
  });

  it('bản phân phối chuẩn hoá dấu / cuối của địa chỉ ghim', () => {
    expect(resolveApiBaseUrl(null, `${PINNED}/`, true)).toBe(PINNED);
  });

  it('bản phát triển (releaseBuild=false) giữ hành vi cũ: chưa ghim thì nhận địa chỉ trong đường dẫn nếu https hoặc máy phát triển', () => {
    expect(resolveApiBaseUrl(EVIL, null)).toBe(EVIL);
    expect(resolveApiBaseUrl('http://192.168.1.4:3100', null, false)).toBe('http://192.168.1.4:3100');
    expect(resolveApiBaseUrl('http://gia-mao.example', null, false)).toBeNull();
  });
});
