import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectKeyterms, isCalendarDate, itemGroups, listSpeakers, loadManifest, ManifestError, parseManifest, resolveAudioPath } from '../src/manifest';
import { FIXTURE_MANIFEST, FIXTURES_DIR } from './helpers';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  file: 'a1.wav',
  speaker: 'S01',
  reference: 'đi thúc anh Tuấn',
  entities: { people: ['Tuấn'], amountsVnd: [], dates: [] },
  ...over,
});
const manifest = (over: Record<string, unknown> = {}) => ({ items: [item()], ...over });

describe('parseManifest: hợp lệ', () => {
  it('manifest tối thiểu, entities mặc định rỗng', () => {
    const m = parseManifest({ items: [{ id: 'a1', file: 'a1.wav', speaker: 'S01', reference: 'xin chào' }] });
    expect(m.items[0]?.entities).toEqual({ people: [], amountsVnd: [], dates: [] });
    expect(m.now).toBeUndefined();
  });

  it('đủ mọi trường', () => {
    const m = parseManifest({
      description: 'bộ thử',
      now: '2026-10-03T09:00:00+07:00',
      items: [
        {
          id: 'tc-01',
          file: 'x/tc-01.wav',
          speaker: 'S01',
          age: 64,
          region: 'Bắc',
          reference: 'duyệt hai chục triệu cho chị Phương trước thứ Tư ngày bảy tháng mười',
          entities: { people: ['Phương'], units: ['Kinh doanh'], amountsVnd: [20000000], dates: ['2026-10-07'] },
          fake: { final: 'duyệt hai chục triệu', interim: ['duyệt'], confidence: 0.9 },
        },
      ],
    });
    expect(m.items[0]?.entities.units).toEqual(['Kinh doanh']);
    expect(m.items[0]?.fake?.confidence).toBe(0.9);
  });

  it('tên được cắt khoảng trắng hai đầu', () => {
    const m = parseManifest(manifest({ items: [item({ entities: { people: ['  Tuấn  '], amountsVnd: [], dates: [] } })] }));
    expect(m.items[0]?.entities.people).toEqual(['Tuấn']);
  });

  it('nhận now có múi giờ Z và +07:00', () => {
    expect(parseManifest(manifest({ now: '2026-10-03T02:00:00Z' })).now).toBe('2026-10-03T02:00:00Z');
    expect(parseManifest(manifest({ now: '2026-10-03T09:00:00+07:00' })).now).toBe('2026-10-03T09:00:00+07:00');
  });

  it('ba tệp mẫu của repo đọc được', () => {
    const { manifest: m } = loadManifest(FIXTURE_MANIFEST);
    expect(m.items.map((i) => i.id)).toEqual(['fx-01', 'fx-02', 'fx-03']);
  });
});

