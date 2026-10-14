import { closeDb, type SeedIds, type UserCode } from '@mihato/backend';
import { POLICY, ROLES, newId, routes, type Action, type Role, type RouteDef } from '@mihato/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Test phân quyền sinh từ bảng 9.1 (SPEC 13.4 [QUYẾT ĐỊNH]): bảng quyền ở packages/domain là dữ liệu của test.
 * Mọi cặp (vai trò, endpoint có khai quyền) được kiểm: vai không có quyền nhận 403 `forbidden`, vai có quyền
 * không bao giờ nhận 403 `forbidden`. Sửa bảng thì test đổi theo, không viết tay ở hai nơi.
 */
const USER_OF_ROLE: Record<Role, UserCode> = {
  chairman: 'U_CHAIRMAN',
  director: 'U_DIRECTOR',
  deputy: 'U_HUY',
  office_admin: 'U_ADMIN',
  process_designer: 'U_DESIGNER',
  it_admin: 'U_IT',
  employee: 'U_LAN',
};

let app: FastifyInstance;
let ids: SeedIds;
let call: Caller;

beforeAll(async () => {
  ids = await freshOrg('perm');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});

const guarded = (Object.entries(routes) as [string, RouteDef][]).filter(([, d]) => d.auth === 'user' && (d.permission || d.anyPermission));
const urlOf = (def: RouteDef) => def.path.replace(':id', newId()).replace(':day', '2026-01-01').replace(':n', '1').replace(':name', 'x');
const allowed = (role: Role, def: RouteDef) => {
  const needs: readonly Action[] = def.permission ? [def.permission] : (def.anyPermission ?? []);
  return needs.some((a) => POLICY[role].includes(a));
};

describe('ma trận quyền (SPEC 9.1)', () => {
  it('mọi route của người dùng có trong hợp đồng đều đã có handler', () => {
    expect(app.missingRoutes).toEqual([]);
  });

  for (const role of ROLES) {
    it(`vai ${role}: đúng 403 với việc không được làm, không 403 với việc được làm`, async () => {
      for (const [key, def] of guarded) {
        const res = await call<{ code?: string }>(USER_OF_ROLE[role], def.method, urlOf(def), def.method === 'GET' ? undefined : {});
        const forbidden = res.status === 403 && res.body?.code === 'forbidden';
        expect(forbidden, `${role} → ${key} (${res.status} ${res.body?.code ?? ''})`).toBe(!allowed(role, def));
      }
    });
  }

  it('chưa đăng nhập thì mọi route của người dùng trả 401', async () => {
    for (const [key, def] of Object.entries(routes) as [string, RouteDef][]) {
      if (def.auth !== 'user') continue;
      const res = await app.inject({ method: def.method, url: urlOf(def), payload: def.method === 'GET' ? undefined : {} });
      expect(res.statusCode, key).toBe(401);
    }
  });

  it('giao diện nội bộ từ chối khi không có service token, và từ chối phiên người dùng', async () => {
    for (const [key, def] of Object.entries(routes) as [string, RouteDef][]) {
      if (def.auth !== 'service') continue;
      const anon = await app.inject({ method: def.method, url: urlOf(def), payload: {} });
      expect(anon.statusCode, key).toBe(401);
      const asUser = await call<{ code?: string }>('U_CHAIRMAN', def.method, urlOf(def), {});
      expect(asUser.status, key).toBe(401);
    }
  });
});
