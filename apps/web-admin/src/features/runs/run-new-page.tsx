import { useId, useMemo, useState, type FormEvent } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, Play, Stamp, TriangleAlert, UserRoundX, Workflow } from 'lucide-react';
import type { SimulationRowView, TemplateSummary } from '@mihato/domain';
import { fmt, formatDateWeekday, formatTime, vi } from '@mihato/i18n';
import { PersonName } from '@/components/person-name';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, Td, Th } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { sortByVi } from '@/lib/collator';
import { codeMessage, errorMessage, problemFields } from '@/lib/errors';
import { useCan } from '@/lib/auth';
import { useDebouncedValue } from '@/lib/hooks';
import { personName } from '@/lib/person';
import { useApiMutation, useApiQuery } from '@/lib/query';
import { SubmitToExecutive } from '@/features/dispatch';
import { effectiveRunTitle } from './derive-title';
import {
  asFormFields,
  DynamicField,
  fieldCodeText,
  fieldErrorsFromProblem,
  hasInput,
  hasUploading,
  needsFileUpload,
  proposalInputs,
  toPayload,
  validateFields,
  type FieldErrors,
  type FieldValue,
  type FieldValues,
} from './form-fields';

const t = vi.admin.runs.create;
const route = getRouteApi('/shell/luot-chay/moi');
const MAX_TITLE = 200;

type SimArgs = { templateId: string; inputs: Record<string, unknown> };

/** Quy trình đã xuất bản, còn dùng, và người đang đăng nhập nằm trong những người được khởi chạy (`canStart`). */
function isLaunchable(tpl: TemplateSummary): boolean {
  return tpl.archivedAt === null && tpl.latestPublishedVersion !== null && tpl.canStart;
}

/** Quy trình đang dùng được, nhưng người này không được khởi chạy. */
function isRestricted(tpl: TemplateSummary): boolean {
  return tpl.archivedAt === null && tpl.latestPublishedVersion !== null && !tpl.canStart;
}

/**
 * Một dòng của bản xem trước: việc, người nhận, hạn. Người nhận do quy trình chỉ định (docs/DECISIONS.md, 05/10/2026), nên ở
 * đây không đổi được; việc chưa tìm được người thì hiện cờ "Cần giao người" và Văn phòng giao sau khi khởi chạy.
 */
