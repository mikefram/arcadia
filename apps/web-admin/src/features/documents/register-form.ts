import { z } from 'zod';
import {
  formatDocumentNumber,
  isValidNumberPattern,
  RegisterCodeSchema,
  RegisterDirectionSchema,
  type RegisterDirection,
  type RegisterUpsert,
  type RegisterView,
} from '@mihato/domain';
import { vi } from '@mihato/i18n';

const t = vi.admin.documents.config;

/** Số cột hiển thị tối đa của một sổ (khớp RegisterUpsertSchema). */
export const COLUMN_LIMIT = 12;

/** Các dấu hiệu của mẫu số, theo thứ tự hiện ở hàng nút chèn. */
export const PATTERN_TOKENS = [
  { id: 'seq', token: '{seq}', meaning: t.token.seq },
  { id: 'seq4', token: '{seq:4}', meaning: t.token.seq4 },
  { id: 'yyyy', token: '{yyyy}', meaning: t.token.yyyy },
  { id: 'yy', token: '{yy}', meaning: t.token.yy },
] as const;

export type RegisterFormValues = {
  /** chỉ nhập lúc tạo; lúc sửa là mã của sổ đang sửa và không đổi được */
  code: string;
  name: string;
  direction: RegisterDirection;
  pattern: string;
  /** true = đánh lại số từ 1 mỗi năm (resetPolicy 'yearly') */
  resetYearly: boolean;
  columns: { key: string; label: string }[];
};

const columnSchema = z.object({
  key: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, t.columnKeyInvalid),
  label: z.string().trim().min(1, t.columnLabelRequired).max(100, t.columnLabelTooLong),
});

/**
 * Luật nhập của biểu mẫu cấu hình sổ. `takenCodes` là mã các sổ đã có: tạo sổ mới không được trùng (PUT sẽ ghi đè sổ cũ).
 * Mã so không phân biệt hoa thường để người dùng không tạo "vbden" bên cạnh "VBDEN".
 */
export function registerFormSchema(mode: 'create' | 'edit', takenCodes: readonly string[]) {
  const taken = new Set(takenCodes.map((c) => c.toLowerCase()));
  return z
    .object({
      code: z.string().trim(),
      name: z.string().trim().min(1, t.nameRequired).max(200, t.nameTooLong),
      direction: RegisterDirectionSchema,
      pattern: z
        .string()
        .trim()
        .refine((v) => isValidNumberPattern(v), t.patternInvalid),
      resetYearly: z.boolean(),
      columns: z.array(columnSchema).max(COLUMN_LIMIT),
    })
    .superRefine((value, ctx) => {
      if (mode === 'create') {
        if (value.code === '') ctx.addIssue({ code: 'custom', path: ['code'], message: t.codeRequired });
        else if (!RegisterCodeSchema.safeParse(value.code).success) ctx.addIssue({ code: 'custom', path: ['code'], message: t.codeInvalid });
        else if (taken.has(value.code.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['code'], message: t.codeTaken });
      }
      const seen = new Set<string>();
      value.columns.forEach((column, i) => {
        const key = column.key.toLowerCase();
        if (key !== '' && seen.has(key)) ctx.addIssue({ code: 'custom', path: ['columns', i, 'key'], message: t.columnKeyDuplicate });
        seen.add(key);
      });
    });
}

/** Giá trị nhập → thân yêu cầu `registers.upsert`. */
export function toUpsert(values: RegisterFormValues): RegisterUpsert {
  return {
    name: values.name.trim(),
    direction: values.direction,
    pattern: values.pattern.trim(),
    resetPolicy: values.resetYearly ? 'yearly' : 'never',
    columns: values.columns.map((c) => ({ key: c.key.trim(), label: c.label.trim() })),
  };
}

export function valuesFromRegister(register: RegisterView): RegisterFormValues {
  return {
    code: register.code,
    name: register.name,
    direction: register.direction,
    pattern: register.pattern,
    resetYearly: register.resetPolicy === 'yearly',
    columns: register.columns.map((c) => ({ key: c.key, label: c.label })),
  };
}

export const EMPTY_REGISTER_VALUES: RegisterFormValues = { code: '', name: '', direction: 'incoming', pattern: '{seq}', resetYearly: true, columns: [] };

/** Số thứ tự dùng làm ví dụ thứ hai ở phần xem trước (đủ lớn để thấy chuyện đệm số 0). */
export const PREVIEW_LATER_SEQ = 25;

export type NumberPreview = { first: string; later: string; laterSeq: number };

/** Xem trước mẫu số bằng đúng hàm máy chủ dùng để cấp số. `null` khi mẫu chưa hợp lệ. */
export function previewNumbers(pattern: string, year: number): NumberPreview | null {
  const p = pattern.trim();
  if (!isValidNumberPattern(p)) return null;
  return { first: formatDocumentNumber(p, 1, year), later: formatDocumentNumber(p, PREVIEW_LATER_SEQ, year), laterSeq: PREVIEW_LATER_SEQ };
}

/** Nối một dấu hiệu vào cuối mẫu số. */
export function appendToken(pattern: string, token: string): string {
  return `${pattern}${token}`;
}

/**
 * Ba sổ nên có (khớp DEFAULT_REGISTERS của máy chủ, packages/backend/src/services/registers.ts): mã, loại, mẫu số, khoá các cột.
 * Tên sổ và tên cột là chữ giao diện, nằm ở vi.admin.documents.recommended.
 */
export const RECOMMENDED_REGISTERS = [
  { code: 'VBDEN', direction: 'incoming', pattern: '{seq:4}', columnKeys: ['noiGui', 'soKyHieu', 'ngayVanBan', 'loaiVanBan', 'mucKhan', 'mucMat', 'hanXuLy', 'chuTri'] },
  { code: 'VBDI', direction: 'outgoing', pattern: '{seq}/VB-{yyyy}', columnKeys: ['noiNhan', 'loaiVanBan', 'mucKhan', 'mucMat', 'nguoiKy', 'soLuongBan', 'ngayBanHanh'] },
  { code: 'CHITHI', direction: 'internal', pattern: '{seq}/CT-{yyyy}', columnKeys: ['tieuDe', 'mucKhan', 'hanHoanThanh'] },
] as const satisfies readonly { code: string; direction: RegisterDirection; pattern: string; columnKeys: readonly string[] }[];

export type RecommendedCode = (typeof RECOMMENDED_REGISTERS)[number]['code'];

/** Giá trị điền sẵn khi bấm “Tạo Sổ văn bản đến”… ở trạng thái chưa có sổ. */
export function recommendedValues(code: RecommendedCode): RegisterFormValues {
  const base = RECOMMENDED_REGISTERS.find((r) => r.code === code);
  const text = vi.admin.documents.recommended[code];
  if (!base) return EMPTY_REGISTER_VALUES;
  return {
    code: base.code,
    name: text.name,
    direction: base.direction,
    pattern: base.pattern,
    resetYearly: true,
    columns: base.columnKeys.map((key, i) => ({ key, label: text.columns[i] ?? key })),
  };
}
