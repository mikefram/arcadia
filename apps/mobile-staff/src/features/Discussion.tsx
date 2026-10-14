import { newId, type StepComment, type StepCommentList } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import type { InfiniteData } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { errorMessage } from '../api/errors';
import { keys, useStepComments } from '../data/queries';
import { useOnline } from '../hooks';
import { api, queryClient } from '../services';
import { AppText } from '../ui/AppText';
import { Banner } from '../ui/Banner';
import { Card, ErrorState, LoadingState, SectionHeading } from '../ui/Blocks';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { TextField } from '../ui/Field';
import { showFlash } from '../ui/Flash';
import { color, profile, space } from '../ui/theme';
import { CommentKeyRing, COMMENT_MAX, appendComment, canCommentOf, commentCountText, commentErrorMessage, composerState, mergeCommentPages, removeComment } from './comments';
import { dateTimeText, personName } from './steps';

const t = vi.staff.comments;

type CommentData = InfiniteData<StepCommentList, string | undefined>;

type Props = {
  stepId: string;
  /** lượt là văn bản mật: nhắc rõ ai đọc được */
  restricted: boolean;
  /** báo vị trí của mục (so với đầu nội dung) để màn cuộn tới khi mở từ thông báo bình luận */
  onLayoutY?: (y: number) => void;
};

function CommentRow({ comment, confirming, deleting, onAskDelete, onCancel, onConfirm }: { comment: StepComment; confirming: boolean; deleting: boolean; onAskDelete: () => void; onCancel: () => void; onConfirm: () => void }) {
  const author = personName(comment.author) ?? vi.staff.stepDetail.unknownPerson;
  return (
    <View style={styles.comment} testID={`comment-${comment.id}`}>
      <View style={styles.commentHead}>
        <AppText weight="semibold" style={styles.grow}>
          {author}
        </AppText>
        {comment.mine ? <Chip label={t.mine} glyph={null} /> : null}
      </View>
      <AppText variant="caption" tone="sub">
        {dateTimeText(comment.createdAt)}
      </AppText>
      {comment.body ? <AppText selectable>{comment.body}</AppText> : null}
      {comment.files.length > 0 ? (
        <AppText variant="caption" tone="sub">
          {fmt(t.filesNote, { n: comment.files.length })}
        </AppText>
      ) : null}
      {comment.mine ? (
        confirming ? (
          <View style={styles.confirm} testID={`comment-delete-confirm-${comment.id}`}>
            <AppText weight="medium">{t.deleteTitle}</AppText>
            <AppText tone="sub">{t.deleteBody}</AppText>
            <Button label={t.deleteConfirm} variant="secondary" busy={deleting} onPress={onConfirm} testID="comment-delete-yes" />
            <Button label={t.deleteKeep} variant="quiet" disabled={deleting} onPress={onCancel} testID="comment-delete-no" />
          </View>
        ) : (
          <Button label={t.delete} accessibilityLabel={t.deleteLabel} variant="quiet" onPress={onAskDelete} style={styles.deleteButton} testID={`comment-delete-${comment.id}`} />
        )
      ) : null}
    </View>
  );
}

/**
 * Mục "Thảo luận" của một việc (chi tiết việc thường, màn gửi phần của bước đóng góp và duyệt): bình luận cũ nhất trước, tải thêm,
 * ô viết, xoá bình luận của mình. Bình luận không phải sự kiện của engine, nên KHÔNG đi qua hàng đợi ngoại tuyến: không có mạng thì
 * báo cần có mạng và giữ nguyên nội dung đã gõ. Dữ liệu chỉ ở bộ nhớ (xem `shouldPersistQuery`).
 */
