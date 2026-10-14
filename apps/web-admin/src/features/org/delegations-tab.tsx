import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarClock, Check, History, Plus, Trash2, UsersRound, type LucideIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { DELEGATION_SCOPES, DelegationCreateSchema, DelegationScopeSchema, LocalDateSchema, ROLES, TEMPLATE_VIEW_ACTIONS, type DelegationScope, type DelegationView, type Role } from '@mihato/domain';
import { fmt, formatDate, formatTime, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useCan } from '@/lib/auth';
import { sortByVi } from '@/lib/collator';
import { vnToday } from '@/lib/datetime';
import { errorMessage } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { endOfVnDay, startOfVnDay } from './dates';
import { fieldIssue, LoadError, StateChip } from './shared';

const t = vi.admin.org.delegations;
const delegationId = (d: DelegationView) => d.id;

type Validity = 'active' | 'upcoming' | 'ended';
const VALIDITY_CHIP: Record<Validity, { tone: 'good' | 'plain' | 'muted'; icon: LucideIcon }> = {
  active: { tone: 'good', icon: Check },
  upcoming: { tone: 'plain', icon: CalendarClock },
  ended: { tone: 'muted', icon: History },
};

function validityOf(d: DelegationView): Validity {
  if (d.active) return 'active';
  return Date.parse(d.validFrom) > Date.now() ? 'upcoming' : 'ended';
}

function isRole(value: string | null): value is Role {
  return value !== null && (ROLES as readonly string[]).includes(value);
}

/** Ngày, kèm giờ khi mốc không rơi vào đầu ngày hoặc cuối ngày (ủy quyền tạo từ app có thể đặt giờ lẻ). */
function Moment({ at }: { at: string }) {
  const time = formatTime(at);
  const boundary = time === '00:00' || time === '23:59';
  return (
    <time dateTime={at} className="tabular whitespace-nowrap">
      {formatDate(at)}
      {boundary ? null : <span className="text-ink-sub"> {time}</span>}
    </time>
  );
}

// ───────────────────────── Thêm ủy quyền ─────────────────────────

const FormSchema = z
  .object({
    fromUserId: z.string().min(1),
    toUserId: z.string().min(1),
    fromDate: LocalDateSchema,
    toDate: LocalDateSchema,
    scope: DelegationScopeSchema,
    scopeRef: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.fromUserId && v.fromUserId === v.toUserId) ctx.addIssue({ code: 'custom', path: ['toUserId'], message: 'same' });
    if (v.toDate < v.fromDate) ctx.addIssue({ code: 'custom', path: ['toDate'], message: 'order' });
    if (v.scope !== 'all' && !v.scopeRef) ctx.addIssue({ code: 'custom', path: ['scopeRef'], message: 'required' });
  });
type FormValues = z.infer<typeof FormSchema>;

function DelegationForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const can = useCan();
  const canListTemplates = can(TEMPLATE_VIEW_ACTIONS);
  const [from, setFrom] = useState<PersonOption | null>(null);
  const [to, setTo] = useState<PersonOption | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { fromUserId: '', toUserId: '', fromDate: vnToday(), toDate: '', scope: 'all', scopeRef: null },
  });
  const { errors, isSubmitted } = form.formState;
  const scope = form.watch('scope');

  const templates = useApiQuery('templates.list', {}, { enabled: canListTemplates && scope === 'process', staleTime: 60_000 });
  const templateOptions = useMemo(() => sortByVi(templates.data?.items ?? [], (x) => x.name).map((x) => ({ value: x.id, label: x.name })), [templates.data]);
  const scopeOptions = DELEGATION_SCOPES.map((s: DelegationScope) => ({ value: s, label: t.scope[s], disabled: s === 'process' && !canListTemplates }));
  const roleOptions = ROLES.map((r: Role) => ({ value: r, label: vi.common.role[r] }));

  const create = useApiMutation('delegations.create', { toastError: false, invalidate: ['delegations.list', 'me.get', 'admin.audit'] });
  const toDisabled = fieldIssue(create.error, 'body.toUserId') === 'disabled';

  const submit = form.handleSubmit((values) => {
    if (!from || !to) return;
    const body = DelegationCreateSchema.parse({
      fromUserId: values.fromUserId,
      toUserId: values.toUserId,
      validFrom: startOfVnDay(values.fromDate),
      validTo: endOfVnDay(values.toDate),
      scope: values.scope,
      scopeRef: values.scope === 'all' ? null : values.scopeRef,
    });
    create.mutate(
      { body },
      {
        onSuccess: () => {
          toast.success(fmt(t.form.created, { 'người ủy': personName(from, 'short'), 'người nhận': personName(to, 'short') }));
          onOpenChange(false);
        },
      },
    );
  });

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.form.title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {create.isError ? <Callout tone="error">{toDisabled ? t.form.errors.toDisabled : errorMessage(create.error)}</Callout> : null}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label={t.form.from} hint={t.form.fromHint} required error={errors.fromUserId ? t.form.errors.from : undefined}>
            <PersonPicker
              value={from}
              excludeIds={to ? [to.id] : undefined}
              onChange={(p) => {
                setFrom(p);
                form.setValue('fromUserId', p?.id ?? '', { shouldValidate: isSubmitted });
              }}
            />
          </Field>
          <Field label={t.form.to} hint={t.form.toHint} required error={errors.toUserId ? (errors.toUserId.message === 'same' ? t.form.errors.sameUser : t.form.errors.to) : undefined}>
            <PersonPicker
              value={to}
              excludeIds={from ? [from.id] : undefined}
              onChange={(p) => {
                setTo(p);
                form.setValue('toUserId', p?.id ?? '', { shouldValidate: isSubmitted });
              }}
            />
          </Field>
        </div>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label={t.form.validFrom} required error={errors.fromDate ? t.form.errors.date : undefined}>
            <Input type="date" {...form.register('fromDate')} />
          </Field>
          <Field label={t.form.validTo} required error={errors.toDate ? (errors.toDate.message === 'order' ? t.form.errors.dateOrder : t.form.errors.date) : undefined}>
            <Input type="date" min={form.watch('fromDate') || undefined} {...form.register('toDate')} />
          </Field>
        </div>
        <Field label={t.form.scope} hint={t.form.scopeHint[scope]}>
          <Controller
            control={form.control}
            name="scope"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(v) => {
                  const next = DelegationScopeSchema.safeParse(v);
                  if (!next.success) return;
                  field.onChange(next.data);
                  form.setValue('scopeRef', null, { shouldValidate: isSubmitted });
                }}
                options={scopeOptions}
              />
            )}
          />
        </Field>
        {canListTemplates ? null : <p className="-mt-2 text-sm text-ink-sub">{t.form.processUnavailable}</p>}
        {scope === 'process' ? (
          <Field label={t.form.process} required error={errors.scopeRef ? t.form.errors.process : undefined}>
            <Controller
              control={form.control}
              name="scopeRef"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={(v) => form.setValue('scopeRef', v, { shouldValidate: isSubmitted })}
                  options={templateOptions}
                  placeholder={templates.isPending ? vi.common.loading : t.form.processPlaceholder}
                  disabled={templates.isPending}
                />
              )}
            />
          </Field>
        ) : null}
        {scope === 'role' ? (
          <Field label={t.form.role} required error={errors.scopeRef ? t.form.errors.role : undefined}>
            <Controller
              control={form.control}
              name="scopeRef"
              render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => form.setValue('scopeRef', v, { shouldValidate: isSubmitted })} options={roleOptions} placeholder={t.form.rolePlaceholder} />
              )}
            />
          </Field>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t.form.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ───────────────────────── Bảng ủy quyền ─────────────────────────

