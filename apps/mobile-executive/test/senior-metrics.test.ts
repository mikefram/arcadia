import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fontScale, profiles } from '@mihato/ui-tokens';
import { describe, expect, it } from 'vitest';
import { CROWDED_RATIO, FONT_SCALE_NAMES, chromeIsCrowded, lineHeightFor, metricsFor } from '../components/senior/metrics';

/**
 * Số đo của thư viện thành phần senior (SPEC 7.3, 13.7; CLAUDE.md luật 8): mọi vùng chạm đọc từ token, từ 56dp;
 * nút chính 64dp; micro 96dp; phím PIN từ 72dp; không có chữ dưới 18sp ở bất kỳ mức cỡ chữ nào.
 */
describe('hồ sơ senior', () => {
  const senior = metricsFor('senior', 'large');

  it('mọi kích thước chạm từ 56dp trở lên', () => {
    const entries = Object.entries(senior.touch);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [name, size] of entries) expect(size, `touch.${name}`).toBeGreaterThanOrEqual(56);
  });

  it('nút chính 64dp, micro 96dp, phím PIN từ 72dp, thanh điều hướng 64dp', () => {
    expect(senior.touch.primaryButton).toBe(64);
    expect(senior.touch.mic).toBe(96);
    expect(senior.touch.pinKey).toBeGreaterThanOrEqual(72);
    expect(senior.touch.navBar).toBe(64);
  });

  it('số đo lấy thẳng từ @mihato/ui-tokens, không viết số riêng', () => {
    const t = profiles.senior.touch;
    expect(senior.touch).toMatchObject({ min: t.min, primaryButton: t.primaryButton, navBar: t.navBar, mic: t.mic, pinKey: t.pinKey });
    expect(senior.space).toMatchObject(profiles.senior.space);
    expect(senior.radius).toBe(profiles.senior.radius);
    expect(senior.borderWidth).toBe(profiles.senior.borderWidth);
  });

  it('chữ thân 20sp, phụ chú 18sp, tiêu đề màn hình 30sp, tiêu đề thẻ 24sp, chữ nút 22sp', () => {
    expect(senior.font).toMatchObject({ body: 20, caption: 18, screenTitle: 30, cardTitle: 24, button: 22 });
  });

  it('không có chữ dưới 18sp ở cả ba mức Lớn, Rất lớn, Cực lớn; mức lớn hơn thì chữ lớn hơn', () => {
    let previous = 0;
    for (const scale of FONT_SCALE_NAMES) {
      const m = metricsFor('senior', scale);
      for (const [name, size] of Object.entries(m.font)) expect(size, `${scale}.${name}`).toBeGreaterThanOrEqual(18);
      expect(m.font.body).toBeGreaterThan(previous);
      previous = m.font.body;
      expect(m.scale).toBe(fontScale[scale]);
      // Vùng chạm không co giãn theo cỡ chữ: luôn đủ lớn.
      expect(m.touch).toEqual(senior.touch);
    }
    expect(metricsFor('senior', 'xxlarge').font.body).toBe(26);
  });

  it('giãn dòng từ 1.5 để không cắt dấu tiếng Việt chồng; theo cỡ chữ hệ thống tới 200%', () => {
    expect(senior.tokens.font.lineHeight).toBeGreaterThanOrEqual(1.5);
    for (const size of [18, 20, 22, 24, 26, 30, 39]) expect(lineHeightFor(size, senior.tokens)).toBeGreaterThanOrEqual(size * 1.5);
    expect(senior.maxFontSizeMultiplier).toBe(2);
  });

  it('khoảng cách: lề 24dp, giữa hai thẻ 16dp, giữa hai nút từ 16dp, góc bo 16dp, viền 2dp', () => {
    expect(senior.space.screen).toBe(24);
    expect(senior.space.betweenCards).toBe(16);
    expect(senior.space.betweenButtons).toBeGreaterThanOrEqual(16);
    expect(senior.radius).toBe(16);
    expect(senior.borderWidth).toBe(2);
  });
});

describe('hồ sơ standard (Giám đốc, Phó giám đốc mặc định) dùng cùng thành phần', () => {
  it('cùng cấu trúc số đo, lấy từ profiles.standard', () => {
    const standard = metricsFor('standard', 'large');
    const senior = metricsFor('senior', 'large');
    expect(Object.keys(standard.touch)).toEqual(Object.keys(senior.touch));
    expect(Object.keys(standard.font)).toEqual(Object.keys(senior.font));
    expect(standard.touch.min).toBe(profiles.standard.touch.min);
    expect(standard.touch.mic).toBe(profiles.standard.touch.mic);
    expect(standard.font.body).toBe(profiles.standard.font.body);
  });
});

describe('thành phần senior không viết cứng kích thước chạm', () => {
  const dir = fileURLToPath(new URL('../components/senior/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));

  it('mỗi nút (Pressable) lấy chiều cao tối thiểu từ token `m.touch.*`', () => {
    const withPressable = files.filter((f) => /<Pressable\b/.test(readFileSync(dir + f, 'utf8')));
    expect(withPressable.sort()).toEqual(['BigMic.tsx', 'ChoiceGroup.tsx', 'ConfirmList.tsx', 'PinPad.tsx', 'ScreenFrame.tsx', 'SeniorButton.tsx', 'SeniorCard.tsx']);
    for (const file of withPressable) {
      const text = readFileSync(dir + file, 'utf8');
      const pressables = text.match(/<Pressable\b/g)?.length ?? 0;
      const tokens = text.match(/m\.touch\.\w+/g)?.length ?? 0;
      expect(tokens, `${file}: ${pressables} nút nhưng chỉ ${tokens} lần dùng m.touch`).toBeGreaterThanOrEqual(file === 'PinPad.tsx' ? 1 : pressables);
    }
  });

  it('không tệp nào viết số trực tiếp cho minHeight của vùng chạm', () => {
    for (const file of files) {
      const text = readFileSync(dir + file, 'utf8');
      expect(text, file).not.toMatch(/minHeight:\s*\d/);
    }
  });
});

describe('màn hình chật: nút chính xuống cuối nội dung khi đầu trang, chân và thanh đáy quá lớn', () => {
  it('chữ Lớn trên máy thường: nút chính vẫn dính đáy', () => {
    expect(chromeIsCrowded({ header: 84, footer: 160, nav: 72 }, 844)).toBe(false);
  });

  it('Cực lớn cộng chữ hệ thống 200% trên máy nhỏ (đã đo vùng cuộn cao 0): chuyển nút chính vào cuối nội dung', () => {
    expect(chromeIsCrowded({ header: 230, footer: 330, nav: 180 }, 740)).toBe(true);
    // đúng ranh giới: 60% chiều cao
    expect(chromeIsCrowded({ header: 100, footer: 200, nav: 144 }, 740)).toBe(444 > 740 * CROWDED_RATIO);
  });

  it('chưa đo được chiều cao thì không coi là chật', () => {
    expect(chromeIsCrowded({ header: 0, footer: 0, nav: 0 }, 844)).toBe(false);
    expect(chromeIsCrowded({ header: 300, footer: 300, nav: 300 }, 0)).toBe(false);
  });
});
