import type { FormField } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { deriveRunTitle, effectiveRunTitle } from '../src/features/runs/derive-title';

const f = (key: string, type: FormField['type'] = 'text'): FormField => ({ key, label: key, type });

describe('tên lượt chạy tự trộn từ trích yếu', () => {
  it('lấy trích yếu rồi tới tiêu đề; gộp khoảng trắng; bỏ trống thì rỗng', () => {
    expect(deriveRunTitle([f('trichYeu')], { trichYeu: '  V/v   kiểm tra  PCCC ' })).toBe('V/v kiểm tra PCCC');
    expect(deriveRunTitle([f('tieuDe'), f('noiDung', 'longtext')], { tieuDe: 'Đẩy nhanh thu hồi công nợ', noiDung: 'abc' })).toBe('Đẩy nhanh thu hồi công nợ');
    expect(deriveRunTitle([f('trichYeu'), f('tieuDe')], { trichYeu: '', tieuDe: 'Chỉ thị' })).toBe('Chỉ thị');
    expect(deriveRunTitle([f('trichYeu')], { trichYeu: '   ' })).toBe('');
    expect(deriveRunTitle([f('ten')], { ten: 'x' })).toBe('');
  });

  it('chỉ lấy ô chữ, không lấy ô thuộc loại khác trùng khoá', () => {
    expect(deriveRunTitle([f('trichYeu', 'date')], { trichYeu: '2026-10-07' })).toBe('');
  });

  it('tên người dùng gõ luôn được ưu tiên', () => {
    expect(effectiveRunTitle(' Công văn 12 ', [f('trichYeu')], { trichYeu: 'V/v khác' })).toBe('Công văn 12');
    expect(effectiveRunTitle('', [f('trichYeu')], { trichYeu: 'V/v khác' })).toBe('V/v khác');
  });
});
