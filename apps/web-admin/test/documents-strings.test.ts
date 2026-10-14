import { TEMPLATE_CATEGORIES } from '@mihato/domain';
import { findBannedWords, vi } from '@mihato/i18n';
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from '../src/app/nav';

/** Mọi chuỗi lá của một nhánh chuỗi giao diện, kèm đường dẫn. */
function leaves(node: unknown, path: string, out: { path: string; value: string }[] = []): { path: string; value: string }[] {
  if (typeof node === 'string') out.push({ path, value: node });
  else if (Array.isArray(node)) node.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) leaves(v, `${path}.${k}`, out);
  return out;
}

describe('chuỗi của Sổ văn bản và danh sách quy trình', () => {
  const trees = {
    'vi.admin.documents': vi.admin.documents,
    'vi.admin.designer.list': vi.admin.designer.list,
    'vi.admin.shell.nav': vi.admin.shell.nav,
  };

  for (const [name, tree] of Object.entries(trees)) {
    const strings = leaves(tree, name);

    it(`${name}: không rỗng, không từ vay mượn bị cấm, không biểu tượng cảm xúc`, () => {
      expect(strings.length).toBeGreaterThan(0);
      for (const { path, value } of strings) {
        expect(value.trim(), path).not.toBe('');
        expect(findBannedWords(value), path).toEqual([]);
        expect(value, path).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    });
  }

  it('dấu {…} ngoài mẫu số: biến có tên tiếng Việt, mỗi biến một lần', () => {
    const allowed = new Set(['n', 'tên', 'sổ', 'loại', 'mã', 'mẫu', 'số', 'năm', 'thứ', 'nhóm', 'dấu', 'nghĩa', 'việc', 'quy trình', 'seq', 'seq:4', 'yyyy', 'yy']);
    for (const { path, value } of leaves(vi.admin.documents, 'documents')) {
      for (const [, name] of value.matchAll(/\{([^{}]+)\}/g)) expect(allowed.has(name ?? ''), `${path}: {${name}}`).toBe(true);
      expect((value.match(/\{/g) ?? []).length, path).toBe((value.match(/\}/g) ?? []).length);
    }
  });

  it('mọi nhóm quy trình có nhãn', () => {
    for (const category of TEMPLATE_CATEGORIES) expect(vi.admin.designer.list.category[category], category).toBeTruthy();
  });

  it('mục “Sổ văn bản” nằm ở nhóm Điều phối của thanh bên, hiện cho quyền document.view hoặc org.settings (cấu hình sổ)', () => {
    const group = NAV_GROUPS.find((g) => g.label === vi.admin.shell.nav.groupCoordination);
    const item = group?.items.find((x) => x.to === '/so-van-ban');
    expect(item?.label).toBe('Sổ văn bản');
    expect(item?.anyOf).toEqual(['document.view', 'org.settings']);
  });
});
