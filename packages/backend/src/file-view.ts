import type { FileView } from '@mihato/domain';
import type { OrgContext } from './context';
import type { schema } from './db/client';

export type FileRow = typeof schema.files.$inferSelect;

/** Tên trường đánh dấu tệp tổng hợp do máy chủ dựng. */
export const COMPILED_FIELD = '__compiled';

/** Dựng FileView từ một dòng; `stepTitles` tra tên việc theo id. */
export function toFileView(ctx: OrgContext, row: FileRow, stepTitles: ReadonlyMap<string, string> = new Map()): FileView {
  return {
    id: row.id,
    name: row.name ?? 'tệp',
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    uploadedBy: ctx.person(row.ownerUserId),
    uploadedAt: row.createdAt.toISOString(),
    fieldKey: row.fieldKey,
    runId: row.runId,
    stepId: row.stepRunId,
    stepTitle: row.stepRunId ? (stepTitles.get(row.stepRunId) ?? null) : null,
    compiled: row.fieldKey === COMPILED_FIELD,
    renditionOf: row.sourceFileId ?? null,
    status: row.status === 'pending' ? 'pending' : 'attached',
  };
}
