import type { DuplexAudioNative } from './types';

/**
 * Chọn mô-đun gốc theo nền tảng. Tách khỏi native.ts (nạp React Native) để test được bằng Node.
 * Hôm nay chỉ iOS có mô-đun; Android, web nhận `null`. Nạp lỗi cũng là `null`: không có mô-đun thì app đi đường cũ, không báo lỗi lạ.
 */
export function pickDuplexAudio(os: string, load: () => DuplexAudioNative | null | undefined): DuplexAudioNative | null {
  if (os !== 'ios') return null;
  try {
    return load() ?? null;
  } catch {
    return null;
  }
}
