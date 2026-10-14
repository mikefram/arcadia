import { createHash } from 'node:crypto';
import {
  ApiError,
  ERROR_CODES,
  can,
  requiresIdempotencyKey,
  routes,
  type Problem,
  type RouteDef,
  type RouteInput,
  type RouteKey,
  type RouteResponse,
} from '@mihato/domain';
import {
  authenticateBearer,
  authenticateCookie,
  MFA_SETUP_ROUTES,
  mfaPending,
  clock,
  loadOrgContext,
  safeEqual,
  schema,
  withOrg,
  env,
  type OrgContext,
  type RequestMeta,
  type Tx,
  type Viewer,
} from '@mihato/backend';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

export const SESSION_COOKIE = 'mihato_session';
export const CSRF_COOKIE = 'mihato_csrf';

/** Ngữ cảnh của một handler đã xác thực: chạy trong MỘT giao dịch đã đặt app.org_id. */
export type UserHandlerCtx<K extends RouteKey> = {
  input: RouteInput<K>;
  /** thân yêu cầu trước khi Zod điền mặc định: dùng cho PATCH để chỉ áp các khoá người gọi thật sự gửi */
  rawBody: Record<string, unknown>;
  viewer: Viewer;
  tx: Tx;
  ctx: OrgContext;
  /** Idempotency-Key của yêu cầu; với thao tác trên lượt chạy đây chính là eventId (SPEC 10.1) */
  idempotencyKey: string;
  stepUpToken: string | undefined;
  ifMatch: string | undefined;
  meta: RequestMeta;
  req: FastifyRequest;
  reply: FastifyReply;
};

/** Handler không cần đăng nhập (đăng nhập, kích hoạt thiết bị) hoặc của dịch vụ nội bộ: tự mở giao dịch. */
export type OpenHandlerCtx<K extends RouteKey> = {
  input: RouteInput<K>;
  meta: RequestMeta;
  req: FastifyRequest;
  reply: FastifyReply;
};

type UserKeys = { [K in RouteKey]: (typeof routes)[K]['auth'] extends 'user' ? K : never }[RouteKey];
type OpenKeys = Exclude<RouteKey, UserKeys>;

export type Registrar = {
  /** Đăng ký handler cho một route `auth: 'user'` trong bảng hợp đồng. */
  user<K extends UserKeys>(key: K, handler: (c: UserHandlerCtx<K>) => Promise<RouteResponse<K>>): void;
  /** Đăng ký handler cho route `auth: 'none'` hoặc `auth: 'service'`. */
  open<K extends OpenKeys>(key: K, handler: (c: OpenHandlerCtx<K>) => Promise<RouteResponse<K>>): void;
  app: FastifyInstance;
  registered: Set<RouteKey>;
};

export function problemOf(err: unknown, requestId: string): Problem {
  if (err instanceof ApiError) {
    const { detail: _detail, ...extra } = err.extra;
    return {
      type: `https://mihato.local/problems/${err.code}`,
      title: err.code,
      status: err.status,
      code: err.code,
      requestId,
      ...extra,
    };
  }
  return { type: 'https://mihato.local/problems/internal_error', title: 'internal_error', status: 500, code: 'internal_error', requestId };
}

function zodProblem(err: z.ZodError, where: string): ApiError {
  return new ApiError('input_invalid', {
    errors: err.issues.slice(0, 50).map((i) => ({ path: [where, ...i.path].join('.'), code: i.code })),
  });
}

function parsePart<T>(schemaDef: z.ZodType | undefined, value: unknown, where: string): T {
  if (!schemaDef) return undefined as T;
  const res = schemaDef.safeParse(value ?? (where === 'body' ? {} : {}));
  if (!res.success) throw zodProblem(res.error, where);
  return res.data as T;
}

