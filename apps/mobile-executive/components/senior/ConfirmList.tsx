import { vi } from '@mihato/i18n';
import { Pressable, View } from 'react-native';
import { Glyph } from './Glyph';
import { SeniorButton } from './SeniorButton';
import { SeniorInput } from './SeniorInput';
import { SeniorText } from './SeniorText';
import { StatusChip } from './StatusChip';
import { tapFeedback } from './haptics';
import { color, useSenior } from './theme';

const t = vi.executive.review;

export type ConfirmItem = {
  id: string;
  /** câu do MÁY CHỦ dựng (`summary` hoặc `items[].text`), không lấy chữ của LLM (SPEC 6.5 điều 3); null: câu đầu màn hình đã nói đủ */
  text: string | null;
  /** người nhận viết đủ, ví dụ "anh Bùi Quốc Tuấn" */
  recipient: string | null;
  /** "Trễ 2 ngày làm việc"; null nếu không trễ */
  lateLabel: string | null;
  /** câu sẽ gửi (lời nhắc), đã tính phần người dùng sửa */
  message: string | null;
  editable: boolean;
  droppable: boolean;
  dropped: boolean;
  /** mức 2: phải chạm từng mục trước khi đồng ý */
  needsAcknowledge: boolean;
  acknowledged: boolean;
};

export type ConfirmListProps = {
  items: ConfirmItem[];
  editingId: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onEdit: (id: string) => void;
  onEditDone: () => void;
  onDrop: (id: string) => void;
  onRestore: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** nút Nói cạnh ô sửa lời nhắc */
  onSpeak: () => void;
  speaking: boolean;
  /** khoá mọi nút trong lúc đang gửi */
  disabled?: boolean;
};

/**
 * Danh sách mục của cổng xác nhận M3: từng mục ghi người nhận, việc, câu sẽ gửi; sửa được hoặc bỏ được.
 * Bỏ một mục là một chạm và lấy lại được ngay (hoàn tác thay vì hỏi lại, SPEC 7.2 điều 6).
 */
export function ConfirmList({ items, editingId, draft, onDraftChange, onEdit, onEditDone, onDrop, onRestore, onAcknowledge, onSpeak, speaking, disabled = false }: ConfirmListProps) {
  const m = useSenior();
  return (
    <View style={{ gap: m.space.betweenCards }}>
      {items.map((item, index) => {
        const editing = editingId === item.id;
        return (
          <View
            key={item.id}
            style={{
              borderRadius: m.radius,
              borderWidth: m.borderWidth,
              borderColor: item.dropped ? color.hairline : color.border,
              backgroundColor: item.dropped ? color.surfaceAlt : color.surface,
              padding: m.space.cardPadding,
              gap: m.space.md,
            }}
            testID={`confirm-item-${index}`}
          >
            {item.text ? (
              <SeniorText variant="emphasis" tone={item.dropped ? 'sub' : 'text'} testID={`confirm-item-${index}-text`}>
                {item.text}
              </SeniorText>
            ) : null}

            {item.dropped ? (
              <>
                <SeniorText weight="semibold" tone="sub">
                  {t.item.dropped}
                </SeniorText>
                <SeniorButton variant="secondary" label={t.item.restore} onPress={() => onRestore(item.id)} disabled={disabled} testID={`confirm-item-${index}-restore`} />
              </>
            ) : (
              <>
                {item.recipient ? (
                  <View>
                    <SeniorText variant="caption" tone="gold" weight="semibold">
                      {t.item.to}
                    </SeniorText>
                    <SeniorText weight="semibold">{item.recipient}</SeniorText>
                  </View>
                ) : null}
                {item.lateLabel ? <StatusChip kind="late" label={item.lateLabel} /> : null}

                {item.message !== null && !editing ? (
                  <View style={{ gap: m.space.xs }}>
                    <SeniorText variant="caption" tone="gold" weight="semibold">
                      {t.item.message}
                    </SeniorText>
                    <View style={{ borderLeftWidth: 4, borderLeftColor: color.gold, paddingLeft: m.space.md }}>
                      <SeniorText testID={`confirm-item-${index}-message`}>{item.message}</SeniorText>
                    </View>
                  </View>
                ) : null}

                {editing ? (
                  <View style={{ gap: m.space.md }}>
                    <SeniorInput value={draft} onChangeText={onDraftChange} label={t.item.editTitle} onSpeak={onSpeak} speaking={speaking} testID="confirm-edit-input" />
                    {draft.trim() === '' ? <SeniorText tone="sub">{t.messageEmpty}</SeniorText> : null}
                    <SeniorButton variant="secondary" icon="check" label={t.item.editDone} onPress={onEditDone} disabled={draft.trim() === ''} testID="confirm-edit-done" />
                  </View>
                ) : (
                  <View style={{ gap: m.space.md }}>
                    {item.editable ? <SeniorButton variant="secondary" icon="pen" label={t.item.edit} onPress={() => onEdit(item.id)} disabled={disabled} testID={`confirm-item-${index}-edit`} /> : null}
                    {item.droppable ? <SeniorButton variant="secondary" label={t.item.drop} onPress={() => onDrop(item.id)} disabled={disabled} testID={`confirm-item-${index}-drop`} /> : null}
                  </View>
                )}

                {item.needsAcknowledge ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={item.acknowledged ? t.cancelRun.acknowledged : t.cancelRun.acknowledge}
                    accessibilityState={{ checked: item.acknowledged, disabled }}
                    disabled={disabled}
                    onPress={() => {
                      tapFeedback();
                      onAcknowledge(item.id);
                    }}
                    style={({ pressed }) => ({
                      minHeight: m.touch.listItem,
                      borderRadius: m.radius,
                      borderWidth: m.borderWidth,
                      borderColor: item.acknowledged ? color.primary : color.border,
                      backgroundColor: item.acknowledged || pressed ? color.primaryTint : color.surface,
                      paddingHorizontal: m.space.md,
                      paddingVertical: m.space.sm,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: m.space.md,
                    })}
                    testID={`confirm-item-${index}-acknowledge`}
                  >
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        borderWidth: m.borderWidth,
                        borderColor: item.acknowledged ? color.primary : color.border,
                        backgroundColor: item.acknowledged ? color.primary : color.surface,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {item.acknowledged ? <Glyph name="check" size={20} tint={color.onPrimary} /> : null}
                    </View>
                    <SeniorText weight="semibold" tone={item.acknowledged ? 'onPrimaryTint' : 'text'} style={{ flex: 1 }}>
                      {item.acknowledged ? t.cancelRun.acknowledged : t.cancelRun.acknowledge}
                    </SeniorText>
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}
