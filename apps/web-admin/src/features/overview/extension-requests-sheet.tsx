import { useState } from 'react';
import type { ExtensionRequestView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { formatDue } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { Button } from '@/components/ui/button';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { ExtensionDecisionDialog } from '@/features/dispatch';
import { useCan } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiQuery } from '@/lib/query';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.shell.overview.extensions;

/** Danh sách yêu cầu gia hạn chờ duyệt, mở từ thẻ số của Tổng quan. */
export function ExtensionRequestsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const can = useCan();
  const [deciding, setDeciding] = useState<ExtensionRequestView | null>(null);
  const requests = useApiQuery('extensionRequests.list', { query: { state: 'pending' } }, { enabled: open });
  const items = requests.data?.items ?? [];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{t.title}</SheetTitle>
            <SheetDescription>{t.description}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            {requests.isPending ? (
              <Spinner showLabel />
            ) : requests.isError ? (
              <p className="text-ink-sub">{errorMessage(requests.error)}</p>
            ) : items.length === 0 ? (
              <p className="text-ink-sub">{t.empty}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {items.map((req) => (
                  <li key={req.id} className="rounded-lg border border-hairline p-3.5">
                    <p className="font-semibold">{req.step.title}</p>
                    <p className="text-sm text-ink-sub">{runLabel(req.step)}</p>
                    <p className="mt-2">
                      {fmt(t.asks, { tên: personName(req.requestedBy, 'full', true) })} <span className="font-medium">{fmt(t.to, { ngày: formatDue(req.proposedDueAt) })}</span>
                    </p>
                    <p className="mt-1 text-sm whitespace-pre-line text-ink-sub">{req.reason}</p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-sm text-ink-sub">
                        {vi.admin.shell.dispatch.extension.current}: {req.step.dueAt ? formatDue(req.step.dueAt) : vi.common.due.none}
                      </span>
                      {can('extension.decide') ? (
                        <Button size="sm" onClick={() => setDeciding(req)}>
                          {t.decide}
                        </Button>
                      ) : (
                        <PersonName person={req.step.assignee} form="short" className="text-sm text-ink-sub" />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <ExtensionDecisionDialog
        open={deciding !== null}
        request={deciding}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeciding(null);
        }}
      />
    </>
  );
}
