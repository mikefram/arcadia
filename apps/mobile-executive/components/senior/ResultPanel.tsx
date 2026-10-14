import { vi } from '@mihato/i18n';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Glyph } from './Glyph';
import { SeniorButton } from './SeniorButton';
import { SeniorText } from './SeniorText';
import { color, useSenior } from './theme';

export type ResultPanelProps = {
  /** done: việc đã xong (dấu tích, nền xanh nhạt). info: báo tin, lỗi nhận về phía hệ thống (sắc vàng đồng). */
  tone?: 'done' | 'info';
  title: string;
  body?: string;
  children?: ReactNode;
  /** Kết quả nằm yên tới khi bấm nút này (SPEC 7.2 điều 5). KHÔNG có hẹn giờ tự đóng. */
  onUnderstood: () => void;
  understoodLabel?: string;
  /** nút phụ (viền), ví dụ "Thử lại" hoặc "Xem việc tiếp theo" */
  secondary?: { label: string; onPress: () => void; testID?: string };
  testID?: string;
};

/**
 * Bảng kết quả: thay cho toast. Hiện trong màn hình và ở yên đó tới khi người dùng bấm **Đã rõ**.
 */
export function ResultPanel({ tone = 'done', title, body, children, onUnderstood, understoodLabel, secondary, testID }: ResultPanelProps) {
  const m = useSenior();
  const done = tone === 'done';
  return (
    <View style={{ gap: m.space.betweenCards }} testID={testID ?? 'result-panel'}>
      <View
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        style={{
          borderRadius: m.radius,
          borderWidth: m.borderWidth,
          borderColor: done ? color.onPrimaryTint : color.gold,
          backgroundColor: done ? color.primaryTint : color.goldTint,
          padding: m.space.cardPadding,
          gap: m.space.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: m.space.md }}>
          {done ? (
            <View style={{ marginTop: 4 }}>
              <Glyph name="check" size={Math.round(m.font.cardTitle)} tint={color.onPrimaryTint} />
            </View>
          ) : null}
          <SeniorText variant="cardTitle" tone={done ? 'onPrimaryTint' : 'text'} style={{ flex: 1 }} testID="result-title">
            {title}
          </SeniorText>
        </View>
        {body ? <SeniorText>{body}</SeniorText> : null}
        {children}
      </View>
      <SeniorButton label={understoodLabel ?? vi.executive.nav.understood} onPress={onUnderstood} testID="result-understood" />
      {secondary ? <SeniorButton variant="secondary" label={secondary.label} onPress={secondary.onPress} testID={secondary.testID} /> : null}
    </View>
  );
}
