import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { ScrollText } from 'lucide-react';
import type { AuditEntry } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { endOfVnDay, isLocalDate, startOfVnDay } from '@/features/org/dates';
import { LoadError, useUnitNames } from '@/features/org/shared';
import { useCan } from '@/lib/auth';
import { sortByVi } from '@/lib/collator';
import { personName } from '@/lib/person';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/query';

const t = vi.admin.org.logs.audit;
const tl = vi.admin.org.logs;
const entryId = (e: AuditEntry) => e.id;

const ACTION_TEXT: Record<string, string> = t.actions;
const TARGET_TEXT: Record<string, string> = t.targets;

/** `template_unarchived` không phải mã hành động: máy chủ ghi `template_archived` kèm `detail.archived = false`. */
const ACTION_OPTIONS = sortByVi(
  Object.entries(t.actions).filter(([code]) => code !== 'template_unarchived'),
  ([, label]) => label,
).map(([value, label]) => ({ value, label }));

/** Tên hành động bằng tiếng Việt; mã chưa có trong kho chuỗi vẫn hiện được, kèm chính mã đó. */
function actionLabel(entry: AuditEntry): string {
  if (entry.action === 'template_archived' && entry.detail.archived === false) return t.actions.template_unarchived;
  return ACTION_TEXT[entry.action] ?? fmt(t.actionUnknown, { mã: entry.action });
}

function actorLabel(entry: AuditEntry): string {
  if (entry.actor) return personName(entry.actor, 'full');
  if (entry.actorType === 'system') return t.actorSystem;
  if (entry.actorType === 'ai_service') return t.actorAssistant;
  return t.actorUnknown;
}

/**
 * Nhật ký hoạt động (`admin.audit`, SPEC 11.3): ai đã làm gì, lúc nào, từ địa chỉ nào. Nhật ký chỉ lưu id của
 * đối tượng (luật 6: không chứa tên người), nên tên người và tên đơn vị được tra lại ở đây từ danh sách hiện có.
 */
export function AuditTab() {
  const can = useCan();
  const [action, setAction] = useState<string | null>(null);
  const [actor, setActor] = useState<PersonOption | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const rangeInvalid = isLocalDate(from) && isLocalDate(to) && from > to;

  const entries = useApiInfiniteQuery(
    'admin.audit',
    {
      query: {
        limit: 100,
        action: action ?? undefined,
        actorId: actor?.id,
        from: isLocalDate(from) ? startOfVnDay(from) : undefined,
        to: isLocalDate(to) ? endOfVnDay(to) : undefined,
      },
    },
    // Nhật ký mở ra là phải thấy thao tác vừa làm: không dùng lại số liệu cũ.
    { enabled: !rangeInvalid, staleTime: 0 },
  );

  const users = useApiQuery('users.list', { query: { limit: 200 } }, { enabled: can('user.manage'), staleTime: 60_000 });
  const unitNames = useUnitNames();
  const userNames = useMemo(() => new Map((users.data?.items ?? []).map((u) => [u.id, personName(u, 'full')])), [users.data]);

  const filtered = action !== null || actor !== null || from !== '' || to !== '';
  const clearFilters = () => {
    setAction(null);
    setActor(null);
    setFrom('');
    setTo('');
  };

  const columns = useMemo<ColumnDef<AuditEntry>[]>(() => {
    const targetName = (e: AuditEntry): string | undefined => {
      if (!e.targetId) return undefined;
      if (e.targetType === 'user') return userNames.get(e.targetId);
      if (e.targetType === 'unit') return unitNames.get(e.targetId);
      return undefined;
    };
    return [
      {
        id: 'at',
        header: t.col.at,
        enableSorting: false,
        meta: { className: 'w-[150px]' },
        cell: ({ row }) => (
          <time dateTime={row.original.at} className="tabular whitespace-nowrap">
            {formatDateTime(row.original.at)}
          </time>
        ),
      },
      { id: 'actor', header: t.col.actor, enableSorting: false, cell: ({ row }) => (row.original.actor ? actorLabel(row.original) : <span className="text-ink-sub">{actorLabel(row.original)}</span>) },
      { id: 'action', header: t.col.action, enableSorting: false, cell: ({ row }) => <span className="font-medium">{actionLabel(row.original)}</span> },
      {
        id: 'target',
        header: t.col.target,
        enableSorting: false,
        meta: { className: 'w-[210px]' },
        cell: ({ row: { original: e } }) => {
          if (!e.targetType) return <span className="text-ink-sub">–</span>;
          const name = targetName(e);
          return (
            <>
              <p>{TARGET_TEXT[e.targetType] ?? t.targetUnknown}</p>
              {name ? <p className="truncate text-sm text-ink-sub">{name}</p> : null}
            </>
          );
        },
      },
      {
        id: 'ip',
        header: t.col.ip,
        enableSorting: false,
        meta: { className: 'w-[132px]' },
        cell: ({ row }) => <span className="tabular text-ink-sub">{row.original.ip ?? '–'}</span>,
      },
    ];
  }, [userNames, unitNames]);

  return (
    <section aria-labelledby="tab-nhat-ky" className="flex min-w-0 flex-col gap-3">
      <h2 id="tab-nhat-ky" className="sr-only">
        {tl.page.tabs.audit}
      </h2>

      <div role="group" aria-label={t.filters} className="grid items-end gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_10rem_10rem_auto]">
        <Field label={t.filterAction} hideLabel>
          <Select value={action} onValueChange={setAction} options={ACTION_OPTIONS} emptyOption={t.allActions} />
        </Field>
        <PersonPicker aria-label={t.filterActor} placeholder={t.filterActorPlaceholder} value={actor} onChange={setActor} />
        <Field label={tl.from}>
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={tl.to}>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {filtered ? (
          <Button variant="ghost" onClick={clearFilters}>
            {tl.clearFilters}
          </Button>
        ) : null}
      </div>

      {rangeInvalid ? (
        <p role="alert" className="font-medium">
          {tl.rangeInvalid}
        </p>
      ) : entries.isError ? (
        <LoadError error={entries.error} onRetry={() => void entries.refetch()} />
      ) : (
        <DataTable
          caption={t.caption}
          tableClassName="min-w-[900px] table-fixed"
          columns={columns}
          data={entries.items}
          getRowId={entryId}
          isLoading={entries.isPending}
          hasMore={entries.hasNextPage}
          onLoadMore={() => void entries.fetchNextPage()}
          isLoadingMore={entries.isFetchingNextPage}
          empty={
            filtered ? (
              <EmptyState title={t.emptyFiltered.title} description={t.emptyFiltered.body} action={<Button onClick={clearFilters}>{tl.clearFilters}</Button>} />
            ) : (
              <EmptyState icon={ScrollText} title={t.empty.title} description={t.empty.body} />
            )
          }
        />
      )}
    </section>
  );
}
