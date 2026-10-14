import { ApiError, PG_NOTIFY_CHANNEL, StreamEventSchema, TEMPLATE_VIEW_ACTIONS, can, canAny, type StreamEvent } from '@mihato/domain';
import { env, loadOrgContext, mfaPending, viewerSeesRun, withOrg, type Viewer } from '@mihato/backend';
import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { authenticate } from './registrar';

/**
 * SSE cho web (SPEC 10.8). Sự kiện chỉ mang id, không mang dữ liệu; client nhận rồi làm mới truy vấn.
 * Mỗi bản api giữ một kết nối LISTEN riêng (kết nối phiên, không qua PgBouncer chế độ giao dịch) và chỉ
 * gửi cho người đang nối có quyền xem lượt chạy đó. Không phát lại sự kiện đã lỡ [QUYẾT ĐỊNH].
 */
type Client = { viewer: Viewer; reply: FastifyReply; seesAll: boolean; visible: Map<string, { ok: boolean; at: number }> };

const clients = new Set<Client>();
let listener: pg.Client | null = null;
let connecting = false;

async function canSee(client: Client, e: StreamEvent): Promise<boolean> {
  // Mọi bên phát đều gắn orgId; thiếu thì từ chối thay vì coi là của mọi tổ chức.
  if (!e.orgId || e.orgId !== client.viewer.orgId) return false;
  if (e.kind === 'notification.created' || e.kind === 'proposal.updated') return e.userId === client.viewer.id;
  if (e.kind === 'template.updated') return canAny(client.viewer, TEMPLATE_VIEW_ACTIONS);
  if (!e.runId) return false;
  const hit = client.visible.get(e.runId);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  // Một nguồn sự thật với mọi đường đọc: runVisibility (views.ts). Người có `run.view_all` cũng phải qua đây vì lượt mật
  // (văn bản mật) không mở cho họ nếu họ không phải chủ sở hữu, người tham gia hay người được chia sẻ (docs/DECISIONS.md, 07/10/2026).
  const ok = await withOrg(client.viewer.orgId, async (tx) => viewerSeesRun(tx, await loadOrgContext(tx, client.viewer.orgId), client.viewer, e.runId!)).catch(() => false);
  client.visible.set(e.runId, { ok, at: Date.now() });
  return ok;
}

function write(client: Client, event: string, data: unknown): void {
  client.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function dispatch(payload: string): Promise<void> {
  let parsed: StreamEvent;
  try {
    parsed = StreamEventSchema.parse(JSON.parse(payload));
  } catch {
    return;
  }
  const { orgId: _org, userId: _user, ...publicEvent } = parsed;
  for (const client of clients) {
    if (await canSee(client, parsed)) write(client, parsed.kind, publicEvent);
  }
}

async function ensureListener(app: FastifyInstance): Promise<void> {
  if (listener || connecting) return;
  connecting = true;
  try {
    const c = new pg.Client({ connectionString: env.databaseUrl });
    c.on('notification', (msg) => {
      if (msg.channel === PG_NOTIFY_CHANNEL && msg.payload) void dispatch(msg.payload);
    });
    c.on('error', () => {
      listener = null;
      setTimeout(() => void ensureListener(app), 2000);
    });
    await c.connect();
    await c.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);
    listener = c;
  } catch {
    setTimeout(() => void ensureListener(app), 2000);
  } finally {
    connecting = false;
  }
}

export function registerStream(app: FastifyInstance): void {
  void ensureListener(app);
  const ping = setInterval(() => {
    for (const c of clients) write(c, 'ping', {});
  }, 20_000);
  ping.unref();

  app.get('/v1/stream', { config: { routeKey: 'stream', rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const viewer = await authenticate(req);
    req.viewer = viewer;
    if (mfaPending(viewer)) throw new ApiError('mfa_required');
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // reply.hijack() bỏ qua header của helmet nên đặt tay những header cần cho luồng này.
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': env.webOrigin,
      'Access-Control-Allow-Credentials': 'true',
    });
    const client: Client = { viewer, reply, seesAll: can(viewer, 'run.view_all'), visible: new Map() };
    clients.add(client);
    write(client, 'ping', {});
    req.raw.on('close', () => clients.delete(client));
  });

  app.addHook('onClose', async () => {
    clearInterval(ping);
    for (const c of clients) c.reply.raw.end();
    clients.clear();
    const l = listener;
    listener = null;
    if (l) await l.end().catch(() => {});
  });
}
