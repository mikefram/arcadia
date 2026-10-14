import { color, profiles } from '@mihato/ui-tokens';

/**
 * Giao diện hồ sơ `standard` (SPEC 7.3, 8.1): chữ thân từ 16sp, vùng chạm từ 48dp, giãn dòng 1.5.
 * Mọi màu lấy từ @mihato/ui-tokens. Đỏ nâu (`lateText`, `lateBg`) CHỈ dùng cho việc quá hạn.
 */
export const profile = profiles.standard;
export { color };

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

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

export type TextVariant = 'body' | 'caption' | 'screenTitle' | 'cardTitle' | 'button' | 'heading';

const SIZE: Record<TextVariant, number> = {
  body: profile.font.body,
  caption: profile.font.caption,
  screenTitle: profile.font.screenTitle,
  cardTitle: profile.font.cardTitle,
  button: profile.font.button,
  heading: profile.font.body,
};

export const DEFAULT_WEIGHT: Record<TextVariant, FontWeightName> = {
  body: 'regular',
  caption: 'regular',
  screenTitle: 'bold',
  cardTitle: 'semibold',
  button: 'semibold',
  heading: 'semibold',
};

/** Cỡ chữ và giãn dòng (1.5: dấu tiếng Việt chồng nhau nên giãn dòng chật sẽ cắt dấu). */
export function textSize(variant: TextVariant): { fontSize: number; lineHeight: number } {
  const fontSize = SIZE[variant];
  return { fontSize, lineHeight: Math.round(fontSize * profile.font.lineHeight) };
}
