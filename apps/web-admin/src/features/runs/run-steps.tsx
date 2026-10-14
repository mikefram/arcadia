import { useState } from 'react';
import { CalendarClock, Hand, Stamp } from 'lucide-react';
import type { ExtensionRequestView, StepView } from '@mihato/domain';
import { fmt, formatDateTime, formatMoney, vi } from '@mihato/i18n';
import { CommentCount } from '@/components/comment-count';
import { DueLabel, formatDue } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { StatusChip } from '@/components/status-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ExtensionDecisionDialog, StepActionsMenu } from '@/features/dispatch';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { personName } from '@/lib/person';
import { useApiQuery } from '@/lib/query';
import { blockedLabel } from './step-parts';

const t = vi.admin.runs.detail.steps;

function StepRow({ step, request, onOpen, onDecide }: { step: StepView; request: ExtensionRequestView | undefined; onOpen: () => void; onDecide: (request: ExtensionRequestView) => void }) {
  const waiting = step.state === 'pending';
  const closed = step.completedAt !== null || step.state === 'skipped' || step.state === 'cancelled';
  return (
    <li className={cn('relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-canvas md:grid-cols-[minmax(0,1fr)_11.5rem_9.5rem_2rem] md:items-start', step.isOverdue && 'bg-late-bg/40 hover:bg-late-bg/60')}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* Lớp phủ của nút trải hết dòng: bấm đâu trên dòng cũng mở chi tiết; các nút khác nổi lên trên. */}
          <button
            type="button"
            onClick={onOpen}
            aria-label={fmt(t.open, { việc: step.title })}
            className={cn('rounded-sm text-left font-medium after:absolute after:inset-0 hover:text-primary', waiting && 'text-ink-sub')}
          >
            {step.title}
          </button>
          {step.kind === 'approval' ? (
            <Badge tone="gold">
              <Stamp aria-hidden="true" />
              {step.action === 'contribute' ? t.kindContribute : t.kindApproval}
            </Badge>
          ) : null}
        </p>
        {/* Việc chưa tới lượt thì chưa có người nhận: không hiện dòng này. */}
        {step.assignee || step.state === 'unassigned' ? (
          <p className="mt-0.5 text-sm text-ink-sub">
            <PersonName person={step.assignee} fallback={vi.common.stepState.unassigned} className={step.assignee ? 'text-ink' : 'font-medium text-warn'} />
            {step.onBehalfOf ? `, ${fmt(vi.common.onBehalfOf, { tên: personName(step.onBehalfOf, 'full') })}` : null}
            {step.unitName ? `, ${step.unitName}` : null}
          </p>
        ) : null}
        {step.kind === 'approval' && step.action === 'contribute' && (step.participants ?? []).length > 0 ? (
          <p className="mt-1">
            <Badge tone="muted">
              {fmt(vi.admin.runs.step.participants.progressBadge, {
                xong: (step.participants ?? []).filter((p) => p.decision !== null).length,
                tổng: (step.participants ?? []).length,
              })}
            </Badge>
          </p>
        ) : null}
        {step.commentCount ? (
          <p className="mt-1">
            <CommentCount count={step.commentCount} />
          </p>
        ) : null}
        {step.kind === 'approval' && step.amountVnd !== null ? <p className="tabular mt-0.5 text-sm font-medium">{fmt(t.amount, { tiền: formatMoney(step.amountVnd) })}</p> : null}
        {step.blockedReason ? (
          <p className="mt-1.5">
            <Badge tone="warn">
              <Hand aria-hidden="true" />
              {fmt(t.blockedReason, { 'lý do': blockedLabel(step.blockedReason) })}
            </Badge>
          </p>
        ) : null}
        {step.pendingExtension ? (
          <div className="relative z-10 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-hairline bg-surface px-3 py-2">
            <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-ink-sub" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">{fmt(t.extensionPending, { ngày: formatDue(step.pendingExtension.proposedDueAt) })}</span>
              <span className="block text-sm text-ink-sub">{fmt(t.extensionReason, { 'lý do': step.pendingExtension.reason })}</span>
            </p>
            {request ? (
              <Button size="sm" aria-label={fmt(t.decideExtensionFor, { việc: step.title })} onClick={() => onDecide(request)}>
                {t.decideExtension}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="col-start-1 md:col-start-2">
        {!step.dueAt && (waiting || closed) ? null : (
          <DueLabel dueAt={step.dueAt} dueOriginalAt={step.dueOriginalAt} isOverdue={step.isOverdue} lateWorkingDays={step.lateWorkingDays} closed={closed} className="text-base" />
        )}
        {step.completedAt ? (
          <p className="text-sm text-ink-sub">
            {/* Chỉ việc xong mới ghi "Xong"; việc bị bỏ qua, chưa được đồng ý hay bị huỷ ghi "Khép lại". */}
            <time dateTime={step.completedAt}>{fmt(step.state === 'done' ? t.completedAt : t.closedAt, { ngày: formatDateTime(step.completedAt) })}</time>
          </p>
        ) : null}
      </div>

      <div className="col-start-1 md:col-start-3">
        <StatusChip step={step} />
      </div>

      <div className="relative z-10 col-start-2 row-start-1 justify-self-end md:col-start-4">
        <StepActionsMenu step={step} />
      </div>
    </li>
  );
}

/**
 * Danh sách việc của một lượt chạy: người nhận (kèm "thay mặt …" khi có ủy quyền), hạn và hạn gốc, trạng thái,
 * cờ đang vướng, yêu cầu gia hạn chờ duyệt kèm nút quyết định, số tiền ở việc duyệt. Bấm một việc để mở chi tiết.
 */
export function RunSteps({ steps, onOpenStep }: { steps: readonly StepView[]; onOpenStep: (stepId: string) => void }) {
  const can = useCan();
  const [deciding, setDeciding] = useState<ExtensionRequestView | null>(null);
  const hasPending = steps.some((s) => s.pendingExtension !== null);
  // Hộp thoại quyết định cần đủ yêu cầu (người xin, ngày tạo): lấy từ danh sách chờ duyệt, khớp theo id.
  const requests = useApiQuery('extensionRequests.list', { query: { state: 'pending' } }, { enabled: hasPending && can('extension.decide') });
  const requestById = new Map((requests.data?.items ?? []).map((r) => [r.id, r]));

  return (
    <Card aria-labelledby="luot-chay-danh-sach-viec" className="min-w-0 overflow-hidden">
      <CardHeader className="items-baseline border-b border-hairline">
        <CardTitle id="luot-chay-danh-sach-viec">{t.title}</CardTitle>
        <span className="text-sm text-ink-sub">{fmt(t.count, { n: steps.length })}</span>
      </CardHeader>
      {steps.length === 0 ? (
        <p className="px-5 py-6 text-ink-sub">{t.empty}</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              request={step.pendingExtension ? requestById.get(step.pendingExtension.id) : undefined}
              onOpen={() => onOpenStep(step.id)}
              onDecide={setDeciding}
            />
          ))}
        </ul>
      )}
      <ExtensionDecisionDialog
        open={deciding !== null}
        request={deciding}
        onOpenChange={(open) => {
          if (!open) setDeciding(null);
        }}
      />
    </Card>
  );
}
