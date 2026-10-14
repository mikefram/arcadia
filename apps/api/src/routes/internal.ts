import { ApiError } from '@mihato/domain';
import {
  claimScribeSession,
  env,
  executeTool,
  loadOrgContext,
  recordMessage,
  recordUsage,
  safeEqual,
  scribePublicJwk,
  sql,
  viewerForUser,
  withOrg,
  type OrgContext,
  type Tx,
} from '@mihato/backend';
import type { FastifyRequest } from 'fastify';
import type { Registrar } from '../registrar';

/**
 * Giao diện nội bộ `/internal/v1/*` (SPEC 10.7.1). Không đưa ra Internet ở reverse proxy; chỉ nhận service token
 * của `ai_service` (registrar kiểm với mọi route `auth: 'service'`). Dịch vụ scribe không truy cập CSDL nên mọi dữ liệu đi qua đây.
 *
 * Mỗi lời gọi kèm `X-Org-Id` (tổ chức, lấy từ claim `org` của token phiên) và, với tool, `X-On-Behalf-Of` (người dùng).
 * Handler tự mở giao dịch có `app.org_id` nên RLS vẫn chặn chéo tổ chức, và tool chạy dưới đúng tầm nhìn của người đó.
 * KHÔNG có route nào ở đây ghi trực tiếp lên lượt chạy: tool `propose_*` chỉ tạo `proposals` (CLAUDE.md luật 3).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function requiredId(req: FastifyRequest, name: string): string {
  const v = headerOf(req, name);
  if (!v || !UUID_RE.test(v)) throw new ApiError('input_invalid', { errors: [{ path: `headers.${name}`, code: v ? 'invalid' : 'required' }] });
  return v.toLowerCase();
}

function optionalId(req: FastifyRequest, name: string): string | undefined {
  const v = headerOf(req, name);
  if (v === undefined || v === '') return undefined;
  return requiredId(req, name);
}

/** Giao dịch của một tổ chức kèm ngữ cảnh. Tổ chức không tồn tại thì 404 thay vì lỗi máy chủ. */
function inOrg<T>(orgId: string, fn: (tx: Tx, ctx: OrgContext) => Promise<T>): Promise<T> {
  return withOrg(orgId, async (tx) => {
    const found = await tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${orgId}`);
    if (found.rows.length === 0) throw new ApiError('not_found');
    return fn(tx, await loadOrgContext(tx, orgId));
  });
}

export function registerInternalRoutes(r: Registrar): void {
  r.open('internal.tool', ({ input, req }) => {
    const orgId = requiredId(req, 'x-org-id');
    const userId = requiredId(req, 'x-on-behalf-of');
    return inOrg(orgId, async (tx, ctx) => {
      // Viewer dựng từ CSDL với vai trò HIỆN TẠI của người đó; người đã bị vô hiệu hoá thì không chạy được tool nào.
      const viewer = viewerForUser(ctx, userId);
      if (!viewer) throw new ApiError('forbidden');
      return executeTool(tx, ctx, viewer, input.params.name, input.body.args, { conversationId: input.body.conversationId });
    });
  });

  r.open('internal.claim', ({ input, req }) => inOrg(requiredId(req, 'x-org-id'), (tx, ctx) => claimScribeSession(tx, ctx, input.params.id, input.body.jti)));

  r.open('internal.message', ({ input, req }) =>
    inOrg(requiredId(req, 'x-org-id'), async (tx, ctx) => {
      await recordMessage(tx, ctx, input.body, { onBehalfOf: optionalId(req, 'x-on-behalf-of') });
      return { ok: true as const };
    }),
  );

  r.open('internal.usage', ({ input, req }) => inOrg(requiredId(req, 'x-org-id'), (tx, ctx) => recordUsage(tx, ctx, input.body, { onBehalfOf: optionalId(req, 'x-on-behalf-of') })));

  // Khoá công khai để scribe kiểm chữ ký token phiên (ES256). Route ngoài bảng hợp đồng nên tự kiểm service token.
  r.app.get('/internal/v1/jwks', async (req) => {
    const auth = headerOf(req, 'authorization');
    if (!auth?.startsWith('Bearer ') || !safeEqual(auth.slice(7), env.internalServiceToken)) throw new ApiError('unauthenticated');
    return { keys: [await scribePublicJwk()] };
  });
}
