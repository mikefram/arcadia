import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { FileView } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { DownloadButton } from '@/components/file-list';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/errors';
import { fetchFileBlob } from '@/lib/file-transfer';
import { previewKind, previewMime, type PreviewKind } from '@/lib/file-preview';
import { formatBytes } from '@/lib/files';
import type { ViewProps } from './views/types';

const t = vi.admin.runs.files.viewer;

// Mỗi loại là một khối mã riêng, chỉ tải khi người dùng mở đúng loại đó (pdf.js và trình dựng Word khá nặng).
const VIEWS: Record<PreviewKind, React.LazyExoticComponent<(props: ViewProps) => ReactNode>> = {
  pdf: lazy(() => import('./views/pdf-view')),
  image: lazy(() => import('./views/image-view')),
  docx: lazy(() => import('./views/docx-view')),
  xlsx: lazy(() => import('./views/sheet-view')),
  text: lazy(() => import('./views/text-view')),
  csv: lazy(() => import('./views/csv-view')),
};

/** Lỗi tải khối mã của một trình xem (mất mạng giữa chừng) cũng hiện câu "tải xuống" chứ không làm trắng hộp thoại. */
class ViewBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFail();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Load = { status: 'loading' } | { status: 'ready'; blob: Blob } | { status: 'error'; error: unknown };

export type FileViewerDialogProps = {
  file: Pick<FileView, 'id' | 'name' | 'sizeBytes'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Xem tài liệu ngay trên web, không cần tải về: PDF, ảnh, Word (.docx), bảng tính (.xlsx), CSV và văn bản. Loại khác (doc, xls, ppt, odt, rtf, zip)
 * hiện lời giải thích kèm nút tải xuống. Tệp lấy qua `files.download` nên quyền xem do máy chủ quyết như khi tải xuống.
 */
export function FileViewerDialog({ file, open, onOpenChange }: FileViewerDialogProps) {
  const kind = previewKind(file.name);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [renderFailed, setRenderFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onFail = useCallback(() => setRenderFailed(true), []);

  useEffect(() => {
    if (!open || !kind) return;
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    setRenderFailed(false);
    fetchFileBlob(file.id, controller.signal).then(
      (blob) => {
        if (!controller.signal.aborted) setLoad({ status: 'ready', blob: new Blob([blob], { type: previewMime(file.name) }) });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoad({ status: 'error', error });
      },
    );
    return () => controller.abort();
  }, [open, file.id, file.name, kind, attempt]);

  const View = kind ? VIEWS[kind] : null;
  let body: ReactNode;
  if (!kind || !View) body = <Callout tone="info">{t.notSupported}</Callout>;
  else if (load.status === 'loading') body = <Skeleton className="min-h-0 flex-1 rounded-lg" aria-label={t.loading} />;
  else if (load.status === 'error')
    body = (
      <Callout
        tone="error"
        action={
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {vi.admin.shell.ui.retry}
          </Button>
        }
      >
        {`${t.loadFailed} ${errorMessage(load.error)}`}
      </Callout>
    );
  else if (renderFailed) body = <Callout tone="warn">{t.renderFailed}</Callout>;
  else
    body = (
      <ViewBoundary onFail={onFail}>
        <Suspense fallback={<Spinner label={t.opening} showLabel className="p-4" />}>
          <View blob={load.blob} name={file.name} onFail={onFail} />
        </Suspense>
      </ViewBoundary>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{file.name}</DialogTitle>
          <DialogDescription>{`${formatBytes(file.sizeBytes)}. ${t.description}`}</DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-hidden">{body}</DialogBody>
        <DialogFooter>
          <DownloadButton file={file} />
          <DialogClose asChild>
            <Button variant="secondary">{t.close}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
