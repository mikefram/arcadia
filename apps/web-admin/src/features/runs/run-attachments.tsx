import { useMemo, type ReactNode } from 'react';
import { FileCheck } from 'lucide-react';
import type { FileView, FormField, RunDetail } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { FileRow } from '@/components/file-list';
import { Callout } from '@/components/ui/callout';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/errors';
import { viewableFor } from '@/lib/file-preview';
import { groupRunFiles, presentedFiles } from '@/lib/files';
import { useApiQuery } from '@/lib/query';
import { buildPersonIndex, FieldValueList, personIdsIn } from './form-fields';
import { AddRunFilesButton } from './add-run-files';
import { usePeople } from './use-people';

const tp = vi.admin.runs.detail.attachments;
const tc = vi.admin.runs.files;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

/** Tên ô của biểu mẫu khởi chạy mà tệp được đính vào, để ghi chú dưới tên tệp. */
function fieldNote(file: FileView, form: readonly FormField[]): string | undefined {
  const label = file.fieldKey ? form.find((f) => f.key === file.fieldKey)?.label : undefined;
  return label ? fmt(tc.forField, { ô: label }) : undefined;
}

/**
 * Hồ sơ đính kèm của lượt chạy (`RunDetail.files`): bản trình duyệt (tệp tổng hợp mới nhất) nổi bật ở đầu, các bản tổng hợp cũ,
 * tài liệu khởi chạy, rồi tệp theo từng việc. Mỗi tệp có nút tải xuống.
 */
export function RunAttachments({ files, inputForm, runId, canAdd = false }: { files: readonly FileView[]; inputForm: readonly FormField[]; runId?: string; canAdd?: boolean }) {
  const groups = useMemo(() => groupRunFiles(files), [files]);
  const empty = files.length === 0;
  /** Bấm "Xem" ở tệp Word tổng hợp thì mở bản PDF dựng cùng lúc (đúng như bản sẽ in và ký). */
  const viewAs = (file: FileView) => {
    const target = viewableFor(file, files);
    return target === file ? undefined : target;
  };
  return (
    <Card aria-labelledby="luot-chay-ho-so" className="min-w-0" data-testid="run-attachments">
      <CardHeader className="items-baseline border-b border-hairline">
        <CardTitle id="luot-chay-ho-so" className="flex items-center gap-2">
          {tp.title}
        </CardTitle>
        <span className="flex items-center gap-3 text-sm text-ink-sub">
          {fmt(tp.count, { n: files.length })}
          {canAdd && runId ? <AddRunFilesButton runId={runId} /> : null}
        </span>
      </CardHeader>
      <div className="flex flex-col gap-5 px-5 py-4">
        {empty ? <p className="text-ink-sub">{tp.empty}</p> : null}

        {groups.presented ? (
          <Group title={tp.presented}>
            <p className="-mt-1 text-sm text-ink-sub">{tp.presentedHint}</p>
            <ul aria-label={tp.presented} className="flex flex-col gap-2">
              <FileRow file={groups.presented} featured showStep viewAs={viewAs(groups.presented)} />
              {groups.presentedExtras.map((file) => (
                <FileRow key={file.id} file={file} featured showStep />
              ))}
            </ul>
          </Group>
        ) : null}

        {groups.earlierCompiled.length > 0 ? (
          <Group title={tp.earlierCompiled}>
            <ul className="flex flex-col gap-2">
              {groups.earlierCompiled.map((file) => (
                <FileRow key={file.id} file={file} showStep viewAs={viewAs(file)} />
              ))}
            </ul>
          </Group>
        ) : null}

        {groups.initial.length > 0 ? (
          <Group title={tp.initial}>
            <ul className="flex flex-col gap-2">
              {groups.initial.map((file) => (
                <FileRow key={file.id} file={file} note={fieldNote(file, inputForm)} />
              ))}
            </ul>
          </Group>
        ) : null}

        {groups.extra.length > 0 ? (
          <Group title={tp.extra}>
            <p className="-mt-1 text-sm text-ink-sub">{tp.extraHint}</p>
            <ul className="flex flex-col gap-2">
              {groups.extra.map((file) => (
                <FileRow key={file.id} file={file} />
              ))}
            </ul>
          </Group>
        ) : null}

        {groups.byStep.length > 0 ? (
          <Group title={tp.byStep}>
            <div className="flex flex-col gap-4">
              {groups.byStep.map((group) => (
                <div key={group.stepId} className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-ink-sub">{fmt(tp.stepFiles, { việc: group.stepTitle ?? vi.admin.runs.timeline.unknownStep })}</p>
                  <ul className="flex flex-col gap-2">
                    {group.files.map((file) => (
                      <FileRow key={file.id} file={file} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Group>
        ) : null}
      </div>
    </Card>
  );
}

/** Thông tin khởi chạy: `run.inputs` vẽ theo `run.inputForm` (nhãn, ngày, tiền, tên người, danh sách người, tệp, nhiều dòng). */
export function RunStartInfo({ run, fields }: { run: RunDetail; fields: readonly FormField[] }) {
  const t = vi.admin.runs.detail;
  const known = buildPersonIndex([run.initiator, ...run.steps.flatMap((s) => [s.assignee, s.assignedBy, s.onBehalfOf, ...(s.participants ?? []).map((p) => p.person)]), ...(run.files ?? []).map((f) => f.uploadedBy)]);
  const people = usePeople(personIdsIn(fields, run.inputs), known);
  return (
    <Card aria-labelledby="luot-chay-thong-tin" className="min-w-0" data-testid="run-start-info">
      <CardHeader className="items-baseline border-b border-hairline">
        <CardTitle id="luot-chay-thong-tin">{t.startInfo}</CardTitle>
      </CardHeader>
      <div className="px-5 py-4">
        <FieldValueList fields={fields} values={run.inputs} files={run.files} people={people} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5" />
      </div>
    </Card>
  );
}

/**
 * Bản trình duyệt của một lượt chạy: tệp tổng hợp mới nhất, đặt ở đầu hộp duyệt để người duyệt mở được trước khi quyết.
 * Lấy từ `runs.files`, nên dùng được cả khi chỉ có `runId` (trang Việc của tôi).
 */
export function PresentedFile({ runId, showEmpty = false }: { runId: string; showEmpty?: boolean }) {
  const files = useApiQuery('runs.files', { params: { id: runId } });
  const shown = files.data ? presentedFiles(files.data.items) : [];
  if (files.isPending) return <Skeleton className="h-16 w-full rounded-lg" />;
  if (files.isError) return <Callout tone="warn">{errorMessage(files.error)}</Callout>;
  if (shown.length === 0) return showEmpty ? <p className="text-ink-sub">{vi.admin.runs.myTasks.approval.presentedNone}</p> : null;
  return (
    <div className="flex flex-col gap-2" data-testid="presented-file">
      <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
        <FileCheck aria-hidden="true" className="size-4 text-primary" />
        {vi.admin.runs.myTasks.approval.presentedHeading}
      </h3>
      <p className="-mt-1 text-sm text-ink-sub">{vi.admin.runs.myTasks.approval.presentedHint}</p>
      <ul aria-label={vi.admin.runs.myTasks.approval.presentedHeading} className="flex flex-col gap-2">
        {shown.map((file) => (
          <FileRow key={file.id} file={file} featured showStep viewAs={(() => { const target = viewableFor(file, shown); return target === file ? undefined : target; })()} />
        ))}
      </ul>
    </div>
  );
}
