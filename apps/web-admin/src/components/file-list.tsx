import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Download, Eye, FileArchive, FileImage, FileSpreadsheet, FileText, type LucideIcon } from 'lucide-react';
import type { FileView } from '@mihato/domain';
import { fmt, formatDateTime, vi } from '@mihato/i18n';
import { cn } from '@/lib/cn';
import { useFileDownload } from '@/lib/file-transfer';
import { canPreview } from '@/lib/file-preview';
import { fileExtension, formatBytes } from '@/lib/files';
import { personName } from '@/lib/person';
import { Badge } from './ui/badge';
import { Button, type ButtonProps } from './ui/button';

const t = vi.admin.runs.files;

// Trình xem nặng (pdf.js, trình dựng Word) nên tách thành khối mã riêng, chỉ tải khi có người bấm "Xem".
const FileViewerDialog = lazy(() => import('./file-viewer/file-viewer-dialog').then((m) => ({ default: m.FileViewerDialog })));

const SPREADSHEET = new Set(['xls', 'xlsx', 'ods', 'csv']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif']);

function iconFor(name: string): LucideIcon {
  const ext = fileExtension(name);
  if (IMAGE.has(ext)) return FileImage;
  if (SPREADSHEET.has(ext)) return FileSpreadsheet;
  if (ext === 'zip') return FileArchive;
  return FileText;
}

export type DownloadButtonProps = {
  file: Pick<FileView, 'id' | 'name'>;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
  children?: ReactNode;
};

/** Nút tải một tệp xuống. Tên đọc cho trình đọc màn hình nêu rõ tệp nào. */
export function DownloadButton({ file, size = 'sm', variant = 'secondary', className, children }: DownloadButtonProps) {
  const { pendingId, start } = useFileDownload();
  const pending = pendingId === file.id;
  return (
    <Button size={size} variant={variant} className={className} loading={pending} aria-label={fmt(t.downloadFile, { tên: file.name })} onClick={() => void start(file)}>
      {pending ? null : <Download aria-hidden="true" />}
      {children ?? t.download}
    </Button>
  );
}

export type ViewButtonProps = {
  /** tệp sẽ mở trong trình xem (có thể là bản PDF của tệp Word tổng hợp) */
  file: Pick<FileView, 'id' | 'name' | 'sizeBytes'>;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
  children?: ReactNode;
};

/** Nút xem một tệp ngay trên web (hộp thoại). Chỉ hiện với loại tệp xem được; loại khác dùng nút tải xuống. */
export function ViewButton({ file, size = 'sm', variant = 'secondary', className, children }: ViewButtonProps) {
  const [open, setOpen] = useState(false);
  if (!canPreview(file.name)) return null;
  return (
    <>
      <Button size={size} variant={variant} className={className} aria-label={fmt(t.viewFile, { tên: file.name })} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Eye aria-hidden="true" />
        {children ?? t.view}
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <FileViewerDialog file={file} open onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}

export type FileRowProps = {
  file: FileView;
  /** nổi bật (bản trình duyệt) */
  featured?: boolean;
  /** hiện tên việc mà tệp thuộc về */
  showStep?: boolean;
  /** hiện người tải lên và thời điểm */
  showUploader?: boolean;
  /** chữ nhãn đặt cạnh tên, ví dụ "Mới nhất" */
  badge?: ReactNode;
  /** dòng ghi chú nhỏ dưới tên, ví dụ ô của biểu mẫu mà tệp thuộc về */
  note?: ReactNode;
  /** tệp mở khi bấm "Xem" nếu khác tệp của dòng: bản PDF của tệp Word tổng hợp (đúng như bản sẽ in và ký) */
  viewAs?: FileView | undefined;
};

/** Một tệp: biểu tượng theo loại, tên, cỡ, người tải lên và nút tải xuống. */
export function FileRow({ file, featured = false, showStep = false, showUploader = true, badge, note, viewAs }: FileRowProps) {
  const Icon = iconFor(file.name);
  return (
    <li data-testid="file-row" className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5', featured ? 'border-primary/40 bg-primary-tint' : 'border-hairline bg-surface')}>
      <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', featured ? 'text-on-primary-tint' : 'text-ink-sub')} />
      <div className="min-w-40 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium [overflow-wrap:anywhere]">{file.name}</span>
          {file.renditionOf ? <Badge tone="neutral">{t.pdfCopy}</Badge> : null}
          {badge}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-sub">
          <span className="tabular">{formatBytes(file.sizeBytes)}</span>
          {showUploader && file.uploadedBy ? (
            <span>
              {fmt(t.uploadedBy, { tên: personName(file.uploadedBy, 'short'), giờ: formatDateTime(file.uploadedAt) })}
            </span>
          ) : null}
        </p>
        {showStep && file.stepTitle ? <p className="text-sm text-ink-sub">{fmt(t.fromStep, { việc: file.stepTitle })}</p> : null}
        {note ? <p className="text-sm text-ink-sub">{note}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ViewButton file={viewAs ?? file} variant={featured ? 'primary' : 'secondary'} />
        <DownloadButton file={file} variant="secondary" />
      </div>
    </li>
  );
}

export type FileListProps = {
  files: readonly FileView[];
  'aria-label'?: string;
  showStep?: boolean;
  showUploader?: boolean;
  className?: string;
};

/** Danh sách tệp chỉ đọc (có tải xuống). Tệp tổng hợp mang nhãn "Tệp tổng hợp". */
export function FileList({ files, showStep, showUploader, className, ...rest }: FileListProps) {
  if (files.length === 0) return null;
  return (
    <ul aria-label={rest['aria-label']} className={cn('flex flex-col gap-2', className)}>
      {files.map((file) => (
        <FileRow
          key={file.id}
          file={file}
          {...(showStep !== undefined ? { showStep } : {})}
          {...(showUploader !== undefined ? { showUploader } : {})}
          badge={file.compiled ? <Badge tone="gold">{t.compiled}</Badge> : undefined}
        />
      ))}
    </ul>
  );
}
