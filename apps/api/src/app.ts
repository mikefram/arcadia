import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ApiError, routes, type RouteKey } from '@mihato/domain';
import { env, getDb, sql } from '@mihato/backend';
import Fastify, { type FastifyInstance } from 'fastify';
import { createRegistrar, problemOf } from './registrar';
import { registerAllRoutes } from './routes';
import { registerStream } from './sse';

export type BuildOptions = {
  /** test tắt log */
  quiet?: boolean;
  /** `false` tắt giới hạn tần suất; `true` bật cả khi chạy test; bỏ trống thì bật trừ khi chạy test */
  rateLimit?: boolean;
  /** ghi đè TRUST_PROXY (dùng trong test): số bước nhảy, danh sách IP/CIDR, hoặc 'loopback' */
  trustProxy?: TrustProxy | number;
  /** test không mở kết nối LISTEN */
  stream?: boolean;
};

export type TrustProxy = boolean | string | string[] | ((addr: string, hop: number) => boolean);

/** Tin `hops` bước nhảy kể từ kết nối trực tiếp: Fastify 5 không nhận số (số bị coi là không tin ai), nên tự dựng hàm. */
const trustHops = (hops: number) => (_addr: string, hop: number) => hop < hops;

/**
 * Cấu hình tin proxy từ biến TRUST_PROXY (SPEC 11): số bước nhảy ('1'), danh sách IP hoặc CIDR phân tách bằng dấu phẩy,
 * 'loopback', 'true' hoặc 'false'. Số bước nhảy chỉ an toàn khi API chỉ nhận kết nối qua reverse proxy (không mở cổng
 * API ra ngoài); nếu không chắc, dùng danh sách IP/CIDR của proxy. Mặc định ở production là 1 bước (một reverse proxy đứng ngay trước API), không phải
 * `true` (tin mọi bước nhảy làm req.ip lấy được giá trị client tự ghi trong X-Forwarded-For); ngoài production là 'loopback'.
 */
export function parseTrustProxy(raw: string | undefined, isProd: boolean): TrustProxy {
  const v = raw?.trim();
  if (!v) return isProd ? trustHops(1) : 'loopback';
  if (v === 'true') return true;
  if (v === 'false' || v === '0') return false;
  if (/^\d+$/.test(v)) return trustHops(Number(v));
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  return list.length === 1 ? list[0]! : list;
}

/**
 * Một API REST duy nhất, tiền tố /v1 (SPEC 10). Nhật ký có cấu trúc chỉ gồm id, tuyến, mã trạng thái,
 * thời gian xử lý: không có nội dung câu nói, tên việc hay số tiền (SPEC 12.4, CLAUDE.md luật 6).
 */
export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.quiet ? false : { level: 'info' },
    disableRequestLogging: true,
    trustProxy: typeof opts.trustProxy === 'number' ? trustHops(opts.trustProxy) : (opts.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY, env.isProd)),
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      const v = Array.isArray(h) ? h[0] : h;
      return v && /^[\w-]{8,64}$/.test(v) ? v : crypto.randomUUID();
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  // Header bảo mật cho API JSON (không phục vụ trang): CSP chặt nhất, không cho nhúng khung, không gửi Referer, không đoán loại nội dung.
  // Tệp tải xuống là `attachment` nên CSP `default-src 'none'` không ảnh hưởng. HSTS chỉ ở production.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    hsts: env.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    // Web gọi API khác nguồn bằng CORS; CORP chỉ ảnh hưởng yêu cầu no-cors nên tắt để không gây lỗi khó đoán.
    crossOriginResourcePolicy: false,
  });
  await app.register(cors, {
    origin: [env.webOrigin, ...env.corsExtraOrigins],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-CSRF-Token', 'X-Step-Up-Token', 'X-Request-Id', 'X-App-Version', 'X-Platform'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay', 'Retry-After', 'ETag'],
  });
  const rateLimitOn = opts.rateLimit === true || (opts.rateLimit !== false && !env.isTest);
  if (rateLimitOn) {
    await app.register(rateLimit, {
      max: 120,
      timeWindow: '1 minute',
      // Khoá luôn là IP (đã qua TRUST_PROXY). Không bao giờ lấy từ header Authorization hay cookie do client tự đặt, vì đổi
      // header mỗi yêu cầu sẽ né giới hạn. Giới hạn theo người dùng nằm ở registrar, sau khi xác thực.
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: (_req, ctx) => new ApiError('rate_limited', { detail: `retry after ${ctx.after}` }),
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  app.addHook('onResponse', async (req, reply) => {
    if (opts.quiet) return;
    req.log.info({
      requestId: req.id,
      orgId: req.viewer?.orgId,
      userId: req.viewer?.id,
      route: req.routeOptions.config.routeKey ?? req.routeOptions.url,
      method: req.method,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler((err, req, reply) => {
    let apiErr: ApiError | null = err instanceof ApiError ? err : null;
    const fe = err as { statusCode?: number; code?: string };
    if (!apiErr && fe.statusCode === 429) apiErr = new ApiError('rate_limited');
    if (!apiErr && typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) apiErr = new ApiError('input_invalid', { status: fe.statusCode });
    if (!apiErr) {
      // Chỉ ghi tên lỗi và mã, không ghi thông điệp có thể chứa dữ liệu người dùng.
      if (!opts.quiet) req.log.error({ requestId: req.id, errName: (err as Error).name, errCode: fe.code, route: req.routeOptions?.config?.routeKey });
      else if (env.isTest) console.error(err);
    }
    const problem = problemOf(apiErr ?? err, req.id);
    if (problem.status === 429) reply.header('Retry-After', '60');
    return reply.status(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).type('application/problem+json').send(problemOf(new ApiError('not_found'), req.id)));

  // Kiểm sức khoẻ: không trả chi tiết (SPEC 12.4).
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      const res = await getDb().execute<{ beat_at: string | null }>(sql`select max(beat_at) as beat_at from worker_heartbeats`);
      const beat = res.rows[0]?.beat_at ? new Date(res.rows[0].beat_at) : null;
      const workerOk = !!beat && Date.now() - beat.getTime() < 2 * 60_000;
      // CSDL trả lời được (truy vấn đã chạy) tách khỏi worker còn nhịp tim: người trực biết cái nào chết, không lộ chi tiết khác.
      return reply.status(workerOk ? 200 : 503).send({ ok: workerOk, db: true, worker: workerOk });
    } catch {
      return reply.status(503).send({ ok: false, db: false, worker: false });
    }
  });

  const registrar = createRegistrar(app, { rateLimit: rateLimitOn });
  registerAllRoutes(registrar);
  if (opts.stream !== false) registerStream(app);

  const missing = (Object.keys(routes) as RouteKey[]).filter((k) => !registrar.registered.has(k));
  if (missing.length && !opts.quiet) app.log.warn({ missingRoutes: missing }, 'Route có trong hợp đồng nhưng chưa có handler');
  app.decorate('missingRoutes', missing);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    missingRoutes: RouteKey[];
  }
}
