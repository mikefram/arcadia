import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import type { RouteResponse } from '@mihato/api-client';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { PersonName } from '@/components/person-name';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldError } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { codeMessage, errorMessage } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiMutation } from '@/lib/query';
import { eligible, STEP_INVALIDATE, type DispatchDialogProps } from './shared';
import { SubmitToExecutive } from './submit-to-executive';

const t = vi.admin.shell.dispatch.nudge;
const MAX_MESSAGE = 1000;

type Draft = RouteResponse<'nudges.drafts'>['items'][number];
type SendResult = RouteResponse<'nudges.send'>['results'][number];

function canSend(draft: Draft): boolean {
  return !draft.throttled && draft.toUser !== null;
}

function throttleText(draft: Draft): string {
  const reason = draft.throttleReason ? t.throttled[draft.throttleReason] : t.throttled.fallback;
  return draft.nextAllowedAt ? `${reason} ${fmt(t.nextAllowed, { giờ: formatDateTime(draft.nextAllowedAt) })}` : reason;
}

function DraftHeader({ draft }: { draft: Draft }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
      <p className="font-semibold">
        <PersonName person={draft.toUser} capitalize />
      </p>
      {draft.lateWorkingDays > 0 ? <Badge tone="late">{fmt(t.lateDays, { n: draft.lateWorkingDays })}</Badge> : <span />}
      <p className="col-span-2 text-sm text-ink-sub">
        <span className="font-medium text-ink">{draft.stepTitle}</span>, {draft.runTitle}
      </p>
    </div>
  );
}

