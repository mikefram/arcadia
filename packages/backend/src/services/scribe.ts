import { createPrivateKey, createPublicKey } from 'node:crypto';
import { ApiError, HONORIFIC_LABEL, ROLES, UserPrefsSchema, can, newId, type Honorific, type InternalClaimResponse, type ScribeSession } from '@mihato/domain';
import { toLocalDate } from '@mihato/domain/calendar';
import { DEFAULT_ABBREVIATIONS } from '@mihato/domain/vi-normalize';
import { vi } from '@mihato/i18n';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8, type JWK } from 'jose';
import { audit } from '../audit';
import { clock } from '../clock';
import type { OrgContext, UserRecord } from '../context';
import { schema, type Tx } from '../db/client';
import { env } from '../env';
import type { Viewer } from '../views';

/**
 * Phiên AI Scribe và giao diện nội bộ (SPEC 10.7.1). Dịch vụ `scribe` không truy cập CSDL: nó kiểm chữ ký token
 * phiên bằng khoá công khai, rồi gọi `claim`, `messages`, `usage` ở /internal/v1 bằng service token của `ai_service`.
 *
 * Token phiên là JWT ES256 (ký bất đối xứng), sống 120 giây, dùng một lần, mang `sub`, `org`, `device`,
 * `scope: 'scribe'` và `jti` = id phiên. Token này KHÔNG gọi được endpoint công khai nào: API công khai chỉ nhận
 * access token HS256 có `aud = 'access'` hoặc cookie phiên (SPEC 6.5 điều 2).
 */

export const SCRIBE_TOKEN_TTL_S = 120;
export const SCRIBE_SCOPE = 'scribe';

type SigningKey = { privateKey: Awaited<ReturnType<typeof importPKCS8>>; publicJwk: JWK & { kid: string; alg: 'ES256'; use: 'sig' } };
let signingKey: Promise<SigningKey> | null = null;

async function loadSigningKey(): Promise<SigningKey> {
  // Biến môi trường thường chứa "\n" dạng chữ: đổi lại thành xuống dòng thật của PEM.
  const pem = env.scribeJwtPrivateKey.replace(/\\n/g, '\n').trim();
  let privateKey: SigningKey['privateKey'];
  let jwk: JWK;
  if (pem) {
    privateKey = await importPKCS8(pem, 'ES256');
    jwk = await exportJWK(createPublicKey(createPrivateKey(pem)));
  } else {
    // Chỉ ở môi trường phát triển và thử nghiệm: khoá tạm sống theo tiến trình API. Nhiều bản API phải dùng chung khoá ở env.
    if (env.isProd) throw new Error('Thiếu biến môi trường SCRIBE_JWT_PRIVATE_KEY ở môi trường production');
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    jwk = await exportJWK(pair.publicKey);
  }
  const pub: JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const kid = await calculateJwkThumbprint(pub);
  return { privateKey, publicJwk: { ...pub, kid, alg: 'ES256', use: 'sig' } };
}

const getSigningKey = (): Promise<SigningKey> => (signingKey ??= loadSigningKey());

/** Khoá công khai (JWK, kèm `kid`) để dịch vụ scribe kiểm chữ ký token phiên; phát qua `GET /internal/v1/jwks`. */
export async function scribePublicJwk(): Promise<JWK & { kid: string; alg: 'ES256'; use: 'sig' }> {
  return (await getSigningKey()).publicJwk;
}

function assertAiEnabled(ctx: OrgContext): void {
  const ai = ctx.settings.ai;
  if (!ai.enabled || ai.llm === 'off') throw new ApiError('ai_disabled');
}

/** Ngày tính hạn mức: ngày lịch theo giờ Việt Nam. */
const usageDay = (ctx: OrgContext, now: Date) => toLocalDate(now, ctx.calendar);

/** Hạn mức lượt gọi LLM còn lại trong ngày của một người (mặc định 200 mỗi ngày, SPEC 6.11). Không âm. */
export async function aiQuotaLeft(tx: Tx, ctx: OrgContext, userId: string): Promise<number> {
  const [row] = await tx
    .select({ llmCalls: schema.aiUsage.llmCalls })
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), eq(schema.aiUsage.day, usageDay(ctx, clock.now()))));
  return Math.max(0, ctx.settings.ai.dailyCallLimit - (row?.llmCalls ?? 0));
}