export function requestMeta(req: FastifyRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Xác thực người dùng: bearer (app) hoặc cookie phiên kèm X-CSRF-Token (web). */
export async function authenticate(req: FastifyRequest): Promise<Viewer> {
  const auth = header(req, 'authorization');
  if (auth?.startsWith('Bearer ')) return authenticateBearer(auth.slice(7));
  const cookie = req.cookies[SESSION_COOKIE];
  if (cookie) return authenticateCookie(cookie, { csrfHeader: header(req, 'x-csrf-token'), isWrite: req.method !== 'GET' && req.method !== 'HEAD' });
  throw new ApiError('unauthenticated');
}

export function assertPermission(def: RouteDef, viewer: Viewer): void {
  if (def.permission && !can(viewer, def.permission)) throw new ApiError('forbidden');
  if (def.anyPermission && !def.anyPermission.some((a) => can(viewer, a))) throw new ApiError('forbidden');
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_IN_PROGRESS_MS = 60_000;

type Stored = { status: number; body: unknown };

/**
 * Chống lặp (SPEC 10.1): cùng khoá và cùng thân thì trả đúng phản hồi cũ kèm `Idempotent-Replay: true`;
 * cùng khoá khác thân thì 422 idempotency_key_reuse; đang xử lý thì 409 request_in_progress.
 */
async function beginIdempotent(viewer: Viewer, key: string, req: FastifyRequest, requestHash: Buffer): Promise<Stored | null> {
  return withOrg(viewer.orgId, async (tx) => {
    const inserted = await tx
      .insert(schema.idempotencyKeys)
      .values({ orgId: viewer.orgId, userId: viewer.id, key, method: req.method, path: req.url.split('?')[0]!, requestHash, state: 'in_progress', createdAt: clock.now() })
      .onConflictDoNothing()
      .returning({ key: schema.idempotencyKeys.key });
    if (inserted.length) return null;
    const where = and(eq(schema.idempotencyKeys.orgId, viewer.orgId), eq(schema.idempotencyKeys.userId, viewer.id), eq(schema.idempotencyKeys.key, key));
    const [row] = await tx.select().from(schema.idempotencyKeys).where(where).for('update');
    if (!row) return null;
    if (!row.requestHash.equals(requestHash)) throw new ApiError('idempotency_key_reuse');
    if (row.state === 'done') return { status: row.responseStatus ?? 200, body: row.responseBody };
    if (clock.now().getTime() - row.createdAt.getTime() < STALE_IN_PROGRESS_MS) throw new ApiError('request_in_progress');
    // Lần trước chết giữa chừng: nhận lại khoá. eventId trùng nên hiệu lực vẫn chỉ xảy ra một lần.
    await tx.update(schema.idempotencyKeys).set({ createdAt: clock.now() }).where(where);
    return null;
  });
}

async function finishIdempotent(viewer: Viewer, key: string, stored: Stored | null): Promise<void> {
  await withOrg(viewer.orgId, async (tx) => {
    const where = and(eq(schema.idempotencyKeys.orgId, viewer.orgId), eq(schema.idempotencyKeys.userId, viewer.id), eq(schema.idempotencyKeys.key, key));
    if (stored) await tx.update(schema.idempotencyKeys).set({ state: 'done', responseStatus: stored.status, responseBody: stored.body }).where(where);
    else await tx.delete(schema.idempotencyKeys).where(where);
  });
}

/** Giới hạn tần suất theo IP cho route chưa đăng nhập: đăng nhập và TOTP chặt, phần còn lại vừa phải. */
const LOGIN_MAX_PER_MIN = 10;
const OPEN_MAX_PER_MIN = 60;
/** Trần thô theo IP cho route đã đăng nhập (nhiều người cùng một IP văn phòng); giới hạn chính theo người dùng, xem UserLimiter. */
const USER_ROUTE_IP_MAX_PER_MIN = 3000;
// Một người dùng cùng lúc có web nhiều thẻ, hai app và trợ lý, nên trần theo người (cộng dồn mọi phiên) rộng hơn trần 120 mỗi phiên trước đây;
// các route đoán bí mật có trần riêng chặt ở dưới. Đổi từ 120 lên 600 sau khi bộ test giao diện (nhiều phiên cùng tài khoản) chạm trần cũ.
const USER_MAX_PER_MIN = 600;
/** Các route đoán được bí mật (mật khẩu, TOTP) có trần riêng theo người dùng, ngoài bộ đếm sai và khoá tạm ở service. */
const SECOND_FACTOR_ROUTES: ReadonlySet<string> = new Set(['auth.stepUp', 'auth.totpSetup', 'auth.totpEnable']);
const SECOND_FACTOR_MAX_PER_MIN = 10;

/**
 * Giới hạn theo người dùng ĐÃ XÁC THỰC (viewer.id), chạy sau authenticate nên không dùng được header do client tự đặt.
 * Cửa sổ cố định một phút trong bộ nhớ của mỗi bản api; đủ để chặn dò mật khẩu, TOTP và lạm dụng phiên.
 */
export class UserLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  /** true nếu còn trong hạn mức */
  allow(key: string, max: number): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { n: 1, resetAt: t + 60_000 });
      return true;
    }
    cur.n += 1;
    return cur.n <= max;
  }
}

export type RegistrarOptions = { rateLimit?: boolean };

