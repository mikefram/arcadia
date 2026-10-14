import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Download, FileUp } from 'lucide-react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import type { RouteResponse } from '@mihato/api-client';
import { routes } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Table, TableFrame, Td, Th } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { downloadCsv } from '@/lib/csv';
import { errorMessage } from '@/lib/errors';
import { invalidateRoutes, useApiMutation } from '@/lib/query';

const t = vi.admin.org.users.import;

/** Thân yêu cầu của `users.import` trong bảng hợp đồng: { csv }. */
const FormSchema = routes['users.import'].body;
type FormValues = z.infer<typeof FormSchema>;
type ImportResult = RouteResponse<'users.import'>;

/** Tên cột của tệp CSV, đúng thứ tự máy chủ đọc (SPEC 9.5, 10.3). Là mã cột, không dịch. */
const CSV_COLUMNS = ['fullName', 'givenName', 'honorific', 'email', 'phone', 'unit', 'manager', 'roles', 'uiProfile'] as const;
type CsvColumnName = (typeof CSV_COLUMNS)[number];
type SampleRow = Partial<Record<CsvColumnName, string>>;

const ERROR_TEXT: Record<string, string> = t.errors;
/** Máy chủ trả MÃ lỗi từng dòng; câu chữ nằm ở vi.admin.org. Mã lạ vẫn hiện được, kèm chính mã đó. */
const importError = (code: string): string => ERROR_TEXT[code] ?? fmt(t.errorFallback, { mã: code });

function downloadTemplate(): void {
  const sample: readonly SampleRow[] = t.sample;
  downloadCsv(
    t.templateFileName,
    sample,
    CSV_COLUMNS.map((column) => ({ header: column, value: (row: SampleRow) => row[column] ?? '' })),
  );
}