/**
 * `POST /v1/scribe/sessions`: tạo `conversations` và `scribe_sessions`, trả token dùng một lần.
 * `transcriptConsent` là kết quả màn đồng ý lần đầu (SPEC 6.8): không đồng ý thì không ghi `messages`.
 */
export async function createScribeSession(tx: Tx, ctx: OrgContext, viewer: Viewer, body: { channel: 'voice' | 'text'; transcriptConsent: boolean }): Promise<ScribeSession> {
  assertAiEnabled(ctx);
  if (!can(viewer, 'assistant.use')) throw new ApiError('forbidden');
  // Tắt STT thì chỉ còn đường gõ chữ (SPEC 11.7): máy chủ không mở phiên giọng nói.
  if (body.channel === 'voice' && ctx.settings.ai.stt === 'off') throw new ApiError('ai_disabled');

  const now = clock.now();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SCRIBE_TOKEN_TTL_S;
  const expiresAt = new Date(exp * 1000);
  const conversationId = newId(now.getTime());
  const sessionId = newId(now.getTime());
  await tx.insert(schema.conversations).values({ id: conversationId, orgId: ctx.orgId, userId: viewer.id, channel: body.channel, transcriptConsent: body.transcriptConsent, startedAt: now });
  await tx.insert(schema.scribeSessions).values({ id: sessionId, orgId: ctx.orgId, userId: viewer.id, deviceId: viewer.deviceId, conversationId, expiresAt, createdAt: now });

  const key = await getSigningKey();
  const token = await new SignJWT({ org: ctx.orgId, device: viewer.deviceId, scope: SCRIBE_SCOPE })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: key.publicJwk.kid })
    .setSubject(viewer.id)
    .setJti(sessionId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key.privateKey);

  await audit(tx, {
    orgId: ctx.orgId,
    action: 'scribe_session_created',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'scribe_session',
    targetId: sessionId,
    detail: { channel: body.channel, transcriptConsent: body.transcriptConsent },
  });
  return { sessionId, conversationId, wsUrl: env.publicScribeWsUrl, token, expiresAt: expiresAt.toISOString() };
}

const honorificOf = (u: UserRecord) => (u.honorific ? HONORIFIC_LABEL[u.honorific as Honorific] : null);
const unitOf = (ctx: OrgContext, u: UserRecord) => (u.unitId ? (ctx.units.get(u.unitId)?.name ?? null) : null);
const roleTitleOf = (u: UserRecord) => {
  const role = ROLES.find((r) => u.roles.some((g) => g.role === r));
  return role ? vi.common.role[role] : '';
};
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const MAX_PEOPLE = 300;
const MAX_TEMPLATES = 50;
const MAX_KEYTERMS = 150;

type TemplateBrief = { name: string; description: string | null };

async function publishedTemplates(tx: Tx): Promise<TemplateBrief[]> {
  const rows = await tx
    .selectDistinct({ id: schema.processTemplates.id, name: schema.processTemplates.name, description: schema.processTemplates.description })
    .from(schema.processTemplates)
    .innerJoin(schema.processTemplateVersions, eq(schema.processTemplateVersions.templateId, schema.processTemplates.id))
    .where(and(isNull(schema.processTemplates.archivedAt), eq(schema.processTemplates.kind, 'process'), eq(schema.processTemplateVersions.status, 'published')));
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'vi')).slice(0, MAX_TEMPLATES);
}

function activePeople(ctx: OrgContext): UserRecord[] {
  return [...ctx.users.values()]
    .filter((u) => u.status !== 'disabled')
    .sort((a, b) => a.displayOrder - b.displayOrder || a.fullName.localeCompare(b.fullName, 'vi'))
    .slice(0, MAX_PEOPLE);
}

/**
 * Khối "theo tổ chức" của lời nhắc hệ thống (SPEC 6.6): danh sách người (tên, xưng hô, đơn vị), mẫu quy trình
 * kèm mô tả ngắn, từ điển viết tắt. Không có id, số điện thoại hay thư điện tử: muốn có id thì trợ lý phải gọi
 * `search_people`, nhờ vậy tên trùng luôn được hỏi lại chứ không bị chọn thay.
 * Cùng dữ liệu thì cùng chuỗi, từng ký tự, để cache prompt của nhà cung cấp còn hiệu lực (TTL 1 giờ).
 */
