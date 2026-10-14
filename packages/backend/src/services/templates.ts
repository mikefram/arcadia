import {
  ApiError,
  DraftDefinitionSchema,
  PG_NOTIFY_CHANNEL,
  StarterRuleSchema,
  TEMPLATE_CATEGORIES,
  TEMPLATE_DRAFT_ACTIONS,
  TEMPLATE_MANAGE_ACTIONS,
  TEMPLATE_VIEW_ACTIONS,
  canAny,
  newId,
  type AssigneeRule,
  type DefinitionIssue,
  type DraftDefinition,
  type DraftSaveResponseSchema,
  type DraftSaveSchema,
  type PersonRef,
  type ProcessDefinition,
  type PublishResponseSchema,
  type SimulateRequestSchema,
  type SimulateResponse,
  type StarterRule,
  type StreamEvent,
  type TemplateCategory,
  type TemplateCreateSchema,
  type TemplateDetail,
  type TemplateDiffSchema,
  type TemplateSummary,
  type TemplateVersion,
  type ValidateResponse,
} from '@mihato/domain';
import { normalizeText, stripDiacritics } from '@mihato/domain/vi-normalize';
import { vi } from '@mihato/i18n';
import { canStartRun, simulate, validate } from '@mihato/workflow-engine';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../audit';
import { ensureRegistersFor } from './registers';
import type { RequestMeta } from '../auth/service';
import { clock } from '../clock';
import type { OrgContext } from '../context';
import { schema, type Tx } from '../db/client';
import { loadDefinition, mapEngineError } from '../engine/runner';
import type { Viewer } from '../views';

/**
 * Mẫu quy trình (SPEC 9.3, 10.4). Mỗi mẫu có nhiều phiên bản; nhiều nhất MỘT dòng `draft` tại một thời điểm.
 * Xuất bản là đổi chính dòng nháp thành `published`; từ đó trigger CSDL cấm UPDATE và DELETE trên dòng ấy,
 * nên lần sửa kế tiếp tạo dòng nháp mới với version = max + 1. Lượt chạy đang chạy giữ phiên bản cũ.
 */

type TemplateRow = typeof schema.processTemplates.$inferSelect;
type VersionRow = typeof schema.processTemplateVersions.$inferSelect;
/** Dòng phiên bản không kèm definition (definition có thể lớn), kèm số việc đếm sẵn trong SQL. */
type VersionMeta = Omit<VersionRow, 'definition' | 'orgId'> & { stepCount: number; starters: unknown };

export type TemplateCreateInput = z.output<typeof TemplateCreateSchema>;
export type DraftSaveInput = z.output<typeof DraftSaveSchema>;
export type DraftSaveResult = z.infer<typeof DraftSaveResponseSchema>;
export type SimulateRequest = z.output<typeof SimulateRequestSchema>;
export type PublishResult = z.infer<typeof PublishResponseSchema>;
export type TemplateDiff = z.infer<typeof TemplateDiffSchema>;
type StoredDefinition = TemplateVersion['definition'];

const v = schema.processTemplateVersions;
const t = schema.processTemplates;
const collator = new Intl.Collator('vi');
const fold = (s: string): string => stripDiacritics(normalizeText(s));
/** Thấy bản nháp và mẫu chưa xuất bản: người sửa, và người xuất bản (phải xem được cái mình sắp xuất bản). */
const seesDrafts = (viewer: Viewer): boolean => canAny(viewer, TEMPLATE_DRAFT_ACTIONS);
/**
 * Có quyền xem mẫu quy trình nói chung (đọc bản xuất bản hoặc quản lý mẫu). Người không có vẫn xem được MẪU MÀ HỌ KHỞI CHẠY ĐƯỢC
 * (theo `starters`), để nhân viên soạn văn bản đi mở được biểu mẫu khởi chạy mà không cần quyền xem mọi quy trình
 * (docs/DECISIONS.md, 06/10/2026).
 */
const viewsTemplates = (viewer: Viewer): boolean => canAny(viewer, TEMPLATE_VIEW_ACTIONS);
/** Thấy cả mẫu đã lưu trữ trong danh sách: ba việc quản lý mẫu (người lưu trữ cần thấy mẫu để bỏ lưu trữ). */
const seesArchived = (viewer: Viewer): boolean => canAny(viewer, TEMPLATE_MANAGE_ACTIONS);

