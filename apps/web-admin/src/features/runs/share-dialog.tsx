import { useState } from 'react';
import { LoaderCircle, Lock, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { RUN_SHARE_ROLES, type PersonRef, type RunShareRole, type RunShares } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { PersonPicker, type PersonOption } from '@/components/person-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth';
import { isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { apiKey, useApiMutation, useApiQuery } from '@/lib/query';
import { accessIds, isRetryableShareError, orderAccess, roleLabel, shareErrorMessage, shareErrorNeedsRefresh, type AccessRow } from './share-model';

const t = vi.admin.runs.share;

const ROLE_OPTIONS = RUN_SHARE_ROLES.map((role) => ({ value: role, label: t.roles[role] }));

function isShareRole(value: string | null): value is RunShareRole {
  return value !== null && (RUN_SHARE_ROLES as readonly string[]).includes(value);
}

type Op = { kind: 'set'; person: PersonRef; role: RunShareRole; change: boolean } | { kind: 'remove'; person: PersonRef };

function Initial({ person }: { person: PersonRef }) {
  return (
    <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-base font-semibold text-on-primary-tint">
      {(person.givenName || person.fullName).charAt(0).toLocaleUpperCase('vi')}
    </span>
  );
}

function AccessRowView({ row, canManage, busy, meId, onChange, onRemove }: { row: AccessRow; canManage: boolean; busy: boolean; meId: string; onChange: (role: RunShareRole) => void; onRemove: () => void }) {
  const name = personName(row.person, 'full');
  return (
    <li data-testid="share-row" data-person-id={row.person.id} data-kind={row.kind} className="flex items-center gap-3 py-2.5">
      <Initial person={row.person} />
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">
          {name}
          {row.person.id === meId ? <span className="font-normal text-ink-sub"> ({t.you})</span> : null}
        </p>
        {row.kind === 'shared' && row.grantedBy ? (
          <p className="text-sm text-ink-sub">{fmt(t.grantedBy, { tên: personName(row.grantedBy, 'short'), giờ: formatDateTime(row.createdAt) })}</p>
        ) : null}
      </div>
      {row.kind === 'fixed' ? (
        <Badge tone="muted" data-testid="share-role">
          {roleLabel(row.role)}
        </Badge>
      ) : canManage ? (
        <div className="flex shrink-0 items-center gap-1">
          <Select
            value={row.role}
            onValueChange={(v) => {
              if (isShareRole(v) && v !== row.role) onChange(v);
            }}
            options={ROLE_OPTIONS}
            disabled={busy}
            aria-label={fmt(t.roleFor, { tên: personName(row.person, 'short') })}
            className="w-36"
          />
          <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={fmt(t.removeFor, { tên: name })} title={t.remove} onClick={onRemove}>
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <Badge tone="neutral" data-testid="share-role">
          {roleLabel(row.role)}
        </Badge>
      )}
    </li>
  );
}

function ShareBody({ runId }: { runId: string }) {
  const me = useMe();
  const client = useQueryClient();
  const list = useApiQuery('runs.shares.list', { params: { id: runId } }, { staleTime: 0 });
  const set = useApiMutation('runs.shares.set', { toastError: false });
  const remove = useApiMutation('runs.shares.remove', { toastError: false });
  const [newRole, setNewRole] = useState<RunShareRole>('viewer');
  const [failed, setFailed] = useState<{ op: Op; error: unknown } | null>(null);
  const [notice, setNotice] = useState('');
  const busy = set.isPending || remove.isPending;
  const data = list.data;

  const apply = (next: RunShares, message: string) => {
    client.setQueryData(apiKey('runs.shares.list', { params: { id: runId } }), next);
    setNotice(message);
  };

  const run = (op: Op) => {
    setFailed(null);
    setNotice('');
    const name = personName(op.person, 'short');
    const onError = (error: unknown) => {
      setFailed({ op, error });
      // Danh sách phía sau đã đổi (hết quyền, người không còn xem được): làm mới để hiện đúng.
      if (shareErrorNeedsRefresh(error)) void list.refetch();
    };
    if (op.kind === 'set') {
      set.mutate(
        { params: { id: runId, userId: op.person.id }, body: { role: op.role } },
        { onSuccess: (next) => apply(next, fmt(op.change ? t.changed : t.added, { tên: name, mức: t.roles[op.role] })), onError },
      );
    } else {
      remove.mutate({ params: { id: runId, userId: op.person.id } }, { onSuccess: (next) => apply(next, fmt(t.removed, { tên: name })), onError });
    }
  };

  if (list.isError && !data) {
    const missing = isApiError(list.error, 'not_found');
    return (
      <DialogBody>
        <Callout
          tone="error"
          action={
            missing ? undefined : (
              <Button size="sm" onClick={() => void list.refetch()}>
                {t.retry}
              </Button>
            )
          }
        >
          {missing ? t.notFound : t.loadFailed}
        </Callout>
      </DialogBody>
    );
  }
  if (!data) {
    return (
      <DialogBody>
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t.loading}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </DialogBody>
    );
  }

  const rows = orderAccess(data);
  const restricted = data.confidentiality === 'restricted';
  const hasFixed = data.fixed.length > 0;
  const hasShared = data.shares.length > 0;
  const retryable = failed !== null && isRetryableShareError(failed.error);

  return (
    <DialogBody className="gap-4">
      {restricted ? (
        <div role="note" data-testid="share-restricted" className="flex items-start gap-2.5 rounded-lg border border-gold/40 bg-gold-tint px-3.5 py-3">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-gold" />
          <div className="min-w-0">
            <p className="font-semibold text-gold">{t.restrictedTitle}</p>
            <p className="mt-0.5 text-ink">{t.restrictedBody}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-sub">{t.normalNote}</p>
      )}

      {data.canManage ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end" data-testid="share-add">
          <Field label={t.addLabel} className="min-w-0 flex-1">
            <PersonPicker
              value={null}
              excludeIds={accessIds(data)}
              placeholder={t.addPlaceholder}
              disabled={busy}
              onChange={(person: PersonOption | null) => {
                if (person) run({ kind: 'set', person, role: newRole, change: false });
              }}
            />
          </Field>
          <Field label={t.addRoleLabel} className="sm:w-40">
            <Select
              value={newRole}
              onValueChange={(v) => {
                if (isShareRole(v)) setNewRole(v);
              }}
              options={ROLE_OPTIONS}
              disabled={busy}
            />
          </Field>
        </div>
      ) : (
        <p className="text-sm text-ink-sub">{t.readOnlyNote}</p>
      )}

      {/* Lỗi đọc ngay; kết quả và đang lưu đọc nhẹ. */}
      <div aria-live="assertive">
        {failed ? (
          <Callout
            tone="error"
            data-testid="share-error"
            action={
              retryable ? (
                <Button size="sm" onClick={() => run(failed.op)}>
                  {t.retry}
                </Button>
              ) : undefined
            }
          >
            {shareErrorMessage(failed.error)}
          </Callout>
        ) : null}
      </div>
      <div className="flex min-h-5 items-center gap-2 text-sm text-ink-sub">
        {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
        <span role="status">{busy ? t.saving : notice}</span>
      </div>

      <section aria-label={t.accessHeading} className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-ink">{t.accessHeading}</h3>
        <ul data-testid="share-list" className="divide-y divide-hairline">
          {rows.map((row) => (
            <AccessRowView
              key={`${row.kind}-${row.person.id}`}
              row={row}
              canManage={data.canManage}
              busy={busy}
              meId={me.id}
              onChange={(role) => run({ kind: 'set', person: row.person, role, change: true })}
              onRemove={() => run({ kind: 'remove', person: row.person })}
            />
          ))}
        </ul>
        {hasFixed ? <p className="text-sm text-ink-sub">{t.fixedNote}</p> : null}
        {!hasShared ? <p className="text-sm text-ink-sub">{t.sharedEmpty}</p> : null}
      </section>
    </DialogBody>
  );
}

/**
 * Chia sẻ lượt chạy kiểu Google Drive (docs/DECISIONS.md, 07/10/2026 điểm b): chủ sở hữu và người tham gia (cố định, có nhãn,
 * không gỡ được), người được chia sẻ (đổi mức Xem hoặc Bình luận, gỡ), ô tìm người để thêm. Lượt `restricted` (văn bản mật) nói rõ
 * rằng quyền xem mọi lượt chạy không đủ. Người không có quyền quản lý vẫn xem được danh sách.
 */
export function ShareDialog({ runId, runTitle, open, onOpenChange }: { runId: string; runTitle: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{fmt(t.description, { tên: runTitle })}</DialogDescription>
        </DialogHeader>
        <ShareBody runId={runId} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
