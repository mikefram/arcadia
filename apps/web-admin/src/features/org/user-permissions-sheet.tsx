import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { ACTION_GROUPS, type Action, type UserView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { personName } from '@/lib/person';
import { invalidateRoutes, useApiMutation, useApiQuery } from '@/lib/query';
import { actionHint, actionLabel, groupLabel, permissionErrorText } from './permission-text';
import { LoadError } from './shared';

const t = vi.admin.org.permissions.user;
const AFTER_SAVE = ['users.permissions', 'permissions.get', 'me.get', 'users.list', 'admin.audit'] as const;

const sameSet = (a: ReadonlySet<Action>, b: ReadonlySet<Action>) => a.size === b.size && [...a].every((x) => b.has(x));

function Form({ user, onOpenChange }: { user: UserView; onOpenChange: (open: boolean) => void }) {
  const view = useApiQuery('users.permissions', { params: { id: user.id } }, { staleTime: 0, gcTime: 0 });
  const [want, setWant] = useState<Set<Action> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const save = useApiMutation('users.setPermissions', { toastError: false });

  // Điểm xuất phát là quyền thật đang có của người này; người dùng bật tắt từ đó.
  useEffect(() => {
    if (view.data && want === null) setWant(new Set(view.data.effective));
  }, [view.data, want]);

  const fromRoles = useMemo(() => new Set<Action>(view.data?.fromRoles ?? []), [view.data]);
  const locked = useMemo(() => new Set<Action>(view.data?.locked ?? []), [view.data]);
  const grants = want ? [...want].filter((a) => !fromRoles.has(a)) : [];
  const revokes = want ? [...fromRoles].filter((a) => !want.has(a)) : [];
  const saved = new Set<Action>(view.data?.effective ?? []);
  const dirty = want !== null && !sameSet(want, saved);
  const hasOwn = grants.length + revokes.length > 0;

  const roleText = user.roles.map((g) => vi.common.role[g.role]).join(', ');

  const submit = () => {
    if (!want) return;
    setFailure(null);
    save.mutate(
      { params: { id: user.id }, body: { grants: grants as Action[], revokes: revokes as Action[] } },
      {
        onSuccess: () => {
          toast.success(fmt(t.saved, { tên: personName(user, 'full') }));
          invalidateRoutes([...AFTER_SAVE]);
          onOpenChange(false);
        },
        onError: (err) => setFailure(permissionErrorText(err)),
      },
    );
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{fmt(t.title, { tên: personName(user, 'full') })}</SheetTitle>
        <SheetDescription>{t.description}</SheetDescription>
      </SheetHeader>
      <SheetBody aria-busy={view.isPending || undefined}>
        <p className="text-sm text-ink-sub">{fmt(t.roles, { 'vai trò': roleText })}</p>
        {failure ? <Callout tone="error">{failure}</Callout> : null}
        {view.isError ? (
          <LoadError error={view.error} onRetry={() => void view.refetch()} />
        ) : !view.data || !want ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <>
            <p role="status" className="font-medium" data-testid="own-summary">
              {hasOwn ? fmt(t.summary, { thêm: grants.length, bớt: revokes.length }) : t.summaryNone}
            </p>
            {ACTION_GROUPS.map((group) => (
              <section key={group.id} aria-label={groupLabel(group.id)} className="flex flex-col">
                <h3 className="mb-1 text-sm font-semibold tracking-wide text-ink-sub">{groupLabel(group.id)}</h3>
                <ul className="divide-y divide-hairline rounded-xl border border-hairline">
                  {group.actions.map((action) => {
                    const on = want.has(action);
                    const fromRole = fromRoles.has(action);
                    const isLocked = locked.has(action);
                    const source = isLocked ? t.sourceLocked : on && fromRole ? t.sourceRole : on ? t.sourceGranted : fromRole ? t.sourceRevoked : null;
                    const tone = !isLocked && on !== fromRole ? 'gold' : 'neutral';
                    return (
                      <li key={action} className="flex items-center gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <label htmlFor={`own-${action}`} className="block font-medium">
                            {actionLabel(action)}
                          </label>
                          <p className="text-sm text-ink-sub">{actionHint(action)}</p>
                        </div>
                        {source ? <Badge tone={tone}>{source}</Badge> : null}
                        <Switch
                          id={`own-${action}`}
                          checked={on}
                          disabled={isLocked || save.isPending}
                          aria-label={fmt(t.switchLabel, { quyền: actionLabel(action) })}
                          onCheckedChange={(v) => {
                            setFailure(null);
                            setWant((prev) => {
                              const next = new Set(prev ?? []);
                              if (v) next.add(action);
                              else next.delete(action);
                              return next;
                            });
                          }}
                          data-testid={`own-${action}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        )}
      </SheetBody>
      <SheetFooter>
        <Button variant="secondary" disabled={!hasOwn || save.isPending || !view.data} onClick={() => setWant(new Set(fromRoles))}>
          <RotateCcw aria-hidden="true" />
          {t.clear}
        </Button>
        <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={submit}>
          {save.isPending ? null : <Save aria-hidden="true" />}
          {t.save}
        </Button>
      </SheetFooter>
    </>
  );
}

/**
 * Quyền riêng của một người (docs/DECISIONS.md, 05/10/2026): bật tắt từng quyền cho riêng người này. Chỉ phần khác quyền từ vai trò được
 * lưu (thêm riêng, bớt riêng); vai trò và quyền của người khác cùng vai trò không đổi. Mở lại là tải quyền mới nhất.
 */
export function UserPermissionsSheet({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: UserView | null }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>{user ? <Form key={user.id} user={user} onOpenChange={onOpenChange} /> : null}</SheetContent>
    </Sheet>
  );
}
