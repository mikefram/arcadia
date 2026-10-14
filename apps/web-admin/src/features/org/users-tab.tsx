import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Check, Ellipsis, FileUp, Hourglass, KeyRound, MailPlus, Minus, Pencil, QrCode, Search, ShieldCheck, ShieldOff, Smartphone, UserPlus, UserRoundCheck, UserRoundX, type LucideIcon } from 'lucide-react';
import { USER_STATUSES, type UserStatus, type UserView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, useAfterMenuClose } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { UnitSelect } from '@/components/unit-select';
import { useCan, useMe } from '@/lib/auth';
import { useDebouncedValue } from '@/lib/hooks';
import { personName } from '@/lib/person';
import { toast } from '@/components/ui/toast';
import { useApiInfiniteQuery, useApiMutation } from '@/lib/query';
import { DevicesSheet } from './devices-sheet';
import { LoadError, StateChip, useUnitNames } from './shared';
import { TotpResetDialog } from './totp-reset-dialog';
import { canResetTotp } from './totp-reset-model';
import { ActivationDialog, PasswordLinkDialog } from './user-access-dialogs';
import { UserFormSheet } from './user-form-sheet';
import { UserImportDialog } from './user-import-dialog';
import { UserPermissionsSheet } from './user-permissions-sheet';
import { DisableUserDialog, EnableUserDialog } from './user-status-dialogs';

const t = vi.admin.org.users;
const userId = (u: UserView) => u.id;

type UserAction = 'edit' | 'permissions' | 'activation' | 'passwordLink' | 'inviteEmail' | 'totpReset' | 'devices' | 'disable' | 'enable';
type OpenDialog = { kind: 'new' } | { kind: 'import' } | { kind: UserAction; user: UserView } | null;

const STATUS_CHIP: Record<UserStatus, { tone: 'plain' | 'good' | 'muted'; icon: LucideIcon }> = {
  invited: { tone: 'plain', icon: Hourglass },
  active: { tone: 'good', icon: Check },
  disabled: { tone: 'muted', icon: Ban },
};

const STATUS_OPTIONS = USER_STATUSES.map((s) => ({ value: s, label: t.status[s] }));

function isUserStatus(value: string | null): value is UserStatus {
  return value !== null && (USER_STATUSES as readonly string[]).includes(value);
}