function PreviewRow({ row }: { row: SimulationRowView }) {
  return (
    <tr className={cn('[&:last-child>td]:border-b-0', row.pastDue && 'bg-late-bg/45')}>
      <Td className="tabular w-10 pr-0 text-ink-sub">{row.order + 1}</Td>
      <Td>
        <p className="font-medium">{row.title}</p>
        {row.kind === 'approval' ? (
          <Badge tone="gold" className="mt-1">
            <Stamp aria-hidden="true" />
            {row.action === 'contribute' ? t.kindContribute : t.kindApproval}
          </Badge>
        ) : null}
      </Td>
      <Td className="w-[208px]">
        {row.assignee ? (
          <span>
            <PersonName person={row.assignee} />
            {row.onBehalfOf ? <span className="block text-sm text-ink-sub">{fmt(t.onBehalfOf, { tên: personName(row.onBehalfOf, 'full') })}</span> : null}
          </span>
        ) : (
          <Badge tone="warn">
            <UserRoundX aria-hidden="true" />
            {t.needsAssignee}
          </Badge>
        )}
      </Td>
      <Td className="w-[164px]">
        {row.dueAt ? (
          <span className="inline-flex flex-col">
            <time dateTime={row.dueAt} className={cn('tabular', row.pastDue && 'font-medium text-late')}>
              <span className="block">{formatDateWeekday(row.dueAt)}</span>
              <span className={cn('text-sm', !row.pastDue && 'text-ink-sub')}>{formatTime(row.dueAt)}</span>
            </time>
            {row.pastDue ? (
              <span className="mt-0.5 inline-flex items-center gap-1 text-sm font-semibold text-late">
                <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                {t.pastDue}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-ink-sub">{t.noDue}</span>
        )}
      </Td>
    </tr>
  );
}

/**
 * Khởi chạy mới (SPEC 9.2, 10.5): chọn quy trình đã xuất bản, đặt tên, điền biểu mẫu sinh từ `inputs`,
 * xem trước bằng `templates.simulate` (tự tính lại khi đủ ô bắt buộc; người nhận do quy trình chỉ định, không đổi được),
 * rồi `runs.create`. Hạn đã qua được báo rõ và phải xác nhận trước khi bấm; hệ thống không tự dời hạn (SPEC 4.5).
 */
export function RunNewPage() {
  const { templateId: preselected } = route.useSearch();
  const navigate = useNavigate();
  const ackId = useId();
  const can = useCan();
  // Xem trước dùng `templates.simulate` (quyền template.simulate). Người khởi chạy theo `starters` mà không có quyền này
  // (ví dụ nhân viên soạn văn bản đi) vẫn khởi chạy được: không bắt buộc xem trước, người nhận do quy trình chỉ định.
  const canPreview = can('template.simulate');

  const [chosen, setChosen] = useState<string | null>(preselected ?? null);
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<FieldValues>({});
  const [ackedFor, setAckedFor] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  /** lỗi từng ô do máy chủ trả (422); gỡ khi người dùng sửa ô đó */
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});

  const templates = useApiQuery('templates.list', { query: {} });
  const options = useMemo(() => sortByVi((templates.data?.items ?? []).filter(isLaunchable), (tpl) => tpl.name), [templates.data]);
  // Chỉ có một quy trình thì chọn luôn; quy trình chọn sẵn mà không còn dùng được thì coi như chưa chọn.
  const templateId = chosen && options.some((o) => o.id === chosen) ? chosen : chosen === null && options.length === 1 ? (options[0]?.id ?? null) : null;
  const template = options.find((o) => o.id === templateId) ?? null;
  const preselectedItem = preselected !== undefined ? templates.data?.items.find((tpl) => tpl.id === preselected) : undefined;
  const preselectedRestricted = templates.isSuccess && preselectedItem !== undefined && chosen === preselected && isRestricted(preselectedItem);
  const preselectedGone = templates.isSuccess && preselected !== undefined && chosen === preselected && template === null && !preselectedRestricted;

  const version = useApiQuery(
    'templates.version',
    { params: { id: templateId ?? '', n: template?.latestPublishedVersion ?? 1 } },
    { enabled: template !== null, staleTime: 5 * 60_000 },
  );
  const fields = useMemo(() => (version.data ? asFormFields(version.data.definition.inputs) : []), [version.data]);

  const fieldErrors = validateFields(fields, values);
  const inputsValid = version.isSuccess && Object.keys(fieldErrors).length === 0;
  const uploading = hasUploading(fields, values);
  const cannotPropose = needsFileUpload(fields);
  // Để trống tên thì lấy trích yếu (hoặc tiêu đề) của biểu mẫu, văn thư khỏi gõ hai lần.
  const runTitle = effectiveRunTitle(title, fields, values);
  const canDeriveTitle = fields.some((f) => f.key === 'trichYeu' || f.key === 'tieuDe');
  const titleError = runTitle === '' ? t.runTitleRequired : runTitle.length > MAX_TITLE ? t.runTitleTooLong : null;

  // Bản xem trước tính lại sau khi người dùng ngừng gõ; khoá là chuỗi để giá trị trễ không đổi mỗi lần vẽ.
  const simKey = templateId && inputsValid ? JSON.stringify({ templateId, inputs: toPayload(fields, values) } satisfies SimArgs) : '';
  const debouncedKey = useDebouncedValue(simKey, 350);
  const simArgs = useMemo(() => (debouncedKey ? (JSON.parse(debouncedKey) as SimArgs) : null), [debouncedKey]);
  const simulation = useApiQuery(
    'templates.simulate',
    { params: { id: simArgs?.templateId ?? '' }, body: { inputs: simArgs?.inputs ?? {} } },
    { enabled: simArgs !== null && canPreview, staleTime: 0, gcTime: 60_000, placeholderData: keepPreviousData },
  );

  const previewReady = simKey !== '' && simArgs !== null && simulation.data !== undefined;
  const previewStale = simKey !== debouncedKey || simulation.isFetching;
  /** Có quyền xem trước thì phải tính xong; không có thì chỉ cần chọn quy trình và điền biểu mẫu hợp lệ. */
  const previewSettled = canPreview ? previewReady && !previewStale : simKey !== '';
  const rows = useMemo(() => [...(simulation.data?.rows ?? [])].sort((a, b) => a.order - b.order), [simulation.data]);
  const pastDueCount = rows.filter((r) => r.pastDue).length;
  const unassignedCount = rows.filter((r) => !r.assignee).length;
  const assigneeCount = new Set(rows.map((r) => r.assignee?.id).filter(Boolean)).size;
  const otherWarnings = (simulation.data?.warnings ?? []).filter((w) => w.code !== 'due_in_past');

  // Lời xác nhận gắn với đúng bản xem trước đang hiện: đổi ngày mốc hay đổi quy trình thì phải xác nhận lại.
  const ackKey = `${simArgs?.templateId ?? ''}:${JSON.stringify(simArgs?.inputs ?? {})}:${pastDueCount}`;
  const ackPastDue = ackedFor === ackKey;

  const create = useApiMutation('runs.create', {
    invalidate: ['runs.list', 'steps.list', 'overview.get', 'activity.list', 'templates.list'],
    toastError: false,
  });

  const chooseTemplate = (id: string | null) => {
    // Hộp chọn không có mục "bỏ chọn", nhưng khi danh sách vừa tải xong nó có thể báo giá trị rỗng: bỏ qua, kẻo mất quy trình chọn sẵn từ ?templateId=.
    if (!id) return;
    setChosen(id);
    setValues({});
    setShowErrors(false);
    setServerErrors({});
    create.reset();
  };

  const setValue = (key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      if (prev[key] === undefined) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  };

  const canSubmit = templateId !== null && titleError === null && inputsValid && !uploading && previewSettled && (pastDueCount === 0 || ackPastDue);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!canSubmit || !templateId || create.isPending) return;
    setServerErrors({});
    create.mutate(
      { body: { templateId, title: runTitle, inputs: toPayload(fields, values) } },
      {
        onSuccess: (run) => {
          toast.success(fmt(t.done, { tên: run.title }));
          // Chi tiết lượt chạy cần quyền xem mọi lượt; người khởi chạy theo `starters` mà không có thì về Việc của tôi, kẻo bị đẩy ra kèm báo thiếu quyền.
          if (can('run.view_all')) void navigate({ to: '/luot-chay/$runId', params: { runId: run.id } });
          else void navigate({ to: '/viec-cua-toi' });
        },
        // 422: gắn lỗi vào đúng ô (tệp không còn dùng được, sai kiểu…); lỗi không gắn được thì hiện ở khung báo lỗi.
        onError: (err) => setServerErrors(fieldErrorsFromProblem(fields, problemFields(err), (code) => fieldCodeText(code, codeMessage))),
      },
    );
  };

  const back = (
    <Link to="/luot-chay" className="inline-flex items-center gap-1 rounded-sm text-ink-sub hover:text-primary">
      <ChevronLeft aria-hidden="true" className="size-4" />
      {t.back}
    </Link>
  );

  if (templates.isSuccess && options.length === 0) {
    // Có quy trình đã xuất bản nhưng người này không nằm trong những người được khởi chạy: nói rõ, đừng bảo là "chưa có".
    const restricted = (templates.data?.items ?? []).some(isRestricted);
    return (
      <>
        <PageHeader title={t.title} back={back} />
        <div className="rounded-xl border border-hairline bg-surface">
          <EmptyState icon={Workflow} title={restricted ? t.noStartableTitle : t.noTemplatesTitle} description={restricted ? t.noStartableBody : t.noTemplatesBody} />
        </div>
      </>
    );
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-5">
      <PageHeader className="mb-0" title={t.title} description={t.description} back={back} />

      {templates.isError ? <Callout tone="error">{errorMessage(templates.error)}</Callout> : null}
      {preselectedGone ? <Callout tone="warn">{t.templateGone}</Callout> : null}
      {preselectedRestricted ? (
        <Callout tone="warn" title={t.notStartableTitle}>
          {t.notStartableBody}
        </Callout>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[21rem_minmax(0,1fr)]">
        {/* ───── Biểu mẫu ───── */}
        <Card aria-labelledby="khoi-chay-bieu-mau">
          <CardHeader>
            <CardTitle id="khoi-chay-bieu-mau">{t.formHeading}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label={t.template} required hint={template ? fmt(t.templateMeta, { n: template.stepCount, 'phiên bản': template.latestPublishedVersion ?? 1 }) : undefined}>
              {/* aria-label: hộp chọn của khung chưa nhận id từ <Field> nên nhãn phải truyền thẳng. */}
              <Select
                aria-label={t.template}
                value={templateId}
                onValueChange={chooseTemplate}
                options={options.map((o) => ({ value: o.id, label: o.name }))}
                placeholder={templates.isPending ? vi.common.loading : t.templatePlaceholder}
                disabled={templates.isPending}
              />
            </Field>
            {template?.description ? <p className="-mt-2 text-sm text-ink-sub">{template.description}</p> : null}

            <Field label={t.runTitle} required={!canDeriveTitle} hint={canDeriveTitle ? vi.admin.documents.autoTitleHint : t.runTitleHint} error={showErrors && titleError ? titleError : undefined}>
              <Input autoComplete="off" maxLength={MAX_TITLE + 20} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>

            {template ? (
              <div role="group" aria-labelledby="khoi-chay-dau-vao" className="flex flex-col gap-4 border-t border-hairline pt-4">
                <h3 id="khoi-chay-dau-vao" className="text-base font-semibold">
                  {t.inputsHeading}
                </h3>
                {version.isPending ? (
                  <div role="status" className="flex flex-col gap-3">
                    <span className="sr-only">{t.loadingForm}</span>
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : version.isError ? (
                  <Callout tone="error">{errorMessage(version.error)}</Callout>
                ) : fields.length === 0 ? (
                  <p className="text-ink-sub">{t.noInputs}</p>
                ) : (
                  fields.map((field) => (
                    <DynamicField
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => setValue(field.key, v)}
                      // Lỗi của máy chủ hiện trước; ô bắt buộc còn trống chỉ báo lỗi sau khi bấm Khởi chạy; ô đã gõ mà sai kiểu thì báo ngay.
                      error={serverErrors[field.key] ?? (showErrors || hasInput(field, values[field.key]) ? fieldErrors[field.key] : undefined)}
                    />
                  ))
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* ───── Bản xem trước ───── */}
        <Card aria-labelledby="khoi-chay-xem-truoc" className="min-w-0 overflow-hidden xl:sticky xl:top-[4.5rem]">
          <CardHeader className="items-baseline border-b border-hairline">
            <CardTitle id="khoi-chay-xem-truoc">{t.previewHeading}</CardTitle>
            <div aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-sub">
              {previewReady ? <span data-testid="preview-summary">{fmt(t.previewSummary, { n: rows.length, người: assigneeCount })}</span> : null}
              {previewReady && simulation.data?.targetAt ? <span>{fmt(t.target, { ngày: formatDateWeekday(simulation.data.targetAt) })}</span> : null}
              {simKey !== '' && previewStale ? <Spinner label={t.previewUpdating} showLabel={!previewReady} /> : null}
            </div>
          </CardHeader>

          {!template ? (
            <p className="px-5 py-8 text-center text-ink-sub">{t.previewPickTemplate}</p>
          ) : !canPreview ? (
            <p className="px-5 py-8 text-center text-ink-sub" data-testid="preview-not-allowed">
              {t.previewNotAllowed}
            </p>
          ) : simKey === '' ? (
            <p className="px-5 py-8 text-center text-ink-sub">{version.isPending ? t.loadingForm : t.previewNeedInputs}</p>
          ) : simulation.isError && !simulation.isFetching ? (
            <div className="p-5">
              <Callout
                tone="error"
                title={t.previewFailed}
                action={
                  <Button size="sm" onClick={() => void simulation.refetch()}>
                    {vi.admin.shell.ui.retry}
                  </Button>
                }
              >
                {errorMessage(simulation.error)}
              </Callout>
            </div>
          ) : !previewReady ? (
            <div aria-busy="true" className="flex flex-col gap-3 px-5 py-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : (
            <>
              <Table className={cn('min-w-[560px] table-fixed', previewStale && 'opacity-60')} data-testid="preview-table">
                <caption className="sr-only">{t.previewCaption}</caption>
                <thead>
                  <tr>
                    <Th className="w-10 pr-0">
                      <span className="sr-only">{t.colOrder}</span>
                    </Th>
                    <Th>{t.colStep}</Th>
                    <Th className="w-[208px]">{t.colAssignee}</Th>
                    <Th className="w-[164px]">{t.colDue}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <PreviewRow key={row.nodeId} row={row} />
                  ))}
                </tbody>
              </Table>

              {pastDueCount > 0 || unassignedCount > 0 || otherWarnings.length > 0 ? (
                <div className="flex flex-col gap-3 border-t border-hairline px-5 py-4">
                  {pastDueCount > 0 ? (
                    <Callout tone="late" title={fmt(t.pastDueTitle, { n: pastDueCount })}>
                      <p>{t.pastDueBody}</p>
                      <div className="mt-2.5 flex items-start gap-2.5">
                        <Checkbox id={ackId} checked={ackPastDue} onCheckedChange={(v) => setAckedFor(v === true ? ackKey : null)} className="mt-0.5 border-late" />
                        <label htmlFor={ackId} className="font-medium">
                          {t.pastDueConfirm}
                        </label>
                      </div>
                    </Callout>
                  ) : null}
                  {unassignedCount > 0 ? <Callout tone="warn">{fmt(t.unassignedNote, { n: unassignedCount })}</Callout> : null}
                  {otherWarnings.length > 0 ? (
                    <Callout tone="warn" title={t.warningsTitle}>
                      <ul className="flex list-disc flex-col gap-1 pl-4">
                        {otherWarnings.map((w, i) => (
                          <li key={`${w.code}-${w.nodeId ?? ''}-${i}`}>{w.message}</li>
                        ))}
                      </ul>
                    </Callout>
                  ) : null}
                </div>
              ) : null}
            </>
          )}

          <div className="flex flex-col gap-3 border-t border-hairline bg-canvas px-5 py-3.5">
            {create.isError ? <Callout tone="error">{Object.keys(serverErrors).length > 0 ? vi.admin.runs.form.serverRejected : errorMessage(create.error)}</Callout> : null}
            {uploading ? <Callout tone="info">{t.uploadingBlock}</Callout> : null}
            {showErrors && template && !uploading && (!inputsValid || titleError) ? <Callout tone="warn">{t.fixBeforeSubmit}</Callout> : null}
            {cannotPropose ? <p className="text-sm text-ink-sub">{t.proposeNoFiles}</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="text-sm text-ink-sub">{t.submitHint}</p>
              <div className="flex flex-wrap items-center gap-2">
                {templateId ? (
                  <SubmitToExecutive
                    tool="propose_start_run"
                    payload={{ templateId, title: runTitle, inputs: proposalInputs(fields, toPayload(fields, values)) }}
                    note={vi.admin.shell.dispatch.submit.startRunNote}
                    disabled={!canSubmit || cannotPropose}
                    onDone={() => void navigate({ to: '/luot-chay' })}
                  />
                ) : null}
                <Button type="submit" variant="primary" loading={create.isPending} aria-disabled={!canSubmit || create.isPending || undefined}>
                  {create.isPending ? null : <Play aria-hidden="true" />}
                  {t.submit}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </form>
  );
}
