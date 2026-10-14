import { fontScale as FONT_SCALE, profiles, type FontScale, type ProfileTokens } from '@mihato/ui-tokens';

/**
 * Số đo của thư viện thành phần senior (SPEC 7.3, 7.8). Tệp này thuần TypeScript, không nạp React Native,
 * để test Vitest đọc được: mọi vùng chạm lấy từ `@mihato/ui-tokens`, KHÔNG viết số trực tiếp ở thành phần
 * (CLAUDE.md luật 8: chữ thân 20sp, vùng chạm từ 56dp, micro 96dp).
 */
export type ProfileName = 'senior' | 'standard';

export type TextVariant = 'body' | 'caption' | 'screenTitle' | 'cardTitle' | 'button' | 'emphasis' | 'heard' | 'pinDigit';

export type SeniorMetrics = {
  profile: ProfileName;
  tokens: ProfileTokens;
  /** hệ số cỡ chữ người dùng chọn: Lớn 1, Rất lớn 1.15, Cực lớn 1.3 */
  scale: number;
  /** cỡ chữ đã nhân hệ số người dùng chọn (chưa nhân cỡ chữ hệ thống: Text tự nhân, tới 200%) */
  font: Record<TextVariant, number>;
  /** vùng chạm tối thiểu của từng loại thành phần, tính bằng dp; không co theo cỡ chữ */
  touch: {
    min: number;
    primaryButton: number;
    secondaryButton: number;
    headerButton: number;
    navBar: number;
    mic: number;
    pinKey: number;
    choice: number;
    card: number;
    listItem: number;
    input: number;
  };
  space: ProfileTokens['space'] & { xs: number; sm: number; md: number };
  radius: number;
  borderWidth: number;
  maxFontSizeMultiplier: number;
};

/** Giãn dòng (từ 1.5): dấu tiếng Việt chồng nhau nên giãn dòng chật sẽ cắt dấu. */
export function lineHeightFor(fontSize: number, tokens: ProfileTokens): number {
  return Math.ceil(fontSize * tokens.font.lineHeight);
}

export function metricsFor(profile: ProfileName, scaleName: FontScale = 'large'): SeniorMetrics {
  const tokens = profiles[profile];
  const scale = FONT_SCALE[scaleName];
  const size = (base: number) => Math.round(base * scale * 10) / 10;
  return {
    profile,
    tokens,
    scale,
    font: {
      body: size(tokens.font.body),
      caption: size(tokens.font.caption),
      screenTitle: size(tokens.font.screenTitle),
      cardTitle: size(tokens.font.cardTitle),
      button: size(tokens.font.button),
      emphasis: size(tokens.font.body),
      // chữ trợ lý nghe được và số của bàn phím PIN: cỡ tiêu đề thẻ và tiêu đề màn hình
      heard: size(tokens.font.cardTitle),
      pinDigit: size(tokens.font.screenTitle),
    },
    touch: {
      min: tokens.touch.min,
      primaryButton: tokens.touch.primaryButton,
      // nút phụ (viền) cao bằng nút chính để hai nút xếp chồng trông cân
      secondaryButton: tokens.touch.primaryButton,
      headerButton: tokens.touch.min,
      navBar: tokens.touch.navBar,
      mic: tokens.touch.mic,
      pinKey: tokens.touch.pinKey,
      choice: tokens.touch.min,
      card: tokens.touch.primaryButton,
      listItem: tokens.touch.min,
      input: tokens.touch.primaryButton,
    },
    space: { ...tokens.space, xs: 4, sm: 8, md: 12 },
    radius: tokens.radius,
    borderWidth: tokens.borderWidth,
    maxFontSizeMultiplier: tokens.maxFontSizeMultiplier,
  };
}

export const FONT_SCALE_NAMES: readonly FontScale[] = ['large', 'xlarge', 'xxlarge'];

/**
 * Đầu trang + chân màn hình + thanh đáy chiếm quá tỉ lệ này của chiều cao màn hình thì vùng nội dung gần như không còn
 * (máy nhỏ, cỡ chữ Cực lớn và chữ hệ thống 200%: đã đo thấy vùng cuộn cao 0). Khi đó nút chính nằm cuối nội dung
 * thay vì dính đáy, để đọc được nội dung.
 */
export const CROWDED_RATIO = 0.6;

export function chromeIsCrowded(chrome: { header: number; footer: number; nav: number }, windowHeight: number): boolean {
  return windowHeight > 0 && chrome.header + chrome.footer + chrome.nav > windowHeight * CROWDED_RATIO;
}
