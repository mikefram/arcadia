import { ApiError } from '@mihato/domain';
import { compactVerify, importJWK, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { parseActivationInput, resolveApiBaseUrl } from '../src/session/activation-link';
import { BACKGROUND_LOCK_MS, SessionController, type SessionEndReason, type TokenPair } from '../src/session/controller';
import { KV_KEYS, createMemoryKV } from '../src/session/kv';
import { isWeakPin, type PinHasher } from '../src/session/pin';
import { NobleStepUpSigner, UnsupportedStepUpSigner, WebCryptoStepUpSigner, base64Url, createStepUpSigner, fromBase64Url, type RandomBytes, type StepUpSigner } from '../src/session/step-up';

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
    });
  return { kv, ended, clock, calls, make, session: make() };
}

async function activated() {
  const s = setup();
  await s.session.load();
  await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
  await s.session.acknowledgeNotice();
  await s.session.setPin('271828');
  s.session.finishOnboarding();
  return s;
}

describe('phiên trên máy (SPEC 10.2, 11.2)', () => {
  it('máy mới: chưa có phiên thì về màn kích hoạt', async () => {
    const { session } = setup();
    expect(session.getSnapshot().status).toBe('loading');
    await session.load();
    expect(session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: null });
  });

  it('kích hoạt, đọc thông tin, đặt PIN: lưu token và địa chỉ máy chủ vào kho an toàn; PIN chỉ lưu băm có muối', async () => {
    const { session, kv } = await activated();
    expect(session.getSnapshot()).toMatchObject({ status: 'unlocked', apiBaseUrl: API, deviceId: DEVICE, pinSet: true, noticeRead: true });
    const stored = kv.dump();
    expect(stored[KV_KEYS.accessToken]).toBe('a1');
    expect(stored[KV_KEYS.refreshToken]).toBe('r1');
    expect(stored[KV_KEYS.apiBaseUrl]).toBe(API);
    expect(stored[KV_KEYS.deviceId]).toBe(DEVICE);
    expect(stored[KV_KEYS.pin]).not.toContain('271828');
    const record = JSON.parse(stored[KV_KEYS.pin] ?? '{}') as { salt: string; hash: string };
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.salt.length).toBeGreaterThanOrEqual(16);
  });

  it('mở lại app thì phải mở khoá; đúng PIN thì vào', async () => {
    const { make } = await activated();
    const reopened = make();
    await reopened.load();
    expect(reopened.getSnapshot().status).toBe('locked');
    expect(await reopened.unlockWithPin('271828')).toEqual({ ok: true });
    expect(reopened.getSnapshot().status).toBe('unlocked');
  });

  it('tắt app giữa chừng trước khi đặt PIN: mở lại quay về các bước kích hoạt', async () => {
    const s = setup();
    await s.session.load();
    await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
    const reopened = s.make();
    await reopened.load();
    expect(reopened.getSnapshot()).toMatchObject({ status: 'onboarding', pinSet: false, noticeRead: false });
  });

  it('quá 5 lần sai PIN: xoá phiên trên máy và về màn kích hoạt kèm lý do', async () => {
    const { make, kv, ended } = await activated();
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
    expect(await second.unlockWithPin('111114')).toEqual({ ok: false, attemptsLeft: 2, wiped: false });
    expect(await second.unlockWithPin('271828')).toEqual({ ok: true });
    expect(second.getSnapshot().pinFailures).toBe(0);
  });

  it('ở nền dưới 2 phút thì không khoá; từ 2 phút thì khoá', async () => {
    const { session, clock } = await activated();
    session.noteBackground();
    clock.now += BACKGROUND_LOCK_MS - 1;
    session.noteForeground();
    expect(session.getSnapshot().status).toBe('unlocked');
    session.noteBackground();
    clock.now += BACKGROUND_LOCK_MS;
    session.noteForeground();
    expect(session.getSnapshot().status).toBe('locked');
  });

  it('sinh trắc học chỉ mở khoá khi đã bật', async () => {
    const { session } = await activated();
    session.lock();
    session.unlockWithBiometrics();
    expect(session.getSnapshot().status).toBe('locked');
    await session.setBiometricsEnabled(true);
    session.unlockWithBiometrics();
    expect(session.getSnapshot().status).toBe('unlocked');
  });
});

