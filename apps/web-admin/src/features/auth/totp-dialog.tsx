import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Copy } from 'lucide-react';
import * as QRCode from 'qrcode';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { errorMessage, isApiError } from '@/lib/errors';
import { useApiMutation } from '@/lib/query';

const t = vi.admin.shell.auth.totp;

const schema = z.object({ code: z.string().regex(/^\d{6}$/, t.codeInvalid) });
type FormValues = z.infer<typeof schema>;

/** Khoá chữ chia nhóm bốn ký tự cho dễ gõ tay. */
function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Bật xác thực hai bước: `auth.totpSetup` tạo khoá, hiện mã QR và khoá chữ,
 * người dùng nhập mã 6 số rồi `auth.totpEnable`.
 */
export function TotpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const setup = useApiMutation('auth.totpSetup', { toastError: false });
  const enable = useApiMutation('auth.totpEnable', { toastError: false, invalidate: ['me.get'] });
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const { mutate: startSetup, data: setupData } = setup;
  // Chỉ tạo khoá một lần cho mỗi lần mở (StrictMode chạy effect hai lần khi phát triển).
  const started = useRef(false);
  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      startSetup({});
    }
    if (!open) started.current = false;
  }, [open, startSetup]);

  useEffect(() => {
    if (!setupData) return;
    let cancelled = false;
    QRCode.toDataURL(setupData.otpauthUrl, { margin: 1, width: 208, color: { dark: '#1F1B16', light: '#FFFFFF' } })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // Không vẽ được mã QR thì người dùng vẫn nhập được khoá chữ bên dưới.
      });
    return () => {
      cancelled = true;
    };
  }, [setupData]);

  const copySecret = async () => {
    if (!setupData) return;
    try {
      await navigator.clipboard.writeText(setupData.secret);
      toast.success(vi.admin.shell.ui.copied);
    } catch {
      // Trình duyệt chặn bộ nhớ tạm: người dùng chép tay khoá đang hiện.
    }
  };

  const submit = form.handleSubmit((values) => {
    enable.mutate(
      { body: { code: values.code } },
      {
        onSuccess: () => {
          toast.success(t.enabled);
          onOpenChange(false);
        },
      },
    );
  });

  const enableError = enable.isError ? (isApiError(enable.error) && enable.error.status < 500 && enable.error.status !== 429 ? t.codeWrong : errorMessage(enable.error)) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription>{t.intro}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {setup.isError ? (
              <Callout
                tone="error"
                action={
                  <Button size="sm" onClick={() => startSetup({})}>
                    {vi.admin.shell.ui.retry}
                  </Button>
                }
              >
                {t.setupFailed} {errorMessage(setup.error)}
              </Callout>
            ) : (
              <>
                <section aria-busy={!setupData || undefined}>
                  <h3 className="font-semibold">{t.stepScan}</h3>
                  <div className="mt-2.5 flex flex-col items-center gap-3 rounded-xl border border-hairline bg-canvas p-4">
                    {qr ? <img src={qr} alt={t.qrAlt} width={208} height={208} className="rounded-md" /> : <Skeleton className="size-52" />}
                    {setupData ? (
                      <div className="w-full text-center">
                        <p className="text-sm text-ink-sub">{t.manual}</p>
                        <p className="tabular mt-1 font-semibold break-all select-all">{groupSecret(setupData.secret)}</p>
                        <Button variant="ghost" size="sm" className="mt-1" onClick={() => void copySecret()}>
                          <Copy aria-hidden="true" />
                          {t.copyKey}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-ink-sub">{t.preparing}</p>
                    )}
                  </div>
                </section>
                <section>
                  <h3 className="font-semibold">{t.stepCode}</h3>
                  <Field label={t.code} hideLabel error={form.formState.errors.code?.message ?? enableError} className="mt-2.5">
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      disabled={!setupData}
                      className="tabular h-12 text-center text-xl font-semibold tracking-[0.4em]"
                      {...form.register('code')}
                    />
                  </Field>
                </section>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={enable.isPending} disabled={!setupData}>
              {t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
