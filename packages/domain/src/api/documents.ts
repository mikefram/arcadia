import { z } from 'zod';
import { IdSchema, InstantSchema, RunStateSchema } from '../enums';
import { isValidNumberPattern } from '../document-number';
import { PageQuerySchema, PersonRefSchema } from './common';

/** Sổ văn bản (docs/DECISIONS.md, 06/10/2026): văn bản đến, văn bản đi và số chỉ thị, đánh số theo mẫu. */
export const REGISTER_DIRECTIONS = ['incoming', 'outgoing', 'internal'] as const;
export const RegisterDirectionSchema = z.enum(REGISTER_DIRECTIONS);
export type RegisterDirection = z.infer<typeof RegisterDirectionSchema>;

export const RegisterCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
export const RegisterColumnSchema = z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), label: z.string().min(1).max(100) });
export type RegisterColumn = z.infer<typeof RegisterColumnSchema>;

export const RegisterViewSchema = z.object({
  code: RegisterCodeSchema,
  name: z.string(),
  direction: RegisterDirectionSchema,
  pattern: z.string(),
  resetPolicy: z.enum(['yearly', 'never']),
  columns: z.array(RegisterColumnSchema),
  entryCount: z.number().int(),
  /** số kế tiếp sẽ cấp trong năm nay, để người cấu hình thấy ngay hiệu quả của mẫu */
  nextNumber: z.string(),
  archivedAt: InstantSchema.nullable(),
});
export type RegisterView = z.infer<typeof RegisterViewSchema>;

export const RegisterUpsertSchema = z.object({
  name: z.string().min(1).max(200),
  direction: RegisterDirectionSchema,
  pattern: z.string().refine(isValidNumberPattern, { message: 'invalid_pattern' }),
  resetPolicy: z.enum(['yearly', 'never']).default('yearly'),
  columns: z.array(RegisterColumnSchema).max(12).default([]),
});
export type RegisterUpsert = z.infer<typeof RegisterUpsertSchema>;

export const RegisterEntryViewSchema = z.object({
  id: IdSchema,
  number: z.string(),
  year: z.number().int(),
  seq: z.number().int(),
  createdAt: InstantSchema,
  subject: z.string(),
  createdBy: PersonRefSchema.nullable(),
  run: z.object({ id: IdSchema, state: RunStateSchema }),
  /** ảnh chụp các ô lên cột của sổ lúc cấp số */
  values: z.record(z.string(), z.unknown()),
});
export type RegisterEntryView = z.infer<typeof RegisterEntryViewSchema>;

export const RegisterEntriesQuerySchema = PageQuerySchema.extend({
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  q: z.string().max(200).optional(),
});
export const RegisterEntriesSchema = z.object({ items: z.array(RegisterEntryViewSchema), nextCursor: z.string().nullable() });
