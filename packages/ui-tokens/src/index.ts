/**
 * Token giao diện (SPEC 7.3). Hai hồ sơ `senior` và `standard` cùng cấu trúc.
 * Màu đã tính độ tương phản theo WCAG; test trong gói này tính lại tự động.
 * App Chủ tịch: KHÔNG tự đổi các giá trị senior (CLAUDE.md luật 8).
 */
export const color = {
  /** nền ngà */
  bg: '#FAF6EE',
  /** thẻ */
  surface: '#FFFFFF',
  /** nền phụ, hàng xen kẽ */
  surfaceAlt: '#F3EDE0',
  /** chữ chính: 15.88:1 trên nền ngà */
  text: '#1F1B16',
  /** chữ phụ: 9.14:1 trên nền ngà */
  textSub: '#4A423A',
  /** nút chính (chữ trắng), liên kết: 7.99:1 chữ trắng trên nút */
  primary: '#1D5B43',
  primaryPressed: '#174A37',
  onPrimary: '#FFFFFF',
  /** nền thẻ "Xong" */
  primaryTint: '#E1EFE7',
  onPrimaryTint: '#174A37',
  /** tiêu đề phụ, viền nhấn: sắc vàng đồng gợi sơn mài */
  gold: '#6B4E0E',
  goldTint: '#F4EAD0',
  /** CHỈ cho việc quá hạn */
  lateText: '#7A2E05',
  lateBg: '#FBE9DC',
  /** việc đến hạn hôm nay */
  warnText: '#664200',
  warnBg: '#FCEFC9',
  /** viền nút, thẻ: 5.25:1 */
  border: '#6F6657',
  /** đường kẻ mảnh trong bảng (không phải thành phần tương tác) */
  hairline: '#DDD5C5',
  /** lớp phủ khi mở hộp thoại */
  scrim: 'rgba(31, 27, 22, 0.45)',
} as const;
export type ColorToken = keyof typeof color;

/** Cặp (chữ, nền) phải đạt ngưỡng tương phản; test tính tự động (SPEC 13.7). */
export const contrastPairs: { fg: ColorToken; bg: ColorToken; min: number; use: string }[] = [
  { fg: 'text', bg: 'bg', min: 7, use: 'chữ chính trên nền ngà' },
  { fg: 'text', bg: 'surface', min: 7, use: 'chữ chính trên thẻ' },
  { fg: 'textSub', bg: 'bg', min: 7, use: 'chữ phụ trên nền ngà' },
  { fg: 'textSub', bg: 'surface', min: 7, use: 'chữ phụ trên thẻ' },
  { fg: 'onPrimary', bg: 'primary', min: 7, use: 'chữ trắng trên nút chính' },
  { fg: 'primary', bg: 'bg', min: 7, use: 'liên kết trên nền ngà' },
  { fg: 'onPrimaryTint', bg: 'primaryTint', min: 7, use: 'chữ trên thẻ Xong' },
  { fg: 'gold', bg: 'bg', min: 7, use: 'tiêu đề phụ trên nền ngà' },
  { fg: 'lateText', bg: 'bg', min: 7, use: 'chữ quá hạn trên nền ngà' },
  { fg: 'lateText', bg: 'lateBg', min: 7, use: 'chữ quá hạn trên nền quá hạn' },
  { fg: 'warnText', bg: 'warnBg', min: 7, use: 'chữ đến hạn hôm nay' },
  { fg: 'border', bg: 'bg', min: 3, use: 'viền thành phần giao diện' },
  { fg: 'border', bg: 'surface', min: 3, use: 'viền thành phần trên thẻ' },
];

export const fontFamily = {
  /** Be Vietnam Pro (OFL): đủ dấu tiếng Việt chồng (ệ, ữ, ặ, ỡ, ẫ, ộ) */
  sans: 'Be Vietnam Pro',
  fallback: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as const;

export type ProfileTokens = {
  font: {
    body: number;
    /** phụ chú tối thiểu */
    caption: number;
    screenTitle: number;
    cardTitle: number;
    button: number;
    /** hệ số giãn dòng; dấu tiếng Việt chồng nhau nên giãn dòng chật sẽ cắt dấu */
    lineHeight: number;
  };
  touch: {
    /** vùng chạm tối thiểu */
    min: number;
    primaryButton: number;
    navBar: number;
    mic: number;
    pinKey: number;
  };
  space: { screen: number; betweenCards: number; betweenButtons: number; cardPadding: number };
  radius: number;
  borderWidth: number;
  /** vẫn tôn trọng cỡ chữ hệ thống, tới 200% */
  maxFontSizeMultiplier: number;
};

export const profiles: Record<'senior' | 'standard', ProfileTokens> = {
  senior: {
    font: { body: 20, caption: 18, screenTitle: 30, cardTitle: 24, button: 22, lineHeight: 1.5 },
    touch: { min: 56, primaryButton: 64, navBar: 64, mic: 96, pinKey: 72 },
    space: { screen: 24, betweenCards: 16, betweenButtons: 16, cardPadding: 20 },
    radius: 16,
    borderWidth: 2,
    maxFontSizeMultiplier: 2,
  },
  standard: {
    font: { body: 16, caption: 14, screenTitle: 22, cardTitle: 18, button: 16, lineHeight: 1.5 },
    touch: { min: 48, primaryButton: 48, navBar: 56, mic: 72, pinKey: 64 },
    space: { screen: 16, betweenCards: 12, betweenButtons: 12, cardPadding: 16 },
    radius: 12,
    borderWidth: 1,
    maxFontSizeMultiplier: 2,
  },
};

/** Ba nút cỡ chữ của người dùng: Lớn, Rất lớn, Cực lớn (không dùng thanh trượt). */
export const fontScale = { large: 1, xlarge: 1.15, xxlarge: 1.3 } as const;
export type FontScale = keyof typeof fontScale;

/** Tốc độ đọc của TTS: Chậm, Vừa, Nhanh. Mặc định 0.9 (SPEC 6.4). */
export const speechRate = { slow: 0.8, normal: 0.9, fast: 1.05 } as const;

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Độ sáng tương đối theo WCAG 2.x. Chỉ nhận mã #RRGGBB. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** Tỷ lệ tương phản theo WCAG giữa hai màu #RRGGBB. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
