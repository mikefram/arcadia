import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateSummary } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  categoryLabel,
  countByCategory,
  filterByCategory,
  isCategory,
  isNameTaken,
  isStartable,
  normalizeName,
  sortPresets,
  startableIn,
} from '../src/features/templates/template-categories';

type Row = Pick<TemplateSummary, 'name' | 'category' | 'canStart' | 'latestPublishedVersion' | 'archivedAt'>;
const row = (name: string, category: TemplateCategory, over: Partial<Row> = {}): Row => ({ name, category, canStart: true, latestPublishedVersion: 1, archivedAt: null, ...over });

describe('nhóm quy trình: đếm và lọc', () => {
  const items = [row('A', 'directive'), row('B', 'directive'), row('C', 'incoming'), row('D', 'general')];

  it('đếm theo nhóm và "Tất cả"; nhóm trống đếm 0 nhưng vẫn có khoá', () => {
    const counts = countByCategory(items);
    expect(counts).toMatchObject({ all: 4, directive: 2, incoming: 1, general: 1, outgoing: 0, business: 0, finance: 0, hr: 0, operations: 0 });
    expect(Object.keys(counts).sort()).toEqual(['all', ...TEMPLATE_CATEGORIES].sort());
  });

  it('danh sách rỗng đếm toàn 0', () => {
    expect(Object.values(countByCategory([])).every((n) => n === 0)).toBe(true);
  });

  it('lọc giữ nguyên thứ tự; "all" trả đủ và là bản sao', () => {
    expect(filterByCategory(items, 'directive').map((x) => x.name)).toEqual(['A', 'B']);
    expect(filterByCategory(items, 'hr')).toEqual([]);
    const all = filterByCategory(items, 'all');
    expect(all).toEqual(items);
    expect(all).not.toBe(items);
  });

  it('số đếm của mỗi nhóm bằng số dòng khi lọc nhóm đó', () => {
    const counts = countByCategory(items);
    for (const category of CATEGORY_ORDER) expect(filterByCategory(items, category)).toHaveLength(counts[category]);
  });
});

describe('nhãn nhóm', () => {
  it('mọi nhóm trong miền đều có nhãn tiếng Việt riêng', () => {
    const labels = TEMPLATE_CATEGORIES.map(categoryLabel);
    expect(new Set(labels).size).toBe(TEMPLATE_CATEGORIES.length);
    for (const category of TEMPLATE_CATEGORIES) expect(vi.admin.designer.list.category[category], category).toBeTruthy();
    expect(labels).toContain('Chỉ thị');
    expect(labels).toContain('Văn bản đến');
    expect(labels).toContain('Tài chính - Kế toán');
  });

  it('isCategory chỉ nhận khoá của miền', () => {
    expect(isCategory('directive')).toBe(true);
    expect(isCategory('all')).toBe(false);
    expect(isCategory('khac')).toBe(false);
  });
});

describe('khởi chạy được (canStart)', () => {
  it('cần canStart, đã xuất bản và chưa lưu trữ', () => {
    expect(isStartable(row('A', 'directive'))).toBe(true);
    expect(isStartable(row('A', 'directive', { canStart: false }))).toBe(false);
    expect(isStartable(row('A', 'directive', { latestPublishedVersion: null }))).toBe(false);
    expect(isStartable(row('A', 'directive', { archivedAt: '2026-10-01T00:00:00.000Z' }))).toBe(false);
  });

  it('startableIn: đúng nhóm, chỉ quy trình khởi chạy được, sắp theo tên tiếng Việt', () => {
    const list = [
      row('Ra chỉ thị sau', 'directive'),
      row('Đón khách', 'directive'),
      row('Ân hạn', 'directive'),
      row('Chỉ Chủ tịch', 'directive', { canStart: false }),
      row('Nháp', 'directive', { latestPublishedVersion: null }),
      row('Vào sổ', 'incoming'),
    ];
    expect(startableIn(list, 'directive').map((x) => x.name)).toEqual(['Ân hạn', 'Đón khách', 'Ra chỉ thị sau']);
    expect(startableIn(list, 'incoming').map((x) => x.name)).toEqual(['Vào sổ']);
    expect(startableIn(list, 'outgoing')).toEqual([]);
  });

  it('startableIn không đổi danh sách gốc', () => {
    const list = [row('B', 'directive'), row('A', 'directive')];
    startableIn(list, 'directive');
    expect(list.map((x) => x.name)).toEqual(['B', 'A']);
  });
});

describe('báo trùng tên', () => {
  const existing = [{ name: 'Đón đoàn nhà đầu tư' }, { name: 'Nhận văn bản đến' }];

  it('bỏ khoảng trắng thừa và không phân biệt hoa thường', () => {
    expect(normalizeName('  Nhận   Văn bản  ĐẾN ')).toBe('nhận văn bản đến');
    expect(isNameTaken('nhận văn bản đến', existing)).toBe(true);
    expect(isNameTaken('  ĐÓN ĐOÀN   nhà đầu tư  ', existing)).toBe(true);
  });

  it('nhận cả chữ có dấu dạng tổ hợp và dựng sẵn', () => {
    expect(isNameTaken('Nhận văn bản đến'.normalize('NFD'), existing)).toBe(true);
  });

  it('tên khác hoặc rỗng thì không trùng', () => {
    expect(isNameTaken('Nhận văn bản đi', existing)).toBe(false);
    expect(isNameTaken('   ', existing)).toBe(false);
    expect(isNameTaken('Gì đó', [])).toBe(false);
  });
});

describe('thư viện mẫu', () => {
  it('sắp theo thứ tự nhóm rồi theo tên', () => {
    const presets = [
      { name: 'Z', category: 'general' as const },
      { name: 'Văn bản đi', category: 'outgoing' as const },
      { name: 'Vào sổ', category: 'incoming' as const },
      { name: 'Chỉ thị B', category: 'directive' as const },
      { name: 'Chỉ thị A', category: 'directive' as const },
    ];
    expect(sortPresets(presets).map((x) => x.name)).toEqual(['Chỉ thị A', 'Chỉ thị B', 'Vào sổ', 'Văn bản đi', 'Z']);
    expect(presets[0]?.name).toBe('Z');
  });
});
