import { useEffect, useState, type ReactNode } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { BellRing, CalendarClock, CalendarPlus, Check, ChevronLeft, Hand, HandHelping, Send, Share2, Stamp, ThumbsUp, UserRoundPen, UsersRound, X } from 'lucide-react';
import type { StepDetail } from '@mihato/domain';
import { fmt, formatDateTime, formatMoney, vi } from '@mihato/i18n';
import { DueLabel, formatDue } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { StatusChip } from '@/components/status-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { allows, ReassignDialog, STEP_INVALIDATE } from '@/features/dispatch';
import { PresentedFile } from '@/features/runs/run-attachments';
import { ShareDialog } from '@/features/runs/share-dialog';
import { StepComments } from '@/features/runs/step-comments';
import { blockedLabel, formatWhen, NudgeList, SectionHeading, PriorContributions, StepCompiledFiles, StepHistory, StepParticipants, StepResult } from '@/features/runs/step-parts';
import { useMe } from '@/lib/auth';
import { errorMessage, isApiError } from '@/lib/errors';
import { personName } from '@/lib/person';
import { invalidateRoutes, useApiMutation, useApiQuery } from '@/lib/query';
import { ApproveDialog, BlockDialog, CompleteDialog, ExtensionRequestDialog, RejectDialog } from './step-dialogs';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.runs.myTasks;
const ts = vi.admin.runs.step;
const route = getRouteApi('/shell/viec-cua-toi/$stepId');

type DialogKind = 'complete' | 'extension' | 'block' | 'approve' | 'reject' | 'reassign';
type OpenDialog = { kind: DialogKind; nudgeId?: string } | null;

const CHECKLIST_KEY = 'mihato.checklist.';

/** Dấu kiểm của danh sách kiểm chỉ để tự theo dõi: lưu trên máy này, không gửi lên máy chủ. */
function useChecklist(stepId: string, size: number): [boolean[], (index: number, checked: boolean) => void] {
  const [checked, setChecked] = useState<boolean[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(CHECKLIST_KEY + stepId) ?? '[]');
      return Array.from({ length: size }, (_, i) => Array.isArray(raw) && raw[i] === true);
    } catch {
      return Array.from({ length: size }, () => false);
    }
  });
  useEffect(() => {
    try {
      if (checked.some(Boolean)) localStorage.setItem(CHECKLIST_KEY + stepId, JSON.stringify(checked));
      else localStorage.removeItem(CHECKLIST_KEY + stepId);
    } catch {
      // trình duyệt chặn lưu trữ: dấu kiểm chỉ giữ trong phiên này
    }
  }, [checked, stepId]);
  return [checked, (index, value) => setChecked((prev) => prev.map((v, i) => (i === index ? value : v)))];
}