describe('parseManifest: sai thì báo đúng chỗ', () => {
  const bad: [string, unknown, RegExp][] = [
    ['gốc là mảng', [item()], /gốc/],
    ['thiếu items', {}, /items/],
    ['items rỗng', { items: [] }, /ít nhất một mục/],
    ['khoá lạ ở gốc', manifest({ extra: 1 }), /extra/],
    ['mục thiếu id', manifest({ items: [item({ id: undefined })] }), /items\[0\]\.id/],
    ['id có khoảng trắng', manifest({ items: [item({ id: 'a 1' })] }), /items\[0\] \(a 1\)|items\[0\]\.id/],
    ['id có dấu', manifest({ items: [item({ id: 'câu-1' })] }), /mã ẩn danh/],
    ['id quá dài', manifest({ items: [item({ id: 'a'.repeat(65) })] }), /items\[0\]\.id/],
    ['người nói là tên thật', manifest({ items: [item({ speaker: 'Nguyễn Văn A' })] }), /không ghi tên thật/],
    ['người nói rỗng', manifest({ items: [item({ speaker: '' })] }), /items\[0\]\.speaker/],
    ['thiếu file', manifest({ items: [item({ file: undefined })] }), /items\[0\]\.file/],
    ['file rỗng', manifest({ items: [item({ file: '  ' })] }), /items\[0\]\.file/],
    ['thiếu câu chuẩn', manifest({ items: [item({ reference: undefined })] }), /items\[0\]\.reference/],
    ['câu chuẩn không có chữ', manifest({ items: [item({ reference: '... !!!' })] }), /câu chuẩn phải có chữ/],
    ['gõ sai tên khoá refrence', manifest({ items: [item({ refrence: 'x' })] }), /refrence/],
    ['gõ sai amountVnd', manifest({ items: [item({ entities: { people: [], amountVnd: [1], dates: [] } })] }), /amountVnd/],
    ['số tiền lẻ', manifest({ items: [item({ entities: { people: [], amountsVnd: [1.5], dates: [] } })] }), /amountsVnd\[0\]/],
    ['số tiền âm', manifest({ items: [item({ entities: { people: [], amountsVnd: [-5], dates: [] } })] }), /amountsVnd\[0\]/],
    ['số tiền bằng 0', manifest({ items: [item({ entities: { people: [], amountsVnd: [0], dates: [] } })] }), /số tiền phải dương/],
    ['số tiền là chuỗi', manifest({ items: [item({ entities: { people: [], amountsVnd: ['20 triệu'], dates: [] } })] }), /amountsVnd\[0\]/],
    ['ngày sai dạng', manifest({ items: [item({ entities: { people: [], amountsVnd: [], dates: ['07/10/2026'] } })] }), /YYYY-MM-DD/],
    ['ngày không có thật', manifest({ items: [item({ entities: { people: [], amountsVnd: [], dates: ['2026-02-30'] } })] }), /đúng lịch/],
    ['tháng 13', manifest({ items: [item({ entities: { people: [], amountsVnd: [], dates: ['2026-13-01'] } })] }), /dates\[0\]/],
    ['tên người rỗng', manifest({ items: [item({ entities: { people: [''], amountsVnd: [], dates: [] } })] }), /people\[0\]/],
    ['tên người toàn khoảng trắng', manifest({ items: [item({ entities: { people: ['   '], amountsVnd: [], dates: [] } })] }), /people\[0\]/],
    ['tuổi âm', manifest({ items: [item({ age: -1 })] }), /age/],
    ['tuổi 150', manifest({ items: [item({ age: 150 })] }), /age/],
    ['tuổi lẻ', manifest({ items: [item({ age: 63.5 })] }), /age/],
    ['now thiếu múi giờ', manifest({ now: '2026-10-03T09:00:00' }), /now/],
    ['now không phải thời điểm', manifest({ now: 'hôm qua' }), /now/],
    ['id trùng', manifest({ items: [item(), item({ reference: 'khác' })] }), /items\[1\] \(a1\).*id bị trùng|id bị trùng/],
    ['fake thiếu final', manifest({ items: [item({ fake: {} })] }), /fake\.final/],
    ['fake độ tin cậy quá 1', manifest({ items: [item({ fake: { final: 'x', confidence: 1.5 } })] }), /fake\.confidence/],
    ['fake khoá lạ', manifest({ items: [item({ fake: { final: 'x', loi: 1 } })] }), /loi/],
  ];
  it.each(bad)('%s', (_name, data, message) => {
    expect(() => parseManifest(data)).toThrowError(ManifestError);
    expect(() => parseManifest(data)).toThrowError(message);
  });

  it('báo mọi chỗ sai cùng lúc, không dừng ở chỗ đầu tiên', () => {
    try {
      parseManifest(manifest({ items: [item({ id: 'a b', speaker: 'Lê Thị B' }), item({ id: 'a2', file: '' })] }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      expect((e as ManifestError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('thông báo lỗi không chép lại nội dung câu nói', () => {
    const secret = 'câu nói riêng tư về lương của anh Quyết';
    try {
      parseManifest(manifest({ items: [item({ reference: secret, agee: 5, entities: { people: ['Quyết'], amountsVnd: [-1], dates: [] } })] }));
      expect.unreachable();
    } catch (e) {
      const message = (e as ManifestError).message;
      expect(message).not.toContain('riêng tư');
      expect(message).not.toContain('Quyết');
      expect(message).not.toContain('lương');
    }
  });

  it('chỉ rõ id của mục sai để tìm cho nhanh', () => {
    try {
      parseManifest(manifest({ items: [item(), item({ id: 'tc-77', file: undefined })] }));
      expect.unreachable();
    } catch (e) {
      expect((e as ManifestError).message).toMatch(/items\[1\]\.file|items\[1\] \(tc-77\)/);
    }
  });
});

describe('isCalendarDate', () => {
  const cases: [string, boolean][] = [
    ['2026-10-07', true],
    ['2026-02-28', true],
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-10-00', false],
    ['2026-1-7', false],
    ['07/10/2026', false],
    ['2026-10-07T09:00', false],
    ['', false],
    ['hôm nay', false],
    ['2026-12-31', true],
    ['1999-01-01', true],
  ];
  it.each(cases)('%s → %s', (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected);
  });
});

describe('loadManifest', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'stt-bench-manifest-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('trả thư mục gốc của manifest để tìm tệp âm thanh', () => {
    expect(loadManifest(FIXTURE_MANIFEST).baseDir).toBe(resolve(FIXTURES_DIR));
  });

  it('không có tệp thì báo không đọc được', () => {
    expect(() => loadManifest(join(tmp(), 'khong-co.json'))).toThrowError(/không đọc được tệp manifest/);
  });

  it('JSON hỏng thì báo chung, không chép đoạn nội dung', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'm.json'), '{ "items": [ { "reference": "câu nói bí mật ", } ] }');
    try {
      loadManifest(join(dir, 'm.json'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      expect((e as ManifestError).message).toMatch(/không phải JSON hợp lệ/);
      expect((e as ManifestError).message).not.toContain('bí mật');
    }
  });

  it('JSON đúng nhưng sai lược đồ thì ném ManifestError', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ items: [] }));
    expect(() => loadManifest(join(dir, 'm.json'))).toThrowError(ManifestError);
  });
});