describe('làm mới token (xoay vòng, SPEC 10.2)', () => {
  it('nhiều yêu cầu cùng hết hạn chỉ gây một lần làm mới, và lưu cặp token mới', async () => {
    const { session, kv, calls } = await activated();
    const results = await Promise.all([session.refresh(), session.refresh(), session.refresh()]);
    expect(results).toEqual([true, true, true]);
    expect(calls).toEqual(['r1']);
    expect(session.getAccessToken()).toBe('access-after-r1');
    expect(kv.dump()[KV_KEYS.refreshToken]).toBe('refresh-after-r1');

    // Lần sau dùng refresh token mới, không dùng lại token cũ.
    await session.refresh();
    expect(calls).toEqual(['r1', 'refresh-after-r1']);
  });

  it('mất mạng khi làm mới: giữ phiên, không đẩy người dùng về màn kích hoạt', async () => {
    const s = setup(async () => {
      throw new TypeError('Network request failed');
    });
    await s.session.load();
    await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
    expect(await s.session.refresh()).toBe(false);
    s.session.handleUnauthenticated('token_expired');
    expect(s.session.getSnapshot().status).toBe('onboarding');
    expect(s.session.getAccessToken()).toBe('a1');
  });

  it('máy chủ báo device_revoked khi làm mới: xoá phiên, về màn kích hoạt kèm lý do', async () => {
    const s = setup(async () => {
      throw new ApiError('device_revoked', { status: 401 });
    });
    await s.session.load();
    await s.session.activate({ accessToken: 'a1', refreshToken: 'r1', apiBaseUrl: API, deviceId: DEVICE });
    expect(await s.session.refresh()).toBe(false);
    expect(s.session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: 'device_revoked' });
    expect(s.kv.dump()).toEqual({});
    expect(s.ended).toEqual(['device_revoked']);
  });

  it('401 khác ở một yêu cầu thường: phiên hết, về màn kích hoạt', async () => {
    const { session, ended } = await activated();
    session.handleUnauthenticated('unauthenticated');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: 'session_expired' });
    expect(ended).toEqual(['session_expired']);
  });
});

describe('mã PIN', () => {
  it('từ chối mã dễ đoán', () => {
    for (const pin of ['000000', '999999', '123456', '654321', '012345', '12345', 'abcdef']) expect(isWeakPin(pin), pin).toBe(true);
    for (const pin of ['271828', '135790', '112233']) expect(isWeakPin(pin), pin).toBe(false);
  });
});

describe('đường dẫn kích hoạt (SPEC 10.2)', () => {
  const TOKEN = 'act_0199c000aaaa7000800000000000beef';

  it('đọc đường dẫn mihato://activate?token=…&api=…', () => {
    expect(parseActivationInput(`mihato://activate?token=${TOKEN}&api=${encodeURIComponent('http://127.0.0.1:3100')}`)).toEqual({ token: TOKEN, apiBaseUrl: 'http://127.0.0.1:3100' });
    expect(parseActivationInput(`  mihato://activate?api=https%3A%2F%2Fapi.mihato.vn%2F&token=${TOKEN}  `)).toEqual({ token: TOKEN, apiBaseUrl: 'https://api.mihato.vn' });
  });

  it('đường dẫn của người điều hành (mihato-exec://) dán hoặc quét trong app nhân viên vẫn đọc được', () => {
    // Máy chủ cấp scheme `mihato-exec` cho vai trò điều hành để hệ điều hành mở app Chủ tịch. Phó giám đốc vẫn dùng
    // app nhân viên để duyệt (kịch bản vàng, SPEC 8.6 điều 4), nên app nhận mã ở mọi scheme khi dán hoặc quét QR.
    expect(parseActivationInput(`mihato-exec://activate?token=${TOKEN}&api=${encodeURIComponent('https://api.mihato.vn')}`)).toEqual({ token: TOKEN, apiBaseUrl: 'https://api.mihato.vn' });
  });

  it('nhận mã dán tay, không kèm địa chỉ máy chủ', () => {
    expect(parseActivationInput(TOKEN)).toEqual({ token: TOKEN, apiBaseUrl: null });
  });

  it('không nhận nội dung lạ', () => {
    expect(parseActivationInput('')).toBeNull();
    expect(parseActivationInput('xin chào')).toBeNull();
    expect(parseActivationInput('mihato://activate?token=ngan')).toBeNull();
    expect(parseActivationInput('https://example.com/trang-khac?x=1')).toBeNull();
  });

  it('địa chỉ máy chủ: bản ghim trong app.json thắng; http chỉ cho máy phát triển', () => {
    expect(resolveApiBaseUrl('https://gia-mao.example', 'https://api.mihato.vn/')).toBe('https://api.mihato.vn');
    expect(resolveApiBaseUrl('https://api.mihato.vn', null)).toBe('https://api.mihato.vn');
    expect(resolveApiBaseUrl('http://127.0.0.1:3100', null)).toBe('http://127.0.0.1:3100');
    expect(resolveApiBaseUrl('http://192.168.1.20:3100', null)).toBe('http://192.168.1.20:3100');
    expect(resolveApiBaseUrl('http://api.mihato.vn', null)).toBeNull();
    expect(resolveApiBaseUrl(null, null)).toBeNull();
  });
});

