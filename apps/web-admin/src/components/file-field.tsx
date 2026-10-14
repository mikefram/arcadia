import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Check, CircleAlert, CloudUpload, FileText, X } from 'lucide-react';
import { FORM_LIMITS } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { codeMessage, errorMessage, subCodeMessage } from '@/lib/errors';
import { removeUploadedFile, uploadFile } from '@/lib/file-transfer';
import { checkClientFile, FILE_ACCEPT, fileRulesText, formatBytes, type FileItem } from '@/lib/files';
import { Button } from './ui/button';
import { useFieldControl } from './ui/field';

const t = vi.admin.runs.files;

let sequence = 0;
function newLocalId(): string {
  sequence += 1;
  return `tep-${Date.now().toString(36)}-${sequence}`;
}

/** Câu báo lỗi của một mã lỗi tệp: kiểm ở máy khách và ở máy chủ dùng chung một bảng. */
function problemText(code: string): string {
  if (code === 'too_many') return fmt(vi.admin.runs.form.filesTooMany, { n: FORM_LIMITS.files });
  return subCodeMessage(code) ?? codeMessage(code);
}

export type FileFieldProps = {
  /** khoá ô biểu mẫu, dùng đặt data-testid */
  fieldKey: string;
  /** nhãn của ô, để đọc cho người dùng đọc màn hình */
  label: string;
  value: readonly FileItem[];
  onChange: (items: FileItem[]) => void;
  /** cho đính nhiều tệp; mặc định một tệp (chọn tệp mới thì thay tệp cũ) */
  multiple?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
};

/**
 * Vùng chọn hoặc kéo thả tệp cùng danh sách tệp đã tải (ô `file` của biểu mẫu). Lồng trong <Field> để có nhãn và câu lỗi.
 * Tệp lên máy chủ ngay khi chọn (`files.upload`) và ở trạng thái chờ gắn; id tệp là giá trị của ô khi gửi biểu mẫu.
 * Bàn phím: ô chọn tệp là phần tử thật (Tab tới, Enter hoặc Space mở hộp chọn). Kéo thả chỉ là lối tắt cho chuột.
 * Tiến độ: tệp tải bằng JSON nên không có phần trăm; mỗi tệp đang tải có thanh chạy và được đọc ở vùng thông báo.
 */
