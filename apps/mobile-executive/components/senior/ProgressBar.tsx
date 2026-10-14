import { View } from 'react-native';
import { SeniorText } from './SeniorText';
import { color, useSenior } from './theme';

/** Thanh tiến độ luôn kèm chữ "4 trên 6 việc đã xong" (SPEC 7.4 M4): thanh chỉ là hình minh hoạ cho chữ. */
export function ProgressBar({ done, total, label, onPrimary = false }: { done: number; total: number; label: string; onPrimary?: boolean }) {
  const m = useSenior();
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: total, now: done }} style={{ gap: m.space.sm }}>
      <View
        style={{
          height: 14,
          borderRadius: 7,
          borderWidth: m.borderWidth,
          borderColor: onPrimary ? color.onPrimary : color.border,
          backgroundColor: color.surface,
          overflow: 'hidden',
        }}
      >
        <View style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', backgroundColor: color.primary }} />
      </View>
      <SeniorText weight="medium" tone={onPrimary ? 'onPrimary' : 'text'}>
        {label}
      </SeniorText>
    </View>
  );
}
