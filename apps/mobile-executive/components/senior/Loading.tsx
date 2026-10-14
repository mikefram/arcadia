import { fmtExecutive, vi } from '@mihato/i18n';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SeniorText } from './SeniorText';
import { color, useSenior } from './theme';

/** Quá mức này thì thêm câu "Xin chờ thêm một chút" (SPEC 7.6). */
export const SLOW_AFTER_MS = 3000;

/** Trạng thái đang tải luôn có chữ; quá 3 giây thêm câu chờ. Không có vòng quay đứng một mình. */
export function LoadingText({ text, address, testID }: { text?: string; address?: string; testID?: string }) {
  const m = useSenior();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View accessible accessibilityRole="text" accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: m.space.md, paddingVertical: m.space.md }} testID={testID ?? 'loading'}>
      <ActivityIndicator color={color.primary} style={{ marginTop: 4 }} />
      <View style={{ flex: 1 }}>
        <SeniorText weight="medium">{text ?? fmtExecutive(vi.executive.status.loading, {}, address)}</SeniorText>
        {slow ? <SeniorText tone="sub">{vi.executive.status.loadingSlow}</SeniorText> : null}
      </View>
    </View>
  );
}
