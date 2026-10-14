import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { color, fontFamily } from '@mihato/ui-tokens';
import { toCsv } from '../src/lib/csv';

/** Tên biến trong @theme của styles.css ↔ token trong @mihato/ui-tokens. Giá trị phải trùng từng ký tự. */
const MAP: Record<string, keyof typeof color> = {
  canvas: 'bg',
  surface: 'surface',
  'surface-alt': 'surfaceAlt',
  ink: 'text',
  'ink-sub': 'textSub',
  primary: 'primary',
  'primary-pressed': 'primaryPressed',
  'on-primary': 'onPrimary',
  'primary-tint': 'primaryTint',
  'on-primary-tint': 'onPrimaryTint',
  gold: 'gold',
  'gold-tint': 'goldTint',
  late: 'lateText',
  'late-bg': 'lateBg',
  warn: 'warnText',
  'warn-bg': 'warnBg',
  line: 'border',
  hairline: 'hairline',
  scrim: 'scrim',
};

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

function cssVar(name: string): string | undefined {
  return new RegExp(`--color-${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

describe('token màu của web quản trị', () => {
  it.each(Object.entries(MAP))('--color-%s lấy đúng giá trị của ui-tokens.%s', (name, token) => {
    expect(cssVar(name)?.toLowerCase()).toBe(color[token].toLowerCase());
  });

  it('dùng phông Be Vietnam Pro', () => {
    expect(css).toContain(`'${fontFamily.sans}'`);
  });
});

describe('xuất CSV (SPEC 9.8)', () => {
  it('có BOM, thoát dấu phẩy, nháy kép và xuống dòng, giữ dấu tiếng Việt', () => {
    const csv = toCsv(
      [{ name: 'Nguyễn Thu Lan', note: 'Đặt xe, "gấp"\ndòng hai', n: 3 }],
      [
        { header: 'Người nhận', value: (r) => r.name },
        { header: 'Ghi chú', value: (r) => r.note },
        { header: 'Trễ', value: (r) => r.n },
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('Người nhận,Ghi chú,Trễ\r\nNguyễn Thu Lan,"Đặt xe, ""gấp""\ndòng hai",3\r\n');
  });

  it('không để Excel hiểu ô chữ là công thức', () => {
    const csv = toCsv([{ v: '=1+1' }], [{ header: 'x', value: (r) => r.v }]);
    expect(csv.slice(1)).toBe("x\r\n'=1+1\r\n");
  });
});
