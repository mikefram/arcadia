import type { UserView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Callout } from '@/components/ui/callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { errorMessage, isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { fieldIssue } from './shared';

const t = vi.admin.org.users;

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; user: UserView | null };

// Vô hiệu hoá đổi cả danh sách thiết bị và các việc người đó đang giữ (SPEC 9.5 điều 4).
const AFTER_STATUS_CHANGE = ['users.list', 'users.get', 'devices.list', 'people.search', 'steps.list', 'overview.get', 'runs.list', 'admin.audit'] as const;

/**
 * Hỏi lại trước khi vô hiệu hoá, nêu rõ hệ quả: thu hồi mọi thiết bị, việc đang giữ chuyển sang "Cần giao người".
 * 409 kèm `last_it_admin` (Quản trị hệ thống cuối cùng) được nói bằng câu riêng ngay trong hộp thoại.
 */
export function DisableUserDialog({ open, onOpenChange, user }: DialogProps) {
  const disable = useApiMutation('users.disable', {
    toastError: false,
    invalidate: AFTER_STATUS_CHANGE,
    onError: (err) => {
      if (isApiError(err, 'state_conflict')) invalidateRoutes(['users.list']);
    },
  });
  const name = user ? personName(user, 'full') : '';
  const failure = disable.error;
  const failureText = !failure ? null : fieldIssue(failure, 'params.id') === 'last_it_admin' ? t.disable.lastItAdmin : isApiError(failure, 'state_conflict') ? t.disable.conflict : errorMessage(failure);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) disable.reset();
        onOpenChange(isOpen);
      }}
      tone="danger"
      title={fmt(t.disable.title, { tên: name })}
      description={t.disable.intro}
      confirmLabel={t.disable.confirm}
      loading={disable.isPending}
      onConfirm={() => {
        if (!user) return;
        disable.mutate(
          { params: { id: user.id } },
          {
            onSuccess: () => {
              toast.success(fmt(t.disable.done, { tên: name }));
              onOpenChange(false);
            },
          },
        );
      }}
    >
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {t.disable.effects.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-3 text-ink-sub">{t.disable.note}</p>
      {failureText ? (
        <Callout tone="error" className="mt-3">
          {failureText}
        </Callout>
      ) : null}
    </ConfirmDialog>
  );
}

/** Bật lại một người đã bị vô hiệu hoá (`users.enable`). Thiết bị và việc cũ không tự quay về: nói rõ trước khi làm. */
export function EnableUserDialog({ open, onOpenChange, user }: DialogProps) {
  const enable = useApiMutation('users.enable', { invalidate: AFTER_STATUS_CHANGE });
  const name = user ? personName(user, 'full') : '';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={fmt(t.enable.title, { tên: name })}
      description={t.enable.body}
      confirmLabel={t.enable.confirm}
      loading={enable.isPending}
      onConfirm={() => {
        if (!user) return;
        enable.mutate(
          { params: { id: user.id } },
          {
            onSuccess: () => toast.success(fmt(t.enable.done, { tên: name })),
            onSettled: () => onOpenChange(false),
          },
        );
      }}
    />
  );
}