function ImportResultView({ result }: { result: ImportResult }) {
  const errorRows = result.rows.filter((r) => !r.ok);
  if (errorRows.length === 0) {
    return result.total === 0 ? <Callout tone="warn">{t.noRows}</Callout> : <Callout tone="success">{fmt(t.allOk, { n: result.total })}</Callout>;
  }
  return (
    <>
      <Callout tone="error">{result.total === 0 ? t.headerProblem : fmt(t.hasErrors, { lỗi: errorRows.length, n: result.total })}</Callout>
      <TableFrame>
        <Table>
          <caption className="sr-only">{t.errorRowsCaption}</caption>
          <thead>
            <tr>
              <Th className="w-24">{t.colLine}</Th>
              <Th>{t.colProblem}</Th>
            </tr>
          </thead>
          <tbody>
            {errorRows.map((row) => (
              <tr key={row.line} className="[&:last-child>td]:border-b-0">
                <Td className="tabular font-medium whitespace-nowrap">{fmt(t.lineN, { n: row.line })}</Td>
                <Td>
                  <ul className="flex flex-col gap-0.5">
                    {row.errors.map((code) => (
                      <li key={code}>{importError(code)}</li>
                    ))}
                  </ul>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
    </>
  );
}

function ImportForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileNote, setFileNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** Kết quả lần chạy gần nhất, kèm đúng nội dung đã chạy: sửa nội dung thì phải chạy thử lại. */
  const [checked, setChecked] = useState<{ csv: string; result: ImportResult } | null>(null);

  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: { csv: '' } });
  const csv = form.watch('csv');
  const run = useApiMutation('users.import', { toastError: false });

  const upToDate = checked !== null && checked.csv === csv;
  const clean = upToDate && checked.result.total > 0 && checked.result.rows.every((r) => r.ok);

  // Kết quả nằm dưới ô nội dung dài: kéo hộp thoại tới đó để người nhập thấy ngay các dòng lỗi, không phải tự cuộn tìm.
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (checked) resultRef.current?.scrollIntoView({ block: 'start' });
  }, [checked]);

  const dryRun = form.handleSubmit((values) => {
    run.mutate({ query: { dryRun: 'true' }, body: values }, { onSuccess: (result) => setChecked({ csv: values.csv, result }) });
  });

  const importNow = () => {
    if (!clean) return;
    run.mutate(
      { query: { dryRun: 'false' }, body: { csv } },
      {
        onSuccess: (result) => {
          if (result.created > 0) {
            invalidateRoutes(['users.list', 'units.list', 'people.search', 'admin.audit']);
            toast.success(fmt(t.imported, { n: result.created }));
            onOpenChange(false);
          } else {
            // Giữa lần chạy thử và lần nhập có người vừa thêm email trùng: hiện lại lỗi từng dòng.
            setChecked({ csv, result });
          }
        },
      },
    );
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      // Ký tự NUL hoặc ký tự thay thế U+FFFD nghĩa là tệp không phải UTF-8 (thường là tệp Excel lưu dạng khác).
      if (text.includes(String.fromCharCode(0)) || text.includes(String.fromCharCode(0xfffd))) throw new Error('not utf-8');
      form.setValue('csv', text, { shouldValidate: true, shouldDirty: true });
      setFileNote({ ok: true, text: fmt(t.fileLoaded, { tên: file.name }) });
    } catch {
      setFileNote({ ok: false, text: t.fileUnreadable });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const dryRunning = run.isPending && run.variables?.query?.dryRun === 'true';
  const importing = run.isPending && !dryRunning;

  return (
    <form noValidate onSubmit={(e) => void dryRun(e)} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>{t.intro}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={downloadTemplate}>
            <Download aria-hidden="true" />
            {t.downloadTemplate}
          </Button>
          <Button onClick={() => fileRef.current?.click()}>
            <FileUp aria-hidden="true" />
            {t.chooseFile}
          </Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" aria-label={t.fileInput} className="sr-only" tabIndex={-1} onChange={(e) => void readFile(e.target.files?.[0])} />
          {fileNote ? (
            <p role="status" className={fileNote.ok ? 'text-sm text-ink-sub' : 'text-sm font-medium'}>
              {fileNote.text}
            </p>
          ) : null}
        </div>

        <details className="rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
          <summary className="font-medium">{t.columnsTitle}</summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {CSV_COLUMNS.map((column) => (
              <div key={column} className="contents">
                <dt className="tabular font-semibold">{column}</dt>
                <dd className="text-ink-sub">{t.columns[column]}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm text-ink-sub">{t.templateNote}</p>
        </details>

        <Field label={t.content} error={form.formState.errors.csv ? t.csvRequired : undefined}>
          <Textarea rows={7} wrap="off" spellCheck={false} placeholder={t.contentPlaceholder} className="tabular overflow-x-auto text-sm" {...form.register('csv')} />
        </Field>

        <section ref={resultRef} aria-label={t.resultTitle} aria-live="polite" className="flex flex-col gap-3">
          {run.isError ? <Callout tone="error">{errorMessage(run.error)}</Callout> : null}
          {checked && !upToDate ? <Callout tone="info">{t.changedSinceDryRun}</Callout> : null}
          {upToDate ? <ImportResultView result={checked.result} /> : null}
        </section>
      </DialogBody>
      <DialogFooter>
        {clean ? null : <p className="text-sm text-ink-sub sm:mr-auto">{t.needDryRun}</p>}
        <DialogClose asChild>
          <Button variant="secondary" className={clean ? 'sm:mr-auto' : undefined}>
            {vi.admin.shell.ui.close}
          </Button>
        </DialogClose>
        <Button type="submit" variant={clean ? 'secondary' : 'primary'} loading={dryRunning} disabled={importing}>
          {t.dryRun}
        </Button>
        <Button variant={clean ? 'primary' : 'secondary'} disabled={!clean || dryRunning} loading={importing} onClick={importNow}>
          {clean ? fmt(t.importN, { n: checked.result.total }) : t.importIdle}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Nhập người dùng hàng loạt bằng CSV (SPEC 9.5 điều 1, 10.3): tải mẫu, dán hoặc chọn tệp, chạy thử
 * (`dryRun=true`, hiện lỗi từng dòng), rồi mới nhập thật. Tệp còn dòng lỗi thì máy chủ không ghi dòng nào.
 */
export function UserImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <ImportForm onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
