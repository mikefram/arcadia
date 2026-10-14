import { describe, expect, it } from 'vitest';
import { SessionController, type SessionEndReason } from '../src/session/controller';
import { KV_KEYS, createMemoryKV, type SecureKV } from '../src/session/kv';
import type { PinHasher } from '../src/session/pin';

/** Rà soát 07/10/2026, mục staff-5 và staff-6: kho an toàn (Keychain, Keystore) có thể ném lỗi. */

const hasher: PinHasher = {
  randomSalt: () => 'salt-salt-salt-salt',
  sha256Hex: async (text) => `h:${text}`,
};

/** Kho trong bộ nhớ nhưng đọc hoặc ghi một số khoá có thể bị buộc lỗi, như Keychain khi máy đang khoá. */
function flakyKV() {
  const inner = createMemoryKV();
  const failing = { get: false, set: new Set<string>(), remove: false };
  const kv: SecureKV = {
    get: async (key) => {
      if (failing.get) throw new Error('keystore unavailable');
      return inner.get(key);
    },
    set: async (key, value) => {
      if (failing.set.has(key)) throw new Error('errSecInteractionNotAllowed');
      await inner.set(key, value);
    },
    remove: async (key) => {
      if (failing.remove) throw new Error('keystore unavailable');
      await inner.remove(key);
    },
  };
  return { kv, inner, failing };
}

const API = 'https://api.demo.mihato.local';
const DEVICE = '0199c000-0000-7000-8000-000000000001';

function build(kv: SecureKV, refreshCall?: (base: string, token: string) => Promise<{ accessToken: string; refreshToken: string }>) {
  const ended: SessionEndReason[] = [];
  const used: string[] = [];
  const session = new SessionController({
    kv,
    hasher,
    now: () => Date.parse('2026-10-15T03:00:00Z'),
    refreshCall:
      refreshCall ??
      (async (_base, token) => {
        used.push(token);
        return { accessToken: `access-after-${token}`, refreshToken: `refresh-after-${token}` };
      }),
    onEnded: (reason) => {
      ended.push(reason);
    },
  });
  return { session, ended, used };
}

async function seeded(kv: SecureKV) {
  await kv.set(KV_KEYS.accessToken, 'a1');
  await kv.set(KV_KEYS.refreshToken, 'r1');
  await kv.set(KV_KEYS.apiBaseUrl, API);
  await kv.set(KV_KEYS.deviceId, DEVICE);
}

describe('mở app khi kho an toàn lỗi (staff-5)', () => {
  it('load() không ném và không kẹt: trạng thái giữ loading kèm loadFailed, không xoá gì', async () => {
    const { kv, inner, failing } = flakyKV();
    await seeded(kv);
    failing.get = true;
    const { session, ended } = build(kv);
    await expect(session.load()).resolves.toBeUndefined();
    expect(session.getSnapshot()).toMatchObject({ status: 'loading', loadFailed: true });
    expect(ended).toEqual([]);
    expect(inner.dump()[KV_KEYS.refreshToken]).toBe('r1');
  });

  it('thử lại sau khi kho đọc được: vào phiên bình thường và bỏ cờ loadFailed', async () => {
    const { kv, failing } = flakyKV();
    await seeded(kv);
    failing.get = true;
    const { session } = build(kv);
    await session.load();
    failing.get = false;
    await session.load();
    expect(session.getSnapshot()).toMatchObject({ status: 'onboarding', loadFailed: false, apiBaseUrl: API });
    expect(session.getAccessToken()).toBe('a1');
  });

  it('kích hoạt lại khi kho hỏng hẳn: end() xoá phiên trên máy dù kho không xoá được, về màn kích hoạt', async () => {
    const { kv, failing } = flakyKV();
    await seeded(kv);
    failing.get = true;
    failing.remove = true;
    const { session, ended } = build(kv);
    await session.load();
    await session.end('session_expired');
    expect(session.getSnapshot()).toMatchObject({ status: 'signedOut', endReason: 'session_expired', loadFailed: false });
    expect(ended).toEqual(['session_expired']);
  });
});

describe('làm mới token khi ghi kho lỗi (staff-6)', () => {
  it('ghi kho lỗi: bộ nhớ vẫn giữ cặp MỚI, lần làm mới sau dùng refresh token mới (không bị coi là tái sử dụng)', async () => {
    const { kv, failing } = flakyKV();
    await seeded(kv);
    const { session, used, ended } = build(kv);
    await session.load();
    failing.set.add(KV_KEYS.refreshToken);
    failing.set.add(KV_KEYS.accessToken);
    expect(await session.refresh()).toBe(true);
    expect(session.getAccessToken()).toBe('access-after-r1');
    failing.set.clear();
    expect(await session.refresh()).toBe(true);
    expect(used).toEqual(['r1', 'refresh-after-r1']);
    expect(ended).toEqual([]);
  });

  it('khi app trở lại nền trước, cặp token chưa ghi được sẽ được ghi vào kho', async () => {
    const { kv, inner, failing } = flakyKV();
    await seeded(kv);
    const { session } = build(kv);
    await session.load();
    failing.set.add(KV_KEYS.refreshToken);
    await session.refresh();
    expect(inner.dump()[KV_KEYS.refreshToken]).toBe('r1');
    failing.set.clear();
    session.noteForeground();
    await session.flushUnsavedTokens();
    expect(inner.dump()[KV_KEYS.refreshToken]).toBe('refresh-after-r1');
    expect(inner.dump()[KV_KEYS.accessToken]).toBe('access-after-r1');
  });

  it('ghi refresh token trước access token: lỗi giữa chừng không để lại cặp (access mới, refresh cũ)', async () => {
    const { kv, inner, failing } = flakyKV();
    await seeded(kv);
    const { session } = build(kv);
    await session.load();
    failing.set.add(KV_KEYS.accessToken);
    await session.refresh();
    expect(inner.dump()[KV_KEYS.refreshToken]).toBe('refresh-after-r1');
    expect(inner.dump()[KV_KEYS.accessToken]).toBe('a1');
  });

  it('đăng xuất trong lúc còn token chưa ghi: không ghi lại token vào kho sau khi đã xoá', async () => {
    const { kv, inner, failing } = flakyKV();
    await seeded(kv);
    const { session } = build(kv);
    await session.load();
    failing.set.add(KV_KEYS.refreshToken);
    await session.refresh();
    failing.set.clear();
    await session.end('signed_out');
    await session.flushUnsavedTokens();
    expect(inner.dump()).toEqual({});
  });
});
