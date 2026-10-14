import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { pickDuplexAudio } from './native-core';
import type { DuplexAudioNative } from './types';

let cached: DuplexAudioNative | null | undefined;

/** Mô-đun âm thanh một engine có khử vọng; `null` khi bản dựng không có (Expo Go, web, Android). */
export function duplexAudio(): DuplexAudioNative | null {
  if (cached === undefined) cached = pickDuplexAudio(Platform.OS, () => requireOptionalNativeModule<DuplexAudioNative>('DuplexAudio'));
  return cached;
}

export function duplexAvailable(): boolean {
  return duplexAudio() !== null;
}
