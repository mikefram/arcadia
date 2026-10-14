import { color, type FontScale } from '@mihato/ui-tokens';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { metricsFor, type ProfileName, type SeniorMetrics } from './metrics';

/**
 * Giao diện của app Chủ tịch (SPEC 7.3): nền ngà, xanh lục đậm, vàng đồng gợi sơn mài làm nhấn.
 * Đỏ nâu (`lateText`, `lateBg`) CHỈ dùng cho việc quá hạn. Mọi màu lấy từ @mihato/ui-tokens.
 * Hồ sơ `senior` và `standard` dùng chung thành phần; số đo lấy từ `metricsFor()`.
 */
export { color };

export type FontWeightName = 'regular' | 'medium' | 'semibold' | 'bold';

/** Tên phông đăng ký với expo-font (mỗi độ đậm một tệp, vì Android không tự dựng độ đậm cho phông tự nạp). */
export const FONT_FILES: Record<FontWeightName, string> = {
  regular: 'BeVietnamPro-Regular',
  medium: 'BeVietnamPro-Medium',
  semibold: 'BeVietnamPro-SemiBold',
  bold: 'BeVietnamPro-Bold',
};

const SYSTEM_WEIGHT: Record<FontWeightName, '400' | '500' | '600' | '700'> = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

let customFontsReady = false;

/** Gọi một lần ở lớp gốc sau khi expo-font nạp xong Be Vietnam Pro. Nạp hỏng thì giữ phông hệ thống. */
export function setCustomFontsReady(ready: boolean): void {
  customFontsReady = ready;
}

/** Kiểu phông cho một độ đậm: Be Vietnam Pro nếu đã nạp, không thì phông hệ thống với fontWeight tương ứng. */
export function fontStyle(weight: FontWeightName): { fontFamily?: string; fontWeight?: '400' | '500' | '600' | '700' } {
  return customFontsReady ? { fontFamily: FONT_FILES[weight] } : { fontWeight: SYSTEM_WEIGHT[weight] };
}

/**
 * Bản web (chỉ để phát triển và kiểm bố cục): React Native Web đặt cỡ chữ bằng px nên không theo cỡ chữ của
 * trình duyệt. Đọc cỡ chữ gốc của trang (mặc định 16px) để chữ lớn theo, tối đa 200% như trên máy thật.
 */
export function webFontScale(max: number): number {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return 1;
  try {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    if (!Number.isFinite(root) || root <= 0) return 1;
    return Math.min(max, Math.max(1, root / 16));
  } catch {
    return 1;
  }
}

const SeniorContext = createContext<SeniorMetrics>(metricsFor('senior', 'large'));

export function SeniorThemeProvider({ profile, fontScale, children }: { profile: ProfileName; fontScale: FontScale; children: ReactNode }) {
  const value = useMemo(() => metricsFor(profile, fontScale), [profile, fontScale]);
  return <SeniorContext.Provider value={value}>{children}</SeniorContext.Provider>;
}

/** Số đo của hồ sơ đang dùng, đã tính cỡ chữ người dùng chọn. */
export function useSenior(): SeniorMetrics {
  return useContext(SeniorContext);
}
