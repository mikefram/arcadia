import type { FileView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { openRunFile } from '../files/transfer';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Glyph } from '../ui/Glyph';
import { SectionHeading } from '../ui/Blocks';
import { color, profile, space } from '../ui/theme';
import { openErrorText } from './file-download';
import { fileMetaText, fileOriginText, groupFilesForStep } from './file-list';

const t = vi.staff.files;

/** Mở tệp bằng hộp chia sẻ của hệ điều hành: nhớ tệp đang mở để khoá hàng đó, và câu lỗi (nếu có) của tệp vừa mở. */
function useFileOpener() {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  // `ref` chặn bấm hai lần liên tiếp trước khi React kịp vẽ lại hàng đã khoá.
  const busy = useRef(false);
  const open = useCallback(async (file: FileView) => {
    if (busy.current) return;
    busy.current = true;
    setOpeningId(file.id);
    setFailure(null);
    try {
      await openRunFile(file);
    } catch (err) {
      setFailure({ id: file.id, text: openErrorText(err) });
    } finally {
      busy.current = false;
      setOpeningId(null);
    }
  }, []);
  return { openingId, failure, open };
}

type Opener = ReturnType<typeof useFileOpener>;

function FileRow({ file, opener }: { file: FileView; opener: Opener }) {
  const opening = opener.openingId === file.id;
  const failed = opener.failure?.id === file.id ? opener.failure.text : null;
  return (
    <View style={styles.rowWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={fmt(t.openFile, { tên: file.name })}
        accessibilityState={{ busy: opening, disabled: opener.openingId !== null }}
        disabled={opener.openingId !== null}
        onPress={() => void opener.open(file)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID={`file-${file.id}`}
      >
        <View style={styles.rowText}>
          <AppText weight="medium" style={styles.name}>
            {file.name}
          </AppText>
          <AppText variant="caption" tone="sub">
            {fileMetaText(file)}
          </AppText>
          <AppText variant="caption" tone="sub">
            {fileOriginText(file)}
          </AppText>
        </View>
        {opening ? (
          <View style={styles.opening} accessibilityLabel={t.opening} accessibilityLiveRegion="polite">
            <ActivityIndicator color={color.primary} size="small" />
            <AppText variant="caption" tone="sub">
              {t.opening}
            </AppText>
          </View>
        ) : (
          <AppText weight="semibold" tone="primary">
            {t.open}
          </AppText>
        )}
      </Pressable>
      {failed ? (
        <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="file-open-error">
          <View style={styles.errorGlyph}>
            <Glyph name="alert" size={14} tint={color.text} />
          </View>
          <AppText variant="caption" weight="semibold" style={styles.name}>
            {failed}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

function FileRows({ files, opener }: { files: readonly FileView[]; opener: Opener }) {
  return (
    <View style={styles.rows}>
      {files.map((file) => (
        <FileRow key={file.id} file={file} opener={opener} />
      ))}
    </View>
  );
}

type SectionProps = {
  stepId: string;
  /** tệp trong chi tiết việc (có sẵn cả khi mất mạng) */
  stepFiles: readonly FileView[] | undefined;
  /** mọi tệp của lượt chạy; undefined khi chưa tải được */
  runFiles: readonly FileView[] | undefined;
  /** đang tải lượt chạy, hoặc tải lỗi (kèm nút thử lại) */
  runLoading?: boolean;
  runFailed?: boolean;
  onRetry?: () => void;
};

/**
 * Mục "Tệp đính kèm" của chi tiết việc: tệp của chính việc này, tài liệu đính kèm lúc khởi chạy lượt, và tệp ở các việc khác
 * trong cùng lượt. Chạm một tệp để mở bằng hộp chia sẻ của hệ điều hành. Máy chủ chỉ trả tệp mà người này được xem.
 */
export function FilesSection({ stepId, stepFiles, runFiles, runLoading = false, runFailed = false, onRetry }: SectionProps) {
  const opener = useFileOpener();
  const groups = groupFilesForStep(stepId, stepFiles, runFiles);
  const empty = groups.total === 0;
  return (
    <View style={styles.section} testID="step-files">
      <SectionHeading title={vi.staff.stepDetail.attachments} detail={empty ? undefined : fmt(t.count, { n: groups.total })} />
      {empty && !runLoading && !runFailed ? <AppText tone="sub">{vi.staff.stepDetail.noAttachments}</AppText> : null}
      {empty && runLoading ? <AppText tone="sub">{vi.common.loading}</AppText> : null}
      {groups.own.length > 0 ? <Group title={t.groups.step} files={groups.own} opener={opener} /> : null}
      {groups.initial.length > 0 ? <Group title={t.groups.initial} files={groups.initial} opener={opener} /> : null}
      {groups.other.map((group) => (
        <Group key={group.stepId} title={group.stepTitle ? fmt(t.fromStep, { việc: group.stepTitle }) : t.groups.other} files={group.files} opener={opener} />
      ))}
      {runFailed ? (
        <View style={styles.rows}>
          <AppText tone="sub" accessibilityRole="alert">
            {vi.staff.stepDetail.runInfoFailed}
          </AppText>
          {onRetry ? <Button variant="secondary" label={vi.common.actions.retry} onPress={onRetry} testID="run-retry" /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Group({ title, files, opener }: { title: string; files: readonly FileView[]; opener: Opener }) {
  return (
    <View style={styles.group}>
      <AppText variant="caption" weight="semibold" tone="sub" accessibilityRole="header">
        {title}
      </AppText>
      <FileRows files={files} opener={opener} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  group: { gap: space.xs },
  rows: { gap: space.sm },
  rowWrap: { gap: space.xs },
  row: {
    minHeight: profile.touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    paddingHorizontal: profile.space.cardPadding,
    paddingVertical: space.md,
  },
  rowPressed: { backgroundColor: color.primaryTint },
  rowText: { flex: 1, gap: 2 },
  name: { flexShrink: 1 },
  opening: { alignItems: 'center', gap: space.xs },
  error: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.xs },
  errorGlyph: { paddingTop: 3 },
});
