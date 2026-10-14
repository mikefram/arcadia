import { zodResolver } from '@hookform/resolvers/zod';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Field } from '@/components/ui/field';
import { useApiMutation } from '@/lib/query';
import { AuthLayout } from './auth-layout';
import { PasswordInput } from './password-input';

const t = vi.admin.shell.auth.passwordSet;
const route = getRouteApi('/dat-mat-khau');

const schema = z
  .object({
    password: z.string().min(12, t.tooShort).max(200, t.tooLong),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: t.mismatch });
type FormValues = z.infer<typeof schema>;

/** Đặt mật khẩu web bằng đường dẫn một lần do Quản trị hệ thống cấp (`/dat-mat-khau?token=…`). */
export function PasswordSetPage() {
  const { token } = route.useSearch();
  const save = useApiMutation('auth.passwordSet', { toastError: false });
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });

  const submit = form.handleSubmit((values) => {
    if (token) save.mutate({ body: { token, password: values.password } });
  });

  if (save.isSuccess) {
    return (
      <AuthLayout>
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-semibold">{t.doneTitle}</h1>
            <p className="mt-1 text-ink-sub">{t.doneBody}</p>
          </div>
          <Button asChild variant="primary" size="lg" className="text-base">
            <Link to="/dang-nhap">{t.toLogin}</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <div>
          <h1 className="text-2xl font-semibold">{t.title}</h1>
          <p className="mt-1 text-ink-sub">{t.intro}</p>
        </div>
        {!token ? <Callout tone="error">{t.missingToken}</Callout> : null}
        {save.isError ? <Callout tone="error">{save.error instanceof TypeError ? vi.admin.shell.errors.network : t.failed}</Callout> : null}
        <Field label={t.password} hint={t.passwordHint} error={form.formState.errors.password?.message}>
          <PasswordInput autoComplete="new-password" autoFocus disabled={!token} {...form.register('password')} />
        </Field>
        <Field label={t.confirm} error={form.formState.errors.confirm?.message}>
          <PasswordInput autoComplete="new-password" disabled={!token} {...form.register('confirm')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={save.isPending} disabled={!token} className="mt-1 text-base">
          {t.submit}
        </Button>
      </form>
    </AuthLayout>
  );
}
