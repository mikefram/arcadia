import { useState, type ReactNode } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { BellRing, CalendarClock, ChevronRight, CircleCheck, ClipboardCheck, Hand, Stamp, TriangleAlert, UserRoundPen, Users } from 'lucide-react';
import type { Bucket, StepView } from '@mihato/domain';
import { fmt, formatDateTime, formatMoney, vi } from '@mihato/i18n';
import { CommentCount } from '@/components/comment-count';
import { formatDue } from '@/components/due-label';
import { StatusChip } from '@/components/status-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/query';
import { Callout } from '@/components/ui/callout';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { allows, ReassignDialog } from '@/features/dispatch';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { vnDayDiff } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiInfiniteQuery, type ApiInfiniteResult } from '@/lib/query';
import type { MyTasksTab } from './routes';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.runs.myTasks;
const route = getRouteApi('/shell/viec-cua-toi');

type GroupKey = 'overdue' | 'today' | 'upcoming' | 'other';
const GROUPS: readonly GroupKey[] = ['overdue', 'today', 'upcoming', 'other'];

function groupOf(bucket: Bucket): GroupKey {
  return bucket === 'overdue' || bucket === 'today' || bucket === 'upcoming' ? bucket : 'other';
}

/**
 * Thẻ một việc: tên việc, lượt chạy, hạn, người giao (hoặc người nhận ở "Nhóm của tôi"), trạng thái.
 * Cả thẻ là một đường dẫn tới trang việc, cao tối thiểu 72px để chạm được dễ trên điện thoại.
 */