/** Nhóm lưu ở CSDL là chuỗi tự do; giá trị lạ (dữ liệu cũ, tay sửa) đọc ra là 'general'. */
const asCategory = (raw: string): TemplateCategory => ((TEMPLATE_CATEGORIES as readonly string[]).includes(raw) ? (raw as TemplateCategory) : 'general');
/** `starters` lấy từ cột jsonb; hỏng hoặc vắng thì coi như không khai báo (cách cũ: người có quyền run.start). */
const asStarters = (raw: unknown): StarterRule[] => {
  const parsed = StarterRuleSchema.array().safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
};

const stepCountSql = sql<number>`(SELECT count(*)::int FROM jsonb_array_elements(
  CASE WHEN jsonb_typeof(${v.definition} -> 'nodes') = 'array' THEN ${v.definition} -> 'nodes' ELSE '[]'::jsonb END) n
  WHERE n ->> 'type' IN ('task','approval'))`;

const metaColumns = {
  id: v.id,
  templateId: v.templateId,
  version: v.version,
  status: v.status,
  draftRev: v.draftRev,
  updatedAt: v.updatedAt,
  publishedAt: v.publishedAt,
  publishedBy: v.publishedBy,
  stepCount: stepCountSql,
  /** ai được khởi chạy (docs/DECISIONS.md, 06/10/2026), để tính `canStart` mà không tải cả định nghĩa */
  starters: sql<unknown>`${v.definition} -> 'starters'`,
};

/** Nháp lưu ở CSDL có thể còn dở; đọc ra bằng schema lỏng để kiểu trả về khớp DTO. */
const storedDefinition = (raw: unknown): StoredDefinition => DraftDefinitionSchema.parse(raw);
/** `validate()` nhận kiểu nháp của engine (các nút còn thiếu trường); dữ liệu là một. */
const asDraft = (def: StoredDefinition): DraftDefinition => def as unknown as DraftDefinition;

const issueErrors = (issues: DefinitionIssue[]) => issues.map((i) => ({ path: i.nodeId ?? i.edgeId ?? 'definition', code: i.code }));

async function notifyTemplateUpdated(tx: Tx, orgId: string, rev?: number): Promise<void> {
  const event: StreamEvent = { kind: 'template.updated', orgId, version: rev };
  await tx.execute(sql`select pg_notify(${PG_NOTIFY_CHANNEL}, ${JSON.stringify(event)})`);
}

async function findTemplate(tx: Tx, templateId: string, opts: { lock?: boolean } = {}): Promise<TemplateRow> {
  const q = tx.select().from(t).where(eq(t.id, templateId));
  const [row] = opts.lock ? await q.for('update') : await q;
  // Mẫu một việc ẩn của việc ngoài quy trình không phải quy trình: không xem, sửa, xuất bản hay chép được qua API mẫu.
  if (!row || row.kind !== 'process') throw new ApiError('not_found');
  return row;
}

async function versionMetas(tx: Tx, templateId?: string): Promise<VersionMeta[]> {
  const q = tx.select(metaColumns).from(v);
  const rows = templateId ? await q.where(eq(v.templateId, templateId)) : await q;
  return rows.map((r) => ({ ...r, stepCount: Number(r.stepCount) })).sort((a, b) => a.version - b.version);
}

const latestPublishedOf = (versions: VersionMeta[]): VersionMeta | null => versions.filter((x) => x.status === 'published').at(-1) ?? null;
const draftOf = (versions: VersionMeta[]): VersionMeta | null => versions.find((x) => x.status === 'draft') ?? null;