describe('ký thử thách nâng quyền [GIẢ ĐỊNH, Q16]', () => {
  it('máy không có crypto.subtle: bộ ký báo chưa hỗ trợ, không tự viết mật mã', async () => {
    const signer: StepUpSigner = new UnsupportedStepUpSigner();
    expect(signer.supported).toBe(false);
    expect(await signer.publicJwk()).toBeNull();
    await expect(signer.sign('thử thách')).rejects.toThrow('step_up_unsupported');
  });

  it('có crypto.subtle: assertion là JWS compact ES256 trên chuỗi thử thách, kiểm được bằng JWK P-256 đã gửi lúc kích hoạt', async () => {
    const kv = createMemoryKV();
    const signer = createStepUpSigner(kv);
    expect(signer).toBeInstanceOf(WebCryptoStepUpSigner);
    const jwk = await signer.publicJwk();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(Object.keys(jwk ?? {}).sort()).toEqual(['crv', 'kty', 'x', 'y']);

    const challenge = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.chu-ky-cua-may-chu';
    const jws = await signer.sign(challenge);
    const [header, payload, signature] = jws.split('.');
    const decode = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    expect(JSON.parse(text(decode(header ?? '')))).toEqual({ alg: 'ES256' });
    expect(text(decode(payload ?? ''))).toBe(challenge);
    expect(decode(signature ?? '')).toHaveLength(64);

    // Kiểm chữ ký như máy chủ làm (RFC 7515): ECDSA P-256, SHA-256 trên "header.payload".
    const key = await globalThis.crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(signature ?? ''), new TextEncoder().encode(`${header}.${payload}`));
    expect(ok).toBe(true);

    // Cặp khoá được giữ lại: lần sau vẫn là khoá công khai đó.
    expect(await createStepUpSigner(kv).publicJwk()).toEqual(jwk);
  });
});

