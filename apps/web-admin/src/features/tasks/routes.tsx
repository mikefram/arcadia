import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { BUCKETS, STEP_STATES, type Bucket, type StepStateName } from '@mihato/domain';
import { requireAny, shellRoute } from '@/app/root';

/** Bộ lọc của bảng Công việc nằm ở đường dẫn, để Tổng quan dẫn thẳng tới `?state=unassigned` hay `?late=true`. */
export type TasksSearch = {
  state?: StepStateName;
  bucket?: Bucket;
  late?: boolean;
  kind?: 'task' | 'approval';
  runId?: string;
  unitId?: string;
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseTasksSearch(search: Record<string, unknown>): TasksSearch {
  const out: TasksSearch = {};
  const state = oneOf(search.state, STEP_STATES);
  const bucket = oneOf(search.bucket, BUCKETS);
  const kind = oneOf(search.kind, ['task', 'approval'] as const);
  const runId = text(search.runId);
  const unitId = text(search.unitId);
  if (state) out.state = state;
  if (bucket) out.bucket = bucket;
  if (search.late === true || search.late === 'true') out.late = true;
  if (kind) out.kind = kind;
  if (runId) out.runId = runId;
  if (unitId) out.unitId = unitId;
  return out;
}

/** Công việc: bảng mọi việc của tổ chức. */
const tasksRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/cong-viec',
  validateSearch: parseTasksSearch,
  beforeLoad: requireAny(['run.view_all']),
  component: lazyRouteComponent(() => import('./tasks-page'), 'TasksPage'),
});

export const tasksRoutes = [tasksRoute] as const;
