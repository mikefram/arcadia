import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { fmt, vi } from '@mihato/i18n';
import { FileField } from '@/components/file-field';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import { errorMessage, isApiError } from '@/lib/errors';
import { removeUploadedFile } from '@/lib/file-transfer';
import { isUploading, readyFileIds, type FileItem } from '@/lib/files';
import { useApiMutation } from '@/lib/query';

const t = vi.admin.runs.files.add;

/**
 * Đính thêm tài liệu vào một lượt chạy đang chạy (`runs.attachFiles`): chọn hoặc kéo thả tệp, tệp lên máy chủ ngay (chờ gắn), rồi bấm "Đính vào lượt
 * chạy" để gắn. Đóng hộp thoại mà chưa đính thì các tệp vừa tải được gỡ. Quyền do máy chủ quyết; nút chỉ hiện cho người có khả năng được phép.
 */
export function AddRunFilesButton({ runId, variant = 'secondary' }: { runId: string; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FileItem[]>([]);
  const attach = useApiMutation('runs.attachFiles', { toastError: false, invalidate: ['runs.files', 'runs.get', 'runs.events'] });

  const discard = () => {
    // Tệp đã tải mà chưa đính: gỡ ngay cho khỏi nằm chờ 24 giờ.
    for (const id of readyFileIds(items)) void removeUploadedFile(id).catch(() => undefined);
    setItems([]);
    attach.reset();
  };
  const close = () => {
    setOpen(false);
    discard();
  };

  const ids = readyFileIds(items);
  const uploading = isUploading(items);
  const submit = () =>
    attach.mutate(
      { params: { id: runId }, body: { fileIds: ids } },
      {
        onSuccess: (res) => {
          toast.success(fmt(t.done, { n: res.items.length }));
          setItems([]);
          setOpen(false);
        },
      },
    );

  const failure = attach.error;
  const failureText = !failure ? null : isApiError(failure, 'forbidden') ? t.forbidden : isApiError(failure, 'state_conflict') ? t.closed : `${t.failed} ${errorMessage(failure)}`;

  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <FilePlus2 aria-hidden="true" />
        {t.button}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription>{t.description}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {failureText ? <Callout tone="error">{failureText}</Callout> : null}
            <Field label={t.label}>
              <FileField fieldKey="tai-lieu-them" label={t.label} value={items} onChange={setItems} multiple />
            </Field>
            {uploading ? <p className="text-sm text-ink-sub">{t.uploadingWait}</p> : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{vi.admin.shell.ui.close}</Button>
            </DialogClose>
            <Button variant="primary" loading={attach.isPending} disabled={uploading || ids.length === 0} onClick={submit}>
              {t.submit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
