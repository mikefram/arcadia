import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { MessageSquare, Paperclip, Trash2 } from 'lucide-react';
import { COMMENT_FILES_MAX, COMMENT_MAX, newId, type StepComment } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { FileRow } from '@/components/file-list';
import { FileField } from '@/components/file-field';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { isApiError } from '@/lib/errors';
import { isUploading, readyFileIds, type FileItem } from '@/lib/files';
import { personName } from '@/lib/person';
import { invalidateRoutes, useApiInfiniteQuery, useApiMutation } from '@/lib/query';
import { authorLabel, clampComment, commentTime, composerState, deleteErrorMessage, nextAttempt, sendErrorMessage, shouldReuseKey, type SendAttempt } from './comments-model';
import { SectionHeading } from './step-parts';

const t = vi.admin.runs.comments;

/** Làm mới mọi nơi đọc số bình luận và danh sách bình luận sau khi viết hoặc xoá. */
const AFTER_CHANGE = ['steps.comments.list', 'steps.get', 'steps.list', 'runs.get'] as const;
const PAGE_SIZE = 50;

function CommentItem({ comment, onDelete }: { comment: StepComment; onDelete: (comment: StepComment) => void }) {
  const when = commentTime(comment.createdAt);
  return (
    <li data-testid="comment-item" className={cn('flex flex-col gap-1 rounded-lg border border-hairline px-3.5 py-2.5', comment.mine ? 'bg-primary-tint/40' : 'bg-surface')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="min-w-0 font-semibold break-words">{authorLabel(comment, personName(comment.author, 'full'))}</p>
        <time dateTime={comment.createdAt} className="tabular text-sm text-ink-sub">
          {when}
        </time>
      </div>
      {comment.body ? <p className="break-words whitespace-pre-wrap">{comment.body}</p> : null}
      {comment.files.length > 0 ? (
        <ul aria-label={t.filesListLabel} className="mt-1 flex flex-col gap-2" data-testid="comment-files">
          {comment.files.map((file) => (
            <FileRow key={file.id} file={file} showUploader={false} />
          ))}
        </ul>
      ) : null}
      {comment.mine ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" aria-label={fmt(t.deleteLabel, { giờ: when })} onClick={() => onDelete(comment)}>
            <Trash2 aria-hidden="true" />
            {t.delete}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function Composer({ stepId, onSent }: { stepId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  // Gửi lại sau lỗi mạng hoặc lỗi máy chủ: cùng nội dung, cùng khoá chống gửi trùng.
  const attempt = useRef<SendAttempt | null>(null);
  const [keepKey, setKeepKey] = useState(false);
  /** nội dung dán vào dài hơn mức: đã cắt bớt, nói rõ để người viết biết */
  const [clipped, setClipped] = useState(false);
  /** tệp đính kèm bình luận đang soạn; ô chọn tệp chỉ mở khi bấm "Đính kèm tệp" */
  const [attachOpen, setAttachOpen] = useState(false);
  const [items, setItems] = useState<FileItem[]>([]);
  const helpId = useId();
  const counterId = useId();

  const add = useApiMutation('steps.comments.add', {
    toastError: false,
    invalidate: AFTER_CHANGE,
    callOptions: () => (attempt.current ? { idempotencyKey: attempt.current.key } : {}),
  });
  const fileIds = readyFileIds(items);
  const uploading = isUploading(items);
  const state = composerState(text, { sending: add.isPending, canComment: true, files: fileIds.length, filesBusy: uploading });

  const send = () => {
    if (!state.canSend) return;
    // Khoá chống gửi trùng tính theo cả chữ lẫn danh sách tệp: đổi tệp thì là một bình luận khác.
    const current = nextAttempt(attempt.current, `${state.body}\u0000${fileIds.join(',')}`, newId);
    attempt.current = current;
    add.mutate(
      { params: { id: stepId }, body: { body: state.body, fileIds } },
      {
        onSuccess: () => {
          attempt.current = null;
          setKeepKey(false);
          setText('');
          // Tệp đã gắn vào bình luận: chỉ làm sạch danh sách, không gỡ tệp khỏi máy chủ.
          setItems([]);
          setAttachOpen(false);
          setClipped(false);
          setNotice(t.sent);
          onSent();
        },
        onError: (err) => {
          const reuse = shouldReuseKey(err);
          setKeepKey(reuse);
          if (!reuse) attempt.current = null;
        },
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  const nearLimit = state.length >= COMMENT_MAX * 0.9;
  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Field label={t.inputLabel}>
        <Textarea
          rows={3}
          value={text}
          readOnly={add.isPending}
          placeholder={t.inputPlaceholder}
          aria-describedby={`${helpId} ${counterId}`}
          data-testid="comment-input"
          onKeyDown={onKeyDown}
          onChange={(e) => {
            const next = clampComment(e.target.value);
            setClipped(next.length < e.target.value.length);
            if (add.isError) add.reset();
            if (notice) setNotice('');
            setText(next);
            // Nội dung đã đổi thì lần gửi sau là một bình luận khác: không giữ khoá cũ.
            setKeepKey(false);
          }}
        />
      </Field>
      <div>
        <Button type="button" size="sm" variant="ghost" aria-expanded={attachOpen} data-testid="comment-attach-toggle" disabled={add.isPending} onClick={() => setAttachOpen((open) => !open)}>
          <Paperclip aria-hidden="true" />
          {attachOpen ? t.attachHide : fileIds.length > 0 ? `${t.attach} (${fileIds.length})` : t.attach}
        </Button>
        {attachOpen ? (
          <div className="mt-2 flex flex-col gap-2" data-testid="comment-attach">
            <FileField fieldKey="binh-luan-tep" label={t.attachLabel} value={items} onChange={setItems} multiple disabled={add.isPending} />
            <p className="text-sm text-ink-sub">{fmt(t.attachHint, { n: COMMENT_FILES_MAX })}</p>
            {fileIds.length > COMMENT_FILES_MAX ? <p className="text-sm font-medium text-ink">{fmt(t.filesTooMany, { n: COMMENT_FILES_MAX })}</p> : null}
            {uploading ? <p className="text-sm text-ink-sub">{t.filesUploadingWait}</p> : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-ink-sub">
        <p id={helpId}>{t.inputHint}</p>
        <p id={counterId} className={cn('tabular', nearLimit && 'font-medium text-ink')}>
          {fmt(t.counter, { n: state.length, 'tối đa': COMMENT_MAX })}
        </p>
      </div>
      {/* Vùng báo cho trình đọc màn hình: lỗi đọc ngay, kết quả đọc nhẹ. */}
      <div aria-live="assertive">
        {clipped ? <p className="text-sm font-medium text-ink">{fmt(t.tooLong, { n: COMMENT_MAX })}</p> : null}
        {add.isError ? (
          <Callout tone="error" data-testid="comment-error">
            <p>{sendErrorMessage(add.error)}</p>
            {keepKey ? <p className="mt-1 text-sm text-ink-sub">{t.retryKept}</p> : null}
          </Callout>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={add.isPending} disabled={!state.canSend && !add.isPending} data-testid="comment-send">
          {add.isPending ? t.sending : keepKey ? t.resend : t.submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * Mục "Thảo luận" của một việc (docs/DECISIONS.md, 07/10/2026 điểm a): bình luận cũ nhất trước, tải thêm bằng con trỏ,
 * ô viết (ẩn khi `canComment` là false), xoá bình luận của mình. Bình luận không đổi trạng thái việc.
 * Tự làm mới khi mở, sau khi gửi hoặc xoá, và khi có thông báo mới (loại bình luận mới).
 */
export function StepComments({ stepId }: { stepId: string }) {
  const headingId = useId();
  const list = useApiInfiniteQuery('steps.comments.list', { params: { id: stepId }, query: { limit: PAGE_SIZE } }, { staleTime: 0 });
  const [deleting, setDeleting] = useState<StepComment | null>(null);
  const remove = useApiMutation('steps.comments.delete', { toastError: false, invalidate: AFTER_CHANGE });

  const canComment = list.data?.pages[0]?.canComment ?? false;
  const total = list.items.length;

  /** Bình luận mới nằm ở cuối: nếu còn trang chưa tải thì tải cho tới hết để người viết thấy bình luận của mình. */
  const showLatest = () => {
    void (async () => {
      const more = (r: { data?: { pages: { nextCursor: string | null }[] } | undefined }) => (r.data?.pages.at(-1)?.nextCursor ?? null) !== null;
      let res = await list.refetch();
      for (let i = 0; i < 20 && more(res); i += 1) res = await list.fetchNextPage();
    })();
  };

  return (
    <section aria-labelledby={headingId} data-testid="step-comments" className="flex flex-col gap-3">
      <SectionHeading aside={total > 0 ? fmt(t.count, { n: total }) : undefined}>
        <span id={headingId} className="inline-flex items-center gap-1.5">
          <MessageSquare aria-hidden="true" className="size-4 text-ink-sub" />
          {t.title}
        </span>
      </SectionHeading>

      {list.isError && list.items.length === 0 ? (
        <Callout
          tone="error"
          action={
            <Button size="sm" onClick={() => void list.refetch()}>
              {vi.admin.shell.ui.retry}
            </Button>
          }
        >
          {t.loadFailed}
        </Callout>
      ) : list.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t.loading}</span>
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : total === 0 ? (
        <p className="text-ink-sub">{canComment ? t.emptyCanWrite : t.empty}</p>
      ) : (
        <>
          <ol aria-label={t.listLabel} className="flex flex-col gap-2">
            {list.items.map((comment) => (
              <CommentItem key={comment.id} comment={comment} onDelete={setDeleting} />
            ))}
          </ol>
          {list.hasNextPage ? (
            <div className="flex justify-center">
              <Button size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? t.loadingMore : t.loadMore}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {list.isPending || (list.isError && list.items.length === 0) ? null : canComment ? <Composer stepId={stepId} onSent={showLatest} /> : <p className="text-sm text-ink-sub">{t.cannotWrite}</p>}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            remove.reset();
          }
        }}
        tone="danger"
        title={t.deleteTitle}
        description={t.deleteBody}
        confirmLabel={t.deleteConfirm}
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(
            { params: { id: stepId, commentId: deleting.id } },
            {
              onSuccess: () => {
                toast.success(t.deleted);
                setDeleting(null);
              },
              onError: (err) => {
                // Bình luận đã không còn: làm mới danh sách và đóng hộp.
                if (isApiError(err, 'not_found')) {
                  invalidateRoutes(AFTER_CHANGE);
                  setDeleting(null);
                }
              },
            },
          );
        }}
      >
        {remove.isError ? <Callout tone="error">{deleteErrorMessage(remove.error)}</Callout> : null}
      </ConfirmDialog>
    </section>
  );
}