/** Một dòng "có hay chưa" trong cột Đăng nhập web: phân biệt bằng hình và chữ, không bằng màu. */
function YesNo({ yes, children }: { yes: boolean; children: string }) {
  const Icon = yes ? Check : Minus;
  return (
    <span className={yes ? 'flex items-center gap-1.5' : 'flex items-center gap-1.5 text-ink-sub'}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

function UserActionsMenu({ user, onAction }: { user: UserView; onAction: (kind: UserAction, user: UserView) => void }) {
  const can = useCan();
  const me = useMe();
  const afterClose = useAfterMenuClose();
  const pick = (kind: UserAction) => () => afterClose.run(() => onAction(kind, user));
  const disabled = user.status === 'disabled';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={fmt(t.actionsFor, { tên: personName(user, 'full') })}>
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={afterClose.flush}>
        <DropdownMenuItem onSelect={pick('edit')}>
          <Pencil aria-hidden="true" />
          {t.menu.edit}
        </DropdownMenuItem>
        {can('permission.manage') && !disabled ? (
          <DropdownMenuItem onSelect={pick('permissions')}>
            <ShieldCheck aria-hidden="true" />
            {t.menu.permissions}
          </DropdownMenuItem>
        ) : null}
        {can('device.manage') && !disabled ? (
          <DropdownMenuItem onSelect={pick('activation')}>
            <QrCode aria-hidden="true" />
            {t.menu.activation}
          </DropdownMenuItem>
        ) : null}
        {disabled ? null : (
          <DropdownMenuItem onSelect={pick('passwordLink')}>
            <KeyRound aria-hidden="true" />
            {t.menu.passwordLink}
          </DropdownMenuItem>
        )}
        {disabled || user.email === null ? null : (
          <DropdownMenuItem onSelect={pick('inviteEmail')}>
            <MailPlus aria-hidden="true" />
            {t.menu.inviteEmail}
          </DropdownMenuItem>
        )}
        {canResetTotp({ canManage: can('user.manage'), meId: me.id, user }) ? (
          <DropdownMenuItem onSelect={pick('totpReset')}>
            <ShieldOff aria-hidden="true" />
            {t.menu.totpReset}
          </DropdownMenuItem>
        ) : null}
        {can('device.manage') ? (
          <DropdownMenuItem onSelect={pick('devices')}>
            <Smartphone aria-hidden="true" />
            {t.menu.devices}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {disabled ? (
          <DropdownMenuItem onSelect={pick('enable')}>
            <UserRoundCheck aria-hidden="true" />
            {t.menu.enable}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={pick('disable')}>
            <UserRoundX aria-hidden="true" />
            {t.menu.disable}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Tab "Người dùng" (SPEC 9.5): bảng hồ sơ, tìm theo tên, lọc đơn vị và trạng thái, sắp chữ tiếng Việt.
 * Thêm, sửa, nhập CSV, tạo mã kích hoạt, tạo đường dẫn đặt mật khẩu, xem và thu hồi thiết bị, vô hiệu hoá, bật lại.
 */
export function UsersTab() {
  const [search, setSearch] = useState('');
  const [unitId, setUnitId] = useState<string | null>(null);
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const q = useDebouncedValue(search.trim(), 250);
  const unitNames = useUnitNames();

  const users = useApiInfiniteQuery('users.list', { query: { limit: 100, q: q || undefined, unitId: unitId ?? undefined, status: status ?? undefined } });
  const filtered = q !== '' || unitId !== null || status !== null;
  const clearFilters = () => {
    setSearch('');
    setUnitId(null);
    setStatus(null);
  };

  const close = (isOpen: boolean) => {
    if (!isOpen) setDialog(null);
  };
  // Gửi lại thư kích hoạt: không cần hộp thoại, worker gửi thật; phản hồi chỉ báo đã xếp hàng hay chưa.
  const inviteEmail = useApiMutation('users.inviteEmail', { invalidate: ['admin.audit'] });
  const onAction = (kind: UserAction, user: UserView) => {
    if (kind !== 'inviteEmail') {
      setDialog({ kind, user });
      return;
    }
    inviteEmail.mutate(
      { params: { id: user.id } },
      { onSuccess: (res) => (res.queued ? toast.success(fmt(t.inviteEmail.queued, { email: user.email ?? '' })) : toast.info(t.inviteEmail.recentlyQueued)) },
    );
  };
  const target = dialog && 'user' in dialog ? dialog.user : null;

  const columns = useMemo<ColumnDef<UserView>[]>(
    () => [
      {
        id: 'name',
        // Tiếng Việt xếp theo tên gọi trước, rồi tới họ.
        accessorFn: (u) => `${u.givenName} ${u.fullName}`,
        header: t.col.name,
        cell: ({ row: { original: u } }) => (
          <>
            <p className="font-medium">{personName(u, 'full')}</p>
            <p className="truncate text-sm text-ink-sub" title={u.email ?? undefined}>
              {u.email ?? t.noEmail}
            </p>
          </>
        ),
      },
      {
        id: 'unit',
        accessorFn: (u) => u.unitName ?? '',
        header: t.col.unit,
        meta: { className: 'w-[204px]' },
        cell: ({ row: { original: u } }) => (
          <>
            <p>{u.unitName ?? <span className="text-ink-sub">{t.noUnit}</span>}</p>
            <p className="truncate text-sm text-ink-sub">{u.managerName ? fmt(t.managerLine, { tên: u.managerName }) : t.noManager}</p>
          </>
        ),
      },
      {
        id: 'roles',
        header: t.col.roles,
        enableSorting: false,
        meta: { className: 'w-[132px]' },
        cell: ({ row: { original: u } }) => (
          <ul>
            {u.roles.map((grant) => {
              const role = vi.common.role[grant.role];
              const unit = grant.unitId ? unitNames.get(grant.unitId) : undefined;
              return <li key={`${grant.role}:${grant.unitId ?? ''}`}>{unit ? fmt(t.roleScoped, { 'vai trò': role, 'đơn vị': unit }) : role}</li>;
            })}
          </ul>
        ),
      },
      {
        id: 'status',
        accessorFn: (u) => t.status[u.status],
        header: t.col.status,
        meta: { className: 'w-[160px]' },
        cell: ({ row: { original: u } }) => (
          <StateChip tone={STATUS_CHIP[u.status].tone} icon={STATUS_CHIP[u.status].icon}>
            {t.status[u.status]}
          </StateChip>
        ),
      },
      {
        id: 'devices',
        accessorFn: (u) => u.deviceCount,
        header: t.col.devices,
        meta: { align: 'right', className: 'w-[96px]' },
        cell: ({ row: { original: u } }) => <span className={u.deviceCount === 0 ? 'tabular text-ink-sub' : 'tabular font-medium'}>{u.deviceCount}</span>,
      },
      {
        id: 'webLogin',
        header: t.col.webLogin,
        enableSorting: false,
        meta: { className: 'w-[168px]' },
        cell: ({ row: { original: u } }) => (
          <div className="text-sm whitespace-nowrap">
            <YesNo yes={u.hasPassword}>{u.hasPassword ? t.password.set : t.password.unset}</YesNo>
            <YesNo yes={u.mfaEnabled}>{u.mfaEnabled ? t.totp.on : t.totp.off}</YesNo>
          </div>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{vi.admin.shell.ui.rowActions}</span>,
        enableSorting: false,
        meta: { align: 'right', className: 'w-11' },
        cell: ({ row }) => <UserActionsMenu user={row.original} onAction={onAction} />,
      },
    ],
    [unitNames],
  );

  return (
    <section aria-labelledby="tab-nguoi-dung" className="flex min-w-0 flex-col gap-3">
      <h2 id="tab-nguoi-dung" className="sr-only">
        {vi.admin.org.page.tabs.users}
      </h2>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t.filters} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-52">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-sub" />
            <Input type="search" aria-label={t.searchLabel} placeholder={t.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <UnitSelect allowAll aria-label={t.filterUnit} value={unitId} onValueChange={setUnitId} className="w-full sm:w-40" />
          <Select
            aria-label={t.filterStatus}
            value={status}
            onValueChange={(v) => setStatus(isUserStatus(v) ? v : null)}
            options={STATUS_OPTIONS}
            emptyOption={t.allStatuses}
            className="w-full sm:w-40"
          />
          {filtered ? (
            <Button variant="ghost" onClick={clearFilters}>
              {t.clearFilters}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setDialog({ kind: 'import' })}>
            <FileUp aria-hidden="true" />
            {t.importCsv}
          </Button>
          <Button variant="primary" onClick={() => setDialog({ kind: 'new' })}>
            <UserPlus aria-hidden="true" />
            {t.add}
          </Button>
        </div>
      </div>

      {users.isError ? (
        <LoadError error={users.error} onRetry={() => void users.refetch()} />
      ) : (
        <>
          <DataTable
            caption={t.caption}
            tableClassName="min-w-[960px] table-fixed"
            columns={columns}
            data={users.items}
            getRowId={userId}
            isLoading={users.isPending}
            hasMore={users.hasNextPage}
            onLoadMore={() => void users.fetchNextPage()}
            isLoadingMore={users.isFetchingNextPage}
            empty={
              filtered ? (
                <EmptyState title={t.emptyFiltered.title} description={t.emptyFiltered.body} action={<Button onClick={clearFilters}>{t.clearFilters}</Button>} />
              ) : (
                <EmptyState
                  title={t.empty.title}
                  description={t.empty.body}
                  action={
                    <Button variant="primary" onClick={() => setDialog({ kind: 'new' })}>
                      {t.add}
                    </Button>
                  }
                />
              )
            }
          />
          {users.isSuccess && users.items.length > 0 ? (
            <p role="status" className="text-sm text-ink-sub">
              {`${fmt(t.count, { n: users.items.length })}${users.hasNextPage ? '+' : ''}`}
            </p>
          ) : null}
        </>
      )}

      <UserFormSheet open={dialog?.kind === 'new' || dialog?.kind === 'edit'} onOpenChange={close} user={dialog?.kind === 'edit' ? dialog.user : null} />
      <UserImportDialog open={dialog?.kind === 'import'} onOpenChange={close} />
      <UserPermissionsSheet open={dialog?.kind === 'permissions'} onOpenChange={close} user={target} />
      <ActivationDialog open={dialog?.kind === 'activation'} onOpenChange={close} user={target} />
      <PasswordLinkDialog open={dialog?.kind === 'passwordLink'} onOpenChange={close} user={target} onEditProfile={(user) => setDialog({ kind: 'edit', user })} />
      <DevicesSheet open={dialog?.kind === 'devices'} onOpenChange={close} user={target} />
      <TotpResetDialog open={dialog?.kind === 'totpReset'} onOpenChange={close} user={target} />
      <DisableUserDialog open={dialog?.kind === 'disable'} onOpenChange={close} user={target} />
      <EnableUserDialog open={dialog?.kind === 'enable'} onOpenChange={close} user={target} />
    </section>
  );
}
