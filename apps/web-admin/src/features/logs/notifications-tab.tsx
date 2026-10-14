import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { BellRing, CheckCheck, CircleAlert, Clock, MailOpen, Send, type LucideIcon } from 'lucide-react';
import type { RouteResponse } from '@mihato/api-client';
import { NOTIFICATION_STATES, type NotificationState } from '@mihato/domain';
import { formatDateTime, formatTime, vi, vnDateKey, vnParts } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { LoadError, StateChip } from '@/features/org/shared';
import { personName } from '@/lib/person';
import { useApiInfiniteQuery } from '@/lib/query';

const t = vi.admin.org.logs.notifications;
const tl = vi.admin.org.logs;

type Row = RouteResponse<'admin.notifications'>['items'][number];
const rowId = (n: Row) => n.id;

const KIND_TEXT: Record<string, string> = t.kinds;

const STATE_CHIP: Record<NotificationState, { tone: 'plain' | 'good' | 'warn'; icon: LucideIcon }> = {
  queued: { tone: 'plain', icon: Clock },
  sent: { tone: 'plain', icon: Send },
  delivered: { tone: 'plain', icon: CheckCheck },
  opened: { tone: 'good', icon: MailOpen },
  failed: { tone: 'warn', icon: CircleAlert },
};
const STATE_OPTIONS = NOTIFICATION_STATES.map((s: NotificationState) => ({ value: s, label: t.state[s] }));

const p2 = (n: number) => String(n).padStart(2, '0');

/** Một mốc giờ. Cùng ngày với lúc tạo thì chỉ hiện giờ cho gọn; khác ngày thì thêm ngày và tháng. Chưa tới mốc: "Chưa". */
function Milestone({ at, createdAt }: { at: string | null; createdAt: string }) {
  if (!at) return <span className="text-ink-sub">{t.notYet}</span>;
  const sameDay = vnDateKey(at) === vnDateKey(createdAt);
  const p = vnParts(at);
  return (
    <time dateTime={at} title={formatDateTime(at)} className="tabular whitespace-nowrap">
      {sameDay ? formatTime(at) : `${p2(p.day)}/${p2(p.month)} ${formatTime(at)}`}
    </time>
  );
}

const milestone = (id: 'sent' | 'delivered' | 'opened', key: 'sentAt' | 'deliveredAt' | 'openedAt'): ColumnDef<Row> => ({
  id,
  header: t.col[id],
  enableSorting: false,
  meta: { className: 'w-[92px]' },
  cell: ({ row }) => <Milestone at={row.original[key]} createdAt={row.original.createdAt} />,
});

const columns: ColumnDef<Row>[] = [
  {
    id: 'user',
    header: t.col.user,
    enableSorting: false,
    meta: { className: 'w-[170px]' },
    cell: ({ row }) => <span className="font-medium">{personName(row.original.user, 'full')}</span>,
  },
  {
    id: 'message',
    header: t.col.message,
    enableSorting: false,
    cell: ({ row: { original: n } }) => (
      <>
        <p className="truncate" title={n.title}>
          {n.title}
        </p>
        <p className="text-sm text-ink-sub">{KIND_TEXT[n.kind] ?? t.kindUnknown}</p>
      </>
    ),
  },
  {
    id: 'state',
    header: t.col.state,
    enableSorting: false,
    meta: { className: 'w-[112px]' },
    cell: ({ row: { original: n } }) => (
      <StateChip tone={STATE_CHIP[n.state].tone} icon={STATE_CHIP[n.state].icon}>
        {t.state[n.state]}
      </StateChip>
    ),
  },
  {
    id: 'created',
    header: t.col.created,
    enableSorting: false,
    meta: { className: 'w-[144px]' },
    cell: ({ row }) => (
      <time dateTime={row.original.createdAt} className="tabular whitespace-nowrap">
        {formatDateTime(row.original.createdAt)}
      </time>
    ),
  },
  milestone('sent', 'sentAt'),
  milestone('delivered', 'deliveredAt'),
  milestone('opened', 'openedAt'),
];

function isState(value: string | null): value is NotificationState {
  return value !== null && (NOTIFICATION_STATES as readonly string[]).includes(value);
}

/** Trạng thái gửi và đọc của thông báo (`admin.notifications`, SPEC 4.6): chờ gửi, đã gửi, đã giao, đã mở, lỗi, kèm các mốc giờ. */
export function NotificationsTab() {
  const [state, setState] = useState<NotificationState | null>(null);
  const [person, setPerson] = useState<PersonOption | null>(null);
  const rows = useApiInfiniteQuery('admin.notifications', { query: { limit: 50, state: state ?? undefined, userId: person?.id } });
  const filtered = state !== null || person !== null;
  const clearFilters = () => {
    setState(null);
    setPerson(null);
  };

  return (
    <section aria-labelledby="tab-thong-bao" className="flex min-w-0 flex-col gap-3">
      <h2 id="tab-thong-bao" className="sr-only">
        {tl.page.tabs.notifications}
      </h2>
      <p className="max-w-[80ch] text-ink-sub">{t.intro}</p>

      <div role="group" aria-label={t.filters} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[14rem_18rem_auto] lg:justify-start">
        <Field label={t.filterState} hideLabel>
          <Select value={state} onValueChange={(v) => setState(isState(v) ? v : null)} options={STATE_OPTIONS} emptyOption={t.allStates} />
        </Field>
        <PersonPicker aria-label={t.filterUser} placeholder={t.filterUserPlaceholder} value={person} onChange={setPerson} />
        {filtered ? (
          <Button variant="ghost" className="justify-self-start" onClick={clearFilters}>
            {tl.clearFilters}
          </Button>
        ) : null}
      </div>

      {rows.isError ? (
        <LoadError error={rows.error} onRetry={() => void rows.refetch()} />
      ) : (
        <DataTable
          caption={t.caption}
          tableClassName="min-w-[960px] table-fixed"
          columns={columns}
          data={rows.items}
          getRowId={rowId}
          isLoading={rows.isPending}
          hasMore={rows.hasNextPage}
          onLoadMore={() => void rows.fetchNextPage()}
          isLoadingMore={rows.isFetchingNextPage}
          empty={
            filtered ? (
              <EmptyState title={t.emptyFiltered.title} description={t.emptyFiltered.body} action={<Button onClick={clearFilters}>{tl.clearFilters}</Button>} />
            ) : (
              <EmptyState icon={BellRing} title={t.empty.title} description={t.empty.body} />
            )
          }
        />
      )}
    </section>
  );
}
