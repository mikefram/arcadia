import { z } from 'zod';
import { HonorificSchema, IdSchema } from '../enums';

/** Tham chiếu người (SPEC 10.5). `honorific` có thể trống với tài khoản dùng chung (ví dụ tài khoản Văn phòng). */
export const PersonRefSchema = z.object({
  id: IdSchema,
  fullName: z.string(),
  givenName: z.string(),
  honorific: HonorificSchema.nullable(),
});
export type PersonRef = z.infer<typeof PersonRefSchema>;

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export function paged<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export type Paged<T> = { items: T[]; nextCursor: string | null };

export const OkSchema = z.object({ ok: z.literal(true) });
export const IdParamSchema = z.object({ id: IdSchema });

/** Chuỗi 'true'/'false' ở query → boolean. */
export const QueryBoolSchema = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');
