import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Hand, Stamp } from 'lucide-react';
import type { StepDetail } from '@mihato/domain';
import { fmt, formatDateTime, formatMoney, vi } from '@mihato/i18n';
import { DueLabel, formatDue } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { StatusChip } from '@/components/status-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StepActionButtons } from '@/features/dispatch';
import { errorMessage, isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { useApiQuery } from '@/lib/query';
import { PresentedFile } from './run-attachments';
import { StepComments } from './step-comments';
import { blockedLabel, NudgeList, SectionHeading, StepCompiledFiles, StepHistory, StepParticipants, StepResult } from './step-parts';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.runs.step;

function Facts({ step }: { step: StepDetail }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
      <dt className="text-ink-sub">{t.state}</dt>
      <dd>
        <StatusChip step={step} />
      </dd>
      <dt className="text-ink-sub">{t.assignee}</dt>
      <dd>
        <PersonName person={step.assignee} fallback={vi.common.stepState.unassigned} />
        {step.onBehalfOf ? <span className="text-ink-sub">, {fmt(vi.common.onBehalfOf, { tên: personName(step.onBehalfOf, 'full') })}</span> : null}
        {step.unitName ? <p className="text-sm text-ink-sub">{step.unitName}</p> : null}
      </dd>
      <dt className="text-ink-sub">{t.assignedBy}</dt>
      <dd>
        <PersonName person={step.assignedBy} fallback="–" />
      </dd>
      <dt className="text-ink-sub">{t.due}</dt>
      <dd>
        <DueLabel dueAt={step.dueAt} dueOriginalAt={step.dueOriginalAt} isOverdue={step.isOverdue} lateWorkingDays={step.lateWorkingDays} closed={step.completedAt !== null} />
      </dd>
      {step.completedAt ? (
        <>
          <dt className="text-ink-sub">{step.state === 'done' ? t.completedAt : t.closedAt}</dt>
          <dd>
            <time dateTime={step.completedAt} className="tabular">
              {formatDateTime(step.completedAt)}
            </time>
          </dd>
        </>
      ) : null}
      {step.amountVnd !== null ? (
        <>
          <dt className="text-ink-sub">{t.amount}</dt>
          <dd className="tabular font-semibold">{formatMoney(step.amountVnd)}</dd>
        </>
      ) : null}
    </dl>
  );
}

function StepDetailBody({ step }: { step: StepDetail }) {
  return (
    <>
      <Facts step={step} />

      {step.blockedReason ? (
        <Callout tone="warn">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Hand aria-hidden="true" className="size-4" />
            {fmt(t.blocked, { 'lý do': blockedLabel(step.blockedReason) })}
          </span>
        </Callout>
      ) : null}

      {step.pendingExtension ? (
        <Callout tone="info" title={fmt(t.extensionPending, { ngày: formatDue(step.pendingExtension.proposedDueAt) })}>
          {fmt(t.extensionReason, { 'lý do': step.pendingExtension.reason })}
        </Callout>
      ) : null}

      {step.kind === 'approval' ? <PresentedFile runId={step.runId} /> : null}

      <section className="flex flex-col gap-2">
        <SectionHeading>{t.description}</SectionHeading>
        {step.description ? <p className="whitespace-pre-line">{step.description}</p> : <p className="text-ink-sub">{t.noDescription}</p>}
      </section>

      {step.checklist.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading>{t.checklist}</SectionHeading>
          <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-sub">
            {step.checklist.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <StepResult step={step} />
      <StepParticipants step={step} />
      <StepCompiledFiles files={step.files} />
      <NudgeList nudges={step.nudges} />
      <StepHistory items={step.history} contribute={step.action === 'contribute'} />
      <StepComments stepId={step.id} />
    </>
  );
}

export type StepDetailSheetProps = {
  /** id việc đang xem; null thì đóng */
  stepId: string | null;
  onOpenChange: (open: boolean) => void;
  /** hiện đường dẫn tới lượt chạy (dùng ở màn Công việc; ở chi tiết lượt chạy thì không cần) */
  linkRun?: boolean;
};

/**
 * Bảng trượt chi tiết một việc cho người điều phối (`steps.get`): mô tả, danh sách kiểm, kết quả đã nhập,
 * lời đi thúc kèm trả lời nhanh, lịch sử. Chỉ có thao tác điều phối (giao lại, gia hạn, bỏ qua, đi thúc);
 * không có "báo hoàn thành thay" hay "duyệt thay" (SPEC 9.4).
 */
export function StepDetailSheet({ stepId, onOpenChange, linkRun = false }: StepDetailSheetProps) {
  const detail = useApiQuery('steps.get', { params: { id: stepId ?? '' } }, { enabled: stepId !== null });
  const step = stepId !== null ? detail.data : undefined;

  return (
    <Sheet open={stepId !== null} onOpenChange={onOpenChange}>
      <SheetContent aria-busy={detail.isPending || undefined}>
        <SheetHeader>
          {step?.kind === 'approval' ? (
            <p>
              <Badge tone="gold">
                <Stamp aria-hidden="true" />
                {step.action === 'contribute' ? t.kindContribute : t.kindApproval}
              </Badge>
            </p>
          ) : null}
          <SheetTitle>{step?.title ?? t.loading}</SheetTitle>
          <SheetDescription>{step ? runLabel(step) : ' '}</SheetDescription>
          {linkRun && step ? (
            <p>
              <Button asChild variant="link" size="sm">
                <Link to="/luot-chay/$runId" params={{ runId: step.runId }}>
                  {t.openRun}
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </Button>
            </p>
          ) : null}
        </SheetHeader>
        <SheetBody className="gap-5">
          {detail.isError ? (
            <Callout tone="error" title={isApiError(detail.error, 'not_found') ? t.notFoundTitle : t.loadFailed}>
              {isApiError(detail.error, 'not_found') ? t.notFoundBody : errorMessage(detail.error)}
            </Callout>
          ) : step ? (
            <StepDetailBody step={step} />
          ) : (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-3/5" />
              <Skeleton className="mt-3 h-24 w-full" />
            </div>
          )}
        </SheetBody>
        {step && step.allowedActions.some((a) => a === 'nudge' || a === 'reassign' || a === 'extend' || a === 'skip') ? (
          <SheetFooter className="sm:justify-start">
            <StepActionButtons step={step} />
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
