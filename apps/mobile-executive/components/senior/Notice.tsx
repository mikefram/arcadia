import type { ReactNode } from 'react';
import { View } from 'react-native';
import { SeniorText } from './SeniorText';
import { color, useSenior } from './theme';

/**
 * Khối báo tin nằm yên trong màn hình (không tự biến mất, SPEC 7.2 điều 5): lỗi nhận về phía hệ thống,
 * đang mất mạng, đang ủy quyền. Dùng sắc vàng đồng; KHÔNG dùng đỏ nâu vì đỏ nâu chỉ dành cho việc quá hạn.
 */
export function Notice({ title, children, tone = 'gold', live = false, testID }: { title?: string; children?: ReactNode; tone?: 'gold' | 'plain'; live?: boolean; testID?: string }) {
  const m = useSenior();
  return (
    <View
      accessible
      accessibilityRole={live ? 'alert' : 'text'}
      accessibilityLiveRegion={live ? 'assertive' : 'none'}
      style={{
        flexDirection: 'row',
        borderRadius: m.radius,
        borderWidth: m.borderWidth,
        borderColor: tone === 'gold' ? color.gold : color.hairline,
        backgroundColor: tone === 'gold' ? color.goldTint : color.surface,
        overflow: 'hidden',
      }}
      testID={testID}
    >
      <View style={{ width: 6, backgroundColor: color.gold }} />
      <View style={{ flex: 1, padding: m.space.cardPadding - 4, gap: m.space.xs }}>
        {title ? (
          <SeniorText variant="emphasis" weight="bold">
            {title}
          </SeniorText>
        ) : null}
        {typeof children === 'string' ? <SeniorText>{children}</SeniorText> : children}
      </View>
    </View>
  );
}

/** Tiêu đề phụ có vạch vàng đồng bên trái, gợi nét khảm sơn mài. */
export function SectionTitle({ children, testID }: { children: string; testID?: string }) {
  const m = useSenior();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: m.space.md }}>
      <View style={{ width: 4, borderRadius: 2, backgroundColor: color.gold }} />
      <SeniorText variant="cardTitle" accessibilityRole="header" style={{ flex: 1 }} testID={testID}>
        {children}
      </SeniorText>
    </View>
  );
}
