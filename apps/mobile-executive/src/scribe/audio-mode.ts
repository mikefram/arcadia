import { setAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';

/**
 * Chế độ âm thanh để trợ lý đọc được câu trả lời: phát cả khi gạt nút im lặng (người dùng vừa bấm nói và đang chờ
 * nghe), và hạ nhỏ nhạc của app khác thay vì tắt hẳn.
 *
 * Luồng thu của expo-audio (`AudioStream`) đặt phiên âm thanh iOS ở chế độ chỉ thu và không trả lại khi dừng; không đặt
 * lại thì câu trả lời phát ra mà loa im. Vì vậy hàm này chạy khi mở app và ngay sau mỗi lần thu xong.
 */
export async function configurePlaybackAudioMode(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      allowsRecording: false,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch {
    // Không đặt được thì phát theo chế độ mặc định của máy; không chặn việc dùng app.
  }
}
