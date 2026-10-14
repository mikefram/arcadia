import { View } from 'react-native';
import { color } from './theme';

/** Hình dáng cố định của sóng: giữa cao, hai bên thấp dần, để trông như sóng âm chứ không như cột đo. */
const SHAPE = [0.35, 0.5, 0.65, 0.8, 0.92, 1, 0.92, 0.8, 0.65, 0.5, 0.35] as const;
const BAR_WIDTH = 8;
const BAR_GAP = 8;
const MIN_HEIGHT = 8;
const MAX_HEIGHT = 56;

export type VoiceMeterProps = {
  /** mức âm 0..1 của micro */
  level: number;
  /** micro đang mở: nếu không thì thanh nằm yên, mờ */
  active: boolean;
  testID?: string;
};

/**
 * Thanh mức âm lúc trò chuyện: cho người dùng thấy máy đang nghe thấy mình (nói thì thanh dâng lên, im thì nằm phẳng).
 * Chỉ là phần phụ: trạng thái "Trợ lý đang nghe" luôn có chữ riêng (SPEC 7.2 điều 4), nên thanh ẩn với trình đọc màn hình.
 * Không có chuyển động tự chạy: thanh chỉ đổi theo tiếng thật, mỗi lần đổi là một lần vẽ lại.
 */
export function VoiceMeter({ level, active, testID }: VoiceMeterProps) {
  const lit = active && level > 0;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: MAX_HEIGHT, gap: BAR_GAP }}
      testID={testID}
    >
      {SHAPE.map((weight, i) => (
        <View
          key={i}
          style={{
            width: BAR_WIDTH,
            borderRadius: BAR_WIDTH / 2,
            height: MIN_HEIGHT + (active ? Math.max(0, Math.min(1, level)) * weight * (MAX_HEIGHT - MIN_HEIGHT) : 0),
            backgroundColor: lit ? color.primary : color.hairline,
          }}
        />
      ))}
    </View>
  );
}