function summaryOf(ctx: OrgContext, viewer: Viewer, tpl: TemplateRow, versions: VersionMeta[], runCount: number, drafts: boolean): TemplateSummary {
  const published = latestPublishedOf(versions);
  const draft = drafts ? draftOf(versions) : null;
  const createdBy: PersonRef = ctx.person(tpl.createdBy) ?? { id: tpl.createdBy, fullName: '', givenName: '', honorific: null };
  return {
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    category: asCategory(tpl.category),
    canStart: published !== null && tpl.archivedAt === null && canStartRun({ starters: asStarters(published.starters) }, viewer.id, ctx.resolve),
    archivedAt: tpl.archivedAt?.toISOString() ?? null,
    latestPublishedVersion: published?.version ?? null,
    hasDraft: draft !== null,
    // "bản mới nhất": người sửa hoặc xuất bản thấy nháp đang sửa, người khác thấy bản đã xuất bản.
    stepCount: (draft ?? published)?.stepCount ?? 0,
    runCount,
    createdBy,
    createdAt: tpl.createdAt.toISOString(),
  };
}

async function runCountOf(tx: Tx, templateId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.processRuns)
    .where(eq(schema.processRuns.templateId, templateId));
  return Number(row?.n ?? 0);
}

/**
 * Danh sách mẫu. Người sửa hoặc xuất bản (`seesDrafts`) thấy cả mẫu chưa xuất bản và cờ nháp; người quản lý mẫu (`seesArchived`)
 * thấy cả mẫu đã lưu trữ; người khác chỉ thấy mẫu đã có bản xuất bản và chưa lưu trữ. `archived`: 'true' chỉ mẫu đã lưu trữ,
 * 'false' chỉ mẫu còn dùng, bỏ trống là tất cả.
 */
export async function listTemplates(tx: Tx, ctx: OrgContext, viewer: Viewer, q: { q?: string; archived?: 'true' | 'false'; category?: TemplateCategory } = {}): Promise<TemplateSummary[]> {
  const drafts = seesDrafts(viewer);
  const archivedToo = seesArchived(viewer);
  const templates = await tx.select().from(t).where(eq(t.kind, 'process'));
  const versions = await versionMetas(tx);
  const runCounts = await tx
    .select({ templateId: schema.processRuns.templateId, n: sql<number>`count(*)::int` })
    .from(schema.processRuns)
    .groupBy(schema.processRuns.templateId);
  const byTemplate = new Map<string, VersionMeta[]>();
  for (const ver of versions) byTemplate.set(ver.templateId, [...(byTemplate.get(ver.templateId) ?? []), ver]);
  const runCount = new Map(runCounts.map((r) => [r.templateId, Number(r.n)]));
  const needle = q.q ? fold(q.q) : '';
  return templates
    .filter((tpl) => {
      if (!archivedToo && tpl.archivedAt !== null) return false;
      if (!drafts && latestPublishedOf(byTemplate.get(tpl.id) ?? []) === null) return false;
      if (q.category && asCategory(tpl.category) !== q.category) return false;
      if (q.archived === 'true' && tpl.archivedAt === null) return false;
      if (q.archived === 'false' && tpl.archivedAt !== null) return false;
      return !needle || fold(tpl.name).includes(needle);
    })
    .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
    .map((tpl) => summaryOf(ctx, viewer, tpl, byTemplate.get(tpl.id) ?? [], runCount.get(tpl.id) ?? 0, drafts))
    .filter((s) => viewsTemplates(viewer) || s.canStart);
}

/**
 * Một mẫu kèm danh sách phiên bản. `draft` và dòng phiên bản nháp chỉ dành cho người sửa hoặc xuất bản (`seesDrafts`).
 * Người khác mở được mọi mẫu đã có bản xuất bản, kể cả mẫu đã lưu trữ: lượt chạy cũ vẫn cần vẽ lại sơ đồ của nó.
 * Mẫu chưa xuất bản lần nào thì với họ là không tồn tại (404).
 */
