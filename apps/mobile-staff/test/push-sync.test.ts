import { describe, expect, it } from 'vitest';
import { syncPushTokenWith, type PushPermission, type PushSyncDeps } from '../src/push/sync';

/** Rà soát 07/10/2026, exec-2: bước "Cho phép thông báo" không được báo xong khi chưa đăng ký được. */

function deps(overrides: Partial<PushSyncDeps> = {}) {
  const log: string[] = [];
  let stored: string | null = null;
  const base: PushSyncDeps = {
    permission: async () => 'granted',
    projectId: () => '0199c000-0000-7000-8000-00000000abcd',
    prepare: async () => {
      log.push('prepare');
    },
    getToken: async (projectId) => {
      log.push(`getToken:${projectId}`);
      return 'ExponentPushToken[abc]';
    },
    getStoredToken: async () => stored,
    setStoredToken: async (token) => {
      stored = token;
    },
    putToken: async (token) => {
      log.push(`put:${token}`);
    },
  };
  return { log, deps: { ...base, ...overrides } as PushSyncDeps, stored: () => stored };
}

describe('syncPushTokenWith', () => {
  it('đủ quyền và projectId: lấy token, ghi lên máy chủ, nhớ token, trả granted', async () => {
    const d = deps();
    expect(await syncPushTokenWith(d.deps, true)).toBe('granted');
    expect(d.log).toEqual(['prepare', 'getToken:0199c000-0000-7000-8000-00000000abcd', 'put:ExponentPushToken[abc]']);
    expect(d.stored()).toBe('ExponentPushToken[abc]');
  });

  it('token không đổi thì không gọi máy chủ lần nữa', async () => {
    const d = deps();
    await syncPushTokenWith(d.deps, false);
    d.log.length = 0;
    expect(await syncPushTokenWith(d.deps, false)).toBe('granted');
    expect(d.log.filter((l) => l.startsWith('put:'))).toEqual([]);
  });

  it('thiếu projectId: trả no_project, KHÔNG gọi getToken (trước đây lỗi này bị nuốt rồi báo xong)', async () => {
    const d = deps({ projectId: () => null });
    expect(await syncPushTokenWith(d.deps, true)).toBe('no_project');
    expect(d.log).toEqual([]);
  });

  it('người dùng từ chối: trả denied; máy không hỗ trợ: trả unavailable; cả hai không đụng tới token', async () => {
    for (const permission of ['denied', 'unavailable'] as PushPermission[]) {
      const d = deps({ permission: async () => permission });
      expect(await syncPushTokenWith(d.deps, true)).toBe(permission);
      expect(d.log).toEqual([]);
    }
  });

  it('lấy token lỗi hoặc máy chủ từ chối: trả failed (cho thử lại), không ghi nhớ token', async () => {
    const getTokenFails = deps({
      getToken: async () => {
        throw new Error('ERR_NOTIFICATIONS_NO_EXPERIENCE_ID');
      },
    });
    expect(await syncPushTokenWith(getTokenFails.deps, true)).toBe('failed');

    const putFails = deps({
      putToken: async () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(await syncPushTokenWith(putFails.deps, true)).toBe('failed');
    expect(putFails.stored()).toBeNull();
  });

  it('thất bại rồi thử lại thành công thì ghi nhận bình thường', async () => {
    let attempts = 0;
    const d = deps({
      putToken: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('offline');
      },
    });
    expect(await syncPushTokenWith(d.deps, true)).toBe('failed');
    expect(await syncPushTokenWith(d.deps, true)).toBe('granted');
    expect(d.stored()).toBe('ExponentPushToken[abc]');
  });
});
