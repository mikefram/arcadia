import { Scenario, closeDb, env, setFakeNow, signToken, sql, withOrg, type SeedIds, type UserCode } from '@mihato/backend';
import { newId, routes, type InternalClaimResponse, type InternalToolResult, type ProposalView, type RouteDef, type RouteKey, type ScribeSession } from '@mihato/domain';
import { FakePush } from '@mihato/providers';
import type { FastifyInstance } from 'fastify';
import { importJWK, jwtVerify, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { callerFor, freshOrg, type Caller } from './helpers';

/**
 * Cổng xác nhận ở tầng HTTP (SPEC 13.3 điều 1 và 2, SPEC 10.7.1): AI không có đường ghi.
 * Dùng token của scribe (service token của `ai_service` và token phiên Scribe) gọi MỌI endpoint ghi công khai:
 * tất cả bị từ chối và không có dòng nào đổi. Đề xuất do AI tạo chỉ đúng người `for_user_id` xác nhận được
 * bằng phiên đăng nhập của họ. Một test ở đây đỏ thì không phát hành.
 */
const vn = (s: string) => new Date(`${s}:00+07:00`);

let app: FastifyInstance;
let ids: SeedIds;
let other: SeedIds;
let call: Caller;
let scenario: Scenario;
let runId: string;
let step: Record<string, string>;

type Injected = { status: number; body: Record<string, unknown> & { code?: string } };

async function raw(method: RouteDef['method'], url: string, headers: Record<string, string>, body?: unknown): Promise<Injected> {
  const res = await app.inject({ method, url, headers: { 'content-type': 'application/json', ...headers }, payload: method === 'GET' ? undefined : ((body ?? {}) as object) });
  let parsed: unknown = null;
  try {
    parsed = res.json();
  } catch {}
  return { status: res.statusCode, body: (parsed ?? {}) as Injected['body'] };
}

const service = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${env.internalServiceToken}`, 'x-org-id': ids.ORG, ...extra });
const onBehalf = (code: UserCode) => service({ 'x-on-behalf-of': ids.users[code] });

/** Gọi một tool qua giao diện nội bộ, như dịch vụ scribe gọi. */
async function tool(code: UserCode, name: string, args: unknown): Promise<InternalToolResult> {
  const res = await raw('POST', `/internal/v1/tools/${name}`, onBehalf(code), { args });
  expect(res.status, `tool ${name}`).toBe(200);
  return res.body as unknown as InternalToolResult;
}

async function scribeSession(code: UserCode): Promise<ScribeSession> {
  const res = await call<ScribeSession>(code, 'POST', '/v1/scribe/sessions', { channel: 'text', transcriptConsent: true });
  expect(res.status).toBe(201);
  return res.body;
}

const TABLES = [
  'organizations',
  'units',
  'users',
  'user_roles',
  'devices',
  'delegations',
  'process_templates',
  'process_template_versions',
  'holidays',
  'process_runs',
  'step_runs',
  'step_approvals',
  'extension_requests',
  'run_events',
  'effects',
  'timers',
  'notifications',
  'nudges',
  'conversations',
  'messages',
  'proposals',
  'scribe_sessions',
  'ai_usage',
  'files',
  'audit_log',
  'idempotency_keys',
  'sessions',
  'refresh_tokens',
  'activation_tokens',
  'password_tokens',
] as const;

/** Dấu vân tay của mọi bảng nghiệp vụ của tổ chức: số dòng và băm nội dung từng bảng. */
async function fingerprint(): Promise<Record<string, string>> {
  return withOrg(ids.ORG, async (tx) => {
    const out: Record<string, string> = {};
    for (const t of TABLES) {
      const res = await tx.execute<{ n: number; h: string }>(sql.raw(`SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') AS h FROM ${t} t`));
      out[t] = `${res.rows[0]!.n}:${res.rows[0]!.h}`;
    }
    return out;
  });
}

