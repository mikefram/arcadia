import { useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { Action, PermissionRoleView, Role } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { invalidateRoutes, useApiMutation, useApiQuery } from '@/lib/query';
import { actionHint, actionLabel, groupLabel, permissionErrorText } from './permission-text';
import { LoadError } from './shared';

const t = vi.admin.org.permissions;
const AFTER_SAVE = ['permissions.get', 'users.permissions', 'me.get', 'users.list', 'admin.audit'] as const;

const sameSet = (a: readonly Action[], b: readonly Action[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Tab "Phân quyền" (docs/DECISIONS.md, 05/10/2026): bảng vai trò × quyền. Tích hoặc bỏ tích rồi bấm Lưu; chỉ phần khác bảng mặc
 * của hệ thống được lưu. Quyền đọc hồ sơ của mình không bớt được; tổ chức luôn phải còn người giữ quyền chỉnh quyền và quản lý người dùng.
 */
export function PermissionsTab() {
  const matrix = useApiQuery('permissions.get', {}, { staleTime: 0 });
  const [edits, setEdits] = useState<Partial<Record<Role, Action[]>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [resetting, setResetting] = useState<PermissionRoleView | null>(null);
  const [saving, setSaving] = useState(false);

  const setRole = useApiMutation('permissions.setRole', { toastError: false });
  const resetRole = useApiMutation('permissions.resetRole', { toastError: false });

  const roles = matrix.data?.roles ?? [];
  const locked = useMemo(() => new Set<Action>(matrix.data?.locked ?? []), [matrix.data]);
  const required = useMemo(() => new Set<Action>(matrix.data?.required ?? []), [matrix.data]);
  const allowedOf = (r: PermissionRoleView): readonly Action[] => edits[r.role] ?? r.allowed;
  const dirtyRoles = roles.filter((r) => edits[r.role] !== undefined);

  const toggle = (r: PermissionRoleView, action: Action, on: boolean) => {
    const current = allowedOf(r);
    const next = on ? [...new Set([...current, action])] : current.filter((a) => a !== action);
    setFailure(null);
    setEdits((prev) => {
      const copy = { ...prev };
      if (sameSet(next, r.allowed)) delete copy[r.role];
      else copy[r.role] = next;
      return copy;
    });
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    let done = 0;
    try {
      for (const r of dirtyRoles) {
        await setRole.mutateAsync({ params: { role: r.role }, body: { allowed: edits[r.role]! } });
        done++;
        setEdits((prev) => {
          const copy = { ...prev };
          delete copy[r.role];
          return copy;
        });
      }
      toast.success(fmt(t.saved, { n: done }));
    } catch (err) {
      setFailure(permissionErrorText(err));
    } finally {
      setSaving(false);
      invalidateRoutes([...AFTER_SAVE]);
    }
  };

  const confirmReset = () => {
    if (!resetting) return;
    const role = resetting.role;
    resetRole.mutate(
      { params: { role } },
      {
        onSuccess: () => {
          setEdits((prev) => {
            const copy = { ...prev };
            delete copy[role];
            return copy;
          });
          toast.success(fmt(t.savedReset, { 'vai trò': vi.common.role[role] }));
          invalidateRoutes([...AFTER_SAVE]);
          setResetting(null);
        },
        onError: (err) => {
          setFailure(permissionErrorText(err));
          setResetting(null);
        },
      },
    );
  };

  if (matrix.isError) return <LoadError error={matrix.error} onRetry={() => void matrix.refetch()} />;

  return (
    <section aria-labelledby="tab-phan-quyen" className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 id="tab-phan-quyen" className="text-xl font-semibold">
          {t.title}
        </h2>
        <p className="mt-1 max-w-3xl text-ink-sub">{t.intro}</p>
      </div>

      {failure ? <Callout tone="error">{failure}</Callout> : null}

      {matrix.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full min-w-[920px] border-collapse text-base" data-testid="permission-matrix">
            <caption className="sr-only">{t.caption}</caption>
            <thead>
              <tr className="border-b border-hairline bg-canvas">
                <th scope="col" className="sticky left-0 z-10 w-[300px] bg-canvas px-4 py-3 text-left font-semibold">
                  {t.colAction}
                </th>
                {roles.map((r) => (
                  <th key={r.role} scope="col" className="px-2 py-3 text-center align-bottom font-semibold">
                    <span className="block">{vi.common.role[r.role]}</span>
                    <span className="block text-sm font-normal text-ink-sub">{fmt(t.holders, { n: r.holders })}</span>
                    <span className="mt-1 flex min-h-7 items-center justify-center">
                      {r.customized ? (
                        <Button
                          variant="link"
                          size="sm"
                          aria-label={fmt(t.resetRoleFor, { 'vai trò': vi.common.role[r.role] })}
                          onClick={() => setResetting(r)}
                          disabled={saving}
                        >
                          <RotateCcw aria-hidden="true" className="size-3.5" />
                          {t.resetRole}
                        </Button>
                      ) : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {(matrix.data?.groups ?? []).map((group) => (
              <tbody key={group.id}>
                <tr>
                  <th scope="rowgroup" colSpan={roles.length + 1} className="bg-surface-alt px-4 py-2 text-left text-sm font-semibold tracking-wide text-ink-sub">
                    {groupLabel(group.id)}
                  </th>
                </tr>
                {group.actions.map((action) => (
                  <tr key={action} className="border-t border-hairline">
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-left font-normal">
                      <span className="block font-medium">{actionLabel(action)}</span>
                      <span className="block text-sm text-ink-sub">
                        {actionHint(action)}
                        {locked.has(action) ? ` ${t.lockedHint}` : required.has(action) ? ` ${t.requiredHint}` : ''}
                      </span>
                    </th>
                    {roles.map((r) => {
                      const on = allowedOf(r).includes(action);
                      const isDefault = r.defaults.includes(action);
                      const isLocked = locked.has(action);
                      const changed = on !== isDefault;
                      return (
                        <td key={r.role} className={cn('px-2 py-2.5 text-center', edits[r.role] && 'bg-primary-tint/50')}>
                          <span className="relative inline-flex items-center justify-center">
                            <Checkbox
                              checked={on}
                              disabled={isLocked || saving}
                              aria-label={fmt(isLocked ? t.cellLocked : t.cellOn, { 'vai trò': vi.common.role[r.role], quyền: actionLabel(action) })}
                              onCheckedChange={(v) => toggle(r, action, v === true)}
                              data-testid={`cell-${r.role}-${action}`}
                            />
                            {changed ? (
                              <>
                                <span aria-hidden="true" className="absolute -top-1 -right-2 size-2 rounded-full bg-gold" />
                                <span className="sr-only">{t.customizedMark}</span>
                              </>
                            ) : null}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <p className="text-sm text-ink-sub">{t.legend}</p>

      <div
        role="region"
        aria-label={t.save}
        className={cn('sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-pop', dirtyRoles.length === 0 && 'hidden')}
      >
        <p role="status" className="font-medium">
          {fmt(t.dirty, { n: dirtyRoles.length })}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEdits({})} disabled={saving}>
            {t.discard}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {saving ? null : <Save aria-hidden="true" />}
            {t.save}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(open) => {
          if (!open) setResetting(null);
        }}
        title={resetting ? fmt(t.resetRoleFor, { 'vai trò': vi.common.role[resetting.role] }) : ''}
        description={resetting ? fmt(vi.admin.org.permissions.holders, { n: resetting.holders }) : undefined}
        confirmLabel={t.resetRole}
        loading={resetRole.isPending}
        onConfirm={confirmReset}
      />
    </section>
  );
}
