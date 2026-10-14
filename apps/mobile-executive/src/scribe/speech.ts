import { speechRate as SPEECH_RATE } from '@mihato/ui-tokens';
import * as Speech from 'expo-speech';

export type SpeechRateName = keyof typeof SPEECH_RATE;

/** Chờ giọng của máy tối đa từng này cho mỗi ký tự, cộng một khoảng đệm: quá thì coi như đọc xong (không treo màn hình). */
const MS_PER_CHAR = 140;
const BASE_MS = 6000;

let current = 0;

/**
 * Đọc bằng giọng của hệ điều hành (SPEC 6.11): dùng khi TTS của máy chủ lỗi, khi bản tin sáng không có tệp âm thanh,
 * và cho câu "xin chờ" dựng sẵn. Trả true khi đọc xong, false khi máy không đọc được hoặc bị dừng.
 */
export function speakWithDevice(text: string, rate: SpeechRateName = 'normal'): Promise<boolean> {
  const content = text.trim();
  if (!content) return Promise.resolve(false);
  const id = ++current;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), BASE_MS + content.length * MS_PER_CHAR);
    try {
      Speech.speak(content, {
        language: 'vi-VN',
        // expo-speech: 1.0 là tốc độ thường. Mặc định của app là 0.9 (SPEC 6.4) để người lớn tuổi dễ nghe.
        rate: SPEECH_RATE[rate],
        onDone: () => finish(id === current),
        onStopped: () => finish(false),
        onError: () => finish(false),
      });
    } catch {
      finish(false);
    }
  });
}

export function stopDeviceSpeech(): void {
  current++;
  void Speech.stop().catch(() => undefined);
}
