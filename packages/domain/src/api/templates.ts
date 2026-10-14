import { z } from 'zod';
import { IdSchema, InstantSchema } from '../enums';
import { DefinitionIssueSchema, DraftDefinitionSchema } from '../process';
import { PersonRefSchema } from './common';

/** SPEC 10.4 */
export const TemplateVersionMetaSchema = z.object({
  version: z.number().int(),
  status: z.enum(['draft', 'published']),
  publishedAt: InstantSchema.nullable(),
  publishedBy: PersonRefSchema.nullable(),
});

/** Nhóm quy trình (docs/DECISIONS.md, 06/10/2026): lọc và gom ở danh sách, gợi ý nơi dùng. Khoá ổn định, tên tiếng Việt ở packages/i18n. */
export const TEMPLATE_CATEGORIES = ['directive', 'incoming', 'outgoing', 'business', 'finance', 'hr', 'operations', 'general'] as const;
export const TemplateCategorySchema = z.enum(TEMPLATE_CATEGORIES);
export type TemplateCategory = z.infer<typeof TemplateCategorySchema>;

export const TemplateSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string().nullable(),
  category: TemplateCategorySchema,
  /** người gọi có khởi chạy được quy trình này không (theo `starters` của bản xuất bản mới nhất); false khi chưa xuất bản */
  canStart: z.boolean(),
  archivedAt: InstantSchema.nullable(),
  /** null khi chưa xuất bản lần nào */
  latestPublishedVersion: z.number().int().nullable(),
  hasDraft: z.boolean(),
  /** số việc (task, approval) của bản mới nhất */
  stepCount: z.number().int(),
  runCount: z.number().int(),
  createdBy: PersonRefSchema,
  createdAt: InstantSchema,
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

/** Một quy trình mẫu có sẵn trong thư viện (docs/DECISIONS.md, 06/10/2026): chọn để tạo bản nháp của tổ chức, rồi sửa tiếp trong trình thiết kế. */
export const TemplatePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: TemplateCategorySchema,
  /** số việc (task, approval) */
  steps: z.number().int(),
  /** các dòng "ai làm gì" để người điều hành đọc nhanh trước khi chọn */
  summary: z.array(z.string()),
  definition: DraftDefinitionSchema,
});
export type TemplatePreset = z.infer<typeof TemplatePresetSchema>;

export const TemplateDraftSchema = z.object({
  version: z.number().int(),
  /** dùng cho If-Match khi lưu nháp */
  rev: z.number().int(),
  definition: DraftDefinitionSchema,
  updatedAt: InstantSchema,
});

export const TemplateDetailSchema = TemplateSummarySchema.extend({
  versions: z.array(TemplateVersionMetaSchema),
  /** chỉ process_designer thấy nháp */
  draft: TemplateDraftSchema.nullable(),
});
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

export const TemplateVersionSchema = z.object({
  templateId: IdSchema,
  templateName: z.string(),
  versionId: IdSchema,
  version: z.number().int(),
  status: z.enum(['draft', 'published']),
  definition: DraftDefinitionSchema,
  publishedAt: InstantSchema.nullable(),
});
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;

export const TemplateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  category: TemplateCategorySchema.optional(),
  /** nhân bản từ một mẫu khác (giai đoạn 3) */
  cloneFromTemplateId: IdSchema.optional(),
  /** bản nháp đầu; bỏ trống thì tạo nháp chỉ có Bắt đầu và Hoàn tất */
  definition: DraftDefinitionSchema.optional(),
});

export const DraftSaveSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: TemplateCategorySchema.optional(),
  definition: DraftDefinitionSchema,
});
export const DraftSaveResponseSchema = z.object({ rev: z.number().int(), updatedAt: InstantSchema });

export const ValidateResponseSchema = z.object({
  errors: z.array(DefinitionIssueSchema),
  warnings: z.array(DefinitionIssueSchema),
});
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

export const SimulateRequestSchema = z.object({
  /** bỏ trống: bản xuất bản mới nhất; với người vẽ và draft = true thì dùng nháp */
  version: z.number().int().optional(),
  draft: z.boolean().optional(),
  inputs: z.record(z.string(), z.unknown()),
});

export const SimulationRowViewSchema = z.object({
  nodeId: z.string(),
  kind: z.enum(['task', 'approval']),
  title: z.string(),
  assignee: PersonRefSchema.nullable(),
  onBehalfOf: PersonRefSchema.nullable(),
  dueAt: InstantSchema.nullable(),
  pastDue: z.boolean(),
  order: z.number().int(),
  /** việc duyệt kiểu góp nội dung; các việc khác bỏ trống */
  action: z.literal('contribute').optional(),
  /** người nhận do bước đứng trước chọn lúc chạy */
  assigneeChosenLater: z.boolean().optional(),
});
export type SimulationRowView = z.infer<typeof SimulationRowViewSchema>;

export const SimulateResponseSchema = z.object({
  rows: z.array(SimulationRowViewSchema),
  warnings: z.array(DefinitionIssueSchema),
  targetAt: InstantSchema.nullable(),
});
export type SimulateResponse = z.infer<typeof SimulateResponseSchema>;

export const PublishResponseSchema = z.object({ version: z.number().int(), versionId: IdSchema, publishedAt: InstantSchema });

/** So sánh hai phiên bản (giai đoạn 3) */
export const TemplateDiffSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      change: z.enum(['added', 'removed', 'changed']),
      label: z.string(),
      fields: z.array(z.string()),
    }),
  ),
  edges: z.array(z.object({ edgeId: z.string(), change: z.enum(['added', 'removed', 'changed']), from: z.string(), to: z.string() })),
});
