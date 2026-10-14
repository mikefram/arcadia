import { RegisterUpsertSchema } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import {
  appendToken,
  COLUMN_LIMIT,
  EMPTY_REGISTER_VALUES,
  PATTERN_TOKENS,
  previewNumbers,
  RECOMMENDED_REGISTERS,
  recommendedValues,
  registerFormSchema,
  toUpsert,
  valuesFromRegister,
  type RegisterFormValues,
} from '../src/features/documents/register-form';

const base: RegisterFormValues = { code: 'VBDEN', name: 'Sổ văn bản đến', direction: 'incoming', pattern: '{seq:4}', resetYearly: true, columns: [{ key: 'noiGui', label: 'Nơi gửi' }] };

const issues = (mode: 'create' | 'edit', values: RegisterFormValues, taken: string[] = []) => {
  const result = registerFormSchema(mode, taken).safeParse(values);
  return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
};

describe('xem trước mẫu số', () => {
  it('dùng đúng hàm cấp số của máy chủ', () => {
    expect(previewNumbers('{seq:4}', 2026)).toEqual({ first: '0001', later: '0025', laterSeq: 25 });
    expect(previewNumbers('{seq}/VRG-VP', 2026)).toEqual({ first: '1/VRG-VP', later: '25/VRG-VP', laterSeq: 25 });
    expect(previewNumbers('{seq}/CT-{yyyy}', 2027)?.first).toBe('1/CT-2027');
    expect(previewNumbers('{seq:3}/{yy}', 2026)?.later).toBe('025/26');
  });

  it('mẫu chưa hợp lệ thì không có bản xem trước', () => {
    expect(previewNumbers('', 2026)).toBeNull();
    expect(previewNumbers('không có số', 2026)).toBeNull();
    expect(previewNumbers('{seq}/{abc}', 2026)).toBeNull();
    expect(previewNumbers('{seq', 2026)).toBeNull();
  });

  it('bỏ khoảng trắng hai đầu', () => {
    expect(previewNumbers('  {seq}/VB  ', 2026)?.first).toBe('1/VB');
  });

  it('hàng nút chèn có đủ bốn dấu hiệu và mỗi dấu hiệu cho ra mẫu hợp lệ', () => {
    expect(PATTERN_TOKENS.map((x) => x.token)).toEqual(['{seq}', '{seq:4}', '{yyyy}', '{yy}']);
    expect(appendToken('{seq}/', '{yyyy}')).toBe('{seq}/{yyyy}');
    for (const item of PATTERN_TOKENS) expect(item.meaning).not.toBe('');
  });
});