export async function getTemplate(tx: Tx, ctx: OrgContext, viewer: Viewer, templateId: string): Promise<TemplateDetail> {
  const drafts = seesDrafts(viewer);
  const tpl = await findTemplate(tx, templateId);
  const versions = await versionMetas(tx, templateId);
  if (!drafts && latestPublishedOf(versions) === null) throw new ApiError('not_found');
  const draftMeta = drafts ? draftOf(versions) : null;
  // Người không có quyền xem mẫu chỉ mở được mẫu mà họ khởi chạy được; mẫu khác coi như không tồn tại.
  if (!viewsTemplates(viewer) && !summaryOf(ctx, viewer, tpl, versions, 0, false).canStart) throw new ApiError('not_found');
  let draft: TemplateDetail['draft'] = null;
  if (draftMeta) {
    const [row] = await tx.select({ definition: v.definition }).from(v).where(eq(v.id, draftMeta.id));
    draft = { version: draftMeta.version, rev: draftMeta.draftRev, definition: storedDefinition(row!.definition), updatedAt: draftMeta.updatedAt.toISOString() };
  }
  return {
    ...summaryOf(ctx, viewer, tpl, versions, await runCountOf(tx, templateId), drafts),
    versions: versions
      .filter((x) => drafts || x.status === 'published')
      .map((x) => ({
        version: x.version,
        status: x.status as 'draft' | 'published',
        publishedAt: x.publishedAt?.toISOString() ?? null,
        publishedBy: ctx.person(x.publishedBy),
      })),
    draft,
  };
}

