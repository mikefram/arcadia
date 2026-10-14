import { Text, TextInput, type TextInputProps, type TextProps } from 'react-native';
import { DEFAULT_WEIGHT, color, fontStyle, profile, textSize, type FontWeightName, type TextVariant } from './theme';

type Tone = 'text' | 'sub' | 'primary' | 'gold' | 'late' | 'warn' | 'onPrimary' | 'onPrimaryTint';

const TONE: Record<Tone, string> = {
  text: color.text,
  sub: color.textSub,
  primary: color.primary,
  gold: color.gold,
  late: color.lateText,
  warn: color.warnText,
  onPrimary: color.onPrimary,
  onPrimaryTint: color.onPrimaryTint,
};

export type AppTextProps = TextProps & {
  variant?: TextVariant;
  weight?: FontWeightName;
  tone?: Tone;
};

/**
 * Chữ của app: theo cỡ chữ hệ thống tới 200% (maxFontSizeMultiplier 2, SPEC 7.3), giãn dòng 1.5.
 * Mọi chữ trên màn hình đi qua thành phần này để không chỗ nào bị cắt dấu hay bỏ qua cỡ chữ hệ thống.
 */
export function AppText({ variant = 'body', weight, tone = 'text', style, ...rest }: AppTextProps) {
  return (
    <Text
      maxFontSizeMultiplier={profile.maxFontSizeMultiplier}
      {...rest}
      style={[textSize(variant), fontStyle(weight ?? DEFAULT_WEIGHT[variant]), { color: TONE[tone] }, style]}
    />
  );
}

export function AppTextInput({ style, ...rest }: TextInputProps) {
  return (
    <TextInput
      maxFontSizeMultiplier={profile.maxFontSizeMultiplier}
      // `border` (#6F6657) đạt 5.25:1 trên nền trắng: nhạt hơn chữ thật nhưng vẫn đọc được (mức AA).
      placeholderTextColor={color.border}
      {...rest}
      style={[textSize('body'), fontStyle('regular'), { color: color.text }, style]}
    />
  );
}
