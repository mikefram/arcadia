import { createAudioPlayer } from 'expo-audio';

/**
 * Âm "tinh" khi gửi xong (SPEC 7.6), tắt được trong Cài đặt (`me.prefs.sendSound`).
 * Tệp `assets/tinh.wav` do script tạo ra (hai sóng sin tắt dần), không lấy từ nguồn ngoài.
 */
export function playSentSound(enabled: boolean): void {
  if (!enabled) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const player = createAudioPlayer(require('../../assets/tinh.wav') as number);
    player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish || status.error) {
        try {
          player.remove();
        } catch {}
      }
    });
    player.play();
  } catch {
    // Không phát được âm báo thì bỏ qua: kết quả vẫn hiện bằng chữ trên màn hình.
  }
}