export function createRegistrar(app: FastifyInstance, opts: RegistrarOptions = {}): Registrar {
  const registered = new Set<RouteKey>();
  const userLimiter = new UserLimiter();

  /**
   * Cấu hình giới hạn theo route cho plugin rate-limit (khoá luôn là req.ip, xem app.ts). Route `none` luôn theo IP;
   * route `service` (scribe, một token chung) không giới hạn ở đây vì đã có hạn mức AI theo người.
   */
  function rateLimitConfig(def: RouteDef) {
    if (def.auth === 'service') return false as const;
    if (def.auth === 'none') {
      const strict = def.path.startsWith('/v1/auth/login') || def.path.startsWith('/v1/auth/mfa');
      return { max: strict ? LOGIN_MAX_PER_MIN : OPEN_MAX_PER_MIN, timeWindow: '1 minute' };
    }
    return { max: USER_ROUTE_IP_MAX_PER_MIN, timeWindow: '1 minute' };
  }

  function mount(key: RouteKey, run: (req: FastifyRequest, reply: FastifyReply, def: RouteDef) => Promise<unknown>) {
    const def: RouteDef = routes[key];
    if (registered.has(key)) throw new Error(`Route ${key} đã được đăng ký`);
    registered.add(key);
    app.route({
      method: def.method,
      url: def.path,
      ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
      config: { routeKey: key, rateLimit: rateLimitConfig(def) },
      handler: async (req, reply) => {
        const body = await run(req, reply, def);
        if (reply.sent) return reply;
        return reply.status(reply.statusCode === 200 ? (def.status ?? 200) : reply.statusCode).send(body ?? null);
      },
    });
  }

  return {
    app,
    registered,
    user(key, handler) {
      mount(key, async (req, reply, def) => {
        const viewer = await authenticate(req);
        req.viewer = viewer;
        if (opts.rateLimit) {
          const second = SECOND_FACTOR_ROUTES.has(key);
          if (!userLimiter.allow(`${viewer.orgId}:${viewer.id}:${second ? key : '*'}`, second ? SECOND_FACTOR_MAX_PER_MIN : USER_MAX_PER_MIN)) throw new ApiError('rate_limited');
        }
        // Vai trò bắt buộc TOTP mà chưa bật (SPEC 11.2): chỉ được bật TOTP, xem hồ sơ, đăng xuất.
        if (mfaPending(viewer) && !MFA_SETUP_ROUTES.has(key)) throw new ApiError('mfa_required');
        assertPermission(def, viewer);
        const input = {
          params: parsePart(def.params, req.params, 'params'),
          query: parsePart(def.query, req.query, 'query'),
          body: parsePart(def.body, req.body, 'body'),
        } as RouteInput<typeof key>;
        const rawBody = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
        const needsKey = requiresIdempotencyKey(def);
        const idemHeader = header(req, 'idempotency-key');
        if (needsKey && (!idemHeader || !UUID_RE.test(idemHeader))) throw new ApiError('idempotency_key_required');
        const idempotencyKey = (idemHeader && UUID_RE.test(idemHeader) ? idemHeader : crypto.randomUUID()).toLowerCase();

        const exec = () =>
          withOrg(viewer.orgId, async (tx) => {
            const ctx = await loadOrgContext(tx, viewer.orgId);
            // App quá cũ so với organizations.settings.minAppVersion thì 426 (SPEC 10.1).
            const appVersion = header(req, 'x-app-version');
            if (appVersion && ctx.settings.minAppVersion && compareVersions(appVersion, ctx.settings.minAppVersion) < 0) throw new ApiError('app_update_required');
            return handler({
              input,
              rawBody,
              viewer,
              tx,
              ctx,
              idempotencyKey,
              stepUpToken: header(req, 'x-step-up-token'),
              ifMatch: header(req, 'if-match'),
              meta: requestMeta(req),
              req,
              reply,
            });
          });

        if (!needsKey) return exec();

        const requestHash = createHash('sha256')
          .update(JSON.stringify(req.body ?? null))
          .digest();
        const replay = await beginIdempotent(viewer, idempotencyKey, req, requestHash);
        if (replay) {
          reply.header('Idempotent-Replay', 'true');
          if (replay.status >= 400) reply.type('application/problem+json');
          reply.status(replay.status);
          return replay.body;
        }
        try {
          const body = await exec();
          await finishIdempotent(viewer, idempotencyKey, { status: def.status ?? 200, body: body ?? null });
          return body;
        } catch (err) {
          // Lỗi nghiệp vụ (4xx) cũng là phản hồi được lưu; lỗi máy chủ thì nhả khoá để gửi lại được.
          const stored = err instanceof ApiError && err.status < 500 ? { status: err.status, body: problemOf(err, req.id) } : null;
          await finishIdempotent(viewer, idempotencyKey, stored).catch(() => {});
          throw err;
        }
      });
    },
    open(key, handler) {
      mount(key, async (req, reply, def) => {
        if (def.auth === 'service') {
          const auth = header(req, 'authorization');
          if (!auth?.startsWith('Bearer ') || !safeEqual(auth.slice(7), env.internalServiceToken)) throw new ApiError('unauthenticated');
        }
        const input = {
          params: parsePart(def.params, req.params, 'params'),
          query: parsePart(def.query, req.query, 'query'),
          body: parsePart(def.body, req.body, 'body'),
        } as RouteInput<typeof key>;
        return handler({ input, meta: requestMeta(req), req, reply });
      });
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    viewer?: Viewer;
  }
  interface FastifyContextConfig {
    routeKey?: string;
  }
}

export { ERROR_CODES };
