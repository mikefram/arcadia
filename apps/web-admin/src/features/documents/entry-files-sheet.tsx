import type { RegisterEntryView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Callout } from '@/components/ui/callout';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useApiQuery } from '@/lib/query';
import { RunAttachments } from '@/features/runs/run-attachments';

const t = vi.admin.documents;

/**
 * Tài liệu của một dòng trong sổ văn bản (tài liệu của lượt chạy sinh ra số đó): xem ngay trên web, tải xuống, và thêm tài liệu khi lượt chạy còn
 * đang chạy. Dùng cùng khối hồ sơ đính kèm của trang chi tiết lượt chạy nên hai nơi luôn giống nhau.
 */
export function EntryFilesSheet({ entry, onOpenChange }: { entry: RegisterEntryView | null; onOpenChange: (open: boolean) => void }) {
  const can = useCan();
  const runId = entry?.run.id ?? '';
  const files = useApiQuery('runs.files', { params: { id: runId } }, { enabled: entry !== null });
  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{entry ? fmt(t.filesTitle, { số: entry.number }) : ''}</SheetTitle>
          <SheetDescription>{entry?.subject.trim() ? `${entry.subject}. ${t.filesDescription}` : t.filesDescription}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {files.isError ? (
            <Callout tone="error">{`${t.filesLoadFailed} ${errorMessage(files.error)}`}</Callout>
          ) : !entry || files.isPending ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : (
            <RunAttachments files={files.data.items} inputForm={[]} runId={entry.run.id} canAdd={entry.run.state === 'running' && can('run.note')} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