export function FileField({ fieldKey, label, value, onChange, multiple = false, disabled = false, className }: FileFieldProps) {
  const field = useFieldControl();
  const rulesId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const controllers = useRef(new Map<string, AbortController>());

  // Các lần tải bất đồng bộ cập nhật danh sách theo bản mới nhất, không theo bản của lúc bấm chọn.
  const itemsRef = useRef<FileItem[]>([...value]);
  itemsRef.current = [...value];

  const commit = (next: FileItem[]) => {
    itemsRef.current = next;
    onChange(next);
  };

  const patch = (localId: string, change: Partial<FileItem>) => {
    const current = itemsRef.current;
    if (!current.some((item) => item.localId === localId)) return;
    commit(current.map((item) => (item.localId === localId ? { ...item, ...change } : item)));
  };

  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  const startUpload = async (localId: string, file: File) => {
    const controller = new AbortController();
    controllers.current.set(localId, controller);
    try {
      const view = await uploadFile(file, controller.signal);
      if (!itemsRef.current.some((item) => item.localId === localId)) {
        // Người dùng đã gỡ hoặc biểu mẫu đã đổi trong lúc tải: dọn tệp vừa lên để khỏi nằm chờ.
        void removeUploadedFile(view.id).catch(() => undefined);
        return;
      }
      patch(localId, { status: 'done', id: view.id, name: view.name, sizeBytes: view.sizeBytes });
      setAnnouncement(fmt(t.announceDone, { tên: view.name }));
    } catch (err) {
      if (controller.signal.aborted) return;
      patch(localId, { status: 'error', error: errorMessage(err) });
      setAnnouncement(fmt(t.announceFailed, { tên: file.name }));
    } finally {
      controllers.current.delete(localId);
    }
  };

  const addFiles = (picked: File[]) => {
    if (picked.length === 0 || disabled) return;
    const limit = multiple ? FORM_LIMITS.files : 1;
    let next: FileItem[] = multiple ? [...itemsRef.current] : [];
    if (!multiple) {
      // Ô một tệp: tệp mới thay tệp cũ.
      for (const old of itemsRef.current) {
        controllers.current.get(old.localId)?.abort();
        if (old.status === 'done' && old.id) void removeUploadedFile(old.id).catch(() => undefined);
      }
    }
    const queue: { localId: string; file: File }[] = [];
    let accepted = next.filter((item) => item.status !== 'error').length;
    for (const file of multiple ? picked : picked.slice(0, 1)) {
      const base = { localId: newLocalId(), id: null, name: file.name, sizeBytes: file.size };
      const problem = checkClientFile(file);
      if (problem) {
        next = [...next, { ...base, status: 'error', error: problemText(problem) }];
      } else if (accepted >= limit) {
        next = [...next, { ...base, status: 'error', error: problemText('too_many') }];
      } else {
        accepted += 1;
        next = [...next, { ...base, status: 'uploading' }];
        queue.push({ localId: base.localId, file });
      }
    }
    commit(next);
    if (queue.length > 0) setAnnouncement(fmt(t.announceUploading, { n: queue.length }));
    for (const job of queue) void startUpload(job.localId, job.file);
  };

  const remove = (item: FileItem) => {
    controllers.current.get(item.localId)?.abort();
    commit(itemsRef.current.filter((x) => x.localId !== item.localId));
    if (item.status === 'done' && item.id) void removeUploadedFile(item.id).catch(() => undefined);
    setAnnouncement(fmt(t.announceRemoved, { tên: item.name }));
    // Nút vừa bấm biến mất cùng dòng: trả focus về ô chọn tệp.
    inputRef.current?.focus();
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    // Cho phép chọn lại đúng tệp vừa gỡ.
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const inputId = field.id;
  const describedBy = [field['aria-describedby'], rulesId].filter(Boolean).join(' ');
  const items = value;

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid={`file-${fieldKey}`}>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-line bg-surface px-4 py-5 text-center transition-colors hover:border-ink has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary',
          dragging && 'border-primary bg-primary-tint',
          field['aria-invalid'] && 'border-ink',
          disabled && 'cursor-not-allowed opacity-60 hover:border-line',
        )}
      >
        <CloudUpload aria-hidden="true" className="size-6 text-ink-sub" />
        <span className="font-medium">{dragging ? t.dropActive : multiple ? t.dropTitleMany : t.dropTitle}</span>
        <span aria-hidden="true" className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
          {multiple ? t.chooseMany : t.choose}
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="sr-only"
          data-testid={`file-${fieldKey}-input`}
          accept={FILE_ACCEPT}
          multiple={multiple}
          disabled={disabled}
          aria-label={`${label}: ${multiple ? t.chooseMany : t.choose}`}
          aria-describedby={describedBy || undefined}
          aria-invalid={field['aria-invalid']}
          aria-required={field['aria-required']}
          onChange={onInputChange}
        />
      </label>
      <p id={rulesId} className="text-sm text-ink-sub">
        {fileRulesText()}
      </p>

      {items.length > 0 ? (
        <ul aria-label={fmt(t.selectedLabel, { ô: label })} className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.localId} data-testid={`file-${fieldKey}-item`} className="flex items-start gap-3 rounded-lg border border-hairline bg-surface px-3 py-2.5">
              <FileText aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink-sub" />
              <div className="min-w-0 flex-1">
                <p className="font-medium [overflow-wrap:anywhere]">{item.name}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-sub">
                  <span className="tabular">{formatBytes(item.sizeBytes)}</span>
                  {item.status === 'done' ? (
                    <span className="inline-flex items-center gap-1 font-medium text-on-primary-tint">
                      <Check aria-hidden="true" className="size-3.5" />
                      {t.uploaded}
                    </span>
                  ) : null}
                  {item.status === 'uploading' ? <span>{t.uploading}</span> : null}
                </p>
                {item.status === 'uploading' ? (
                  <div role="progressbar" aria-label={fmt(t.uploadingFile, { tên: item.name })} aria-valuetext={t.uploading} className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
                    <div className="h-full w-2/5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
                  </div>
                ) : null}
                {item.status === 'error' && item.error ? (
                  <p role="alert" className="mt-1 flex items-start gap-1.5 text-sm font-medium text-ink">
                    <CircleAlert aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
                    <span>{item.error}</span>
                  </p>
                ) : null}
              </div>
              <Button size="sm" variant="ghost" disabled={disabled} aria-label={fmt(t.removeFile, { tên: item.name })} onClick={() => remove(item)}>
                <X aria-hidden="true" />
                {t.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Vùng thông báo cho trình đọc màn hình: bắt đầu tải, tải xong, tải lỗi, đã gỡ. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