function StepCard({ step, team = false, onReassign }: { step: StepView; team?: boolean; onReassign?: (step: StepView) => void }) {
  const done = step.bucket === 'done';
  const person = team ? step.assignee : step.assignedBy;
  const nudgedToday = !done && step.lastNudgedAt !== null && vnDayDiff(step.lastNudgedAt) === 0;
  const cardId = `viec-${team ? 'nhom-' : ''}${step.id}`;
  return (
    <li className={cn('flex flex-col transition-colors hover:bg-canvas', step.isOverdue && 'bg-late-bg/40 hover:bg-late-bg/60')}>
      {/* Tên đường dẫn là tên việc; lượt chạy, trạng thái, hạn là phần mô tả, để trình đọc màn hình đọc đủ cả thẻ. */}
      <Link
        to="/viec-cua-toi/$stepId"
        params={{ stepId: step.id }}
        aria-labelledby={`${cardId}-ten`}
        aria-describedby={`${cardId}-chi-tiet`}
        className="flex min-h-[72px] min-w-0 items-center gap-3 px-4 py-3 -outline-offset-2 sm:px-5"
      >
        <span id={`${cardId}-chi-tiet`} className="min-w-0 flex-1">
          <span id={`${cardId}-ten`} className="block text-lg leading-snug font-semibold text-ink">
            {step.title}
          </span>
          <span className="mt-0.5 block truncate text-sm text-ink-sub">{runLabel(step)}</span>
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusChip step={step} />
            {done && step.completedAt ? (
              <time dateTime={step.completedAt} className="tabular text-sm text-ink-sub">
                {fmt(step.state === 'done' ? t.card.completedAt : t.card.closedAt, { ngày: formatDateTime(step.completedAt) })}
              </time>
            ) : (
              <span className="inline-flex items-baseline gap-1.5 text-sm">
                {step.dueAt ? <span className="text-ink-sub">{vi.common.due.label}</span> : null}
                {step.dueAt ? (
                  <time dateTime={step.dueAt} className={cn('tabular', step.isOverdue ? 'font-medium text-late' : vnDayDiff(step.dueAt) === 0 && 'font-medium text-warn')}>
                    {formatDue(step.dueAt)}
                  </time>
                ) : (
                  <span className="text-ink-sub">{vi.common.due.none}</span>
                )}
              </span>
            )}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-sub">
            {person ? <span>{fmt(team ? t.card.assignee : t.card.assignedBy, { tên: personName(person, team ? 'full' : 'short') })}</span> : null}
            {step.onBehalfOf && !team ? <span>{fmt(t.card.onBehalfOf, { tên: personName(step.onBehalfOf, 'short') })}</span> : null}
            {step.kind === 'approval' && !done ? (
              <Badge tone="gold">
                <Stamp aria-hidden="true" />
                {t.card.needsApproval}
              </Badge>
            ) : null}
            {step.kind === 'approval' && step.amountVnd !== null ? <span className="tabular font-medium text-ink">{fmt(t.card.amount, { tiền: formatMoney(step.amountVnd) })}</span> : null}
            {step.blockedReason ? (
              <Badge tone="warn">
                <Hand aria-hidden="true" />
                {t.card.blocked}
              </Badge>
            ) : null}
            {step.pendingExtension ? (
              <Badge tone="muted">
                <CalendarClock aria-hidden="true" />
                {t.card.extensionPending}
              </Badge>
            ) : null}
            <CommentCount count={step.commentCount} />
            {nudgedToday ? (
              <Badge tone="muted">
                <BellRing aria-hidden="true" />
                {t.card.nudged}
              </Badge>
            ) : null}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-ink-sub" />
      </Link>
      {team && onReassign && allows(step, 'reassign') ? (
        <div className="flex justify-end px-4 pb-3 sm:px-5">
          <Button size="sm" aria-label={fmt(t.card.reassignFor, { việc: step.title })} onClick={() => onReassign(step)} className="pointer-coarse:h-10">
            <UserRoundPen aria-hidden="true" />
            {t.card.reassign}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function CardList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface">
      {children}
    </ul>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface">
      {[0, 1, 2].map((i) => (
        <div key={i} className="px-4 py-3.5 sm:px-5">
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="mt-2 h-4 w-2/5" />
          <Skeleton className="mt-3 h-6 w-48 max-w-full" />
        </div>
      ))}
    </div>
  );
}

type StepsQuery = ApiInfiniteResult<'steps.list'>;

function LoadState({ query, children, empty }: { query: StepsQuery; children: ReactNode; empty: ReactNode }) {
  if (query.isPending) return <ListSkeleton />;
  if (query.isError) {
    return (
      <Callout
        tone="error"
        title={vi.admin.shell.ui.loadFailedTitle}
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            {vi.admin.shell.ui.retry}
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Callout>
    );
  }
  if (query.items.length === 0) return <div className="rounded-xl border border-hairline bg-surface">{empty}</div>;
  return (
    <div className="flex flex-col gap-5">
      {children}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {t.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Các việc đang mở, chia nhóm Quá hạn, Hôm nay, Sắp tới theo `bucket` do máy chủ tính; trong nhóm xếp theo hạn. */
function GroupedList({ steps, team, onReassign }: { steps: readonly StepView[]; team?: boolean; onReassign?: (step: StepView) => void }) {
  return (
    <>
      {GROUPS.map((key) => {
        const items = steps.filter((s) => groupOf(s.bucket) === key);
        if (items.length === 0) return null;
        const headingId = `viec-nhom-${team ? 'don-vi-' : ''}${key}`;
        return (
          <section key={key} aria-labelledby={headingId} className="flex flex-col gap-2">
            <h2 id={headingId} className={cn('flex items-center gap-2 text-base font-semibold', key === 'overdue' ? 'text-late' : 'text-ink')}>
              {key === 'overdue' ? <TriangleAlert aria-hidden="true" className="size-4" /> : null}
              {t.groups[key]}
              <span className={cn('tabular text-sm font-medium', key === 'overdue' ? 'text-late' : 'text-ink-sub')}>{fmt(t.groupCount, { n: items.length })}</span>
            </h2>
            <CardList>
              {items.map((step) => (
                <StepCard key={step.id} step={step} team={team} onReassign={onReassign} />
              ))}
            </CardList>
          </section>
        );
      })}
    </>
  );
}

/**
 * Việc của tôi (SPEC 8.2 S1, S8): tab Cần làm (Quá hạn, Hôm nay, Sắp tới) và Đã xong; trưởng đơn vị có thêm
 * Nhóm của tôi. Bố cục một cột, dùng được ở bề rộng 360px. Danh sách tự làm mới khi có sự kiện SSE.
 */
export function MyTasksPage() {
  const me = useMe();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const tab: MyTasksTab = search.tab === 'team' && !me.isUnitHead ? 'todo' : (search.tab ?? 'todo');
  const [reassigning, setReassigning] = useState<StepView | null>(null);

  const todo = useApiInfiniteQuery('steps.list', { query: { assignee: 'me', open: true, sort: 'dueAt', limit: 100 } });
  const done = useApiInfiniteQuery('steps.list', { query: { assignee: 'me', bucket: 'done', sort: '-completedAt', limit: 30 } }, { enabled: tab === 'done' });
  const team = useApiInfiniteQuery('steps.list', { query: { scope: 'team', open: true, sort: 'dueAt', limit: 100 } }, { enabled: me.isUnitHead && tab === 'team' });

  // Quy trình mà người này khởi chạy được (ví dụ nhân viên soạn văn bản đi): hiện nút khởi chạy ngay ở đầu trang.
  const startable = useApiQuery('templates.list', { query: {} });
  const canStartAny = (startable.data?.items ?? []).some((x) => x.canStart);

  const todoCount = todo.isSuccess ? `${todo.items.length}${todo.hasNextPage ? '+' : ''}` : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader
        className="mb-0"
        title={t.title}
        description={t.description}
        actions={
          canStartAny ? (
            <Button asChild variant="primary">
              <Link to="/luot-chay/moi" data-testid="start-process">
                {t.startProcess}
              </Link>
            </Button>
          ) : null
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) => void navigate({ replace: true, search: value === 'done' || value === 'team' ? { tab: value } : {} })}
      >
        <TabsList aria-label={t.tabsLabel}>
          <TabsTrigger value="todo" className="h-11">
            <ClipboardCheck aria-hidden="true" className="hidden size-4 sm:block" />
            {t.tabs.todo}
            {todoCount && todoCount !== '0' ? (
              <Badge tone="count" className="ml-0.5">
                {todoCount}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="done" className="h-11">
            <CircleCheck aria-hidden="true" className="hidden size-4 sm:block" />
            {t.tabs.done}
          </TabsTrigger>
          {me.isUnitHead ? (
            <TabsTrigger value="team" className="h-11">
              <Users aria-hidden="true" className="hidden size-4 sm:block" />
              {t.tabs.team}
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="todo">
          <LoadState query={todo} empty={<EmptyState icon={CircleCheck} title={t.emptyTodoTitle} description={t.emptyTodoBody} />}>
            <GroupedList steps={todo.items} />
          </LoadState>
        </TabsContent>

        <TabsContent value="done">
          <LoadState query={done} empty={<EmptyState icon={ClipboardCheck} title={t.emptyDoneTitle} description={t.emptyDoneBody} />}>
            <CardList label={t.tabs.done}>
              {done.items.map((step) => (
                <StepCard key={step.id} step={step} />
              ))}
            </CardList>
          </LoadState>
        </TabsContent>

        {me.isUnitHead ? (
          <TabsContent value="team">
            <p className="mb-4 text-ink-sub">{t.teamIntro}</p>
            <LoadState query={team} empty={<EmptyState icon={Users} title={t.emptyTeamTitle} description={t.emptyTeamBody} />}>
              <GroupedList steps={team.items} team onReassign={setReassigning} />
            </LoadState>
          </TabsContent>
        ) : null}
      </Tabs>

      {/* Trưởng đơn vị đổi người nhận trong đơn vị mình; máy chủ kiểm phạm vi. */}
      <ReassignDialog
        open={reassigning !== null}
        steps={reassigning ? [reassigning] : []}
        onOpenChange={(open) => {
          if (!open) setReassigning(null);
        }}
      />
    </div>
  );
}