export function buildOrgPrompt(ctx: OrgContext, templates: TemplateBrief[]): string {
  const people = activePeople(ctx).map((u) => {
    const parts = [[honorificOf(u), u.fullName].filter(Boolean).join(' '), `tên gọi: ${u.givenName}`, unitOf(ctx, u), roleTitleOf(u)].filter(Boolean);
    return `- ${oneLine(parts.join('; '), 200)}`;
  });
  const tpl = templates.map((t) => `- ${oneLine(t.name, 120)}${t.description ? `: ${oneLine(t.description, 200)}` : ''}`);
  const abbrev = Object.entries(DEFAULT_ABBREVIATIONS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- ${k}: ${v}`);
  return [
    `Tổ chức: ${oneLine(ctx.org.name, 120)}`,
    '',
    'Danh sách người (xưng hô và họ tên; tên gọi; đơn vị; chức danh):',
    ...(people.length ? people : ['- (chưa có)']),
    '',
    'Mẫu quy trình đã xuất bản (tên: mô tả ngắn):',
    ...(tpl.length ? tpl : ['- (chưa có)']),
    '',
    'Từ điển viết tắt:',
    ...abbrev,
  ].join('\n');
}

/** Tên người, đơn vị, tên mẫu quy trình gửi làm `keyterm` cho STT (SPEC 6.2). Không trùng, có trần. */
export function buildKeyterms(ctx: OrgContext, templates: TemplateBrief[]): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.replace(/\s+/g, ' ').trim();
    if (t) out.add(t);
  };
  const people = activePeople(ctx);
  for (const u of people) add(u.givenName);
  for (const u of people) add(u.fullName);
  for (const unit of [...ctx.units.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'))) add(unit.name);
  for (const t of templates) add(t.name);
  return [...out].slice(0, MAX_KEYTERMS);
}

/**
 * `POST /internal/v1/scribe/sessions/:id/claim`: đánh dấu token đã dùng. Token dùng một lần: lần hai trả 409.
 * Trả hạn mức còn lại trong ngày, tên và danh xưng người dùng, công tắc AI, keyterm cho STT và khối lời nhắc theo tổ chức.
 */
export async function claimScribeSession(tx: Tx, ctx: OrgContext, sessionId: string, jti: string): Promise<InternalClaimResponse> {
  if (jti !== sessionId) throw new ApiError('input_invalid', { errors: [{ path: 'body.jti', code: 'mismatch' }] });
  const now = clock.now();
  // Một câu UPDATE có điều kiện: hai lần claim đồng thời chỉ một lần thắng.
  const [session] = await tx
    .update(schema.scribeSessions)
    .set({ claimedAt: now })
    .where(and(eq(schema.scribeSessions.id, sessionId), isNull(schema.scribeSessions.claimedAt)))
    .returning();
  if (!session) {
    const [seen] = await tx.select({ id: schema.scribeSessions.id }).from(schema.scribeSessions).where(eq(schema.scribeSessions.id, sessionId));
    throw new ApiError(seen ? 'state_conflict' : 'not_found', seen ? { currentState: 'claimed' } : {});
  }
  if (session.expiresAt <= now) throw new ApiError('token_expired');
  assertAiEnabled(ctx);
  const user = ctx.users.get(session.userId);
  if (!user || user.status === 'disabled' || !can(user, 'assistant.use')) throw new ApiError('forbidden');
  const [conversation] = await tx.select().from(schema.conversations).where(eq(schema.conversations.id, session.conversationId));
  if (!conversation) throw new ApiError('not_found');

  const prefs = UserPrefsSchema.parse(user.prefs ?? {});
  const templates = await publishedTemplates(tx);
  const ai = ctx.settings.ai;
  await audit(tx, { orgId: ctx.orgId, action: 'scribe_session_claimed', actorType: 'ai_service', actorUserId: user.id, actorDeviceId: session.deviceId, targetType: 'scribe_session', targetId: session.id });
  return {
    userId: user.id,
    orgId: ctx.orgId,
    conversationId: conversation.id,
    channel: conversation.channel as 'voice' | 'text',
    quotaLeft: await aiQuotaLeft(tx, ctx, user.id),
    user: { fullName: user.fullName, givenName: user.givenName, honorific: honorificOf(user), roleTitle: roleTitleOf(user) },
    ai: { enabled: ai.enabled, stt: ai.stt, llm: ai.llm, tts: ai.tts },
    voiceId: prefs.voiceId,
    speechRate: prefs.speechRate,
    keyterms: buildKeyterms(ctx, templates),
    orgPrompt: buildOrgPrompt(ctx, templates),
  };
}

/**
 * `POST /internal/v1/messages`: ghi một lượt của hội thoại (lượt nói đã chốt, câu trả lời, kết quả tool).
 * Không bao giờ ghi âm thanh: `audio_ref` luôn NULL. Chỉ ghi khi người dùng đã đồng ý lưu bản chép chữ;
 * không đồng ý thì trả `stored: false` và không có dòng nào. Bản chép chỉ nằm ở `messages` (chịu RLS), không vào nhật ký.
 */
export async function recordMessage(
  tx: Tx,
  ctx: OrgContext,
  input: { conversationId: string; role: 'user' | 'assistant' | 'tool'; content?: unknown; sttConfidence?: number },
  opts: { onBehalfOf?: string } = {},
): Promise<{ stored: boolean }> {
  const [conversation] = await tx.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId));
  if (!conversation) throw new ApiError('not_found');
  if (opts.onBehalfOf && opts.onBehalfOf !== conversation.userId) throw new ApiError('not_found');
  if (input.content === undefined || input.content === null) throw new ApiError('input_invalid', { errors: [{ path: 'body.content', code: 'required' }] });
  if (!conversation.transcriptConsent) return { stored: false };
  const now = clock.now();
  await tx.insert(schema.messages).values({
    id: newId(now.getTime()),
    orgId: ctx.orgId,
    conversationId: conversation.id,
    role: input.role,
    content: input.content,
    sttConfidence: input.role === 'user' ? (input.sttConfidence ?? null) : null,
    audioRef: null,
    createdAt: now,
  });
  return { stored: true };
}

export type UsageInput = { conversationId: string; llmCalls?: number; llmInputTokens?: number; llmOutputTokens?: number; sttSeconds?: number; ttsChars?: number; errors?: number };

/**
 * `POST /internal/v1/scribe/usage`: cộng dồn số liệu sau mỗi lượt vào `ai_usage` theo người và theo ngày (giờ Việt Nam).
 * Trả `quotaLeft` theo `settings.ai.dailyCallLimit` để scribe dừng khi hết lượt (chặn chi phí chạy vượt do lỗi vòng lặp).
 */
export async function recordUsage(tx: Tx, ctx: OrgContext, input: UsageInput, opts: { onBehalfOf?: string } = {}): Promise<{ quotaLeft: number }> {
  const [conversation] = await tx.select({ userId: schema.conversations.userId }).from(schema.conversations).where(eq(schema.conversations.id, input.conversationId));
  if (!conversation) throw new ApiError('not_found');
  if (opts.onBehalfOf && opts.onBehalfOf !== conversation.userId) throw new ApiError('not_found');
  const n = (v: number | undefined) => Math.max(0, Math.trunc(v ?? 0));
  const add = { llmCalls: n(input.llmCalls), llmInputTokens: n(input.llmInputTokens), llmOutputTokens: n(input.llmOutputTokens), sttSeconds: n(input.sttSeconds), ttsChars: n(input.ttsChars), errors: n(input.errors) };
  const u = schema.aiUsage;
  const [row] = await tx
    .insert(u)
    .values({ orgId: ctx.orgId, userId: conversation.userId, day: usageDay(ctx, clock.now()), ...add })
    .onConflictDoUpdate({
      target: [u.orgId, u.userId, u.day],
      set: {
        llmCalls: sql`${u.llmCalls} + ${add.llmCalls}`,
        llmInputTokens: sql`${u.llmInputTokens} + ${add.llmInputTokens}`,
        llmOutputTokens: sql`${u.llmOutputTokens} + ${add.llmOutputTokens}`,
        sttSeconds: sql`${u.sttSeconds} + ${add.sttSeconds}`,
        ttsChars: sql`${u.ttsChars} + ${add.ttsChars}`,
        errors: sql`${u.errors} + ${add.errors}`,
      },
    })
    .returning({ llmCalls: u.llmCalls });
  return { quotaLeft: Math.max(0, ctx.settings.ai.dailyCallLimit - (row?.llmCalls ?? 0)) };
}
