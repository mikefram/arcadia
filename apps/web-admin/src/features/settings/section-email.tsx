import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { EmailSettingsView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { fieldIssue, LoadError } from '@/features/org/shared';
import { apiKey, queryClient, useApiMutation, useApiQuery } from '@/lib/query';
import { SectionFrame, useReportDirty, type SectionProps } from './section';

const t = vi.admin.org.settings.email;

export const EMAIL_ID = 'gui-thu';

/** Cùng luật với máy chủ: `thu@ten-mien.vn` hoặc `Tên hiển thị <thu@ten-mien.vn>`. */
const FROM_PATTERN = /^(?:[^<>\r\n]{1,100}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

const stateText = (active: EmailSettingsView['active']) => ({ org: t.stateOrg, env: t.stateEnv, fake: t.stateFake, none: t.stateNone })[active];

type FormValues = { provider: 'resend'; fromAddress: string; apiKey: string };

function EmailForm({ view, onDirtyChange }: { view: EmailSettingsView; onDirtyChange: SectionProps['onDirtyChange'] }) {
  const schema = useMemo(
    () =>
      z.object({
        provider: z.literal('resend'),
        fromAddress: z.string().trim().refine((v) => FROM_PATTERN.test(v), 'invalid'),
        // Bỏ trống = giữ khoá cũ; chưa có khoá thì bắt buộc.
        apiKey: z
          .string()
          .trim()
          .superRefine((v, ctx) => {
            if (v === '' && !view.hasApiKey) ctx.addIssue({ code: 'custom', message: 'required' });
            else if (v !== '' && v.length < 8) ctx.addIssue({ code: 'custom', message: 'short' });
          }),
      }),
    [view.hasApiKey],
  );
  const values = useMemo<FormValues>(() => ({ provider: 'resend', fromAddress: view.fromAddress, apiKey: '' }), [view.fromAddress]);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), values });
  const { errors, isDirty } = form.formState;
  useReportDirty(EMAIL_ID, isDirty, onDirtyChange);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testNote, setTestNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const put = useApiMutation('org.emailPut', { toastError: false, invalidate: ['admin.audit'] });
  const clear = useApiMutation('org.emailDelete', { toastError: false, invalidate: ['admin.audit'] });
  const test = useApiMutation('org.emailTest', { toastError: false, invalidate: ['admin.audit'] });
  const setView = (next: EmailSettingsView) => queryClient.setQueryData(apiKey('org.emailGet', {}), next);

  const submit = form.handleSubmit((next) => {
    put.mutate(
      { body: { provider: next.provider, fromAddress: next.fromAddress.trim(), ...(next.apiKey.trim() ? { apiKey: next.apiKey.trim() } : {}) } },
      {
        onSuccess: (saved) => {
          setView(saved);
          setSavedAt(new Date().toISOString());
          setTestNote(null);
          toast.success(fmt(vi.admin.org.settings.saved, { nhóm: t.title }));
        },
      },
    );
  });

  const serverIssue = put.error ? (fieldIssue(put.error, 'body.fromAddress') ? 'from' : fieldIssue(put.error, 'body.apiKey') ? 'key' : null) : null;
  const fromError = errors.fromAddress || serverIssue === 'from' ? t.fromInvalid : undefined;
  const keyError = errors.apiKey ? (errors.apiKey.message === 'required' ? t.apiKeyRequired : t.apiKeyInvalid) : serverIssue === 'key' ? t.apiKeyRequired : undefined;

  const runTest = () => {
    setTestNote(null);
    if (!z.email().safeParse(testTo.trim()).success) {
      setTestNote({ tone: 'error', text: t.testInvalid });
      return;
    }
    test.mutate(
      { body: { to: testTo.trim() } },
      {
        onSuccess: (res) =>
          setTestNote(
            res.ok
              ? { tone: 'info', text: fmt(t.testOk, { email: testTo.trim() }) }
              : { tone: 'error', text: res.error === 'transient' ? t.testTransient : res.error === 'permanent' ? t.testPermanent : t.testNotConfigured },
          ),
      },
    );
  };

  return (
    <>
      <SectionFrame
        id={EMAIL_ID}
        title={t.title}
        description={t.description}
        dirty={isDirty}
        saving={put.isPending}
        savedAt={savedAt}
        error={serverIssue ? null : put.error}
        onSubmit={(e) => void submit(e)}
        onDiscard={() => {
          put.reset();
          form.reset(values);
        }}
      >
        <Callout tone={view.active === 'org' ? 'info' : 'warn'}>{stateText(view.active)}</Callout>

        <Field label={t.provider}>
          <Select value="resend" onValueChange={() => undefined} options={[{ value: 'resend', label: t.providerResend }]} />
        </Field>
        <Field label={t.from} hint={t.fromHint} error={fromError}>
          <Input type="text" inputMode="email" autoComplete="off" spellCheck={false} placeholder="MIHATO <thu@ten-mien.vn>" {...form.register('fromAddress')} />
        </Field>
        <Field label={t.apiKey} hint={view.hasApiKey ? fmt(t.apiKeyKept, { n: view.apiKeyHint ?? '' }) : `${t.apiKeyNone} ${t.apiKeyHint}`} error={keyError}>
          <Input type="password" autoComplete="new-password" spellCheck={false} {...form.register('apiKey')} />
        </Field>

        <div className="flex flex-col gap-2 border-t border-hairline pt-4">
          <h3 className="font-semibold">{t.testTitle}</h3>
          <Field label={t.testTo} hint={isDirty ? t.testHint : undefined}>
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runTest();
                }
              }}
              className="max-w-96"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" loading={test.isPending} disabled={isDirty || testTo.trim() === ''} onClick={runTest}>
              {test.isPending ? t.testSending : t.testSend}
            </Button>
            {view.updatedAt !== null ? (
              <Button type="button" variant="ghost" onClick={() => setConfirmClear(true)}>
                {t.clear}
              </Button>
            ) : null}
          </div>
          {test.isError ? <Callout tone="error">{t.testNotConfigured}</Callout> : null}
          {testNote ? <Callout tone={testNote.tone}>{testNote.text}</Callout> : null}
        </div>
      </SectionFrame>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t.clearConfirmTitle}
        description={t.clearConfirmBody}
        confirmLabel={t.clear}
        tone="danger"
        loading={clear.isPending}
        onConfirm={() =>
          clear.mutate(
            {},
            {
              onSuccess: (next) => {
                setView(next);
                setConfirmClear(false);
                setTestNote(null);
                toast.success(t.cleared);
              },
              onError: () => setConfirmClear(false),
            },
          )
        }
      />
    </>
  );
}

/** Cài đặt gửi thư: nhà cung cấp, địa chỉ gửi, khoá (chỉ ghi) và nút gửi thư thử. Cấu hình lưu theo tổ chức, khoá được mã hoá. */
export function EmailSection({ onDirtyChange }: { onDirtyChange: SectionProps['onDirtyChange'] }) {
  const query = useApiQuery('org.emailGet', {});
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Skeleton className="h-72 rounded-xl" />;
  return <EmailForm view={query.data} onDirtyChange={onDirtyChange} />;
}
