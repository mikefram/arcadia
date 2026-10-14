import type { FormField } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { deviceFiles } from '../files/device';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Field } from '../ui/Field';
import { Glyph } from '../ui/Glyph';
import { color, profile, space } from '../ui/theme';
import { fileProblemText, fileRulesText, formatBytes, isRetryable, maxFilesOf, type FileItem } from './files';
import type { FormFilesController } from './form-files';

const t = vi.staff.files;

type Props = {
  field: FormField;
  /** nhãn đã có dấu sao nếu bắt buộc */
  label: string;
  items: readonly FileItem[];
  /** câu báo lỗi của cả ô (thiếu tệp, còn tệp đang tải hoặc tải lỗi) */
  error: string | null;
  controller: FormFilesController;
};

/**
 * Ô `file` của biểu mẫu: nút chọn tệp từ máy, danh sách tệp đã chọn kèm trạng thái (đang tải, đã tải, lỗi), Thử lại và Gỡ.
 * Tệp lên máy chủ ngay khi chọn; id tệp là giá trị của ô khi gửi. Nút cao từ 48dp như mọi nút của app.
 * Tải bằng JSON nên không có phần trăm: tệp đang tải hiện vòng quay kèm chữ "Đang tải lên…".
 */
export function FileField({ field, label, items, error, controller }: Props) {
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const multiple = field.multiple === true;
  const limit = maxFilesOf(field);
  const live = items.filter((i) => i.status !== 'error').length;
  const full = multiple && live >= limit;

  const pick = async () => {
    setPicking(true);
    setPickError(null);
    try {
      controller.add(field, await deviceFiles.pick({ multiple }));
    } catch {
      setPickError(t.problems.read_failed);
    } finally {
      setPicking(false);
    }
  };

  return (
    <Field label={label} error={error ?? pickError}>
      <View style={styles.box} testID={`field-${field.key}`}>
        {items.length > 0 ? (
          <View style={styles.list}>
            {items.map((item) => (
              <FileItemRow key={item.localId} item={item} limit={limit} onRetry={() => controller.retry(field.key, item.localId)} onRemove={() => controller.remove(field.key, item.localId)} fieldKey={field.key} />
            ))}
          </View>
        ) : null}
        {full ? (
          <AppText variant="caption" tone="sub">
            {fmt(t.limit, { n: limit })}
          </AppText>
        ) : (
          <Button
            variant="secondary"
            label={items.length === 0 ? vi.staff.complete.attachPick : multiple ? t.chooseMany : t.chooseAgain}
            accessibilityLabel={fmt(t.chooseLabel, { tên: field.label })}
            busy={picking}
            onPress={() => void pick()}
            testID={`field-${field.key}-choose`}
          />
        )}
        <AppText variant="caption" tone="sub">
          {fileRulesText()}
        </AppText>
      </View>
    </Field>
  );
}

function FileItemRow({ item, limit, onRetry, onRemove, fieldKey }: { item: FileItem; limit: number; onRetry: () => void; onRemove: () => void; fieldKey: string }) {
  return (
    <View style={[styles.item, item.status === 'error' && styles.itemError]} testID={`field-${fieldKey}-item`}>
      <AppText weight="medium" style={styles.name}>
        {item.name}
      </AppText>
      <View style={styles.statusRow}>
        <AppText variant="caption" tone="sub">
          {formatBytes(item.sizeBytes)}
        </AppText>
        {item.status === 'uploading' ? (
          <View style={styles.inline} accessibilityRole="progressbar" accessibilityLabel={t.uploading} accessibilityLiveRegion="polite">
            <ActivityIndicator color={color.primary} size="small" />
            <AppText variant="caption" tone="sub">
              {t.uploading}
            </AppText>
          </View>
        ) : null}
        {item.status === 'done' ? <Chip label={t.uploaded} tone="done" /> : null}
      </View>
      {item.status === 'error' ? (
        <View style={styles.inline} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <View style={styles.errorGlyph}>
            <Glyph name="alert" size={14} tint={color.text} />
          </View>
          <AppText variant="caption" weight="semibold" style={styles.name}>
            {fileProblemText(item.problem, limit)}
          </AppText>
        </View>
      ) : null}
      <View style={styles.actions}>
        {isRetryable(item) ? <Button variant="secondary" label={vi.common.actions.retry} accessibilityLabel={fmt(t.retryFile, { tên: item.name })} onPress={onRetry} style={styles.action} testID={`field-${fieldKey}-retry`} /> : null}
        <Button variant="quiet" label={vi.staff.complete.removeAttachment} accessibilityLabel={fmt(t.removeFile, { tên: item.name })} onPress={onRemove} style={styles.action} testID={`field-${fieldKey}-remove`} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.sm },
  list: { gap: profile.space.betweenCards },
  item: {
    backgroundColor: color.surface,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    padding: profile.space.cardPadding,
    gap: space.xs,
  },
  // Lỗi không dùng màu đỏ (đỏ nâu chỉ dành cho quá hạn): viền đậm, có dấu cảnh báo và chữ.
  itemError: { borderWidth: 2, borderColor: color.text },
  name: { flexShrink: 1 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  inline: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  errorGlyph: { paddingTop: 3 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: profile.space.betweenButtons, marginTop: space.xs },
  action: { flexGrow: 1 },
});
