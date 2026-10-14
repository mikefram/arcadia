import { describe, expect, it } from 'vitest';
import { color, contrastPairs, contrastRatio, relativeLuminance } from '../src/index';

/**
 * Tính tự động tỷ lệ tương phản của mọi cặp màu trong `contrastPairs` và so với ngưỡng (SPEC 7.3, 13.7).
 * Chữ thường cần từ 7:1 (WCAG 2.2 mức AAA, tiêu chí 1.4.6); thành phần giao diện cần từ 3:1.
 * Cặp nào không đạt thì test đỏ. KHÔNG tự đổi màu để test xanh (CLAUDE.md luật 8): báo lại cho Mike.
 */

/** In ra đầu ra của test. Gói này không nạp kiểu của Node hay DOM nên khai báo tối thiểu ở đây. */
declare const console: { log: (...args: unknown[]) => void };

const rows = contrastPairs.map((pair) => {
  const ratio = contrastRatio(color[pair.fg], color[pair.bg]);
  return { ...pair, fgHex: color[pair.fg], bgHex: color[pair.bg], ratio, pass: ratio >= pair.min };
});

describe('công thức tương phản WCAG', () => {
  it('đen trên trắng là 21:1, cùng màu là 1:1, không phụ thuộc thứ tự', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1D5B43', '#1D5B43')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
  });
});

describe('độ tương phản của token màu', () => {
  it('in bảng tỷ lệ', () => {
    const header = ['Chữ', 'Nền', 'Tỷ lệ', 'Ngưỡng', 'Kết quả', 'Dùng cho'];
    const body = rows.map((r) => [`${r.fg} ${r.fgHex}`, `${r.bg} ${r.bgHex}`, `${r.ratio.toFixed(2)}:1`, `${r.min}:1`, r.pass ? 'đạt' : 'KHÔNG ĐẠT', r.use]);
    const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ');
    console.log(['', 'Độ tương phản của token màu (WCAG 2.x):', line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line), ''].join('\n'));
    expect(rows.length).toBe(contrastPairs.length);
  });

  it('có cặp để kiểm, và mọi màu trong cặp là mã #RRGGBB', () => {
    expect(contrastPairs.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.fgHex, r.fg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(r.bgHex, r.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(Number.isFinite(r.ratio)).toBe(true);
    }
  });

  it.each(rows)('$fg trên $bg ($use) đạt từ $min:1', (r) => {
    expect(r.ratio, `${r.fg} ${r.fgHex} trên ${r.bg} ${r.bgHex}: ${r.ratio.toFixed(2)}:1, cần ${r.min}:1`).toBeGreaterThanOrEqual(r.min);
  });

  it('ngưỡng chữ thường là 7:1 (AAA), thành phần giao diện là 3:1', () => {
    for (const pair of contrastPairs) expect([3, 7]).toContain(pair.min);
  });

  it('tỷ lệ đo được khớp với con số ghi ở SPEC 7.3', () => {
    const measured = (fg: keyof typeof color, bg: keyof typeof color) => Number(contrastRatio(color[fg], color[bg]).toFixed(2));
    expect(measured('text', 'bg')).toBe(15.88);
    expect(measured('textSub', 'bg')).toBe(9.14);
    expect(measured('onPrimary', 'primary')).toBe(7.99);
    expect(measured('primary', 'bg')).toBe(7.41);
    expect(measured('onPrimaryTint', 'primaryTint')).toBe(8.55);
    expect(measured('gold', 'bg')).toBe(7.16);
    expect(measured('lateText', 'bg')).toBe(8.77);
    expect(measured('lateText', 'lateBg')).toBe(8.01);
    expect(measured('warnText', 'warnBg')).toBe(7.82);
    expect(measured('border', 'bg')).toBe(5.25);
  });
});
