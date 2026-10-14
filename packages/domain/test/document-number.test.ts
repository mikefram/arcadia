import { describe, expect, it } from 'vitest';
import { formatDocumentNumber, isValidNumberPattern } from '../src/document-number';

/** Mẫu số văn bản (docs/DECISIONS.md, 06/10/2026). */
describe('mẫu số văn bản', () => {
  it('đệm số 0 theo {seq:N}, giữ nguyên phần chữ, ghép năm', () => {
    expect(formatDocumentNumber('{seq:4}', 7, 2026)).toBe('0007');
    expect(formatDocumentNumber('{seq}/VRG-VP', 12, 2026)).toBe('12/VRG-VP');
    expect(formatDocumentNumber('{seq:2}/CT-{yyyy}', 3, 2026)).toBe('03/CT-2026');
    expect(formatDocumentNumber('{seq}/{yy}-VB', 125, 2027)).toBe('125/27-VB');
    expect(formatDocumentNumber('{seq:3}', 12345, 2026)).toBe('12345');
  });

  it('chỉ nhận mẫu có {seq} và các dấu hiệu đã biết', () => {
    for (const ok of ['{seq}', '{seq:4}', '{seq}/{yyyy}-VP', 'VB-{seq:3}']) expect(isValidNumberPattern(ok), ok).toBe(true);
    for (const bad of ['', 'khong-co-so', '{yyyy}', '{seq}/{lạ}', '{seq', '}{seq}', `{seq}${'x'.repeat(100)}`]) expect(isValidNumberPattern(bad), bad).toBe(false);
  });
});
