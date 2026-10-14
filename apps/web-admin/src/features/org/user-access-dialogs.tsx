import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Printer, QrCode } from 'lucide-react';
import * as QRCode from 'qrcode';
import type { Role, UserView } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useMe } from '@/lib/auth';
import { errorMessage, isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiMutation } from '@/lib/query';
import { copyText } from './shared';

const t = vi.admin.org.users;
const QR_SIZE = 216;

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; user: UserView | null };

/** Ô chỉ đọc chứa đường dẫn một lần: bấm vào là bôi chọn hết để chép tay khi trình duyệt chặn bộ nhớ tạm. */
function LinkField({ label, hint, value }: { label: string; hint?: string; value: string }) {
  return (
    <Field label={label} hint={hint}>
      <Input readOnly value={value} spellCheck={false} onFocus={(e) => e.currentTarget.select()} className="tabular bg-canvas text-sm" />
    </Field>
  );
}

function CreateFailed({ error, fallback, onRetry }: { error: unknown; fallback: string; onRetry: () => void }) {
  const disabled = isApiError(error, 'state_conflict');
  return (
    <Callout
      tone="error"
      action={
        disabled ? undefined : (
          <Button size="sm" onClick={onRetry}>
            {vi.admin.shell.ui.retry}
          </Button>
        )
      }
    >
      {disabled ? t.activation.userDisabled : `${fallback} ${errorMessage(error)}`}
    </Callout>
  );
}

/**
 * In một tờ có mã QR và cách dùng để Văn phòng đưa tận tay (SPEC 9.5 điều 2). Dùng một khung ẩn riêng nên tờ in
 * chỉ có nội dung cần đưa, không dính giao diện quản trị. Nội dung dựng bằng DOM, không ghép chuỗi HTML.
 */
function printActivationSheet(sheet: { org: string; title: string; person: string; qr: string; qrAlt: string; steps: readonly string[]; lines: readonly string[] }): void {
  document.querySelector('iframe[data-print-frame]')?.remove();
  const frame = document.createElement('iframe');
  frame.setAttribute('data-print-frame', '');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.title = `${sheet.title}: ${sheet.person}`;
  const style = doc.createElement('style');
  style.textContent = [
    '@page { margin: 18mm; }',
    "body { margin: 0; font-family: 'Be Vietnam Pro', system-ui, sans-serif; color: #1f1b16; font-size: 12pt; line-height: 1.5; }",
    'h1 { font-size: 18pt; margin: 0 0 2pt; }',
    '.org { margin: 0 0 14pt; font-size: 11pt; }',
    '.person { margin: 0; font-size: 14pt; font-weight: 600; }',
    'img { display: block; width: 64mm; height: 64mm; margin: 12pt 0; }',
    'ol { margin: 0 0 10pt; padding-left: 16pt; }',
    'p { margin: 0 0 4pt; }',
  ].join('\n');
  doc.head.appendChild(style);

  const add = (tag: string, text: string, className?: string) => {
    const el = doc.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    doc.body.appendChild(el);
    return el;
  };
  add('h1', sheet.title);
  add('p', sheet.org, 'org');
  add('p', sheet.person, 'person');
  const img = doc.createElement('img');
  img.alt = sheet.qrAlt;
  doc.body.appendChild(img);
  const list = doc.createElement('ol');
  for (const step of sheet.steps) {
    const li = doc.createElement('li');
    li.textContent = step;
    list.appendChild(li);
  }
  doc.body.appendChild(list);
  for (const line of sheet.lines) add('p', line);

  win.addEventListener('afterprint', () => frame.remove());
  img.addEventListener('load', () => {
    win.focus();
    win.print();
  });
  img.src = sheet.qr;
}

type AppKind = 'executive' | 'staff';

/**
 * Giám đốc và Phó giám đốc dùng được cả hai app (SPEC 8.6 điều 4: Phó giám đốc chạy kịch bản vàng trên app nhân viên),
 * nên Quản trị hệ thống chọn app khi cấp máy (`users.activation?app=`). Chủ tịch luôn dùng app Điều hành; mọi vai trò
 * khác luôn dùng app nhân viên: không có gì để chọn.
 */
