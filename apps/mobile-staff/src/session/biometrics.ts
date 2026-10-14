import { vi } from '@mihato/i18n';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

/** Máy có vân tay hoặc khuôn mặt đã đăng ký hay không. Bản web và máy không hỗ trợ thì trả false. */
export async function biometricsAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

/**
 * Hỏi sinh trắc học của hệ điều hành. Không cho rơi về mật mã của máy (`disableDeviceFallback`):
 * không dùng được sinh trắc học thì người dùng nhập PIN của app.
 */
export async function promptBiometrics(message: string = vi.staff.lock.biometricPrompt): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: message,
      cancelLabel: vi.staff.lock.usePin,
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
