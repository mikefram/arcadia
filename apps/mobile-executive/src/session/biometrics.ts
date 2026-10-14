import { fmtExecutive, vi } from '@mihato/i18n';
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
export async function promptBiometrics(address: string, message?: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: message ?? fmtExecutive(vi.executive.unlock.biometricPrompt, {}, address),
      cancelLabel: vi.executive.unlock.confirmSkip,
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