export function Discussion({ stepId, restricted, onLayoutY }: Props) {
  const query = useStepComments(stepId);
  const online = useOnline();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const keyRing = useRef(new CommentKeyRing(newId));

  const pages = query.data?.pages;
  const comments = useMemo(() => mergeCommentPages(pages), [pages]);
  const canComment = canCommentOf(pages);
  const composer = composerState({ draft, sending, online });
  const count = query.hasNextPage ? null : commentCountText(comments.length);

  const patchCache = (update: (data: CommentData) => CommentData) => {
    queryClient.setQueryData<CommentData>(keys.comments(stepId), (old) => (old ? update(old) : old));
  };

  // Số bình luận ở thẻ việc và chi tiết lấy từ `StepView.commentCount`: tải lại sau khi gửi hoặc xoá.
  const refreshCounts = () => {
    void queryClient.invalidateQueries({ queryKey: keys.comments(stepId) });
    void queryClient.invalidateQueries({ queryKey: keys.step(stepId) });
    void queryClient.invalidateQueries({ queryKey: ['steps'] });
  };

  const send = async () => {
    if (composer.disabled) return;
    if (!online) {
      setError(t.needNetworkKept);
      return;
    }
    const body = draft.trim();
    setSending(true);
    setError(null);
    try {
      const created = await api.call('steps.comments.add', { params: { id: stepId }, body: { body } }, { idempotencyKey: keyRing.current.keyFor(body) });
      keyRing.current.settle({ ok: true });
      setDraft('');
      patchCache((data) => appendComment(data, created));
      refreshCounts();
      showFlash(t.sent);
    } catch (err) {
      // Mất mạng hoặc 5xx: giữ khoá để gửi lại không tạo bản thứ hai; 4xx: đổi khoá. Nội dung đã gõ luôn được giữ.
      keyRing.current.settle({ ok: false, error: err });
      setError(commentErrorMessage(err, errorMessage));
    } finally {
      setSending(false);
    }
  };

  const remove = async (commentId: string) => {
    if (!online) {
      setError(vi.staff.feedback.needNetwork);
      setConfirming(null);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.call('steps.comments.delete', { params: { id: stepId, commentId } });
      patchCache((data) => removeComment(data, commentId));
      refreshCounts();
      showFlash(t.deleted);
    } catch (err) {
      setError(commentErrorMessage(err, errorMessage));
      void queryClient.invalidateQueries({ queryKey: keys.comments(stepId) });
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  };

  let list: ReactNode;
  if (!pages) {
    list = query.isError ? (
      <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
    ) : query.fetchStatus === 'paused' ? (
      <AppText tone="sub">{t.needNetworkRead}</AppText>
    ) : (
      <LoadingState />
    );
  } else if (comments.length === 0) {
    list = <AppText tone="sub">{t.empty}</AppText>;
  } else {
    list = (
      <Card style={styles.flush} testID="comment-list">
        {comments.map((c, index) => (
          <View key={c.id} style={index > 0 && styles.line}>
            <CommentRow
              comment={c}
              confirming={confirming === c.id}
              deleting={deleting}
              onAskDelete={() => setConfirming(c.id)}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void remove(c.id)}
            />
          </View>
        ))}
      </Card>
    );
  }

  return (
    <View style={styles.section} onLayout={(e) => onLayoutY?.(e.nativeEvent.layout.y)} testID="discussion">
      <SectionHeading title={t.title} detail={count ?? undefined} />
      {restricted ? (
        <AppText variant="caption" tone="sub">
          {t.restrictedNote}
        </AppText>
      ) : null}
      {list}
      {query.hasNextPage ? <Button variant="secondary" label={t.loadMore} busy={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()} testID="comment-load-more" /> : null}

      {pages && !canComment ? (
        <AppText tone="sub" testID="comment-readonly">
          {t.readOnly}
        </AppText>
      ) : null}

      {pages && canComment ? (
        <View style={styles.composer}>
          <TextField
            label={t.inputLabel}
            value={draft}
            onChangeText={(v) => {
              setDraft(v);
              setError(null);
            }}
            placeholder={t.inputPlaceholder}
            multiline
            maxLength={COMMENT_MAX}
            hint={composer.counter}
            error={composer.overLimit ? fmt(t.overLimit, { tổng: COMMENT_MAX }) : null}
            testID="comment-input"
          />
          {composer.offline ? (
            <Banner tone="info" testID="comment-offline">
              {t.needNetwork}
            </Banner>
          ) : null}
          {error ? (
            <Banner tone="info" live testID="comment-error">
              {error}
            </Banner>
          ) : null}
          <Button label={t.send} busy={sending} disabled={composer.disabled} onPress={() => void send()} testID="comment-send" />
        </View>
      ) : error ? (
        <Banner tone="info" live testID="comment-error">
          {error}
        </Banner>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  flush: { paddingVertical: space.xs, gap: 0 },
  line: { borderTopWidth: 1, borderTopColor: color.hairline },
  comment: { paddingVertical: space.sm + 2, gap: 2 },
  commentHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1 },
  confirm: { gap: space.sm, marginTop: space.sm, padding: space.md, borderRadius: profile.radius, borderWidth: 2, borderColor: color.border, backgroundColor: color.surfaceAlt },
  deleteButton: { alignSelf: 'flex-start' },
  composer: { gap: space.sm },
});
