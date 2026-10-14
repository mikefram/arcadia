import type { ReactNode } from 'react';
import { BellRing, Bot, CircleDot, MessageSquareReply, TimerReset } from 'lucide-react';
import type { FileView, NudgeView, PersonRef, StepDetail, StepHistoryItem, StepParticipant, StepView } from '@mihato/domain';
import { fmt, formatDate, formatDateTime, formatTime, vi } from '@mihato/i18n';
import { FileList, FileRow } from '@/components/file-list';
import { PersonName } from '@/components/person-name';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { vnDayDiff } from '@/lib/datetime';
import { orderCompiled } from '@/lib/files';
import { personName } from '@/lib/person';
import { useApiQuery } from '@/lib/query';
import { describeEvent } from '@/lib/timeline';
import { buildPersonIndex, FieldValueList, personIdsIn } from './form-fields';
import { usePeople } from './use-people';

const t = vi.admin.runs.step;

/** "09:12" nếu là hôm nay, "Hôm qua 09:12", còn lại "02/10/2026 09:12". */
export function formatWhen(at: string): string {
  const diff = vnDayDiff(at);
  if (diff === 0) return formatTime(at);
  if (diff === -1) return `${vi.admin.shell.due.yesterday} ${formatTime(at)}`;
  return `${formatDate(at)} ${formatTime(at)}`;
}

/** Lý do vướng: mã mẫu (missing_info…) đổi sang chữ; chữ tự do giữ nguyên. */
export function blockedLabel(reason: string): string {
  return reason in vi.common.blockReason ? vi.common.blockReason[reason as keyof typeof vi.common.blockReason] : reason;
}

/** Tiêu đề một khối trong chi tiết việc. */
export function SectionHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-base font-semibold text-ink">{children}</h3>
      {aside ? <span className="text-sm text-ink-sub">{aside}</span> : null}
    </div>
  );
}

/** Những người đã xuất hiện trong chi tiết một việc: để tra tên khi ô `user`, `users` chỉ lưu id. */
export function stepPeopleSources(step: Pick<StepView, 'assignee' | 'assignedBy' | 'onBehalfOf' | 'requestedBy' | 'participants' | 'files'>): (PersonRef | null | undefined)[] {
  return [
    step.assignee,
    step.assignedBy,
    step.onBehalfOf,
    step.requestedBy,
    ...(step.participants ?? []).flatMap((p) => [p.person, p.onBehalfOf]),
    ...(step.files ?? []).map((f) => f.uploadedBy),
  ];
}

type StepResultStep = Pick<StepView, 'kind' | 'form' | 'result' | 'reason' | 'state'> & Partial<Pick<StepView, 'action' | 'files' | 'assignee' | 'assignedBy' | 'onBehalfOf' | 'requestedBy' | 'participants'>>;

/**
 * Kết quả đã nhập khi báo hoàn thành, hoặc quyết định ở việc duyệt. Ô tệp hiện tên tệp kèm nút tải xuống;
 * ô chọn người hiện tên. Bước đóng góp không có "quyết định" chung: phần của từng người nằm ở StepParticipants.
 */