/** Tab "Ủy quyền" (SPEC 4.8): bảng mọi ủy quyền của tổ chức, thêm (`delegations.create`) và xoá có hỏi lại (`delegations.delete`). */
export function DelegationsTab() {
  const can = useCan();
  const canListTemplates = can(TEMPLATE_VIEW_ACTIONS);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DelegationView | null>(null);

  const delegations = useApiQuery('delegations.list', {});
  const templates = useApiQuery('templates.list', {}, { enabled: canListTemplates, staleTime: 60_000 });
  const templateNames = useMemo(() => new Map((templates.data?.items ?? []).map((x) => [x.id, x.name])), [templates.data]);
  const remove = useApiMutation('delegations.delete', { invalidate: ['delegations.list', 'me.get', 'admin.audit'] });

  const columns = useMemo<ColumnDef<DelegationView>[]>(() => {
    const scopeText = (d: DelegationView): string => {
      if (d.scope === 'role') return isRole(d.scopeRef) ? fmt(t.scopeRole, { tên: vi.common.role[d.scopeRef] }) : t.scope.role;
      if (d.scope === 'process') {
        const name = d.scopeRef ? templateNames.get(d.scopeRef) : undefined;
        return name ? fmt(t.scopeProcess, { tên: name }) : t.scope.process;
      }
      return t.scope.all;
    };
    return [
      { id: 'from', accessorFn: (d) => `${d.fromUser.givenName} ${d.fromUser.fullName}`, header: t.col.from, cell: ({ row }) => <span className="font-medium">{personName(row.original.fromUser, 'full')}</span> },
      { id: 'to', accessorFn: (d) => `${d.toUser.givenName} ${d.toUser.fullName}`, header: t.col.to, cell: ({ row }) => personName(row.original.toUser, 'full') },
      { id: 'validFrom', accessorFn: (d) => d.validFrom, header: t.col.validFrom, meta: { className: 'w-[116px]' }, cell: ({ row }) => <Moment at={row.original.validFrom} /> },
      { id: 'validTo', accessorFn: (d) => d.validTo, header: t.col.validTo, meta: { className: 'w-[116px]' }, cell: ({ row }) => <Moment at={row.original.validTo} /> },
      { id: 'scope', accessorFn: scopeText, header: t.col.scope, meta: { className: 'w-[188px]' }, cell: ({ row }) => scopeText(row.original) },
      {
        id: 'state',
        accessorFn: (d) => t.state[validityOf(d)],
        header: t.col.state,
        meta: { className: 'w-[148px]' },
        cell: ({ row }) => {
          const validity = validityOf(row.original);
          return (
            <StateChip tone={VALIDITY_CHIP[validity].tone} icon={VALIDITY_CHIP[validity].icon}>
              {t.state[validity]}
            </StateChip>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>,
        enableSorting: false,
        meta: { align: 'right', className: 'w-[104px]' },
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" aria-label={fmt(t.removeFor, { tên: personName(row.original.fromUser, 'short') })} onClick={() => setRemoving(row.original)}>
            <Trash2 aria-hidden="true" />
            {t.remove}
          </Button>
        ),
      },
    ];
  }, [templateNames]);

  return (
    <section aria-labelledby="tab-uy-quyen" className="flex min-w-0 flex-col gap-3">
      <h2 id="tab-uy-quyen" className="sr-only">
        {vi.admin.org.page.tabs.delegations}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="max-w-[72ch] text-ink-sub">{t.intro}</p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          {t.add}
        </Button>
      </div>

      {delegations.isError ? (
        <LoadError error={delegations.error} onRetry={() => void delegations.refetch()} />
      ) : (
        <DataTable
          caption={t.caption}
          tableClassName="min-w-[920px] table-fixed"
          columns={columns}
          data={delegations.data?.items ?? []}
          getRowId={delegationId}
          isLoading={delegations.isPending}
          empty={
            <EmptyState
              icon={UsersRound}
              title={t.empty.title}
              description={t.empty.body}
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  {t.add}
                </Button>
              }
            />
          }
        />
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DelegationForm onOpenChange={setAdding} />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoving(null);
        }}
        tone="danger"
        title={t.removeTitle}
        description={removing ? fmt(t.removeBody, { 'người ủy': personName(removing.fromUser, 'short'), 'người nhận': personName(removing.toUser, 'short') }) : undefined}
        confirmLabel={t.removeConfirm}
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate({ params: { id: removing.id } }, { onSuccess: () => toast.success(t.removed), onSettled: () => setRemoving(null) });
        }}
      />
    </section>
  );
}
