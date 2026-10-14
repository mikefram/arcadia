import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { RouteResponse } from '@mihato/api-client';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ME_KEY, setCachedMe } from '@/lib/auth';
import { queryClient, useApiMutation } from '@/lib/query';
import { AuthLayout } from './auth-layout';
import { PasswordInput } from './password-input';

const t = vi.admin.shell.auth;
const route = getRouteApi('/dang-nhap');

const credentialsSchema = z.object({
  email: z.email(t.login.emailInvalid),
  password: z.string().min(1, t.login.passwordRequired),
});
type Credentials = z.infer<typeof credentialsSchema>;

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, t.mfa.codeInvalid) });
type CodeForm = z.infer<typeof codeSchema>;

/** Chỉ nhận đường dẫn nội bộ, để tham số `redirect` không đưa người dùng sang trang khác. */
function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/dang-nhap')) return '/';
  return target;
}

/** Mọi lỗi đăng nhập dùng chung một câu (SPEC 11.2): không cho biết email có tồn tại hay tài khoản đang bị khoá. */
function loginFailure(err: unknown, sentence: string): string {
  return err instanceof TypeError ? vi.admin.shell.errors.network : sentence;
}

export function LoginPage() {
  const router = useRouter();
  const search = route.useSearch();
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  const finish = async (res: RouteResponse<'auth.login'>) => {
    if (res.me) setCachedMe(res.me);
    else await queryClient.invalidateQueries({ queryKey: ME_KEY });
    router.history.push(safeRedirect(search.redirect));
  };

  const login = useApiMutation('auth.login', { toastError: false });
  const verify = useApiMutation('auth.mfaVerify', { toastError: false });

  const credentials = useForm<Credentials>({ resolver: zodResolver(credentialsSchema), defaultValues: { email: '', password: '' } });
  const code = useForm<CodeForm>({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });

  const submitCredentials = credentials.handleSubmit((values) => {
    login.mutate(
      { body: { ...values, ...(search.org ? { org: search.org } : {}) } },
      {
        onSuccess: (res) => {
          if (res.mfaRequired && res.mfaToken) {
            setMfaToken(res.mfaToken);
            code.reset();
            verify.reset();
          } else {
            void finish(res);
          }
        },
      },
    );
  });

  const submitCode = code.handleSubmit((values) => {
    if (!mfaToken) return;
    verify.mutate({ body: { mfaToken, code: values.code } }, { onSuccess: (res) => void finish(res) });
  });

  const restart = () => {
    setMfaToken(null);
    login.reset();
    credentials.resetField('password');
  };

  return (
    <AuthLayout>
      {mfaToken === null ? (
        <form noValidate onSubmit={submitCredentials} className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-semibold">{t.login.title}</h1>
            <p className="mt-1 text-ink-sub">{t.login.intro}</p>
          </div>
          {login.isError ? <Callout tone="error">{loginFailure(login.error, t.login.failed)}</Callout> : null}
          <Field label={t.login.email} error={credentials.formState.errors.email?.message}>
            <Input type="email" autoComplete="username" autoFocus inputMode="email" spellCheck={false} {...credentials.register('email')} />
          </Field>
          <Field label={t.login.password} error={credentials.formState.errors.password?.message}>
            <PasswordInput autoComplete="current-password" {...credentials.register('password')} />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={login.isPending} className="mt-1 text-base">
            {t.login.submit}
          </Button>
          <p className="text-sm text-ink-sub">{t.login.help}</p>
        </form>
      ) : (
        <form noValidate onSubmit={submitCode} className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-semibold">{t.mfa.title}</h1>
            <p className="mt-1 text-ink-sub">{t.mfa.intro}</p>
          </div>
          {verify.isError ? <Callout tone="error">{loginFailure(verify.error, t.mfa.failed)}</Callout> : null}
          <Field label={t.mfa.code} error={code.formState.errors.code?.message}>
            <Input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="tabular h-12 text-center text-xl font-semibold tracking-[0.4em]"
              {...code.register('code')}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={verify.isPending} className="mt-1 text-base">
            {t.mfa.submit}
          </Button>
          <Button variant="link" className="self-start" onClick={restart}>
            {t.mfa.restart}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
