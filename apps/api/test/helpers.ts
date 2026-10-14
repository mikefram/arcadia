import { createSession, generateSeedIds, seedDemoOrg, withOrg, type SeedIds, type UserCode } from '@mihato/backend';
import { newId } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';

/** Mỗi tệp test tạo tổ chức riêng nên chạy song song được và tự kiểm RLS (SPEC 13.1). */
export async function freshOrg(label: string): Promise<SeedIds> {
  const ids = generateSeedIds();
  const tag = ids.ORG.slice(-8);
  await seedDemoOrg(ids, { code: `${label}-${tag}`, name: `Tổ chức thử ${label}`, emailDomain: `${label}-${tag}.test` });
  return ids;
}

export type Caller = <T>(code: UserCode, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T; headers: Record<string, unknown> }>;

/** Gọi API qua app.inject bằng phiên web của một người mẫu (cookie phiên + X-CSRF-Token + Idempotency-Key). */
export function callerFor(app: FastifyInstance, ids: SeedIds): Caller {
  const sessions = new Map<UserCode, { cookie: string; csrf: string }>();
  return async (code, method, url, body, headers = {}) => {
    let s = sessions.get(code);
    if (!s) {
      const g = await withOrg(ids.ORG, (tx) => createSession(tx, ids.ORG, ids.users[code], {}));
      s = { cookie: `mihato_session=${g.token}`, csrf: g.csrfToken };
      sessions.set(code, s);
    }
    const write = method !== 'GET';
    const res = await app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...(write ? { 'idempotency-key': newId(), 'content-type': 'application/json' } : {}), ...headers },
      payload: write ? ((body ?? {}) as object) : undefined,
    });
    let parsed: unknown = null;
    try {
      parsed = res.json();
    } catch {}
    return { status: res.statusCode, body: parsed as never, headers: res.headers };
  };
}

export type RawResponse = { status: number; headers: Record<string, unknown>; rawBody: Buffer };

/** Như `callerFor` nhưng trả thân phản hồi nguyên (nhị phân), dùng cho tải tệp xuống. */
export function rawCallerFor(app: FastifyInstance, ids: SeedIds) {
  const sessions = new Map<UserCode, { cookie: string; csrf: string }>();
  return async (code: UserCode, method: 'GET' | 'POST', url: string, body?: unknown): Promise<RawResponse> => {
    let s = sessions.get(code);
    if (!s) {
      const g = await withOrg(ids.ORG, (tx) => createSession(tx, ids.ORG, ids.users[code], {}));
      s = { cookie: `mihato_session=${g.token}`, csrf: g.csrfToken };
      sessions.set(code, s);
    }
    const write = method !== 'GET';
    const res = await app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...(write ? { 'idempotency-key': newId(), 'content-type': 'application/json' } : {}) },
      payload: write ? ((body ?? {}) as object) : undefined,
    });
    return { status: res.statusCode, headers: res.headers, rawBody: res.rawPayload };
  };
}