describe('NobleStepUpSigner: bộ ký cho iOS và Android bằng @noble/curves [GIẢ ĐỊNH, Q16]', () => {
  const CHALLENGE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiZGlkIjoiZGV2aWNlIiwibm9uY2UiOiJ4In0.chu-ky-cua-may-chu';
  /** Thay cho `getRandomBytes` của expo-crypto; ghi lại số byte được xin. */
  function rng(): { randomBytes: RandomBytes; asked: number[] } {
    const asked: number[] = [];
    return {
      asked,
      randomBytes: (byteCount) => {
        asked.push(byteCount);
        return globalThis.crypto.getRandomValues(new Uint8Array(byteCount));
      },
    };
  }
  /** Kiểm đúng như máy chủ làm ở `stepUp` (packages/backend/src/auth/service.ts). */
  async function verifyLikeServer(assertion: string, jwk: Record<string, unknown> | null) {
    const key = await importJWK(jwk as JWK, 'ES256');
    return compactVerify(assertion, key, { algorithms: ['ES256'] });
  }

  it('iOS và Android chọn bộ ký noble; web vẫn dùng crypto.subtle', () => {
    const { randomBytes } = rng();
    expect(createStepUpSigner(createMemoryKV(), { platform: 'ios', randomBytes })).toBeInstanceOf(NobleStepUpSigner);
    expect(createStepUpSigner(createMemoryKV(), { platform: 'android', randomBytes })).toBeInstanceOf(NobleStepUpSigner);
    expect(createStepUpSigner(createMemoryKV(), { platform: 'web', randomBytes })).toBeInstanceOf(WebCryptoStepUpSigner);
  });

  it('khoá công khai xuất ra đúng dạng JWK { kty: EC, crv: P-256, x, y }, mỗi toạ độ 32 byte', async () => {
    const { randomBytes, asked } = rng();
    const signer = new NobleStepUpSigner(createMemoryKV(), randomBytes);
    const jwk = await signer.publicJwk();
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(fromBase64Url(String(jwk.x))).toHaveLength(32);
    expect(fromBase64Url(String(jwk.y))).toHaveLength(32);
    expect(String(jwk.x) + String(jwk.y)).toMatch(/^[A-Za-z0-9_-]+$/);
    // Sinh khoá đúng một lần, bằng số ngẫu nhiên được truyền vào (48 byte cho P-256).
    await signer.publicJwk();
    expect(asked).toEqual([48]);
  });

  it('assertion là JWS compact ES256 trên chuỗi thử thách, kiểm được bằng jose đúng như máy chủ làm', async () => {
    const { randomBytes } = rng();
    const signer = new NobleStepUpSigner(createMemoryKV(), randomBytes);
    const jwk = await signer.publicJwk();
    const assertion = await signer.sign(CHALLENGE);

    const { payload, protectedHeader } = await verifyLikeServer(assertion, jwk);
    expect(new TextDecoder().decode(payload)).toBe(CHALLENGE);
    expect(protectedHeader).toEqual({ alg: 'ES256' });

    // Chữ ký là r||s 64 byte (RFC 7518 mục 3.4), không phải DER.
    const parts = assertion.split('.');
    expect(parts).toHaveLength(3);
    expect(fromBase64Url(parts[2] ?? '')).toHaveLength(64);
  });

  it('thử thách bị sửa, hoặc khoá của máy khác, thì máy chủ không nhận', async () => {
    const signer = new NobleStepUpSigner(createMemoryKV(), rng().randomBytes);
    const jwk = await signer.publicJwk();
    const [header, , signature] = (await signer.sign(CHALLENGE)).split('.');
    const forged = `${header}.${base64Url(new TextEncoder().encode('thu-thach-khac'))}.${signature}`;
    await expect(verifyLikeServer(forged, jwk)).rejects.toThrow();

    const other = new NobleStepUpSigner(createMemoryKV(), rng().randomBytes);
    await expect(verifyLikeServer(await other.sign(CHALLENGE), jwk)).rejects.toThrow();
  });

  it('khoá riêng nằm trong kho an toàn và giữ nguyên qua các lần mở app', async () => {
    const kv = createMemoryKV();
    const first = new NobleStepUpSigner(kv, rng().randomBytes);
    const jwk = await first.publicJwk();
    expect(Object.keys(kv.dump())).toEqual([KV_KEYS.stepUpKey]);

    const second = rng();
    const reopened = new NobleStepUpSigner(kv, second.randomBytes);
    expect(await reopened.publicJwk()).toEqual(jwk);
    expect(second.asked).toEqual([]);
    await expect(verifyLikeServer(await reopened.sign(CHALLENGE), jwk)).resolves.toBeDefined();
  });

  it('khoá lưu cùng dạng JWK với bộ ký web: khoá do noble sinh, crypto.subtle đọc và ký được', async () => {
    const kv = createMemoryKV();
    const jwk = await new NobleStepUpSigner(kv, rng().randomBytes).publicJwk();
    const web = createStepUpSigner(kv, { platform: 'web' });
    expect(await web.publicJwk()).toEqual(jwk);
    await expect(verifyLikeServer(await web.sign(CHALLENGE), jwk)).resolves.toBeDefined();
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