describe('resolveAudioPath', () => {
  it('đường dẫn tương đối tính từ thư mục manifest', () => {
    expect(resolveAudioPath('/x/y', 'a/b.wav')).toBe(resolve('/x/y', 'a/b.wav'));
  });
  it('đường dẫn tuyệt đối giữ nguyên', () => {
    expect(resolveAudioPath('/x/y', '/z/b.wav')).toBe('/z/b.wav');
  });
});

describe('collectKeyterms', () => {
  const m = (items: Record<string, unknown>[]) => parseManifest({ items });
  const it1 = (id: string, entities: Record<string, unknown>) => item({ id, entities: { people: [], amountsVnd: [], dates: [], ...entities } });

  it('tên người trước, tên đơn vị sau, theo thứ tự xuất hiện', () => {
    const keyterms = collectKeyterms(m([it1('a', { people: ['Tuấn'], units: ['Kinh doanh'] }), it1('b', { people: ['Phương'], units: ['Hành chính'] })]));
    expect(keyterms).toEqual(['Tuấn', 'Phương', 'Kinh doanh', 'Hành chính']);
  });

  it('bỏ trùng không phân biệt hoa thường và khoảng trắng', () => {
    const keyterms = collectKeyterms(m([it1('a', { people: ['Tuấn', 'tuấn', 'TUẤN '] }), it1('b', { people: ['Nguyễn  Thị   Lan', 'nguyễn thị lan'] })]));
    expect(keyterms).toEqual(['Tuấn', 'Nguyễn Thị Lan']);
  });

  it('không có tên nào thì rỗng', () => {
    expect(collectKeyterms(m([it1('a', {})]))).toEqual([]);
  });

  it('giữ nguyên dấu và chuẩn hoá Unicode về NFC', () => {
    const nfd = 'Tuấn'.normalize('NFD');
    const keyterms = collectKeyterms(m([it1('a', { people: [nfd] })]));
    expect(keyterms[0]).toBe('Tuấn'.normalize('NFC'));
  });

  it('bộ mẫu: Tuấn và Phương, không đơn vị', () => {
    expect(collectKeyterms(loadManifest(FIXTURE_MANIFEST).manifest)).toEqual(['Tuấn', 'Phương']);
  });
});

describe('itemGroups', () => {
  const g = (entities: Record<string, unknown>) => itemGroups(parseManifest({ items: [item({ entities: { people: [], amountsVnd: [], dates: [], ...entities } })] }).items[0]!);
  it.each([
    [{}, { name: false, money: false, date: false }],
    [{ people: ['Tuấn'] }, { name: true, money: false, date: false }],
    [{ units: ['Kinh doanh'] }, { name: true, money: false, date: false }],
    [{ amountsVnd: [1000] }, { name: false, money: true, date: false }],
    [{ dates: ['2026-10-07'] }, { name: false, money: false, date: true }],
    [{ people: ['Tuấn'], amountsVnd: [1000], dates: ['2026-10-07'] }, { name: true, money: true, date: true }],
    [{ units: [] }, { name: false, money: false, date: false }],
  ])('%j', (entities, expected) => {
    expect(g(entities)).toEqual(expected);
  });
});

describe('listSpeakers', () => {
  it('theo thứ tự xuất hiện, đếm câu, lấy tuổi và vùng ở mục đầu có ghi', () => {
    const m = parseManifest({
      items: [
        item({ id: 'a', speaker: 'S02' }),
        item({ id: 'b', speaker: 'S01', age: 64, region: 'Bắc' }),
        item({ id: 'c', speaker: 'S02', age: 61 }),
        item({ id: 'd', speaker: 'S01', age: 99 }),
      ],
    });
    expect(listSpeakers(m)).toEqual([
      { speaker: 'S02', sentences: 2, age: 61 },
      { speaker: 'S01', sentences: 2, age: 64, region: 'Bắc' },
    ]);
  });
});
