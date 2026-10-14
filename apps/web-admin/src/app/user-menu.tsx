import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useAfterMenuClose,
} from '@/components/ui/dropdown-menu';
import { markSignedOut, useMe } from '@/lib/auth';
import { personName } from '@/lib/person';
import { queryClient, useApiMutation } from '@/lib/query';

const t = vi.admin.shell;

function roleLabels(roles: readonly { role: keyof typeof vi.common.role }[]): string {
  return [...new Set(roles.map((r) => vi.common.role[r.role]))].join(', ');
}

function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useMe();
  const rows: [string, string][] = [
    [t.profile.fullName, personName(me, 'full', true)],
    [t.profile.email, me.email ?? t.profile.none],
    [t.profile.phone, me.phone ?? t.profile.none],
    [t.profile.unit, me.unitName ?? t.profile.none],
    [t.profile.roles, roleLabels(me.roles)],
    [t.profile.twoStep, me.mfaEnabled ? t.profile.twoStepOn : t.profile.twoStepOff],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t.profile.title}</DialogTitle>
          <DialogDescription>{t.profile.note}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5">
            {rows.map(([label, value]) => (
              <div key={label} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-ink-sub">{label}</dt>
                <dd className="font-medium break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Trình đơn người dùng ở thanh trên: hồ sơ, bật xác thực hai bước, đăng xuất. */
export function UserMenu({ onEnableTotp }: { onEnableTotp: () => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const afterClose = useAfterMenuClose();

  const leave = async () => {
    markSignedOut();
    await navigate({ to: '/dang-nhap', search: {} });
    queryClient.clear();
  };
  // Dù máy chủ trả lỗi, người dùng vẫn được đưa về trang đăng nhập.
  const logout = useApiMutation('auth.logout', { toastError: false, onSettled: () => leave() });

  const shortName = personName(me, 'short', true);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={fmt(t.topbar.accountMenu, { tên: shortName })}
          className="inline-flex h-10 max-w-56 items-center gap-2 rounded-lg pr-2 pl-1.5 text-base font-medium transition-colors hover:bg-surface-alt data-[state=open]:bg-surface-alt"
        >
          <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-tint text-on-primary-tint">
            <UserRound className="size-4" />
          </span>
          <span className="hidden truncate sm:inline">{shortName}</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-sub" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" onCloseAutoFocus={afterClose.flush}>
          <DropdownMenuLabel>
            <span className="block text-base font-semibold text-ink">{personName(me, 'full', true)}</span>
            <span className="block">{roleLabels(me.roles)}</span>
            {me.email ? <span className="block truncate">{me.email}</span> : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => afterClose.run(() => setProfileOpen(true))}>
            <UserRound aria-hidden="true" />
            {t.topbar.profile}
          </DropdownMenuItem>
          {me.mfaEnabled ? null : (
            <DropdownMenuItem onSelect={() => afterClose.run(onEnableTotp)}>
              <ShieldCheck aria-hidden="true" />
              {t.topbar.enableTotp}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate({})}>
            <LogOut aria-hidden="true" />
            {t.topbar.logout}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}
