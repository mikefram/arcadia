import { fmtExecutive, vi } from '@mihato/i18n';
import { View } from 'react-native';
import { SeniorButton } from './SeniorButton';
import { SeniorText } from './SeniorText';
import { color, useSenior } from './theme';

const t = vi.executive.undo;

export type UndoBannerProps = {
  /** số giây còn lại của cửa hoàn tác, tính từ `undoUntil` do máy chủ trả */
  secondsLeft: number;
  /** câu đầu màn: "Đã đồng ý. Sẽ gửi sau 30 giây." */
  title: string;
  address?: string;
};

/**
 * Phần chữ của cửa hoàn tác 30 giây (M3b): câu đã đồng ý và đồng hồ đếm ngược BẰNG CHỮ (SPEC 6.5 điều 8, 7.4).
 * Hai nút nằm ở `UndoActions`, đặt ở chân màn hình để luôn thấy dù chữ lớn bao nhiêu.
 */
export function UndoBanner({ secondsLeft, title, address }: UndoBannerProps) {
  const m = useSenior();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={fmtExecutive(t.a11yCountdown, { n: secondsLeft }, address)}
      style={{
        borderRadius: m.radius,
        borderWidth: m.borderWidth,
        borderColor: color.onPrimaryTint,
        backgroundColor: color.primaryTint,
        padding: m.space.cardPadding,
        gap: m.space.sm,
      }}
      testID="undo-banner"
    >
      <SeniorText variant="cardTitle" tone="onPrimaryTint" testID="undo-title">
        {title}
      </SeniorText>
      <SeniorText variant="screenTitle" tone="onPrimaryTint" testID="undo-countdown">
        {fmtExecutive(t.countdown, { n: secondsLeft })}
      </SeniorText>
    </View>
  );
}

export type UndoActionsProps = {
  onUndo: () => void;
  /** mức 2 không có Gửi ngay (SPEC 6.5 điều 8): bỏ trống */
  onSendNow?: () => void;
  /** đang hoàn tác hoặc đang gửi ngay: khoá hai nút và hiện chữ */
  busy?: 'undo' | 'sendNow' | null;
  address?: string;
};

/** Nút **Hoàn tác** (nút chính) và **Gửi ngay**: cố định ở chân màn hình, không biến mất cho tới khi hết cửa hoàn tác. */
export function UndoActions({ onUndo, onSendNow, busy = null, address }: UndoActionsProps) {
  return (
    <>
      <SeniorButton
        label={t.undo}
        onPress={onUndo}
        disabled={busy !== null}
        busyLabel={busy === 'undo' ? fmtExecutive(t.undoing, {}, address) : null}
        testID="undo-button"
      />
      {onSendNow ? (
        <SeniorButton
          variant="secondary"
          label={t.sendNow}
          onPress={onSendNow}
          disabled={busy !== null}
          busyLabel={busy === 'sendNow' ? fmtExecutive(t.sendingNow, {}, address) : null}
          testID="send-now-button"
        />
      ) : null}
    </>
  );
}
