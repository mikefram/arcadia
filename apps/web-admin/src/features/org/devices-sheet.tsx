import { useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import type { DeviceView, UserView } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { personName } from '@/lib/person';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { LoadError, StateChip } from './shared';

const t = vi.admin.org.users.devices;

const deviceLabel = (d: DeviceView) => d.name?.trim() || t.unnamed;

function DeviceList({ user }: { user: UserView }) {
  const name = personName(user, 'full');
  const [target, setTarget] = useState<DeviceView | null>(null);
  const devices = useApiQuery('devices.list', { query: { userId: user.id } }, { staleTime: 0 });
  const revoke = useApiMutation('devices.revoke', { invalidate: ['devices.list', 'users.list', 'admin.audit'] });

  // Thiết bị đang dùng đứng trước, thiết bị đã thu hồi xuống cuối; trong mỗi nhóm, kích hoạt gần nhất ở trên.
  const items = [...(devices.data?.items ?? [])].sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || b.enrolledAt.localeCompare(a.enrolledAt));

  return (
    <>
      <SheetHeader>
        <SheetTitle>{fmt(t.title, { tên: name })}</SheetTitle>
        <SheetDescription>{t.description}</SheetDescription>
      </SheetHeader>
      <SheetBody aria-busy={devices.isPending || undefined}>
        {devices.isError ? (
          <LoadError error={devices.error} onRetry={() => void devices.refetch()} />
        ) : devices.isPending ? (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        ) : items.length === 0 ? (
          <EmptyState icon={Smartphone} title={t.emptyTitle} description={t.emptyBody} />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((d) => {
              const Icon = d.platform === 'web' ? Monitor : Smartphone;
              const revoked = d.revokedAt !== null;
              return (
                <li key={d.id} className="flex items-start gap-3 rounded-xl border border-hairline px-4 py-3.5">
                  <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink-sub" strokeWidth={1.75} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <p className="font-semibold">{deviceLabel(d)}</p>
                      <StateChip tone={revoked ? 'muted' : 'good'}>{revoked ? t.revoked : t.inUse}</StateChip>
                    </div>
                    <p className="text-sm text-ink-sub">{t.platform[d.platform]}</p>
                    <div className="mt-1.5 text-sm">
                      <p>{fmt(t.enrolled, { giờ: formatDateTime(d.enrolledAt) })}</p>
                      <p>{d.lastSeenAt ? fmt(t.lastSeen, { giờ: formatDateTime(d.lastSeenAt) }) : t.neverSeen}</p>
                      <p>{d.revokedAt ? fmt(t.revokedAt, { giờ: formatDateTime(d.revokedAt) }) : d.hasPushToken ? t.push : t.noPush}</p>
                    </div>
                  </div>
                  {revoked ? null : (
                    <Button size="sm" aria-label={fmt(t.revokeFor, { 'thiết bị': deviceLabel(d) })} onClick={() => setTarget(d)}>
                      {t.revoke}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SheetBody>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setTarget(null);
        }}
        tone="danger"
        title={t.revokeTitle}
        description={target ? fmt(t.revokeBody, { 'thiết bị': deviceLabel(target), tên: name }) : undefined}
        confirmLabel={t.revokeConfirm}
        loading={revoke.isPending}
        onConfirm={() => {
          if (!target) return;
          revoke.mutate(
            { params: { id: target.id } },
            {
              onSuccess: () => toast.success(t.revokedToast),
              onSettled: () => setTarget(null),
            },
          );
        }}
      />
    </>
  );
}

/** Thiết bị của một người (`devices.list`), mỗi thiết bị có nút "Thu hồi" hỏi lại trước khi làm (`devices.revoke`). */
export function DevicesSheet({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: UserView | null }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>{user ? <DeviceList user={user} /> : null}</SheetContent>
    </Sheet>
  );
}