export function StepResult({ step }: { step: StepResultStep }) {
  const result = step.result;
  const known = buildPersonIndex(stepPeopleSources({ assignee: null, assignedBy: null, onBehalfOf: null, requestedBy: null, ...step }));
  const people = usePeople(personIdsIn(step.form, result ?? {}), known);
  if (step.kind === 'approval') {
    if (step.action === 'contribute') return null;
    const decided = step.state === 'done' || step.state === 'rejected';
    if (!decided && !step.reason) return null;
    return (
      <section className="flex flex-col gap-2">
        <SectionHeading>{t.decision}</SectionHeading>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {decided ? (
            <>
              <dt className="text-ink-sub">{t.decision}</dt>
              <dd className="font-medium">{step.state === 'done' ? vi.common.actions.approve : vi.common.actions.reject}</dd>
            </>
          ) : null}
          {step.reason ? (
            <>
              <dt className="text-ink-sub">{t.reason}</dt>
              <dd className="whitespace-pre-line">{step.reason}</dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  }
  const hasResult = result !== null && Object.keys(result).length > 0;
  if (!hasResult && step.form.length === 0 && !step.reason) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{t.result}</SectionHeading>
      {hasResult ? <FieldValueList fields={step.form} values={result} files={step.files} people={people} /> : <p className="text-ink-sub">{t.noResult}</p>}
      {step.reason ? (
        <p className="whitespace-pre-line">
          <span className="text-ink-sub">{t.reason}: </span>
          {step.reason}
        </p>
      ) : null}
    </section>
  );
}

/** Tệp tổng hợp (Word) đã xuất ở việc này, mới nhất trước. */
export function StepCompiledFiles({ files }: { files: readonly FileView[] | undefined }) {
  const compiled = orderCompiled(files ?? []);
  if (compiled.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{t.compile.title}</SectionHeading>
      <ul aria-label={t.compile.title} className="flex flex-col gap-2">
        {compiled.map((file, i) => (
          <FileRow key={file.id} file={file} {...(i === 0 ? { badge: <Badge tone="gold">{t.compile.latest}</Badge> } : {})} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Phần các bước góp nội dung trước đó đã gửi, cho người làm việc tổng hợp đọc ngay trên trang việc của mình
 * (lấy từ chi tiết lượt chạy). Chỉ hiện bước đóng góp đã có người gửi.
 */
export function PriorContributions({ runId, currentStepId }: { runId: string; currentStepId: string }) {
  const run = useApiQuery('runs.get', { params: { id: runId } });
  const sources = (run.data?.steps ?? []).filter((s) => s.id !== currentStepId && s.kind === 'approval' && s.action === 'contribute' && (s.participants ?? []).some((p) => p.decision !== null));
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="prior-contributions">
      {sources.map((source) => (
        <StepParticipants key={source.id} step={source} heading={fmt(t.priorContributions, { việc: source.title })} />
      ))}
    </div>
  );
}

/** Id tệp nằm ở các ô `file` của phần một người gửi, để không liệt kê hai lần. */
function fileIdsInResult(form: StepView['form'], result: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>();
  if (!result) return ids;
  for (const f of form) {
    const v = result[f.key];
    if (f.type === 'file' && Array.isArray(v)) for (const id of v) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function ParticipantRow({ participant, step, contribute, people }: { participant: StepParticipant; step: Pick<StepView, 'form' | 'files'>; contribute: boolean; people: ReadonlyMap<string, PersonRef> }) {
  const tp = t.participants;
  const decided = participant.decision !== null;
  const hasResult = participant.result !== null && Object.keys(participant.result).length > 0;
  const inResult = fileIdsInResult(step.form, participant.result);
  const extraFiles = (step.files ?? []).filter((f) => participant.fileIds.includes(f.id) && !inResult.has(f.id));
  const badge = !decided ? (
    <Badge tone="muted">{contribute ? tp.waiting : tp.pending}</Badge>
  ) : contribute ? (
    <Badge tone="primary">{tp.sent}</Badge>
  ) : participant.decision === 'approved' ? (
    <Badge tone="primary">{tp.approved}</Badge>
  ) : (
    <Badge tone="warn">{tp.rejected}</Badge>
  );
  return (
    <li data-testid="participant" className="rounded-lg border border-hairline bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0">
          <PersonName person={participant.person} className="font-medium" />
          {participant.onBehalfOf ? <span className="text-sm text-ink-sub">, {fmt(tp.onBehalfOf, { tên: personName(participant.onBehalfOf, 'full') })}</span> : null}
        </p>
        <div className="flex items-center gap-2">
          {participant.decidedAt ? (
            <time dateTime={participant.decidedAt} className="tabular text-sm text-ink-sub">
              {fmt(contribute ? tp.sentAt : tp.decidedAt, { giờ: formatWhen(participant.decidedAt) })}
            </time>
          ) : null}
          {badge}
        </div>
      </div>
      {participant.comment ? (
        <p className="mt-2 whitespace-pre-line">
          <span className="text-sm text-ink-sub">{tp.comment}: </span>
          {participant.comment}
        </p>
      ) : null}
      {hasResult && participant.result ? <FieldValueList className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5" fields={step.form} values={participant.result} files={step.files} people={people} /> : null}
      {extraFiles.length > 0 ? <FileList className="mt-2" files={extraFiles} showUploader={false} aria-label={fmt(t.participants.filesOf, { tên: personName(participant.person, 'short') })} /> : null}
      {participant.contentHidden ? <p className="mt-1.5 text-sm text-ink-sub">{tp.contentHidden}</p> : null}
      {decided && contribute && !participant.contentHidden && !hasResult && !participant.comment && extraFiles.length === 0 ? <p className="mt-1.5 text-sm text-ink-sub">{tp.nothingSent}</p> : null}
    </li>
  );
}

/**
 * Người tham gia bước duyệt hoặc đóng góp: ai đã gửi hoặc quyết định, ai chưa, và phần của từng người
 * (ý kiến, nội dung đã điền, tệp riêng của họ). Mọi người xem được bước đều thấy.
 */
export function StepParticipants({ step, heading }: { step: Pick<StepView, 'kind' | 'action' | 'form' | 'files' | 'participants' | 'assignee' | 'assignedBy' | 'onBehalfOf' | 'requestedBy'>; heading?: string }) {
  const participants = step.participants ?? [];
  const known = buildPersonIndex(stepPeopleSources(step));
  const ids = participants.flatMap((p) => (p.result ? personIdsIn(step.form, p.result) : []));
  const people = usePeople(ids, known);
  if (step.kind !== 'approval' || participants.length === 0) return null;
  const contribute = step.action === 'contribute';
  const done = participants.filter((p) => p.decision !== null).length;
  return (
    <section className="flex flex-col gap-2" data-testid="step-participants">
      <SectionHeading aside={fmt(contribute ? t.participants.summaryContribute : t.participants.summaryApprove, { xong: done, tổng: participants.length })}>
        {heading ?? (contribute ? t.participants.titleContribute : t.participants.title)}
      </SectionHeading>
      <ul className="flex flex-col gap-2">
        {participants.map((p) => (
          <ParticipantRow key={p.person.id} participant={p} step={step} contribute={contribute} people={people} />
        ))}
      </ul>
    </section>
  );
}

/** Các lời đi thúc đã gửi cho việc, kèm câu trả lời nhanh của người nhận. */
export function NudgeList({ nudges }: { nudges: readonly NudgeView[] }) {
  if (nudges.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{t.nudges}</SectionHeading>
      <ul className="flex flex-col gap-2">
        {nudges.map((n) => (
          <li key={n.id} className="rounded-lg border border-hairline bg-canvas px-3.5 py-3">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-ink-sub">
              <span className="font-medium text-ink">{fmt(t.nudgeFrom, { tên: n.senderName })}</span>
              <time dateTime={n.sentAt} className="tabular">
                {formatWhen(n.sentAt)}
              </time>
            </p>
            <p className="mt-1 whitespace-pre-line">{n.message}</p>
            {n.aiDisclosure ? <p className="mt-1 text-sm text-ink-sub">{n.aiDisclosure}</p> : null}
            <p className="mt-2">
              {n.reply ? (
                <Badge tone="primary">
                  <MessageSquareReply aria-hidden="true" />
                  {fmt(t.nudgeReplied, { 'trả lời': vi.common.nudgeReply[n.reply] })}
                  {n.repliedAt ? `, ${formatWhen(n.repliedAt)}` : null}
                </Badge>
              ) : (
                <Badge tone="muted">{t.nudgeNoReply}</Badge>
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

type HistoryLine = { icon: ReactNode; head: ReactNode; body: string | null };

/**
 * Câu hành động của khung kết thúc bằng danh từ chờ tên việc ("báo hoàn thành việc", "đồng ý ở bước").
 * Trong lịch sử của chính việc đó không cần nhắc lại tên việc, nên bỏ danh từ cuối câu.
 */
function withoutObject(action: string): string {
  return action.replace(/ (việc|ở việc|ở bước|cho việc|bước)$/u, '');
}

function historyLine(item: StepHistoryItem, contribute: boolean): HistoryLine {
  // Ở bước đóng góp, "đồng ý" của máy chủ thật ra là người đó gửi phần của mình.
  if (contribute && item.type === 'event' && item.code === 'ApproveStep') {
    const who = item.actor ? personName(item.actor, 'short', true) : vi.admin.runs.timeline.unknownPerson;
    return { icon: <CircleDot aria-hidden="true" />, head: <span><span className="font-semibold">{who}</span> {t.participants.sentEvent}</span>, body: item.text };
  }
  if (item.type === 'reminder') {
    return { icon: <TimerReset aria-hidden="true" />, head: t.historyKind.reminder, body: item.text };
  }
  if (item.type === 'nudge') {
    const byAssistant = item.actorType === 'ai';
    return { icon: byAssistant ? <Bot aria-hidden="true" /> : <BellRing aria-hidden="true" />, head: byAssistant ? t.historyKind.nudgeByAssistant : t.historyKind.nudge, body: item.text };
  }
  if (item.type === 'nudge_reply') {
    const reply = item.code in vi.common.nudgeReply ? vi.common.nudgeReply[item.code as keyof typeof vi.common.nudgeReply] : item.code;
    const head = item.actor ? fmt(t.historyKind.nudgeReply, { tên: personName(item.actor, 'short', true), 'trả lời': reply }) : fmt(t.historyKind.nudgeReplyPlain, { 'trả lời': reply });
    return { icon: <MessageSquareReply aria-hidden="true" />, head, body: item.text };
  }
  // Sự kiện của việc: thay đổi dẫn xuất (tới lượt, đổi trạng thái do lan truyền) hoặc sự kiện gốc của engine.
  if (item.code === 'step.activated') {
    const due = typeof item.data.dueAt === 'string' ? item.data.dueAt : null;
    return { icon: <CircleDot aria-hidden="true" />, head: due ? fmt(t.historyKind.activatedDue, { ngày: formatDateTime(due) }) : t.historyKind.activated, body: null };
  }
  if (item.code === 'step.state') {
    const label = (v: unknown) => (typeof v === 'string' && v in vi.common.stepState ? vi.common.stepState[v as keyof typeof vi.common.stepState] : String(v));
    return { icon: <CircleDot aria-hidden="true" />, head: fmt(t.historyKind.state, { từ: label(item.data.from), đến: label(item.data.to) }), body: null };
  }
  const text = describeEvent({ type: item.code, actorType: item.actorType, actor: item.actor, stepTitle: null, payload: item.data });
  return {
    icon: <CircleDot aria-hidden="true" />,
    head: (
      <>
        <span className="font-semibold">{text.actor}</span> {withoutObject(text.action)}
        {text.tail ? ` ${text.tail}` : null}
      </>
    ),
    body: item.text,
  };
}

/** Lịch sử của một việc: sự kiện, lời nhắc tự động, lời đi thúc và câu trả lời nhanh, theo thứ tự thời gian. */
export function StepHistory({ items, contribute = false }: { items: StepDetail['history']; contribute?: boolean }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{t.history}</SectionHeading>
      {items.length === 0 ? (
        <p className="text-ink-sub">{t.historyEmpty}</p>
      ) : (
        <ol className="flex flex-col">
          {items.map((item, i) => {
            const line = historyLine(item, contribute);
            const last = i === items.length - 1;
            return (
              <li key={`${item.at}-${item.type}-${item.code}-${i}`} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5 pb-3.5 last:pb-0">
                {/* Đường nối dọc giữa các mốc */}
                {last ? null : <span aria-hidden="true" className="absolute top-5 bottom-0 left-[0.5625rem] w-px bg-hairline" />}
                <span className={cn('mt-0.5 inline-flex size-5 items-center justify-center text-ink-sub [&_svg]:size-4', item.type === 'event' && 'text-primary')}>{line.icon}</span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0">{line.head}</span>
                    <time dateTime={item.at} title={formatDateTime(item.at)} className="tabular shrink-0 text-sm text-ink-sub">
                      {formatWhen(item.at)}
                    </time>
                  </p>
                  {line.body ? <p className="mt-0.5 text-sm whitespace-pre-line text-ink-sub">{line.body}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