function Checklist({ stepId, items, readOnly }: { stepId: string; items: readonly string[]; readOnly: boolean }) {
  const [checked, toggle] = useChecklist(stepId, items.length);
  if (items.length === 0) return null;
  const doneCount = checked.filter(Boolean).length;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading aside={readOnly ? undefined : fmt(ts.checklistProgress, { xong: doneCount, tổng: items.length })}>{ts.checklist}</SectionHeading>
      {readOnly ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-sub">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <>
          <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-surface">
            {items.map((item, i) => {
              const id = `kiem-${stepId}-${i}`;
              return (
                <li key={i} className="flex items-start gap-3 px-3.5 py-2.5">
                  <Checkbox id={id} checked={checked[i] ?? false} onCheckedChange={(v) => toggle(i, v === true)} className="mt-0.5" />
                  <label htmlFor={id} className={checked[i] ? 'text-ink-sub line-through decoration-ink-sub/60' : undefined}>
                    {item}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-ink-sub">{ts.checklistNote}</p>
        </>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-ink-sub">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Lời đi thúc đang chờ trả lời, kèm ba nút trả lời nhanh (SPEC 4.7 bước 5). Mỗi nút mở đúng thao tác và truyền `nudgeId`. */
function OpenNudge({ step, onReply }: { step: StepDetail; onReply: (kind: 'complete' | 'extension' | 'block', nudgeId: string) => void }) {
  const nudge = step.openNudge;
  if (!nudge) return null;
  return (
    <section aria-labelledby="loi-nhac-dang-cho" className="overflow-hidden rounded-xl border border-gold/40 bg-surface">
      <div className="bg-gold-tint px-4 py-2.5 text-gold sm:px-5">
        <h2 id="loi-nhac-dang-cho" className="flex items-center gap-2 text-base font-semibold">
          <BellRing aria-hidden="true" className="size-4" />
          {t.nudge.title}
        </h2>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
        <div>
          <p className="text-sm text-ink-sub">{fmt(t.nudge.from, { tên: nudge.senderName, giờ: formatWhen(nudge.sentAt) })}</p>
          <p className="mt-1 text-lg whitespace-pre-line">{nudge.message}</p>
          {nudge.aiDisclosure ? <p className="mt-1 text-sm text-ink-sub">{nudge.aiDisclosure}</p> : null}
        </div>
        <div role="group" aria-label={t.nudge.replyHeading} className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {allows(step, 'complete') ? (
            <Button className="pointer-coarse:h-11" onClick={() => onReply('complete', nudge.id)}>
              <Check aria-hidden="true" />
              {vi.common.nudgeReply.done}
            </Button>
          ) : null}
          {allows(step, 'requestExtension') ? (
            <Button className="pointer-coarse:h-11" onClick={() => onReply('extension', nudge.id)}>
              <CalendarPlus aria-hidden="true" />
              {vi.common.nudgeReply.need_time}
            </Button>
          ) : null}
          {allows(step, 'block') ? (
            <Button className="pointer-coarse:h-11" onClick={() => onReply('block', nudge.id)}>
              <HandHelping aria-hidden="true" />
              {vi.common.nudgeReply.blocked}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-ink-sub">{t.nudge.replyNote}</p>
      </div>
    </section>
  );
}

/**
 * Thanh nút dính đáy màn hình: chỉ vẽ nút có trong `allowedActions` (máy chủ tính, và vẫn kiểm lại khi nhận yêu cầu).
 * Không có nút làm thay người khác: người không phải người nhận sẽ không nhận được các hành động này.
 */
function ActionBar({ step, onOpen, onAccept, accepting }: { step: StepDetail; onOpen: (kind: DialogKind) => void; onAccept: () => void; accepting: boolean }) {
  const can = (action: Parameters<typeof allows>[1]) => allows(step, action);
  // Bước đóng góp: một nút "Gửi" thay cho Đồng ý và Chưa đồng ý.
  const contribute = step.action === 'contribute';
  const primary = can('complete') || can('approve') || can('reject');
  const secondary = can('requestExtension') || can('block') || can('reassign');
  if (!primary && !secondary && !can('accept')) return null;
  const touch = 'pointer-coarse:h-12';
  return (
    <div role="group" aria-label={t.detail.actions} className="sticky bottom-0 z-20 -mx-4 mt-2 border-t border-hairline bg-canvas/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:-mx-5 sm:px-5 lg:mx-0 lg:px-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {primary || can('accept') ? (
          <div className="flex gap-2 sm:order-last sm:ml-auto">
            {can('accept') ? (
              <Button className={`flex-1 sm:flex-none ${touch}`} loading={accepting} onClick={onAccept}>
                {accepting ? null : <Hand aria-hidden="true" />}
                {vi.common.actions.accept}
              </Button>
            ) : null}
            {can('reject') && !contribute ? (
              <Button className={`flex-1 sm:flex-none ${touch}`} onClick={() => onOpen('reject')}>
                <X aria-hidden="true" />
                {vi.common.actions.reject}
              </Button>
            ) : null}
            {can('approve') ? (
              <Button variant="primary" className={`flex-1 sm:flex-none ${touch}`} onClick={() => onOpen('approve')}>
                {contribute ? <Send aria-hidden="true" /> : <ThumbsUp aria-hidden="true" />}
                {contribute ? vi.common.actions.send : vi.common.actions.approve}
              </Button>
            ) : null}
            {can('complete') ? (
              <Button variant="primary" className={`flex-1 sm:flex-none ${touch}`} onClick={() => onOpen('complete')}>
                <Send aria-hidden="true" />
                {vi.common.actions.complete}
              </Button>
            ) : null}
          </div>
        ) : null}
        {secondary ? (
          <div className="flex flex-wrap gap-2">
            {can('requestExtension') ? (
              <Button className={`flex-1 px-3 sm:flex-none ${touch}`} onClick={() => onOpen('extension')}>
                <CalendarPlus aria-hidden="true" />
                {vi.common.actions.requestExtension}
              </Button>
            ) : null}
            {can('block') ? (
              <Button className={`flex-1 px-3 sm:flex-none ${touch}`} onClick={() => onOpen('block')}>
                <HandHelping aria-hidden="true" />
                {vi.common.actions.block}
              </Button>
            ) : null}
            {can('reassign') ? (
              <Button variant="ghost" className={`flex-1 px-3 sm:flex-none ${touch}`} onClick={() => onOpen('reassign')}>
                <UserRoundPen aria-hidden="true" />
                {t.detail.reassign}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StepBody({ step }: { step: StepDetail }) {
  const me = useMe();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  const accept = useApiMutation('steps.accept', {
    invalidate: STEP_INVALIDATE,
    toastError: false,
    onSuccess: () => toast.success(t.detail.accepted),
    onError: (err) => {
      if (isApiError(err, 'state_conflict')) invalidateRoutes(STEP_INVALIDATE);
      toast.error(isApiError(err, 'state_conflict') ? t.detail.conflict : errorMessage(err));
    },
  });

  const mine = step.assignee?.id === me.id;
  const open = step.state === 'ready' || step.state === 'in_progress' || step.state === 'unassigned';
  const approval = step.kind === 'approval';
  const contribute = approval && step.action === 'contribute';

  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip step={step} />
          {approval ? (
            <Badge tone="gold">
              {contribute ? <UsersRound aria-hidden="true" /> : <Stamp aria-hidden="true" />}
              {contribute ? t.contribute.stepBadge : ts.kindApproval}
            </Badge>
          ) : null}
        </div>
        <h1 className="text-2xl font-semibold text-ink">{step.title}</h1>
        <p className="text-ink-sub">
          {t.detail.run}: <span className="font-medium text-ink">{runLabel(step)}</span>
        </p>
        <div>
          <Button size="sm" onClick={() => setShareOpen(true)} data-testid="share-run">
            <Share2 aria-hidden="true" />
            {vi.admin.runs.share.button}
          </Button>
        </div>
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 rounded-xl border border-hairline bg-surface px-4 py-3.5 sm:px-5">
        <Fact label={t.detail.due}>
          <DueLabel dueAt={step.dueAt} dueOriginalAt={step.dueOriginalAt} isOverdue={step.isOverdue} lateWorkingDays={step.lateWorkingDays} closed={!open} />
        </Fact>
        {approval ? null : (
          <Fact label={t.detail.assignedBy}>
            <PersonName person={step.assignedBy} fallback="–" />
          </Fact>
        )}
        {/* Bước đóng góp có nhiều người cùng làm: "người nhận" không có nghĩa, danh sách người nằm ở phần của từng người. */}
        {(!mine || step.onBehalfOf) && !contribute ? (
          <Fact label={t.detail.assignee}>
            <PersonName person={step.assignee} fallback={vi.common.stepState.unassigned} />
            {step.onBehalfOf ? <span className="block text-sm text-ink-sub">{fmt(t.detail.onBehalfOf, { tên: personName(step.onBehalfOf, 'full') })}</span> : null}
          </Fact>
        ) : null}
      </dl>

      {step.state === 'pending' ? <Callout tone="info">{t.detail.waitingPrevious}</Callout> : null}
      {contribute && (step.participants ?? []).some((p) => p.person.id === me.id && p.decision !== null) ? (
        <Callout tone="success">
          {t.contribute.alreadySent}
          {open ? ` ${t.contribute.waitingOthers}` : ''}
        </Callout>
      ) : null}
      {step.state === 'done' && step.completedAt ? <Callout tone="success">{fmt(t.detail.doneBanner, { giờ: formatDateTime(step.completedAt) })}</Callout> : null}
      {step.state === 'rejected' || step.state === 'skipped' || step.state === 'cancelled' ? (
        <Callout tone="info">{fmt(t.detail.closedBanner, { 'trạng thái': vi.common.stepState[step.state] })}</Callout>
      ) : null}

      {step.blockedReason ? (
        <Callout tone="warn">
          <span className="font-medium">{fmt(ts.blocked, { 'lý do': blockedLabel(step.blockedReason) })}</span>
        </Callout>
      ) : null}
      {step.pendingExtension ? (
        <Callout tone="info" title={fmt(ts.extensionPending, { ngày: formatDue(step.pendingExtension.proposedDueAt) })}>
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
            {fmt(ts.extensionReason, { 'lý do': step.pendingExtension.reason })}
          </span>
        </Callout>
      ) : null}

      <OpenNudge step={step} onReply={(kind, nudgeId) => setDialog({ kind, nudgeId })} />

      {approval && contribute && !step.description ? null : approval ? (
        <section aria-labelledby="noi-dung-can-duyet" className="overflow-hidden rounded-xl border border-hairline bg-surface">
          <h2 id="noi-dung-can-duyet" className="border-b border-hairline bg-surface-alt px-4 py-2.5 text-base font-semibold sm:px-5">
            {contribute ? t.contribute.sectionHeading : t.approval.heading}
          </h2>
          <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
            {/* Bản trình duyệt ở đầu hộp duyệt, để mở xem trước khi quyết. Bước đóng góp chưa có bản trình. */}
            {contribute ? null : <PresentedFile runId={step.runId} />}
            {step.description ? <p className="whitespace-pre-line">{step.description}</p> : null}
            {contribute ? null : (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
                <Fact label={t.approval.requester}>
                  <PersonName person={step.assignedBy} fallback="–" />
                </Fact>
                <Fact label={t.approval.amount}>
                  {step.amountVnd !== null ? <span className="tabular text-xl font-semibold">{formatMoney(step.amountVnd)}</span> : <span className="text-ink-sub">{t.approval.noAmount}</span>}
                </Fact>
              </dl>
            )}
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-2">
          <SectionHeading>{ts.description}</SectionHeading>
          {step.description ? <p className="whitespace-pre-line">{step.description}</p> : <p className="text-ink-sub">{ts.noDescription}</p>}
        </section>
      )}

      {/* Việc tổng hợp: đọc được phần các đơn vị đã góp ở bước trước ngay trên trang này. */}
      {step.compile && open ? <PriorContributions runId={step.runId} currentStepId={step.id} /> : null}

      <Checklist stepId={step.id} items={step.checklist} readOnly={!mine || !open} />
      <StepResult step={step} />
      <StepParticipants step={step} />
      <StepCompiledFiles files={step.files} />
      <NudgeList nudges={step.nudges.filter((n) => n.id !== step.openNudge?.id)} />
      <StepHistory items={step.history} contribute={contribute} />
      <StepComments stepId={step.id} />

      {open && step.allowedActions.length === 0 ? <p className="text-sm text-ink-sub">{t.detail.noActions}</p> : null}

      <ActionBar step={step} accepting={accept.isPending} onAccept={() => accept.mutate({ params: { id: step.id } })} onOpen={(kind) => setDialog({ kind })} />

      {/* Hộp thoại không phụ thuộc `allowedActions`: sau lỗi 409 dữ liệu phía sau đổi, hộp thoại vẫn mở và giữ nội dung đã nhập. */}
      <CompleteDialog open={dialog?.kind === 'complete'} onOpenChange={close} step={step} nudgeId={dialog?.nudgeId} />
      <ExtensionRequestDialog open={dialog?.kind === 'extension'} onOpenChange={close} step={step} nudgeId={dialog?.nudgeId} />
      <BlockDialog open={dialog?.kind === 'block'} onOpenChange={close} step={step} nudgeId={dialog?.nudgeId} />
      <ApproveDialog open={dialog?.kind === 'approve'} onOpenChange={close} step={step} />
      <RejectDialog open={dialog?.kind === 'reject'} onOpenChange={close} step={step} />
      <ReassignDialog open={dialog?.kind === 'reassign'} onOpenChange={close} steps={[step]} />
      <ShareDialog runId={step.runId} runTitle={runLabel(step)} open={shareOpen} onOpenChange={setShareOpen} />
    </>
  );
}

/**
 * Trang một việc của tôi (SPEC 8.2 S2 đến S6): mô tả, danh sách kiểm, kết quả, lời đi thúc, lịch sử,
 * và các nút Đã nhận, Báo hoàn thành, Xin thêm thời gian, Báo vướng; việc duyệt có Đồng ý và Chưa đồng ý.
 */
export function MyStepPage() {
  const { stepId } = route.useParams();
  const detail = useApiQuery('steps.get', { params: { id: stepId } });

  const back = (
    <Link to="/viec-cua-toi" className="inline-flex min-h-9 items-center gap-1 self-start rounded-sm text-ink-sub hover:text-primary">
      <ChevronLeft aria-hidden="true" className="size-4" />
      {t.detail.back}
    </Link>
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {back}
      {detail.isError ? (
        <div className="rounded-xl border border-hairline bg-surface">
          <EmptyState
            title={isApiError(detail.error, 'not_found') ? ts.notFoundTitle : ts.loadFailed}
            description={isApiError(detail.error, 'not_found') ? ts.notFoundBody : errorMessage(detail.error)}
            action={
              <Button asChild variant="primary">
                <Link to="/viec-cua-toi">{t.detail.back}</Link>
              </Button>
            }
          />
        </div>
      ) : detail.data ? (
        <StepBody key={detail.data.id} step={detail.data} />
      ) : (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{ts.loading}</span>
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="mt-2 h-24 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      )}
    </div>
  );
}
