import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { getRouteApi, Link } from '@tanstack/react-router';
import { BellRing, ChevronLeft, NotebookPen, OctagonX, Share2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { TEMPLATE_VIEW_ACTIONS, type RunDetail, type StepView } from '@mihato/domain';
import { fmt, formatDate, formatDateTime, formatProgress, vi, vnParts, WEEKDAYS } from '@mihato/i18n';
import { ConfidentialBadge } from '@/components/confidential-badge';
import { PersonName } from '@/components/person-name';
import { RunProgress } from '@/components/run-progress';
import { RunStatusChip } from '@/components/status-chip';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { allows, CancelRunDialog, NudgeDialog, StepDispatchProvider } from '@/features/dispatch';
import { useCan, useMe } from '@/lib/auth';
import { errorMessage, isApiError } from '@/lib/errors';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { asFormFields } from './form-fields';
import { RunAttachments, RunStartInfo } from './run-attachments';
import { RunSteps } from './run-steps';
import { ShareDialog } from './share-dialog';
import { RunTimeline } from './run-timeline';
import { ScheduleLine } from './runs-page';
import { StepDetailSheet } from './step-detail-sheet';

const t = vi.admin.runs.detail;
const route = getRouteApi('/shell/luot-chay/$runId');

// React Flow chỉ cần ở trang này: tách thành tệp tải riêng.
const RunDiagram = lazy(() => import('./run-diagram'));

const noteSchema = z.object({ text: z.string().trim().min(1, t.note.required).max(2000, t.note.tooLong) });
type NoteValues = z.infer<typeof noteSchema>;

function NoteForm({ runId, onOpenChange }: { runId: string; onOpenChange: (open: boolean) => void }) {
  const form = useForm<NoteValues>({ resolver: zodResolver(noteSchema), defaultValues: { text: '' } });
  const save = useApiMutation('runs.note', { invalidate: ['runs.events', 'activity.list', 'runs.get'], toastError: false });
  const submit = form.handleSubmit((values) => {
    save.mutate(
      { params: { id: runId }, body: { text: values.text } },
      {
        onSuccess: () => {
          toast.success(t.note.done);
          onOpenChange(false);
        },
      },
    );
  });
  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.note.title}</DialogTitle>
        <DialogDescription>{t.note.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {save.isError ? <Callout tone="error">{errorMessage(save.error)}</Callout> : null}
        <Field label={t.note.label} required error={form.formState.errors.text?.message}>
          <Textarea rows={4} {...form.register('text')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {t.note.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Ghi chú vào lượt chạy (`runs.note`): hiện ở dòng thời gian, không đổi trạng thái việc nào. */
function NoteDialog({ runId, open, onOpenChange }: { runId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <NoteForm runId={runId} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function SummaryCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface px-5 py-3.5">
      <dt className="text-sm font-medium text-ink-sub">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Dải tóm tắt đầu trang: tiến độ, mốc đích, người khởi chạy, phiên bản quy trình. Thông tin khởi chạy và hồ sơ đính kèm nằm ở hai khối riêng bên dưới. */
function RunSummaryBand({ run }: { run: RunDetail }) {
  const late = run.state === 'running' && run.schedule.status === 'late';
  return (
    <section aria-label={t.summary} className="overflow-hidden rounded-xl border border-hairline bg-hairline">
      <dl className="grid gap-px sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        <SummaryCell label={t.progress}>
          {run.state === 'cancelled' ? (
            // Lượt đã huỷ: chỉ ghi bằng chữ, không vẽ thanh đầy (việc bị huỷ không còn nằm trong tổng).
            <span className="tabular font-medium">{formatProgress(run.progress.done, run.progress.total)}</span>
          ) : (
            <>
              <RunProgress done={run.progress.done} total={run.progress.total} late={late} className="[&>span]:text-base [&>span]:font-medium [&>span]:text-ink" />
              <ScheduleLine run={run} className="mt-0.5 block" />
            </>
          )}
        </SummaryCell>
        <SummaryCell label={t.target}>
          {run.targetAt ? (
            // Mốc đích là một ngày (đầu ngày theo giờ Việt Nam), không kèm giờ.
            <time dateTime={run.targetAt} className="tabular flex flex-col">
              <span className="font-medium">{formatDate(run.targetAt)}</span>
              <span className="text-sm text-ink-sub">{WEEKDAYS[vnParts(run.targetAt).weekday]}</span>
            </time>
          ) : (
            <span className="text-ink-sub">{t.noTarget}</span>
          )}
        </SummaryCell>
        <SummaryCell label={t.initiator}>
          <PersonName person={run.initiator} className="block truncate font-medium" />
          <span className="tabular block text-sm text-ink-sub">
            {run.completedAt
              ? fmt(t.completedAt, { ngày: formatDateTime(run.completedAt) })
              : run.startedAt
                ? fmt(t.startedAt, { ngày: formatDateTime(run.startedAt) })
                : vi.common.runState[run.state]}
          </span>
        </SummaryCell>
        <SummaryCell label={t.template}>
          {run.adhoc ? (
            <span className="block font-medium">{t.adhoc}</span>
          ) : (
            <>
              <span className="block truncate font-medium" title={run.templateName}>
                {run.templateName}
              </span>
              <span className="block text-sm text-ink-sub">{fmt(t.version, { n: run.templateVersion })}</span>
            </>
          )}
        </SummaryCell>
      </dl>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-5">
      <span className="sr-only">{t.loading}</span>
      <Skeleton className="h-8 w-80 max-w-full" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

/**
 * Chi tiết lượt chạy (SPEC 9.2, 9.4): đầu trang với các nút điều phối, sơ đồ tô theo trạng thái,
 * danh sách việc và dòng thời gian. Mọi khối tự làm mới khi có sự kiện SSE.
 */
export function RunDetailPage() {
  const { runId } = route.useParams();
  const can = useCan();
  const me = useMe();
  const run = useApiQuery('runs.get', { params: { id: runId } });
  const data = run.data;

  const [openStepId, setOpenStepId] = useState<string | null>(null);
  // Danh sách việc chậm được chụp lại lúc mở, để hộp thoại đứng yên khi trang phía sau tự làm mới.
  const [nudgeSteps, setNudgeSteps] = useState<readonly StepView[] | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const openStep = useCallback((stepId: string) => setOpenStepId(stepId), []);

  const canReadTemplate = can(TEMPLATE_VIEW_ACTIONS);
  const version = useApiQuery(
    'templates.version',
    { params: { id: data?.templateId ?? '', n: data?.templateVersion ?? 1 } },
    // Một phiên bản đã xuất bản không đổi nữa.
    // Việc giao riêng không có quy trình để vẽ: mẫu một việc của nó là mẫu ẩn.
    { enabled: data !== undefined && !data.adhoc && canReadTemplate, staleTime: Infinity },
  );
  // Biểu mẫu khởi chạy đi kèm lượt chạy (đúng phiên bản đã chạy); chưa có thì lấy từ phiên bản mẫu.
  const inputFields = useMemo(() => asFormFields(data?.inputForm ?? version.data?.definition.inputs ?? []), [data?.inputForm, version.data]);

  const back = (
    <Link to="/luot-chay" className="inline-flex items-center gap-1 rounded-sm text-ink-sub hover:text-primary">
      <ChevronLeft aria-hidden="true" className="size-4" />
      {t.back}
    </Link>
  );

  if (run.isError) {
    const missing = isApiError(run.error, 'not_found');
    return (
      <>
        <PageHeader title={missing ? t.notFoundTitle : vi.admin.shell.ui.loadFailedTitle} back={back} />
        <div className="rounded-xl border border-hairline bg-surface">
          <EmptyState
            title={missing ? t.notFoundTitle : vi.admin.shell.ui.loadFailedTitle}
            description={missing ? t.notFoundBody : errorMessage(run.error)}
            action={
              missing ? (
                <Button asChild variant="primary">
                  <Link to="/luot-chay">{t.toList}</Link>
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void run.refetch()}>
                  {vi.admin.shell.ui.retry}
                </Button>
              )
            }
          />
        </div>
      </>
    );
  }

  if (!data) return <DetailSkeleton />;

  const lateSteps = data.steps.filter((s) => s.isOverdue && allows(s, 'nudge'));
  const active = data.state === 'running' || data.state === 'draft';
  const hasInfo = Object.keys(data.inputs).length > 0;
  // Việc giao riêng mà không có tệp thì không cần khối hồ sơ trống.
  const showFiles = (data.files ?? []).length > 0 || !data.adhoc;
  // Gợi ý hiện nút "Thêm tài liệu" (máy chủ vẫn kiểm lại): lượt đang chạy và mình là người khởi chạy, người giữ việc, hoặc có run.note.
  const canAddFiles =
    data.state === 'running' && (can('run.note') || data.initiator.id === me.id || data.steps.some((s) => s.assignee?.id === me.id || (s.participants ?? []).some((p) => p.person.id === me.id)));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {data.title}
            <RunStatusChip run={data} className="text-sm" />
            <ConfidentialBadge confidentiality={data.confidentiality} className="text-sm" />
          </span>
        }
        actions={
          <>
            {lateSteps.length > 0 ? (
              <Button onClick={() => setNudgeSteps(lateSteps)}>
                <BellRing aria-hidden="true" />
                {lateSteps.length > 1 ? fmt(t.nudgeLateCount, { n: lateSteps.length }) : t.nudgeLate}
              </Button>
            ) : null}
            <Button onClick={() => setShareOpen(true)} data-testid="share-run">
              <Share2 aria-hidden="true" />
              {vi.admin.runs.share.button}
            </Button>
            {can('run.note') ? (
              <Button onClick={() => setNoteOpen(true)}>
                <NotebookPen aria-hidden="true" />
                {t.addNote}
              </Button>
            ) : null}
            {active && can('run.cancel') ? (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                <OctagonX aria-hidden="true" />
                {t.cancelRun}
              </Button>
            ) : null}
          </>
        }
      />

      <RunSummaryBand run={data} />

      {hasInfo || showFiles ? (
        <div className={hasInfo && showFiles ? 'grid items-start gap-5 xl:grid-cols-2' : 'flex flex-col gap-5'}>
          {hasInfo ? <RunStartInfo run={data} fields={inputFields} /> : null}
          {showFiles ? <RunAttachments files={data.files ?? []} inputForm={inputFields} runId={data.id} canAdd={canAddFiles} /> : null}
        </div>
      ) : null}

      <StepDispatchProvider>
        {data.adhoc ? null : (
        <Card aria-labelledby="luot-chay-so-do" className="overflow-hidden">
          <CardHeader className="items-baseline border-b border-hairline">
            <CardTitle id="luot-chay-so-do">{t.diagram.title}</CardTitle>
            <CardDescription>{t.diagram.hint}</CardDescription>
          </CardHeader>
          {!canReadTemplate || version.isError ? (
            <p className="px-5 py-6 text-ink-sub">{t.diagram.unavailable}</p>
          ) : version.data ? (
            <div className="h-[300px] sm:h-[360px]" data-testid="run-diagram">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner label={t.diagram.loading} showLabel />
                  </div>
                }
              >
                <RunDiagram definition={version.data.definition} nodeStates={data.nodeStates} steps={data.steps} onOpenStep={openStep} />
              </Suspense>
            </div>
          ) : (
            <div className="flex h-[300px] items-center justify-center sm:h-[360px]">
              <Spinner label={t.diagram.loading} showLabel />
            </div>
          )}
        </Card>
        )}

        <div className="grid items-start gap-5 min-[1500px]:grid-cols-[minmax(0,1fr)_25rem]">
          <RunSteps steps={data.steps} onOpenStep={openStep} />
          <RunTimeline runId={runId} />
        </div>

        <StepDetailSheet
          stepId={openStepId}
          onOpenChange={(open) => {
            if (!open) setOpenStepId(null);
          }}
        />
      </StepDispatchProvider>

      <NudgeDialog
        open={nudgeSteps !== null}
        steps={nudgeSteps ?? []}
        onOpenChange={(open) => {
          if (!open) setNudgeSteps(null);
        }}
      />
      <NoteDialog runId={runId} open={noteOpen} onOpenChange={setNoteOpen} />
      <CancelRunDialog open={cancelOpen} onOpenChange={setCancelOpen} run={data} />
      <ShareDialog runId={runId} runTitle={data.title} open={shareOpen} onOpenChange={setShareOpen} />
    </div>
  );
}