/** Một phiên bản kèm definition. Bản nháp chỉ dành cho người sửa hoặc xuất bản; với người khác là 404. */
export async function getTemplateVersion(tx: Tx, ctx: OrgContext, viewer: Viewer, templateId: string, version: number): Promise<TemplateVersion> {
  const tpl = await findTemplate(tx, templateId);
  if (!viewsTemplates(viewer) && !summaryOf(ctx, viewer, tpl, await versionMetas(tx, templateId), 0, false).canStart) throw new ApiError('not_found');
  const [row] = await tx
    .select()
    .from(v)
    .where(and(eq(v.templateId, templateId), eq(v.version, version)));
  if (!row || (row.status === 'draft' && !seesDrafts(viewer))) throw new ApiError('not_found');
  return {
    templateId: tpl.id,
    templateName: tpl.name,
    versionId: row.id,
    version: row.version,
    status: row.status as 'draft' | 'published',
    definition: storedDefinition(row.definition),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

/** Nháp đầu của một mẫu mới: chỉ có Bắt đầu và Hoàn tất, chưa nối, để người vẽ kéo việc vào giữa. */
function emptyDefinition(name: string): StoredDefinition {
  return storedDefinition({
    schemaVersion: 1,
    name,
    inputs: [],
    layout: { start: { x: 0, y: 160 }, end: { x: 480, y: 160 } },
    nodes: [
      { id: 'start', type: 'start', label: vi.common.nodeKind.start },
      { id: 'end', type: 'end', label: vi.common.nodeKind.end },
    ],
    edges: [],
  });
}

/**
 * Tạo mẫu và bản nháp đầu (version 1). Thứ tự ưu tiên: `definition` gửi kèm; không có thì chép definition mới nhất
 * của `cloneFromTemplateId` (nháp nếu đang có, không thì bản xuất bản mới nhất); không có nữa thì nháp trống.
 */
export async function createTemplate(tx: Tx, ctx: OrgContext, viewer: Viewer, body: TemplateCreateInput): Promise<TemplateDetail> {
  const name = body.name.trim();
  let definition: StoredDefinition;
  if (body.definition) {
    definition = { ...body.definition, name: body.definition.name || name };
  } else if (body.cloneFromTemplateId) {
    await findTemplate(tx, body.cloneFromTemplateId);
    const [source] = await tx.select({ definition: v.definition }).from(v).where(eq(v.templateId, body.cloneFromTemplateId)).orderBy(desc(v.version)).limit(1);
    if (!source) throw new ApiError('not_found');
    definition = { ...storedDefinition(source.definition), name };
  } else {
    definition = emptyDefinition(name);
  }
  const id = newId();
  const now = clock.now();
  // Nhân bản thì giữ nhóm của mẫu gốc nếu người tạo không chọn nhóm khác.
  let category: TemplateCategory = body.category ?? 'general';
  if (body.category === undefined && body.cloneFromTemplateId) {
    const [src] = await tx.select({ category: t.category }).from(t).where(eq(t.id, body.cloneFromTemplateId));
    if (src) category = asCategory(src.category);
  }
  await tx.insert(t).values({ id, orgId: viewer.orgId, name, description: body.description, category, createdBy: viewer.id, createdAt: now });
  await tx.insert(v).values({ id: newId(), orgId: viewer.orgId, templateId: id, version: 1, definition, status: 'draft', draftRev: 0, updatedAt: now });
  await notifyTemplateUpdated(tx, viewer.orgId);
  return getTemplate(tx, ctx, viewer, id);
}

/** `If-Match: 3`, `If-Match: "3"` và `If-Match: W/"3"` đều là rev 3; thiếu hoặc không phải số thì null. */
function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const raw = header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * Lưu nháp (SPEC 10.4): bắt buộc `If-Match` bằng `draft_rev` hiện tại, sai thì 412 `precondition_failed`.
 * Nháp còn lỗi vẫn lưu được: `validate()` chỉ chặn lúc xuất bản.
 *
 * Mẫu vừa xuất bản chưa có dòng nháp: lần lưu này tạo dòng nháp version = max + 1. Khi đó rev hợp lệ là 0
 * (client vừa tải lại, `draft` rỗng) hoặc rev của bản vừa xuất bản (client đang mở trình thiết kế, tự lưu tiếp).
 * Rev nối tiếp qua các phiên bản, không quay về 1, để một tab cũ giữ rev của vòng nháp trước không ghi đè được.
 */
export async function saveTemplateDraft(tx: Tx, viewer: Viewer, templateId: string, body: DraftSaveInput, ifMatch: string | undefined): Promise<DraftSaveResult> {
  // Khoá dòng mẫu: hai lần lưu song song xếp hàng, lần sau thấy rev đã tăng và nhận 412.
  const tpl = await findTemplate(tx, templateId, { lock: true });
  // Mẫu đã lưu trữ thì không sửa nháp; bỏ lưu trữ trước (audit files-7, khớp previewPublish).
  if (tpl.archivedAt) throw new ApiError('state_conflict', { currentState: 'archived' });
  const [latest] = await tx
    .select({ id: v.id, version: v.version, status: v.status, draftRev: v.draftRev })
    .from(v)
    .where(eq(v.templateId, templateId))
    .orderBy(desc(v.version))
    .limit(1);
  const given = parseIfMatch(ifMatch);
  const draft = latest?.status === 'draft' ? latest : null;
  const lastRev = latest?.draftRev ?? 0;
  const accepted = draft ? [draft.draftRev] : [0, lastRev];
  if (given === null || !accepted.includes(given)) throw new ApiError('precondition_failed');

  const now = clock.now();
  const rev = lastRev + 1;
  if (draft) {
    await tx
      .update(v)
      .set({ definition: body.definition, draftRev: rev, updatedAt: now })
      .where(and(eq(v.id, draft.id), eq(v.status, 'draft')));
  } else {
    await tx.insert(v).values({ id: newId(), orgId: viewer.orgId, templateId, version: (latest?.version ?? 0) + 1, definition: body.definition, status: 'draft', draftRev: rev, updatedAt: now });
  }
  const patch: Partial<Pick<TemplateRow, 'name' | 'description' | 'category'>> = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description;
  if (body.category !== undefined) patch.category = body.category;
  if (Object.keys(patch).length > 0) await tx.update(t).set(patch).where(eq(t.id, templateId));
  await notifyTemplateUpdated(tx, viewer.orgId, rev);
  return { rev, updatedAt: now.toISOString() };
}

type WorkingCopy = { row: Pick<VersionRow, 'id' | 'version' | 'status'>; definition: StoredDefinition };

/** Bản đang sửa của mẫu: dòng nháp; chưa có nháp thì là bản xuất bản mới nhất. */
async function workingCopy(tx: Tx, templateId: string): Promise<WorkingCopy | null> {
  const [row] = await tx.select().from(v).where(eq(v.templateId, templateId)).orderBy(desc(v.version)).limit(1);
  return row ? { row, definition: storedDefinition(row.definition) } : null;
}

/** Chạy `validate()` của engine trên nháp (chưa có nháp thì trên bản xuất bản mới nhất). Không ghi gì. */
export async function validateTemplateDraft(tx: Tx, ctx: OrgContext, templateId: string): Promise<ValidateResponse> {
  await findTemplate(tx, templateId);
  const copy = await workingCopy(tx, templateId);
  if (!copy) throw new ApiError('not_found');
  const res = validate(asDraft(copy.definition), { now: clock.now(), calendar: ctx.calendar });
  return { errors: res.errors, warnings: res.warnings };
}

/**
 * Chạy thử "ai làm gì, hạn nào" (SPEC 9.3, 10.4). Hàm thuần của engine, không ghi CSDL; tool `propose_start_run`
 * và bản xem trước khi khởi chạy dùng đúng hàm này.
 * - `draft: true` và người gọi thấy được nháp (sửa hoặc xuất bản): dùng nháp, phải qua `validate()` không lỗi (còn lỗi thì 422).
 * - Ngược lại: bản xuất bản theo `version`, hoặc bản xuất bản mới nhất.
 */
export async function simulateTemplate(tx: Tx, ctx: OrgContext, viewer: Viewer, templateId: string, body: SimulateRequest): Promise<SimulateResponse> {
  await findTemplate(tx, templateId);
  let def: ProcessDefinition;
  const copy = body.draft && seesDrafts(viewer) ? await workingCopy(tx, templateId) : null;
  if (copy && copy.row.status === 'draft') {
    const checked = validate(asDraft(copy.definition), { now: clock.now(), calendar: ctx.calendar });
    if (checked.errors.length > 0 || !checked.definition) throw new ApiError('template_invalid', { errors: issueErrors(checked.errors) });
    def = checked.definition;
  } else {
    const published = and(eq(v.templateId, templateId), eq(v.status, 'published'));
    const [row] = await tx
      .select({ id: v.id })
      .from(v)
      .where(body.version === undefined ? published : and(published, eq(v.version, body.version)))
      .orderBy(desc(v.version))
      .limit(1);
    // Hỏi đích danh một phiên bản không có (hoặc còn là nháp) thì 404; mẫu chưa xuất bản lần nào thì chưa chạy thử được.
    if (!row) throw new ApiError(body.version === undefined ? 'template_invalid' : 'not_found');
    def = await loadDefinition(tx, row.id);
  }
  try {
    const res = simulate({ def, inputs: body.inputs, initiatorId: viewer.id, ctx: ctx.resolve, now: clock.now(), templateId });
    return {
      rows: res.rows.map((r) => ({
        nodeId: r.nodeId,
        kind: r.kind,
        title: r.title,
        assignee: ctx.person(r.assigneeId),
        onBehalfOf: ctx.person(r.onBehalfOfId),
        dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null,
        pastDue: r.pastDue,
        order: r.order,
        ...(r.action ? { action: r.action } : {}),
        ...(r.assigneeChosenLater ? { assigneeChosenLater: true } : {}),
      })),
      warnings: res.warnings,
      targetAt: res.targetAt ? new Date(res.targetAt).toISOString() : null,
    };
  } catch (err) {
    mapEngineError(err);
  }
}

export type PublishPreview = { templateName: string; version: number; definition: ProcessDefinition };

/**
 * Kiểm một bản nháp có xuất bản được không mà KHÔNG ghi gì: cùng các điều kiện với `publishTemplate`. Đề xuất xuất bản của
 * Trợ lý AI dùng để báo lỗi trước khi người dùng bấm Đồng ý, và để dựng bản xem trước khi giao việc ngay.
 * Ném `not_found`; `state_conflict` (mẫu đã lưu trữ: currentState 'archived'; bản mới nhất đã xuất bản: 'published');
 * `template_invalid` kèm `errors[]`.
 */
export async function previewPublish(tx: Tx, ctx: OrgContext, templateId: string): Promise<PublishPreview> {
  const tpl = await findTemplate(tx, templateId);
  if (tpl.archivedAt) throw new ApiError('state_conflict', { currentState: 'archived' });
  const copy = await workingCopy(tx, templateId);
  if (!copy) throw new ApiError('not_found');
  if (copy.row.status !== 'draft') throw new ApiError('state_conflict', { currentState: 'published' });
  const checked = validate(asDraft(copy.definition), { now: clock.now(), calendar: ctx.calendar });
  if (checked.errors.length > 0 || !checked.definition) throw new ApiError('template_invalid', { errors: issueErrors(checked.errors) });
  const foreign = foreignReferences(ctx, checked.definition);
  if (foreign.length > 0) throw new ApiError('template_invalid', { errors: foreign });
  const noRegister = await ensureRegistersFor(tx, ctx, checked.definition);
  if (noRegister.length > 0) throw new ApiError('template_invalid', { errors: noRegister });
  return { templateName: tpl.name, version: copy.row.version, definition: checked.definition };
}

/**
 * Xuất bản (SPEC 10.4): chạy lại `validate()`; còn lỗi thì 422 `template_invalid` kèm `errors[]` (path = nodeId).
 * Dòng nháp được đổi thành `published` với definition đã chuẩn hoá; từ đây dòng này bất biến.
 */
export async function publishTemplate(tx: Tx, ctx: OrgContext, viewer: Viewer, templateId: string, meta: RequestMeta = {}): Promise<PublishResult> {
  const tpl = await findTemplate(tx, templateId, { lock: true });
  if (tpl.archivedAt) throw new ApiError('state_conflict', { currentState: 'archived' });
  const copy = await workingCopy(tx, templateId);
  if (!copy) throw new ApiError('not_found');
  if (copy.row.status !== 'draft') throw new ApiError('state_conflict', { currentState: 'published' });
  const checked = validate(asDraft(copy.definition), { now: clock.now(), calendar: ctx.calendar });
  if (checked.errors.length > 0 || !checked.definition) throw new ApiError('template_invalid', { errors: issueErrors(checked.errors) });
  // validate() là hàm thuần nên không biết danh bạ: người và đơn vị trong mẫu phải thuộc tổ chức này (khoá ngoại không đi qua RLS).
  const foreign = foreignReferences(ctx, checked.definition);
  if (foreign.length > 0) throw new ApiError('template_invalid', { errors: foreign });
  // Ô cấp số phải trỏ vào một sổ có thật: sổ mặc định tự tạo, sổ khác chưa có thì chặn xuất bản.
  const noRegister = await ensureRegistersFor(tx, ctx, checked.definition);
  if (noRegister.length > 0) throw new ApiError('template_invalid', { errors: noRegister });

  const now = clock.now();
  const updated = await tx
    .update(v)
    .set({ status: 'published', definition: checked.definition, publishedAt: now, publishedBy: viewer.id, updatedAt: now })
    .where(and(eq(v.id, copy.row.id), eq(v.status, 'draft')))
    .returning({ id: v.id });
  if (updated.length === 0) throw new ApiError('state_conflict', { currentState: 'published' });
  await tx.update(t).set({ name: checked.definition.name }).where(eq(t.id, templateId));
  await audit(tx, {
    orgId: viewer.orgId,
    action: 'template_published',
    actorUserId: viewer.id,
    actorDeviceId: viewer.deviceId,
    targetType: 'template',
    targetId: templateId,
    ip: meta.ip,
    detail: { version: copy.row.version, versionId: copy.row.id },
  });
  await notifyTemplateUpdated(tx, viewer.orgId);
  return { version: copy.row.version, versionId: copy.row.id, publishedAt: now.toISOString() };
}

/** Người hoặc đơn vị được nêu trong mẫu mà không có trong danh bạ của tổ chức, hoặc đã bị vô hiệu hoá. */
function foreignReferences(ctx: OrgContext, def: ProcessDefinition): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const check = (nodeId: string, rule: AssigneeRule | undefined) => {
    if (!rule) return;
    if (rule.kind === 'user') {
      const u = ctx.users.get(rule.userId);
      if (!u) out.push({ path: nodeId, code: 'assignee_not_found' });
      else if (u.status === 'disabled') out.push({ path: nodeId, code: 'assignee_disabled' });
    }
    if ((rule.kind === 'role' || rule.kind === 'unit_head') && rule.unitId && !ctx.units.has(rule.unitId)) out.push({ path: nodeId, code: 'unit_not_found' });
  };
  // Ai được khởi chạy: người và đơn vị phải thuộc tổ chức này.
  for (const s of def.starters ?? []) {
    if (s.kind === 'user' && !ctx.users.has(s.userId)) out.push({ path: 'starters', code: 'starter_not_found' });
    if (s.kind === 'unit' && !ctx.units.has(s.unitId)) out.push({ path: 'starters', code: 'unit_not_found' });
  }
  for (const node of def.nodes) {
    if (node.type === 'task') {
      check(node.id, node.assignee);
      check(node.id, node.escalateTo);
    } else if (node.type === 'approval') {
      for (const a of node.approvers) check(node.id, a);
    } else if (node.type === 'notify') {
      for (const a of node.to) check(node.id, a);
    }
  }
  return out;
}

/** Lưu trữ: không cho khởi chạy mới, lượt chạy đang chạy không đổi. `archived = false` là bỏ lưu trữ. */
export async function archiveTemplate(tx: Tx, ctx: OrgContext, viewer: Viewer, templateId: string, archived: boolean, meta: RequestMeta = {}): Promise<TemplateSummary> {
  const tpl = await findTemplate(tx, templateId, { lock: true });
  if ((tpl.archivedAt !== null) !== archived) {
    tpl.archivedAt = archived ? clock.now() : null;
    await tx.update(t).set({ archivedAt: tpl.archivedAt }).where(eq(t.id, templateId));
    await audit(tx, { orgId: viewer.orgId, action: 'template_archived', actorUserId: viewer.id, actorDeviceId: viewer.deviceId, targetType: 'template', targetId: templateId, ip: meta.ip, detail: { archived } });
    await notifyTemplateUpdated(tx, viewer.orgId);
  }
  return summaryOf(ctx, viewer, tpl, await versionMetas(tx, templateId), await runCountOf(tx, templateId), seesDrafts(viewer));
}

// ───────────────────────── So sánh hai phiên bản ─────────────────────────

/** JSON có thứ tự khoá cố định, để hai đối tượng cùng nội dung nhưng khác thứ tự khoá không bị coi là khác nhau. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'id' && stable(a[k]) !== stable(b[k])).sort();
}

/** Nút và cạnh thêm, bớt, đổi giữa hai definition; nút đổi kèm tên các trường đã đổi. Toạ độ (`layout`) không tính là đổi. */
export function diffDefinitions(from: StoredDefinition, to: StoredDefinition): Pick<TemplateDiff, 'nodes' | 'edges'> {
  const nodes: TemplateDiff['nodes'] = [];
  const before = new Map(from.nodes.map((n) => [n.id, n as Record<string, unknown> & { id: string; label: string }]));
  const after = new Map(to.nodes.map((n) => [n.id, n as Record<string, unknown> & { id: string; label: string }]));
  for (const [id, n] of after) {
    const old = before.get(id);
    if (!old) nodes.push({ nodeId: id, change: 'added', label: n.label, fields: [] });
    else {
      const fields = changedFields(old, n);
      if (fields.length > 0) nodes.push({ nodeId: id, change: 'changed', label: n.label, fields });
    }
  }
  for (const [id, n] of before) if (!after.has(id)) nodes.push({ nodeId: id, change: 'removed', label: n.label, fields: [] });

  const edges: TemplateDiff['edges'] = [];
  const edgesBefore = new Map(from.edges.map((e) => [e.id, e]));
  const edgesAfter = new Map(to.edges.map((e) => [e.id, e]));
  for (const [id, e] of edgesAfter) {
    const old = edgesBefore.get(id);
    if (!old) edges.push({ edgeId: id, change: 'added', from: e.from, to: e.to });
    else if (stable(old) !== stable(e)) edges.push({ edgeId: id, change: 'changed', from: e.from, to: e.to });
  }
  for (const [id, e] of edgesBefore) if (!edgesAfter.has(id)) edges.push({ edgeId: id, change: 'removed', from: e.from, to: e.to });
  return { nodes, edges };
}

/** So sánh hai phiên bản của một mẫu (SPEC 10.4, Giai đoạn 3). Bản nháp cũng so được: route chỉ mở cho người sửa hoặc xuất bản. */
export async function diffTemplateVersions(tx: Tx, templateId: string, from: number, to: number): Promise<TemplateDiff> {
  await findTemplate(tx, templateId);
  const rows = await tx
    .select({ version: v.version, definition: v.definition })
    .from(v)
    .where(and(eq(v.templateId, templateId), inArray(v.version, [from, to])));
  const a = rows.find((r) => r.version === from);
  const b = rows.find((r) => r.version === to);
  if (!a || !b) throw new ApiError('not_found');
  return { from, to, ...diffDefinitions(storedDefinition(a.definition), storedDefinition(b.definition)) };
}
