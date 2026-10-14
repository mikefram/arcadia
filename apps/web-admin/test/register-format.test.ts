import { describe, expect, it } from 'vitest';
import { formatRegisterValue, tableMinWidth, yearOptions } from '../src/features/documents/register-format';

describe('chữ hiện ở ô của dòng sổ', () => {
  it('không có giá trị thì null', () => {
    for (const v of [null, undefined, '', '   ', [], [null, ''], {}, { id: 3 }]) expect(formatRegisterValue(v), JSON.stringify(v)).toBeNull();
  });

  it('chữ giữ nguyên, bỏ khoảng trắng hai đầu', () => {
    expect(formatRegisterValue('  Sở Công Thương ')).toBe('Sở Công Thương');
    expect(formatRegisterValue('12/2026/QĐ-UBND')).toBe('12/2026/QĐ-UBND');
  });

  it('số: dấu chấm ngăn nghìn, dấu phẩy thập phân', () => {
    expect(formatRegisterValue(0)).toBe('0');
    expect(formatRegisterValue(950)).toBe('950');
    expect(formatRegisterValue(20_000_000)).toBe('20.000.000');
    expect(formatRegisterValue(-1_500)).toBe('-1.500');
    expect(formatRegisterValue(1234.5)).toBe('1.234,5');
    expect(formatRegisterValue(Number.NaN)).toBeNull();
    expect(formatRegisterValue(12_000_000_000n)).toBe('12.000.000.000');
  });

  it('đúng/sai thành Có/Không', () => {
    expect(formatRegisterValue(true)).toBe('Có');
    expect(formatRegisterValue(false)).toBe('Không');
  });

  it('ngày không kèm giờ đổi chữ, không lệch múi giờ', () => {
    expect(formatRegisterValue('2026-10-06')).toBe('06/10/2026');
    expect(formatRegisterValue('2026-01-01')).toBe('01/01/2026');
  });

  it('thời điểm có giờ hiện theo giờ Việt Nam; đúng nửa đêm chỉ hiện ngày', () => {
    expect(formatRegisterValue('2026-10-06T03:30:00.000Z')).toBe('06/10/2026 10:30');
    expect(formatRegisterValue('2026-10-05T17:00:00.000Z')).toBe('06/10/2026');
  });

  it('chuỗi trông giống ngày nhưng không phải thì giữ nguyên', () => {
    expect(formatRegisterValue('2026-10-06 Khẩn')).toBe('2026-10-06 Khẩn');
    expect(formatRegisterValue('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z');
  });

  it('danh sách nối bằng dấu phẩy, bỏ phần tử rỗng', () => {
    expect(formatRegisterValue(['A', '', 'B', null])).toBe('A, B');
    expect(formatRegisterValue([{ fullName: 'Nguyễn Thu Lan' }, { name: 'Phương' }])).toBe('Nguyễn Thu Lan, Phương');
  });

  it('đối tượng lấy chữ đầu tiên có: họ tên, tên, nhãn, tiêu đề, tên tệp; không đổ JSON', () => {
    expect(formatRegisterValue({ fullName: 'Lê Văn Huy', name: 'x' })).toBe('Lê Văn Huy');
    expect(formatRegisterValue({ label: 'Khẩn' })).toBe('Khẩn');
    expect(formatRegisterValue({ fileName: 'cong-van.pdf', size: 10 })).toBe('cong-van.pdf');
    expect(formatRegisterValue({ secret: 'x' })).toBeNull();
  });
});

describe('năm ở bộ lọc', () => {
  it('năm hiện tại rồi lùi dần', () => {
    expect(yearOptions(Date.UTC(2026, 9, 6))).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
    expect(yearOptions(Date.UTC(2026, 9, 6), 2)).toEqual([2026, 2025]);
  });

  it('tính năm theo giờ Việt Nam: 20h UTC ngày 31/12 đã là 1/1 năm sau', () => {
    expect(yearOptions(Date.UTC(2026, 11, 31, 20, 0), 1)).toEqual([2027]);
    expect(yearOptions(Date.UTC(2026, 11, 31, 16, 0), 1)).toEqual([2026]);
  });
});

describe('độ rộng tối thiểu của bảng', () => {
  it('rộng dần theo số cột thêm và không lùi', () => {
    const widths = Array.from({ length: 13 }, (_, n) => Number(/\[(\d+)px\]/.exec(tableMinWidth(n))?.[1]));
    for (let i = 1; i < widths.length; i += 1) expect(widths[i], `${i} cột`).toBeGreaterThanOrEqual(widths[i - 1] ?? 0);
    expect(tableMinWidth(0)).toBe('min-w-[860px]');
    expect(tableMinWidth(-1)).toBe('min-w-[860px]');
  });
});