beforeAll(async () => {
  setFakeNow(vn('2026-10-02T08:00'));
  ids = await freshOrg('gate');
  other = await freshOrg('gate-khac');
  app = await buildApp({ quiet: true, stream: false, rateLimit: false });
  call = callerFor(app, ids);
  scenario = new Scenario(ids, new FakePush());
  await scenario.at(vn('2026-10-02T09:00'));
  const run = await scenario.start('U_CHAIRMAN', { title: 'Đón đoàn nhà đầu tư Nhật Bản', delegation: 'Đoàn nhà đầu tư Nhật Bản', visitDate: '2026-10-15' });
  runId = run.id;
  await scenario.at(vn('2026-10-05T11:00'));
  await scenario.complete('U_LAN', runId, 's1');
  await scenario.at(vn('2026-10-08T09:05'));
  step = Object.fromEntries((await scenario.run(runId)).steps.map((s) => [s.nodeId, s.id]));
});

afterAll(async () => {
  setFakeNow(null);
  await app?.close();
  await closeDb();
});

describe('cổng xác nhận ở tầng HTTP (SPEC 13.3)', () => {
  it('điều 1: token của scribe gọi mọi endpoint ghi công khai đều bị từ chối và không có dòng nào đổi', async () => {
    // Chuẩn bị: một đề xuất đi thúc đang chờ (do AI tạo qua giao diện nội bộ) và một token phiên Scribe còn hạn.
    const proposed = await tool('U_CHAIRMAN', 'propose_nudge', { stepRunIds: [step.s3] });
    const { proposalId, batchId } = proposed.proposals![0]!;
    const session = await scribeSession('U_CHAIRMAN');

    const idFor = (key: string): string => {
      if (key.startsWith('steps.')) return step.s3!;
      if (key.startsWith('runs.')) return runId;
      if (key.startsWith('proposalBatches.')) return batchId!;
      if (key.startsWith('proposals.')) return proposalId;
      if (key.startsWith('users.')) return ids.users.U_TUAN;
      if (key.startsWith('templates.')) return ids.TEMPLATE_DON_DOAN;
      if (key.startsWith('units.')) return ids.units.sales;
      return newId();
    };
    const urlOf = (key: string, def: RouteDef) => def.path.replace(':id', idFor(key)).replace(':day', '2026-12-25').replace(':n', '1').replace(':name', 'x');
    // Thân hợp lệ cho các thao tác chính, để nếu lọt qua xác thực thì thao tác SẼ có hiệu lực và test bắt được.
    const bodies: Partial<Record<RouteKey, unknown>> = {
      'steps.complete': {},
      'steps.accept': {},
      'steps.approve': {},
      'steps.reject': { reason: 'Chưa đủ hồ sơ' },
      'steps.extend': { newDueAt: '2026-10-20T10:00:00.000Z', reason: 'Gia hạn' },
      'steps.reassign': { toUserId: ids.users.U_HUNG, reason: 'Đổi người' },
      'steps.skip': { reason: 'Không cần làm' },
      'steps.block': { reasonCode: 'other' },
      'steps.batch': { action: 'reassign', stepIds: [step.s3], params: { toUserId: ids.users.U_HUNG, reason: 'Đổi người' } },
      'runs.cancel': { reason: 'Dừng', confirmTitle: 'Đón đoàn nhà đầu tư Nhật Bản' },
      'runs.note': { text: 'Ghi chú' },
      'runs.create': { templateId: ids.TEMPLATE_DON_DOAN, title: 'Lượt mới', inputs: { delegation: 'Đoàn B', visitDate: '2026-11-12' } },
      'nudges.send': { items: [{ stepId: step.s3, message: 'Nhắc việc' }] },
      'proposals.confirm': { via: 'touch' },
      'proposalBatches.confirm': { via: 'touch' },
      'proposals.reject': {},
      'proposals.create': { forUserId: ids.users.U_CHAIRMAN, tool: 'propose_nudge', payload: { stepRunIds: [step.s4] } },
      'users.setRoles': { roles: [{ role: 'chairman', unitId: null }] },
      'scribe.createSession': { channel: 'text', transcriptConsent: true },
    };

    const userRoutes = (Object.entries(routes) as [RouteKey, RouteDef][]).filter(([, d]) => d.auth === 'user');
    const writes = userRoutes.filter(([, d]) => d.method !== 'GET');
    // Sáu thao tác SPEC nêu đích danh phải nằm trong danh sách được thử.
    expect(writes.map(([k]) => k)).toEqual(expect.arrayContaining(['steps.complete', 'steps.extend', 'steps.reassign', 'steps.approve', 'runs.cancel', 'proposals.confirm', 'proposalBatches.confirm']));
    expect(writes.length).toBeGreaterThan(40);

    const before = await fingerprint();
    for (const [label, token] of [
      ['service token của ai_service', env.internalServiceToken],
      ['token phiên Scribe', session.token],
    ] as const) {
      for (const [key, def] of writes) {
        const headers = { authorization: `Bearer ${token}`, 'idempotency-key': newId(), 'x-org-id': ids.ORG, 'x-on-behalf-of': ids.users.U_CHAIRMAN, 'x-step-up-token': token };
        const res = await raw(def.method, urlOf(key, def), headers, bodies[key] ?? {});
        expect([401, 403], `${label} → ${key} (${res.status} ${res.body.code ?? ''})`).toContain(res.status);
      }
      // Đường đọc công khai cũng không nhận token của scribe: mọi dữ liệu của scribe đi qua /internal/v1.
      for (const [key, def] of userRoutes.filter(([, d]) => d.method === 'GET')) {
        const res = await raw('GET', urlOf(key, def), { authorization: `Bearer ${token}` });
        expect(res.status, `${label} → ${key}`).toBe(401);
      }
    }
    expect(await fingerprint()).toEqual(before);

    // Giao diện nội bộ không có đường nào để xác nhận, hoàn tác hay gửi ngay một đề xuất, cũng không có tool ghi.
    const internalRoutes = (Object.entries(routes) as [RouteKey, RouteDef][]).filter(([, d]) => d.auth === 'service').map(([k]) => k);
    expect(internalRoutes.sort()).toEqual(['internal.claim', 'internal.message', 'internal.tool', 'internal.usage']);
    for (const name of ['confirm_proposal', 'complete_step', 'approve_step', 'cancel_run', 'reassign_step']) {
      expect(await tool('U_CHAIRMAN', name, { proposalId, stepId: step.s3, runId })).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('điều 2: người dùng thường tạo đề xuất bị 403; token scribe gọi confirm bị từ chối; chỉ đúng for_user_id xác nhận được', async () => {
    // Người dùng thường gọi tạo đề xuất: 403. Chỉ Văn phòng trình được (source = office).
    const office = { forUserId: ids.users.U_CHAIRMAN, tool: 'propose_nudge', payload: { stepRunIds: [step.s4] } };
    for (const code of ['U_CHAIRMAN', 'U_DIRECTOR', 'U_HUY', 'U_LAN', 'U_IT', 'U_DESIGNER'] as const) {
      const res = await call<{ code: string }>(code, 'POST', '/v1/proposals', office);
      expect(res.status, code).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
    const created = await call<{ items: ProposalView[] }>('U_ADMIN', 'POST', '/v1/proposals', office);
    expect(created.status).toBe(201);
    expect(created.body.items).toHaveLength(1);
    expect(created.body.items[0]).toMatchObject({ source: 'office', state: 'pending', risk: 1, createdBy: { id: ids.users.U_ADMIN } });
    const fromOffice = created.body.items[0]!.id;

    const pending = await call<{ items: ProposalView[] }>('U_CHAIRMAN', 'GET', '/v1/proposals?state=pending');
    expect(pending.status).toBe(200);
    const fromAi = pending.body.items.find((p) => p.source === 'ai')!;
    expect(fromAi).toMatchObject({ tool: 'propose_nudge', risk: 1, requiresStepUp: false });
    expect(pending.body.items.map((p) => p.id)).toContain(fromOffice);
    // Câu xác nhận do máy chủ dựng.
    expect(fromAi.summary).toBe('Gửi lời nhắc tới anh Bùi Quốc Tuấn về việc ‘Kiểm tra tuyến tham quan’ của lượt ‘Đón đoàn nhà đầu tư Nhật Bản’, đã quá hạn 1 ngày làm việc.');

    // Token của scribe gọi confirm: bị từ chối.
    const session = await scribeSession('U_CHAIRMAN');
    for (const token of [env.internalServiceToken, session.token]) {
      for (const id of [fromAi.id, fromOffice]) {
        const res = await raw('POST', `/v1/proposals/${id}/confirm`, { authorization: `Bearer ${token}`, 'idempotency-key': newId(), 'x-on-behalf-of': ids.users.U_CHAIRMAN, 'x-org-id': ids.ORG }, { via: 'touch' });
        expect(res.status).toBe(401);
      }
    }
    // Bất kỳ người nào khác for_user_id, ở mọi vai, gọi confirm: bị từ chối (404; người soạn của Văn phòng thì 403).
    for (const code of ['U_DIRECTOR', 'U_HUY', 'U_ADMIN', 'U_IT', 'U_DESIGNER', 'U_LAN', 'U_TUAN'] as const) {
      for (const id of [fromAi.id, fromOffice]) {
        const res = await call<{ code: string }>(code, 'POST', `/v1/proposals/${id}/confirm`, { via: 'touch' });
        expect(res.status, `${code} xác nhận ${id === fromOffice ? 'đề xuất của Văn phòng' : 'đề xuất của AI'}`).toBe(code === 'U_ADMIN' && id === fromOffice ? 403 : 404);
        expect((await call<{ code: string }>(code, 'POST', `/v1/proposals/${id}/undo`)).status).toBeGreaterThanOrEqual(403);
        expect((await call<{ code: string }>(code, 'POST', `/v1/proposals/${id}/send-now`)).status).toBeGreaterThanOrEqual(403);
      }
      expect((await call<{ items: ProposalView[] }>(code, 'GET', '/v1/proposals')).body.items).toEqual([]);
    }
    const still = await call<{ items: ProposalView[] }>('U_CHAIRMAN', 'GET', '/v1/proposals?state=pending');
    expect(still.body.items.map((p) => p.id).sort()).toEqual([fromAi.id, fromOffice].sort());

    // Đúng người, bằng phiên đăng nhập của họ: xác nhận được; gửi lại cùng Idempotency-Key trả đúng kết quả cũ.
    const key = newId();
    const ok = await call<{ state: string; effectiveAt: string; proposalIds: string[] }>('U_CHAIRMAN', 'POST', `/v1/proposals/${fromAi.id}/confirm`, { via: 'touch' }, { 'idempotency-key': key });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'confirmed', effectiveAt: '2026-10-08T02:05:30.000Z', undoUntil: '2026-10-08T02:05:30.000Z', proposalIds: [fromAi.id] });
    const replay = await call<{ state: string }>('U_CHAIRMAN', 'POST', `/v1/proposals/${fromAi.id}/confirm`, { via: 'touch' }, { 'idempotency-key': key });
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(ok.body);
    // Hoàn tác trong cửa 30 giây qua HTTP.
    const undone = await call<ProposalView>('U_CHAIRMAN', 'POST', `/v1/proposals/${fromAi.id}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.body.state).toBe('undone');
    const late = await call<{ code: string }>('U_CHAIRMAN', 'POST', `/v1/proposals/${fromAi.id}/undo`);
    expect(late.status).toBe(200); // hoàn tác lần hai: cùng trạng thái
    expect((await call<ProposalView>('U_CHAIRMAN', 'POST', `/v1/proposals/${fromOffice}/reject`, { reason: 'Để sau' })).body.state).toBe('rejected');
  });

  it('điều 7 và 10 qua HTTP: mức 2 thiếu X-Step-Up-Token bị 403 step_up_required; giọng nói bị từ chối; không có Gửi ngay', async () => {
    const res = await tool('U_CHAIRMAN', 'propose_cancel_run', { runId, reason: 'Đoàn hoãn chuyến thăm' });
    const id = res.proposals![0]!.proposalId;
    expect(res.proposals![0]).toMatchObject({ risk: 2, batchId: null });

    const missing = await call<{ code: string }>('U_CHAIRMAN', 'POST', `/v1/proposals/${id}/confirm`, { via: 'touch' });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('step_up_required');
    const voice = await call<{ code: string }>('U_CHAIRMAN', 'POST', `/v1/proposals/${id}/confirm`, { via: 'voice', transcript: 'đồng ý', sttConfidence: 0.99 });
    expect(voice.status).toBe(422);
    const stepUp = (await signToken('stepup', { sub: ids.users.U_CHAIRMAN, org: ids.ORG }, 60)).token;
    const ok = await call<{ state: string }>('U_CHAIRMAN', 'POST', `/v1/proposals/${id}/confirm`, { via: 'touch' }, { 'x-step-up-token': stepUp });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('confirmed');
    const sendNow = await call<{ code: string }>('U_CHAIRMAN', 'POST', `/v1/proposals/${id}/send-now`);
    expect(sendNow.status).toBe(409);
    // Hoàn tác để lượt chạy còn nguyên cho các test sau.
    expect((await call<ProposalView>('U_CHAIRMAN', 'POST', `/v1/proposals/${id}/undo`)).body.state).toBe('undone');
    expect((await scenario.run(runId)).state).toBe('running');
  });
});

describe('giao diện nội bộ /internal/v1 (SPEC 10.7.1)', () => {
  it('chỉ nhận service token; phiên người dùng và token phiên Scribe đều bị từ chối', async () => {
    const session = await scribeSession('U_CHAIRMAN');
    const cookie = await call<unknown>('U_CHAIRMAN', 'POST', '/internal/v1/tools/get_overview', { args: { scope: 'all' } });
    expect(cookie.status).toBe(401);
    const targets: [RouteDef['method'], string, unknown][] = [
      ['POST', '/internal/v1/tools/get_overview', { args: { scope: 'all' } }],
      ['POST', `/internal/v1/scribe/sessions/${session.sessionId}/claim`, { jti: session.sessionId }],
      ['POST', '/internal/v1/messages', { conversationId: session.conversationId, role: 'user', content: 'x' }],
      ['POST', '/internal/v1/scribe/usage', { conversationId: session.conversationId, llmCalls: 1 }],
      ['GET', '/internal/v1/jwks', undefined],
    ];
    for (const [method, url, body] of targets) {
      for (const auth of [undefined, 'Bearer sai-token', `Bearer ${session.token}`]) {
        const res = await raw(method, url, { ...(auth ? { authorization: auth } : {}), 'x-org-id': ids.ORG, 'x-on-behalf-of': ids.users.U_CHAIRMAN }, body);
        expect(res.status, `${method} ${url} với ${auth ?? 'không token'}`).toBe(401);
      }
    }
  });

  it('tool chạy thay đúng người ở X-On-Behalf-Of, trong đúng tổ chức ở X-Org-Id', async () => {
    const overdue = await tool('U_CHAIRMAN', 'list_overdue_steps', {});
    expect(overdue).toMatchObject({ ok: true, result: { count: 2 } });
    // Người không dùng được trợ lý: tool trả lỗi, không lộ dữ liệu.
    expect(await tool('U_LAN', 'list_overdue_steps', {})).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    // Thiếu header, id sai dạng, người của tổ chức khác, tổ chức không tồn tại.
    expect((await raw('POST', '/internal/v1/tools/get_overview', service(), { args: { scope: 'all' } })).status).toBe(422);
    expect((await raw('POST', '/internal/v1/tools/get_overview', service({ 'x-on-behalf-of': 'khong-phai-id' }), { args: { scope: 'all' } })).status).toBe(422);
    const foreign = await raw('POST', '/internal/v1/tools/get_overview', service({ 'x-on-behalf-of': other.users.U_CHAIRMAN }), { args: { scope: 'all' } });
    expect(foreign.status).toBe(403);
    const noOrg = await raw('POST', '/internal/v1/tools/get_overview', { authorization: `Bearer ${env.internalServiceToken}`, 'x-org-id': newId(), 'x-on-behalf-of': ids.users.U_CHAIRMAN }, { args: { scope: 'all' } });
    expect(noOrg.status).toBe(404);
    // Chủ tịch của tổ chức khác không thấy lượt chạy của tổ chức này.
    const cross = await raw('POST', '/internal/v1/tools/get_run', { authorization: `Bearer ${env.internalServiceToken}`, 'x-org-id': other.ORG, 'x-on-behalf-of': other.users.U_CHAIRMAN }, { args: { runId } });
    expect(cross.status).toBe(200);
    expect(cross.body).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('khoá công khai kiểm được token phiên; claim dùng một lần; messages và usage đi qua giao diện nội bộ', async () => {
    const session = await scribeSession('U_CHAIRMAN');
    expect(session.wsUrl).toBe(env.publicScribeWsUrl);

    const jwks = await raw('GET', '/internal/v1/jwks', service());
    expect(jwks.status).toBe(200);
    const [jwk] = (jwks.body as unknown as { keys: JWK[] }).keys;
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    const { payload } = await jwtVerify(session.token, await importJWK(jwk!, 'ES256'), { algorithms: ['ES256'], currentDate: vn('2026-10-08T09:05') });
    expect(payload).toMatchObject({ sub: ids.users.U_CHAIRMAN, org: ids.ORG, scope: 'scribe', jti: session.sessionId });

    const claimUrl = `/internal/v1/scribe/sessions/${session.sessionId}/claim`;
    const claim = await raw('POST', claimUrl, service(), { jti: session.sessionId });
    expect(claim.status).toBe(200);
    const body = claim.body as unknown as InternalClaimResponse;
    expect(body).toMatchObject({ userId: ids.users.U_CHAIRMAN, orgId: ids.ORG, conversationId: session.conversationId, channel: 'text', user: { roleTitle: 'Chủ tịch', honorific: 'ông' } });
    expect(body.quotaLeft).toBe(200);
    const again = await raw('POST', claimUrl, service(), { jti: session.sessionId });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('state_conflict');
    // Claim dưới tổ chức khác: không thấy phiên.
    expect((await raw('POST', claimUrl, { authorization: `Bearer ${env.internalServiceToken}`, 'x-org-id': other.ORG }, { jti: session.sessionId })).status).toBe(404);

    const message = await raw('POST', '/internal/v1/messages', service(), { conversationId: session.conversationId, role: 'user', content: { text: 'tình hình đón đoàn Nhật thế nào' }, sttConfidence: 0.9 });
    expect(message.status).toBe(200);
    expect(message.body).toEqual({ ok: true });
    const usage = await raw('POST', '/internal/v1/scribe/usage', service(), { conversationId: session.conversationId, llmCalls: 2, llmInputTokens: 900, llmOutputTokens: 120 });
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual({ quotaLeft: 198 });

    // Nút xoá lịch sử hội thoại ở M7 và báo cáo đầu ngày.
    const deleted = await call<{ ok: boolean }>('U_CHAIRMAN', 'DELETE', '/v1/conversations');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    const messagesLeft = await withOrg(ids.ORG, (tx) => tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages`));
    expect(messagesLeft.rows[0]!.n).toBe(0);
    const briefing = await app.inject({ method: 'GET', url: '/v1/briefings/latest', headers: { authorization: 'Bearer x' } });
    expect(briefing.statusCode).toBe(401);
    // Chưa có báo cáo của hôm nay thì dựng ngay (docs/DECISIONS.md, 05/10/2026); lần sau trả đúng bản đó.
    const built = await call<{ id: string; sections: { key: string }[] }>('U_CHAIRMAN', 'GET', '/v1/briefings/latest');
    expect(built.status).toBe(200);
    expect(built.body.sections.map((x) => x.key)).toEqual(['open', 'completed', 'due']);
    expect((await call<{ id: string }>('U_CHAIRMAN', 'GET', '/v1/briefings/latest')).body.id).toBe(built.body.id);
    expect((await call<unknown>('U_LAN', 'GET', '/v1/briefings/latest')).status).toBe(403);
  });
});
