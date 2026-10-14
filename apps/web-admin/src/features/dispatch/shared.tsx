import { Check, CircleAlert } from 'lucide-react';
import type { RouteKey } from '@mihato/api-client';
import type { StepAction, StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { DueLabel } from '@/components/due-label';
import { PersonName } from '@/components/person-name';
import { Callout } from '@/components/ui/callout';
import { codeMessage, errorMessage, isApiError } from '@/lib/errors';
import { runLabel } from '@/lib/run-label';

const t = vi.admin.shell.dispatch;

/** Thao tác hàng loạt tối đa 50 mục mỗi lần (SPEC 9.4). */
export const MAX_BATCH = 50;

/** Các truy vấn cần làm mới sau một thao tác điều phối trên việc. */
export const STEP_INVALIDATE = [
  'steps.list',
  'steps.get',
  'runs.list',
  'runs.get',
  'runs.events',
  'runs.files',
  'overview.get',
  'activity.list',
  'extensionRequests.list',
] as const satisfies readonly RouteKey[];

/** Việc có cho người đang đăng nhập làm hành động này không: máy chủ tính sẵn trong `allowedActions`. */
export function allows(step: Pick<StepView, 'allowedActions'>, action: StepAction): boolean {
  return step.allowedActions.includes(action);
}

/** Các việc làm được hành động, cắt ở 50. */
export function eligible(steps: readonly StepView[], action: StepAction): StepView[] {
  return steps.filter((s) => allows(s, action)).slice(0, MAX_BATCH);
}

export type DispatchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** các việc đang chọn; hộp thoại tự lọc những việc làm được hành động */
  steps: readonly StepView[];
  /** gọi sau khi thao tác thành công, ví dụ để bỏ chọn các dòng */
  onDone?: () => void;
};

/** Tóm tắt các việc sắp được thao tác, đặt đầu hộp thoại. */
export function StepSummary({ steps, total }: { steps: readonly StepView[]; total?: number }) {
  const first = steps[0];
  if (!first) return null;
  const skipped = total !== undefined && total > steps.length;
  return (
    <div className="flex flex-col gap-3">
      {steps.length === 1 ? (
        <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-3">
          <p className="font-semibold">{first.title}</p>
          <p className="text-sm text-ink-sub">{runLabel(first)}</p>
          <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-sub">{t.reassign.current}</dt>
            <dd>
              <PersonName person={first.assignee} />
            </dd>
            <dt className="text-ink-sub">{t.extend.current}</dt>
            <dd>
              <DueLabel dueAt={first.dueAt} dueOriginalAt={first.dueOriginalAt} isOverdue={first.isOverdue} lateWorkingDays={first.lateWorkingDays} />
            </dd>
          </dl>
        </div>
      ) : (
        <div className="rounded-lg border border-hairline bg-canvas px-3.5 py-3">
          <p className="text-sm font-medium text-ink-sub">
            {t.stepsHeading} ({steps.length})
          </p>
          <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {steps.map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{s.title}</span>
                <PersonName person={s.assignee} form="short" className="shrink-0 text-sm text-ink-sub" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {skipped ? <Callout tone="info">{fmt(t.partial, { n: steps.length, tổng: total })}</Callout> : null}
    </div>
  );
}

/** Lỗi của một thao tác trên việc. 409 state_conflict được nói rõ bằng chữ, nội dung đã nhập vẫn giữ. */
export function DispatchError({ error }: { error: unknown }) {
  if (!error) return null;
  // Giao lại việc trong quy trình cho người không được bổ nhiệm: máy chủ trả input_invalid kèm mã con not_appointed.
  const notAppointed = isApiError(error, 'input_invalid') && error.extra.errors?.some((e) => e.code === 'not_appointed');
  return <Callout tone="error">{isApiError(error, 'state_conflict') ? t.conflict : notAppointed ? codeMessage('not_appointed') : errorMessage(error)}</Callout>;
}

export type ItemResult = { stepId: string; ok: boolean; error?: { code: string } | undefined };

/** Kết quả từng việc của một thao tác hàng loạt. */
export function BatchResults({ steps, results, okLabel = t.results.ok }: { steps: readonly StepView[]; results: readonly ItemResult[]; okLabel?: string }) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const okCount = results.filter((r) => r.ok).length;
  return (
    <section aria-label={t.results.title} className="flex flex-col gap-3">
      <Callout tone={okCount === results.length ? 'success' : 'warn'}>{fmt(t.results.summary, { n: okCount, tổng: results.length })}</Callout>
      <ul className="divide-y divide-hairline rounded-lg border border-hairline">
        {results.map((r) => (
          <li key={r.stepId} className="flex items-start gap-2.5 px-3.5 py-2.5">
            {r.ok ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /> : <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
            <div className="min-w-0">
              <p className="font-medium">{byId.get(r.stepId)?.title ?? r.stepId}</p>
              <p className="text-sm text-ink-sub">{r.ok ? okLabel : `${t.results.failed}. ${codeMessage(r.error?.code ?? '')}`}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
