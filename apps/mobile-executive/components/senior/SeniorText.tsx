import { Text, type TextProps } from 'react-native';
import { lineHeightFor, type TextVariant } from './metrics';
import { color, fontStyle, useSenior, webFontScale, type FontWeightName } from './theme';

export type TextTone = 'text' | 'sub' | 'primary' | 'gold' | 'late' | 'warn' | 'onPrimary' | 'onPrimaryTint';

const TONE: Record<TextTone, string> = {
  text: color.text,
  sub: color.textSub,
  primary: color.primary,
  gold: color.gold,
  late: color.lateText,
  warn: color.warnText,
  onPrimary: color.onPrimary,
  onPrimaryTint: color.onPrimaryTint,
};

const DEFAULT_WEIGHT: Record<TextVariant, FontWeightName> = {
  body: 'regular',
  caption: 'regular',
  screenTitle: 'bold',
  cardTitle: 'bold',
  button: 'bold',
  emphasis: 'semibold',
  heard: 'medium',
  pinDigit: 'medium',
};

export type SeniorTextProps = TextProps & {
  variant?: TextVariant;
  weight?: FontWeightName;
  tone?: TextTone;
  center?: boolean;
};

/**
 * Chữ của app Chủ tịch (SPEC 7.3): phông Be Vietnam Pro nạp qua expo-font, giãn dòng từ 1.5 để không cắt dấu
 * tiếng Việt chồng (ệ, ữ, ặ, ỡ, ẫ, ộ), theo cỡ chữ hệ thống tới 200% (`maxFontSizeMultiplier` 2), và nhân hệ số
 * cỡ chữ người dùng chọn (Lớn, Rất lớn, Cực lớn từ `me.prefs.fontScale`).
 * Mọi chữ trên màn hình đi qua thành phần này.
 */
export function SeniorText({ variant = 'body', weight, tone = 'text', center = false, style, ...rest }: SeniorTextProps) {
  const m = useSenior();
  // Có phần tử đặt trần riêng (nhãn thanh đáy) thì bản web cũng theo trần đó, như `maxFontSizeMultiplier` trên máy thật.
  const size = m.font[variant] * webFontScale(rest.maxFontSizeMultiplier ?? m.maxFontSizeMultiplier);
  return (
    <Text
      maxFontSizeMultiplier={m.maxFontSizeMultiplier}
      {...rest}
      style={[
        { fontSize: size, lineHeight: lineHeightFor(size, m.tokens), color: TONE[tone] },
        fontStyle(weight ?? DEFAULT_WEIGHT[variant]),
        center && { textAlign: 'center' },
        style,
      ]}
    />
  );
}
