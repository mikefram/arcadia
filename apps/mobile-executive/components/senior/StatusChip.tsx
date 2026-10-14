import { View } from 'react-native';
import { Glyph } from './Glyph';
import { SeniorText } from './SeniorText';
import { color, useSenior } from './theme';

export type StatusKind = 'done' | 'late' | 'open';

/**
 * Trạng thái việc: hình kèm chữ, không bao giờ chỉ dùng màu (SPEC 7.3).
 * - Xong: nền xanh nhạt, dấu tích.
 * - Quá hạn: nền nâu đỏ nhạt, dấu cảnh báo, chữ "Quá hạn n ngày". Đỏ nâu chỉ dùng ở đây.
 * - Còn lại (Mới giao, Đang làm…): nền trắng, viền xám, chỉ khác chữ.
 */
export function StatusChip({ kind, label, testID }: { kind: StatusKind; label: string; testID?: string }) {
  const m = useSenior();
  const palette =
    kind === 'done'
      ? { bg: color.primaryTint, border: color.primaryTint, tone: 'onPrimaryTint' as const, tint: color.onPrimaryTint }
      : kind === 'late'
        ? { bg: color.lateBg, border: color.lateBg, tone: 'late' as const, tint: color.lateText }
        : { bg: color.surface, border: color.border, tone: 'text' as const, tint: color.text };
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: m.space.sm,
        paddingHorizontal: m.space.md,
        paddingVertical: m.space.xs + 2,
        borderRadius: m.radius,
        borderWidth: m.borderWidth,
        borderColor: palette.border,
        backgroundColor: palette.bg,
        maxWidth: '100%',
      }}
      testID={testID}
    >
      {kind === 'done' ? <Glyph name="check" size={Math.round(m.font.caption)} tint={palette.tint} /> : null}
      {kind === 'late' ? <Glyph name="alert" size={Math.round(m.font.caption)} tint={palette.tint} /> : null}
      <SeniorText variant="caption" weight="semibold" tone={palette.tone} style={{ flexShrink: 1 }}>
        {label}
      </SeniorText>
    </View>
  );
}
