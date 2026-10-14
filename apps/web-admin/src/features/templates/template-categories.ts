import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateSummary } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { compareVi } from '@/lib/collator';

/** Phần của TemplateSummary mà các hàm dưới đây cần, để test không phải dựng cả một mẫu. */
type WithCategory = Pick<TemplateSummary, 'category'>;

/** Thứ tự các nhóm ở thanh lọc: đúng thứ tự khai báo trong miền (chỉ thị, văn bản, rồi các nhóm nghiệp vụ, "Khác" cuối). */
export const CATEGORY_ORDER = TEMPLATE_CATEGORIES;

/** "all" là mục "Tất cả" ở đầu thanh lọc, không phải một nhóm. */
export type CategoryFilter = TemplateCategory | 'all';

export type CategoryCounts = Record<CategoryFilter, number>;

export function isCategory(value: string): value is TemplateCategory {
  return (TEMPLATE_CATEGORIES as readonly string[]).includes(value);
}

export function categoryLabel(category: TemplateCategory): string {
  return vi.admin.designer.list.category[category];
}

/** Số quy trình của từng nhóm và của "Tất cả". Nhóm không có quy trình nào đếm 0 (vẫn hiện ở thanh lọc). */
export function countByCategory(items: readonly WithCategory[]): CategoryCounts {
  const counts: CategoryCounts = { all: items.length, directive: 0, incoming: 0, outgoing: 0, business: 0, finance: 0, hr: 0, operations: 0, general: 0 };
  for (const item of items) counts[item.category] += 1;
  return counts;
}

/** Giữ nguyên thứ tự gốc; "all" trả lại mọi dòng. */
export function filterByCategory<T extends WithCategory>(items: readonly T[], filter: CategoryFilter): T[] {
  return filter === 'all' ? [...items] : items.filter((item) => item.category === filter);
}

/** Quy trình người đang đăng nhập khởi chạy được ngay: máy chủ đã tính `canStart`; thêm kiểm bản xuất bản và lưu trữ cho chắc. */
export function isStartable(template: Pick<TemplateSummary, 'canStart' | 'latestPublishedVersion' | 'archivedAt'>): boolean {
  return template.canStart && template.latestPublishedVersion !== null && template.archivedAt === null;
}

/** Các quy trình khởi chạy được của một nhóm, sắp theo tên (dùng cho thẻ nhanh ở Tổng quan). */
export function startableIn<T extends WithCategory & Pick<TemplateSummary, 'canStart' | 'latestPublishedVersion' | 'archivedAt' | 'name'>>(items: readonly T[], category: TemplateCategory): T[] {
  return items.filter((item) => item.category === category && isStartable(item)).sort((a, b) => compareVi(a.name, b.name));
}

/** Tên để so sánh trùng: bỏ khoảng trắng thừa, không phân biệt hoa thường, nhận cả chữ có dấu dạng tổ hợp lẫn dựng sẵn. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
}

/** Đã có quy trình nào mang tên này chưa (kể cả quy trình đã lưu trữ: tên vẫn làm người ta lẫn). */
export function isNameTaken(name: string, existing: readonly Pick<TemplateSummary, 'name'>[]): boolean {
  const wanted = normalizeName(name);
  return wanted !== '' && existing.some((item) => normalizeName(item.name) === wanted);
}

/** Thứ tự của một nhóm trong CATEGORY_ORDER, để sắp mẫu có sẵn theo nhóm. */
export function categoryRank(category: TemplateCategory): number {
  return CATEGORY_ORDER.indexOf(category);
}

/** Mẫu có sẵn theo thứ tự nhóm, rồi theo tên: "Chỉ thị" và "Văn bản" lên đầu thư viện. */
export function sortPresets<T extends WithCategory & { name: string }>(presets: readonly T[]): T[] {
  return [...presets].sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || compareVi(a.name, b.name));
}
