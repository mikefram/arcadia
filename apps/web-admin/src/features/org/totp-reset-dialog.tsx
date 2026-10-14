import { useRef, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { UserView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { PasswordInput } from '@/features/auth/password-input';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useMe } from '@/lib/auth';
import { isApiError } from '@/lib/errors';
import { invalidateRoutes, useApiMutation } from '@/lib/query';
import { personName } from '@/lib/person';
import { needsStepUp, resetDoneMessage, resetErrorMessage, stepUpErrorMessage, stepUpSecretError } from './totp-reset-model';

const t = vi.admin.org.users.totpReset;
const s = vi.admin.runs.myTasks.stepUp;

const AFTER_RESET = ['users.list', 'users.get', 'admin.audit'] as const;

function TotpResetBody({ user, onOpenChange }: { user: UserView; onOpenChange: (open: boolean) => void }) {
  const me = useMe();
  const useTotp = me.mfaEnabled;
  const name = personName(user, 'full');
  const [phase, setPhase] = useState<'confirm' | 'stepUp'>('confirm');
  const [secret, setSecret] = useState('');
  const [secretError, setSecretError] = useState<string | null>(null);
  /** máy chủ vừa trả 403 step_up_required: hỏi lại và nói rõ vì sao */
  const [asked, setAsked] = useState(false);
  // Mã nâng quyền sống 60 giây, chỉ giữ trong bộ nhớ của hộp thoại này.
  const token = useRef<string | null>(null);

  const stepUp = useApiMutation('auth.stepUp', { toastError: false });
  const reset = useApiMutation('users.totpReset', {
    toastError: false,
    invalidate: AFTER_RESET,
    callOptions: () => (token.current ? { stepUpToken: token.current } : {}),
  });
  const pending = stepUp.isPending || reset.isPending;

  const sendReset = () => {
    reset.mutate(
      { params: { id: user.id } },
      {
        onSuccess: () => {
          toast.success(resetDoneMessage(name));
          onOpenChange(false);
        },
        onError: (err) => {
          token.current = null;
          if (needsStepUp(err)) {
            setSecret('');
            setAsked(true);
          } else if (isApiError(err, 'not_found')) {
            invalidateRoutes(['users.list', 'users.get']);
          }
        },
      },
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const problem = stepUpSecretError(secret, useTotp);
    if (problem) {
      setSecretError(problem);
      return;
    }
    setSecretError(null);
    setAsked(false);
    stepUp.mutate(
      { body: useTotp ? { totpCode: secret.trim() } : { password: secret } },
      {
        onSuccess: (res) => {
          token.current = res.stepUpToken;
          setSecret('');
          sendReset();
        },
      },
    );
  };

  if (phase === 'confirm') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{fmt(t.title, { tên: name })}</DialogTitle>
          <DialogDescription>{t.intro}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {t.effects.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-ink-sub">{t.note}</p>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
          </DialogClose>
          <Button variant="primary" onClick={() => setPhase('stepUp')} data-testid="totp-reset-next">
            {t.next}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const stepUpError = stepUp.isError ? stepUpErrorMessage(stepUp.error, useTotp) : null;
  const resetError = reset.isError && !needsStepUp(reset.error) ? resetErrorMessage(reset.error) : null;
  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col" data-testid="step-up-form">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          {t.stepUpTitle}
        </DialogTitle>
        <DialogDescription>{useTotp ? t.stepUpIntroTotp : t.stepUpIntroPassword}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
          <p className="font-semibold">{fmt(t.title, { tên: name })}</p>
        </div>
        <div aria-live="assertive" className="flex flex-col gap-3">
          {asked && !stepUpError && !resetError ? <Callout tone="warn">{t.expired}</Callout> : null}
          {stepUpError ? <Callout tone="error">{stepUpError}</Callout> : null}
          {resetError ? (
            <Callout tone="error" data-testid="totp-reset-error">
              {resetError}
            </Callout>
          ) : null}
        </div>
        {useTotp ? (
          <Field label={s.totp} required error={secretError ?? undefined}>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus className="tabular max-w-40 tracking-[0.3em]" value={secret} onChange={(e) => setSecret(e.target.value.replace(/\D/g, ''))} />
          </Field>
        ) : (
          <Field label={s.password} required error={secretError ?? undefined}>
            <PasswordInput autoComplete="current-password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" disabled={pending} onClick={() => setPhase('confirm')}>
          {t.back}
        </Button>
        <Button type="submit" variant="danger" loading={pending}>
          {t.confirm}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Đặt lại TOTP cho người mất máy tạo mã (`users.totpReset`, quyền user.manage): hộp thoại nói rõ hệ quả (TOTP tắt, phiên web bị
 * đăng xuất, phải bật lại ở lần đăng nhập sau), rồi hỏi lại mật khẩu hoặc mã TOTP của chính quản trị viên (`auth.stepUp`) và gửi kèm
 * mã nâng quyền. Không có nút cho chính mình; nếu vẫn gọi thì máy chủ trả 403 và hộp thoại nói rõ.
 */
export function TotpResetDialog({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: UserView | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{user ? <TotpResetBody key={user.id} user={user} onOpenChange={onOpenChange} /> : null}</DialogContent>
    </Dialog>
  );
}