describe('luật nhập của biểu mẫu cấu hình sổ', () => {
  it('giá trị hợp lệ qua được ở cả hai chế độ', () => {
    expect(issues('create', base)).toEqual([]);
    expect(issues('edit', { ...base, code: '' })).toEqual([]);
  });

  it('tạo sổ: mã bắt buộc, đúng dạng và không trùng (không phân biệt hoa thường)', () => {
    expect(issues('create', { ...base, code: '' }).map((x) => x.path)).toEqual(['code']);
    expect(issues('create', { ...base, code: '1abc' }).map((x) => x.path)).toEqual(['code']);
    expect(issues('create', { ...base, code: 'có dấu' }).map((x) => x.path)).toEqual(['code']);
    expect(issues('create', { ...base, code: 'A'.repeat(33) }).map((x) => x.path)).toEqual(['code']);
    expect(issues('create', { ...base, code: 'vbden' }, ['VBDEN'])[0]?.message).toContain('Đã có sổ');
    expect(issues('create', { ...base, code: 'VB-KHAC_1' }, ['VBDEN'])).toEqual([]);
  });

  it('sửa sổ: không kiểm mã', () => {
    expect(issues('edit', { ...base, code: 'VBDEN' }, ['VBDEN'])).toEqual([]);
  });

  it('tên: bắt buộc và tối đa 200 ký tự', () => {
    expect(issues('edit', { ...base, name: '   ' }).map((x) => x.path)).toEqual(['name']);
    expect(issues('edit', { ...base, name: 'x'.repeat(201) }).map((x) => x.path)).toEqual(['name']);
  });

  it('mẫu số phải có {seq} và không có ngoặc nhọn lạ', () => {
    for (const pattern of ['', 'VB', '{yyyy}', '{seq}{abc}', '{seq', '}{seq}', 'x'.repeat(101)]) {
      expect(issues('edit', { ...base, pattern }).map((x) => x.path), pattern).toEqual(['pattern']);
    }
    for (const pattern of ['{seq}', '{seq:4}', '{seq}/VRG-VP', '{seq}/CT-{yyyy}', '{yy}-{seq:3}']) expect(issues('edit', { ...base, pattern }), pattern).toEqual([]);
  });

  it('cột: khoá đúng dạng, có tên, không trùng khoá, tối đa 12 cột', () => {
    expect(issues('edit', { ...base, columns: [{ key: '1sai', label: 'A' }] }).map((x) => x.path)).toEqual(['columns.0.key']);
    expect(issues('edit', { ...base, columns: [{ key: 'co dau', label: 'A' }] }).map((x) => x.path)).toEqual(['columns.0.key']);
    expect(issues('edit', { ...base, columns: [{ key: 'a', label: '  ' }] }).map((x) => x.path)).toEqual(['columns.0.label']);
    expect(issues('edit', { ...base, columns: [{ key: 'a', label: 'x'.repeat(101) }] }).map((x) => x.path)).toEqual(['columns.0.label']);
    expect(
      issues('edit', {
        ...base,
        columns: [
          { key: 'noiGui', label: 'A' },
          { key: 'NOIGUI', label: 'B' },
        ],
      }).map((x) => x.path),
    ).toEqual(['columns.1.key']);
    const many = Array.from({ length: COLUMN_LIMIT + 1 }, (_, i) => ({ key: `c${i}`, label: `Cột ${i}` }));
    expect(issues('edit', { ...base, columns: many }).map((x) => x.path)).toEqual(['columns']);
    expect(issues('edit', { ...base, columns: many.slice(0, COLUMN_LIMIT) })).toEqual([]);
  });
});

describe('thân yêu cầu registers.upsert', () => {
  it('toUpsert cắt khoảng trắng, đổi công tắc thành resetPolicy và qua được schema của miền', () => {
    const body = toUpsert({ ...base, name: '  Sổ A  ', pattern: ' {seq}/VB ', resetYearly: false, columns: [{ key: ' a ', label: ' Nơi gửi ' }] });
    expect(body).toEqual({ name: 'Sổ A', direction: 'incoming', pattern: '{seq}/VB', resetPolicy: 'never', columns: [{ key: 'a', label: 'Nơi gửi' }] });
    expect(RegisterUpsertSchema.safeParse(body).success).toBe(true);
    expect(toUpsert(base).resetPolicy).toBe('yearly');
  });

  it('valuesFromRegister rồi toUpsert giữ nguyên cấu hình', () => {
    const view = {
      code: 'VBDI',
      name: 'Sổ văn bản đi',
      direction: 'outgoing' as const,
      pattern: '{seq}/VB-{yyyy}',
      resetPolicy: 'yearly' as const,
      columns: [{ key: 'noiNhan', label: 'Nơi nhận' }],
      entryCount: 3,
      nextNumber: '4/VB-2026',
      archivedAt: null,
    };
    const values = valuesFromRegister(view);
    expect(values).toMatchObject({ code: 'VBDI', resetYearly: true });
    expect(toUpsert(values)).toEqual({ name: view.name, direction: view.direction, pattern: view.pattern, resetPolicy: 'yearly', columns: view.columns });
  });
});

describe('ba sổ nên có', () => {
  it('mỗi sổ điền sẵn qua được luật nhập và schema của miền', () => {
    expect(RECOMMENDED_REGISTERS.map((r) => r.code)).toEqual(['VBDEN', 'VBDI', 'CHITHI']);
    for (const { code } of RECOMMENDED_REGISTERS) {
      const values = recommendedValues(code);
      expect(values.code).toBe(code);
      expect(values.name).not.toBe('');
      expect(values.columns.length).toBeGreaterThan(0);
      for (const c of values.columns) expect(c.label, `${code}.${c.key}`).not.toBe(c.key);
      expect(issues('create', values), code).toEqual([]);
      expect(RegisterUpsertSchema.safeParse(toUpsert(values)).success, code).toBe(true);
    }
  });

  it('biểu mẫu trắng mặc định đánh lại số hằng năm và chưa có cột', () => {
    expect(EMPTY_REGISTER_VALUES).toMatchObject({ code: '', resetYearly: true, columns: [] });
  });
});
