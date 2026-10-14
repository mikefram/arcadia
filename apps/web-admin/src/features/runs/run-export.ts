import type { RunStateName, RunSummary } from '@mihato/domain';
import { formatDate, formatDateTime, vi } from '@mihato/i18n';
import { api } from '@/lib/api';
import type { CsvColumn } from '@/lib/csv';
import { personName } from '@/lib/person';

const t = vi.admin.documents.runsExport;

/** Mỗi lần lấy 200 lượt (mức tối đa của máy chủ), dừng ở 5.000. */
const PAGE = 200;
export const RUN_EXPORT_CAP = 5000;

/** Cột của tệp CSV danh sách lượt chạy: chữ giống màn hình, ngày giờ theo giờ Việt Nam. Chống chèn công thức do `lib/csv.ts` lo. */
export const RUN_CSV_COLUMNS: CsvColumn<RunSummary>[] = [
  { header: t.colTitle, value: (r) => r.title },
  { header: t.colTemplate, value: (r) => (r.adhoc ? t.adhoc : r.templateName) },
  { header: t.colState, value: (r) => vi.common.runState[r.state] },
  { header: t.colProgress, value: (r) => `${r.progress.done}/${r.progress.total}` },
  { header: t.colTarget, value: (r) => (r.targetAt ? formatDate(r.targetAt) : '') },
  { header: t.colInitiator, value: (r) => personName(r.initiator, 'full') },
  { header: t.colStarted, value: (r) => (r.startedAt ? formatDateTime(r.startedAt) : '') },
  { header: t.colCompleted, value: (r) => (r.completedAt ? formatDateTime(r.completedAt) : '') },
];

/** Bộ lọc của danh sách lượt chạy (cùng tên với `runs.list`), trừ phân trang. */
export type RunExportQuery = {
  state?: RunStateName;
  unitId?: string;
  templateId?: string;
  q?: string;
  late?: boolean;
  adhoc?: boolean;
  sort: '-startedAt' | 'startedAt' | 'targetAt' | '-targetAt';
};

/** Tải mọi trang của `runs.list` theo bộ lọc đang dùng, để tệp xuất không chỉ gồm các dòng đã hiện. */
export async function fetchAllRuns(query: RunExportQuery): Promise<{ items: RunSummary[]; capped: boolean }> {
  const items: RunSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call('runs.list', { query: { ...query, limit: PAGE, cursor } });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < RUN_EXPORT_CAP);
  return { items: items.slice(0, RUN_EXPORT_CAP), capped: cursor !== undefined };
}