const CHOOSABLE_APP_ROLES: readonly Role[] = ['director', 'deputy'];
const canChooseApp = (user: UserView): boolean => user.roles.some((r) => CHOOSABLE_APP_ROLES.includes(r.role)) && !user.roles.some((r) => r.role === 'chairman');

/** Đường dẫn do máy chủ dựng: app Điều hành có đuôi `-exec` ở tên lược đồ (`mihato-exec://activate`), app nhân viên thì không. */
const appOfLink = (url: string): AppKind => (/^[a-z][a-z0-9+.-]*-exec:\/\//i.test(url) ? 'executive' : 'staff');

function AppChoice({ value, onChange }: { value: AppKind; onChange: (app: AppKind) => void }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2.5">
      <legend className="text-base font-medium">{t.activation.app.legend}</legend>
      <p className="text-sm text-ink-sub">{t.activation.app.hint}</p>
      {(['executive', 'staff'] as const).map((kind) => (
        <label
          key={kind}
          className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-4 py-3 transition-colors hover:bg-canvas has-checked:border-primary has-checked:bg-primary-tint/50 has-checked:hover:bg-primary-tint/50"
        >
          <input type="radio" name="activation-app" value={kind} checked={value === kind} onChange={() => onChange(kind)} className="mt-1 size-4 shrink-0 accent-primary" />
          <span className="min-w-0">
            <span className="block font-semibold">{t.activation.app[kind].name}</span>
            <span className="block text-ink-sub">{t.activation.app[kind].note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ActivationBody({ user }: { user: UserView }) {
  const me = useMe();
  const name = personName(user, 'full');
  const [qr, setQr] = useState<string | null>(null);
  const choosable = canChooseApp(user);
  const [app, setApp] = useState<AppKind>('executive');
  // Người có thể chọn app thì chọn trước rồi mới tạo mã: mỗi mã đã tạo là một mã còn hiệu lực 72 giờ nên không tạo thừa.
  // Người khác tạo ngay khi mở, app theo vai trò.
  const [chosen, setChosen] = useState(!choosable);
  const create = useApiMutation('users.activation', { toastError: false, invalidate: ['admin.audit'] });
  const { mutate, data } = create;

  // Chỉ tạo một mã cho mỗi lần mở (StrictMode chạy effect hai lần khi phát triển).
  const requested = useRef(false);
  useEffect(() => {
    if (!chosen || requested.current) return;
    requested.current = true;
    mutate({ params: { id: user.id }, ...(choosable ? { query: { app } } : {}) });
  }, [mutate, user.id, chosen, choosable, app]);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    QRCode.toDataURL(data.qrPayload, { margin: 1, width: QR_SIZE * 2, errorCorrectionLevel: 'M', color: { dark: '#1F1B16', light: '#FFFFFF' } })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // Không vẽ được mã QR thì vẫn còn đường dẫn kích hoạt bên dưới.
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  // "Mã chỉ hiện một lần": đóng hộp thoại thì gỡ luôn tờ in còn nằm trong trang.
  useEffect(() => () => document.querySelector('iframe[data-print-frame]')?.remove(), []);

  const expires = data ? fmt(t.activation.expires, { giờ: formatDateTime(data.expiresAt) }) : null;
  const appName = data ? t.activation.app[appOfLink(data.url)].name : null;
  const request = () => mutate({ params: { id: user.id }, ...(choosable ? { query: { app } } : {}) });

  const print = () => {
    if (!data || !qr || !appName) return;
    printActivationSheet({
      org: me.orgName,
      title: t.activation.title,
      person: name,
      qr,
      qrAlt: fmt(t.activation.qrAlt, { tên: name }),
      steps: t.activation.printSteps.map((step) => fmt(step, { 'ứng dụng': appName })),
      lines: [expires ?? '', t.activation.printNote].filter(Boolean),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.activation.title}</DialogTitle>
        <DialogDescription>{fmt(t.activation.forUser, { tên: name })}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {!chosen ? (
          <AppChoice value={app} onChange={setApp} />
        ) : create.isError ? (
          <CreateFailed error={create.error} fallback={t.activation.failed} onRetry={request} />
        ) : (
          <>
            <Callout tone="warn" title={t.activation.onceTitle}>
              {t.activation.onceBody}
            </Callout>
            <div aria-busy={!data || undefined} className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-5">
              <div className="shrink-0 rounded-xl border border-hairline bg-surface p-2.5">
                {qr ? (
                  <img src={qr} alt={fmt(t.activation.qrAlt, { tên: name })} width={QR_SIZE} height={QR_SIZE} data-testid="activation-qr" />
                ) : (
                  <Skeleton style={{ width: QR_SIZE, height: QR_SIZE }} />
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2.5">
                {appName ? <p className="font-medium">{fmt(t.activation.app.current, { 'ứng dụng': appName })}</p> : null}
                <p>{t.activation.scanHint}</p>
                {expires ? <p className="font-medium">{expires}</p> : <Spinner label={t.activation.creating} showLabel />}
              </div>
            </div>
            {data ? <LinkField label={t.activation.linkLabel} hint={t.activation.linkHint} value={data.url} /> : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary" className="sm:mr-auto">
            {vi.admin.shell.ui.close}
          </Button>
        </DialogClose>
        {chosen ? (
          <>
            <Button disabled={!qr} onClick={print}>
              <Printer aria-hidden="true" />
              {t.activation.print}
            </Button>
            <Button variant="primary" disabled={!data} onClick={() => data && void copyText(data.url, t.activation.copied, t.activation.copyFailed)}>
              <Copy aria-hidden="true" />
              {t.activation.copy}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setChosen(true)}>
            <QrCode aria-hidden="true" />
            {t.activation.app.create}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * Tạo mã kích hoạt thiết bị (`users.activation`, SPEC 9.5 điều 2): mã QR, đường dẫn, hạn 72 giờ, dùng một lần.
 * Mã gốc chỉ có ở phản hồi này nên hộp thoại nói rõ "mã chỉ hiện một lần", kèm nút chép và nút in.
 */
export function ActivationDialog({ open, onOpenChange, user }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{user ? <ActivationBody user={user} /> : null}</DialogContent>
    </Dialog>
  );
}

function PasswordLinkBody({ user, onEditProfile }: { user: UserView; onEditProfile: () => void }) {
  const name = personName(user, 'full');
  const create = useApiMutation('users.passwordLink', { toastError: false, invalidate: ['admin.audit'] });
  const { mutate, data } = create;
  const hasEmail = user.email !== null;

  const started = useRef(false);
  useEffect(() => {
    if (!hasEmail || started.current) return;
    started.current = true;
    mutate({ params: { id: user.id } });
  }, [mutate, user.id, hasEmail]);

  let body: ReactNode;
  if (!hasEmail) {
    body = (
      <Callout
        tone="info"
        action={
          <Button size="sm" onClick={onEditProfile}>
            {t.passwordLink.editProfile}
          </Button>
        }
      >
        {t.passwordLink.noEmail}
      </Callout>
    );
  } else if (create.isError) {
    body = <CreateFailed error={create.error} fallback={t.passwordLink.failed} onRetry={() => mutate({ params: { id: user.id } })} />;
  } else if (!data) {
    body = <Spinner label={t.passwordLink.creating} showLabel />;
  } else {
    body = (
      <>
        <Callout tone="warn" title={t.passwordLink.onceTitle}>
          {t.passwordLink.onceBody}
        </Callout>
        <LinkField label={t.passwordLink.linkLabel} value={data.url} />
        <p className="font-medium">{fmt(t.passwordLink.expires, { giờ: formatDateTime(data.expiresAt) })}</p>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.passwordLink.title}</DialogTitle>
        <DialogDescription>{fmt(t.passwordLink.forUser, { tên: name })}</DialogDescription>
      </DialogHeader>
      <DialogBody>{body}</DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        {hasEmail ? (
          <Button variant="primary" disabled={!data} onClick={() => data && void copyText(data.url, t.activation.copied, t.activation.copyFailed)}>
            <Copy aria-hidden="true" />
            {t.passwordLink.copy}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

/** Tạo đường dẫn đặt mật khẩu web (`users.passwordLink`). Hồ sơ chưa có email thì mời sửa hồ sơ trước, không gọi máy chủ. */
export function PasswordLinkDialog({ open, onOpenChange, user, onEditProfile }: DialogProps & { onEditProfile: (user: UserView) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{user ? <PasswordLinkBody user={user} onEditProfile={() => onEditProfile(user)} /> : null}</DialogContent>
    </Dialog>
  );
}