function NudgeFlow({ steps, onDone, onClose }: Pick<DispatchDialogProps, 'steps' | 'onDone'> & { onClose: () => void }) {
  const targets = eligible(steps, 'nudge');
  const stepIds = targets.map((s) => s.id);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);

  const drafts = useApiMutation('nudges.drafts', {
    toastError: false,
    onSuccess: (res) => setMessages(Object.fromEntries(res.items.map((d) => [d.stepId, d.message]))),
  });
  const send = useApiMutation('nudges.send', { invalidate: STEP_INVALIDATE, toastError: false, onSuccess: () => onDone?.() });

  // Soạn nháp một lần khi hộp thoại mở (StrictMode chạy effect hai lần khi phát triển).
  const { mutate: requestDrafts } = drafts;
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current || stepIds.length === 0) return;
    requested.current = true;
    requestDrafts({ body: { stepIds } });
  });

  const items = drafts.data?.items ?? [];
  const sendable = items.filter(canSend);
  const tooLong = (d: Draft) => (messages[d.stepId] ?? '').length > MAX_MESSAGE;
  const empty = (d: Draft) => (messages[d.stepId] ?? '').trim().length === 0;

  const submit = () => {
    if (sendable.some((d) => empty(d) || tooLong(d))) {
      setShowErrors(true);
      return;
    }
    send.mutate({ body: { items: sendable.map((d) => ({ stepId: d.stepId, message: (messages[d.stepId] ?? '').trim() })) } });
  };

  // ───── Bước 3: kết quả từng lời nhắc ─────
  if (send.data) {
    const byStep = new Map(items.map((d) => [d.stepId, d]));
    const results: SendResult[] = send.data.results;
    const okCount = results.filter((r) => r.ok).length;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t.resultTitle}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Callout tone={okCount === results.length ? 'success' : 'warn'}>
            {okCount === results.length ? fmt(t.doneAll, { n: okCount }) : fmt(t.summary, { n: okCount, tổng: results.length })}
          </Callout>
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {results.map((r) => {
              const draft = byStep.get(r.stepId);
              const next = r.error?.nextAllowedAt;
              return (
                <li key={r.stepId} className="flex items-start gap-2.5 px-3.5 py-2.5">
                  {r.ok ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /> : <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-medium">
                      {draft?.toUser ? `${personName(draft.toUser, 'short', true)}, ` : null}
                      {draft?.stepTitle ?? r.stepId}
                    </p>
                    <p className="text-sm text-ink-sub">
                      {r.ok ? t.sent : `${t.notSent}. ${codeMessage(r.error?.code ?? '')}`}
                      {!r.ok && next ? ` ${fmt(t.nextAllowed, { giờ: formatDateTime(next) })}` : null}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="primary">{vi.admin.shell.ui.close}</Button>
          </DialogClose>
        </DialogFooter>
      </>
    );
  }

  // ───── Bước 1 và 2: soạn nháp, đọc lại và sửa ─────
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody aria-busy={drafts.isPending || undefined}>
        {drafts.isError ? (
          <Callout
            tone="error"
            action={
              <Button size="sm" onClick={() => requestDrafts({ body: { stepIds } })}>
                {vi.admin.shell.ui.retry}
              </Button>
            }
          >
            {t.draftFailed} {errorMessage(drafts.error)}
          </Callout>
        ) : null}
        {send.isError ? <Callout tone="error">{errorMessage(send.error)}</Callout> : null}

        {drafts.isPending || (drafts.isIdle && stepIds.length > 0) ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t.drafting}</span>
            {stepIds.slice(0, 3).map((id) => (
              <div key={id} className="rounded-lg border border-hairline p-3.5">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="mt-2 h-4 w-64 max-w-full" />
                <Skeleton className="mt-3 h-20 w-full" />
              </div>
            ))}
          </div>
        ) : null}

        {stepIds.length === 0 ? <Callout tone="info">{t.nothingToSend}</Callout> : null}

        {drafts.data ? (
          <>
            <p className="text-sm text-ink-sub">{fmt(t.sender, { tên: drafts.data.senderName })}</p>
            <ul className="flex flex-col gap-3">
              {items.map((draft) => {
                const id = `nudge-${draft.stepId}`;
                const error = showErrors && canSend(draft) ? (empty(draft) ? t.messageRequired : tooLong(draft) ? t.messageTooLong : null) : null;
                return (
                  <li key={draft.stepId} className="flex flex-col gap-2.5 rounded-lg border border-hairline p-3.5">
                    <DraftHeader draft={draft} />
                    {canSend(draft) ? (
                      <>
                        <label htmlFor={id} className="sr-only">
                          {fmt(t.message, { tên: draft.toUser ? personName(draft.toUser, 'short') : '' })}
                        </label>
                        <Textarea
                          id={id}
                          rows={3}
                          value={messages[draft.stepId] ?? ''}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? `${id}-error` : undefined}
                          onChange={(e) => setMessages((m) => ({ ...m, [draft.stepId]: e.target.value }))}
                        />
                        {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
                      </>
                    ) : (
                      <Callout tone="warn" title={t.cannotSend}>
                        {draft.toUser === null ? t.noRecipient : throttleText(draft)}
                      </Callout>
                    )}
                  </li>
                );
              })}
            </ul>
            {sendable.length === 0 ? <Callout tone="info">{t.nothingToSend}</Callout> : null}
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <SubmitToExecutive
          tool="propose_nudge"
          payload={{ stepRunIds: sendable.map((d) => d.stepId), named: true }}
          note={vi.admin.shell.dispatch.submit.nudgeNote}
          disabled={sendable.length === 0}
          onDone={() => {
            onDone?.();
            onClose();
          }}
        />
        <Button variant="primary" loading={send.isPending} disabled={sendable.length === 0} onClick={submit}>
          {sendable.length > 1 ? fmt(t.send, { n: sendable.length }) : t.sendOne}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Đi thúc (SPEC 9.4, 10.6): `nudges.drafts` soạn nháp theo ma trận xưng hô, người dùng đọc lại và sửa từng lời,
 * bấm Gửi gọi `nudges.send`, rồi hiện kết quả từng lời nhắc. Mục bị chặn làm phiền hiện lý do và giờ nhắc lại được,
 * và không được gửi.
 */
export function NudgeDialog({ open, onOpenChange, steps, onDone }: DispatchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <NudgeFlow steps={steps} onDone={onDone} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
