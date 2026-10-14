import type { FileView } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { canPreview, limitTable, parseCsv, previewKind, previewMime, safeHref, stripBom, viewableFor } from '../src/lib/file-preview';

const file = (over: Partial<FileView>): FileView => ({
  id: 'f1',
  name: 'a.pdf',
  mime: 'application/pdf',
  sizeBytes: 10,
  uploadedBy: null,
  uploadedAt: '2026-10-12T00:00:00.000Z',
  fieldKey: null,
  runId: 'r1',
  stepId: null,
  stepTitle: null,
  compiled: false,
  renditionOf: null,
  status: 'attached',
  ...over,
});

describe('previewKind', () => {
  it('nhận đúng loại xem được, không phân biệt hoa thường', () => {
    expect(previewKind('Công văn.PDF')).toBe('pdf');
    expect(previewKind('scan.JPG')).toBe('image');
    expect(previewKind('a.jpeg')).toBe('image');
    expect(previewKind('a.png')).toBe('image');
    expect(previewKind('bao-cao.docx')).toBe('docx');
    expect(previewKind('bang.xlsx')).toBe('xlsx');
    expect(previewKind('ghi-chu.txt')).toBe('text');
    expect(previewKind('so-lieu.csv')).toBe('csv');
  });
  it('loại chưa xem được trả null (vẫn tải xuống được)', () => {
    for (const name of ['a.doc', 'a.xls', 'a.ppt', 'a.pptx', 'a.odt', 'a.ods', 'a.rtf', 'a.zip', 'khong-co-duoi', '.pdf', 'a.pdf.exe']) {
      expect(previewKind(name)).toBeNull();
      expect(canPreview(name)).toBe(false);
    }
  });
  it('đuôi giả nằm trong tên không đánh lừa: chỉ tính phần mở rộng cuối', () => {
    expect(previewKind('anh.png.zip')).toBeNull();
    expect(previewKind('..\\..\\x.pdf')).toBe('pdf');
  });
  it('loại nội dung của Blob', () => {
    expect(previewMime('a.pdf')).toBe('application/pdf');
    expect(previewMime('a.docx')).toContain('wordprocessingml');
    expect(previewMime('a.zip')).toBe('application/octet-stream');
  });
});

describe('viewableFor', () => {
  const word = file({ id: 'w', name: 'to-trinh.docx', compiled: true });
  const pdf = file({ id: 'p', name: 'to-trinh.pdf', compiled: true, renditionOf: 'w' });
  it('tệp Word tổng hợp có bản PDF thì xem bản PDF', () => {
    expect(viewableFor(word, [word, pdf]).id).toBe('p');
  });
  it('không có bản PDF, hoặc không phải tệp tổng hợp, hoặc đã là bản PDF thì xem chính nó', () => {
    expect(viewableFor(word, [word]).id).toBe('w');
    const plain = file({ id: 'x', name: 'x.docx' });
    expect(viewableFor(plain, [plain, pdf]).id).toBe('x');
    expect(viewableFor(pdf, [word, pdf]).id).toBe('p');
  });
});

describe('parseCsv', () => {
  it('đọc dòng và cột cơ bản', () => {
    expect(parseCsv('a,b,c\n1,2,3\n').rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('trường có nháy kép chứa dấu phẩy, xuống dòng và nháy đôi', () => {
    expect(parseCsv('"Hà Nội, VN","dòng 1\ndòng 2","nói ""có"""\n').rows).toEqual([['Hà Nội, VN', 'dòng 1\ndòng 2', 'nói "có"']]);
  });
  it('tự nhận dấu chấm phẩy (Excel tiếng Việt), CRLF và BOM', () => {
    expect(parseCsv('﻿Số;Ngày\r\n01;12/10/2026\r\n').rows).toEqual([['Số', 'Ngày'], ['01', '12/10/2026']]);
  });
  it('bỏ dòng trống, giữ ô rỗng, dòng cuối không có xuống dòng', () => {
    expect(parseCsv('a,,c\n\n1,2,3').rows).toEqual([['a', '', 'c'], ['1', '2', '3']]);
  });
  it('cắt ở số dòng tối đa và báo đã cắt', () => {
    const csv = Array.from({ length: 10 }, (_, i) => `r${i},x`).join('\n');
    expect(parseCsv(csv, 3)).toEqual({ rows: [['r0', 'x'], ['r1', 'x'], ['r2', 'x']], truncated: true });
    expect(parseCsv('a,b\n1,2\n', 5).truncated).toBe(false);
  });
  it('nội dung nguy hiểm vẫn chỉ là chữ (React sẽ thoát ký tự khi hiện)', () => {
    expect(parseCsv('<img src=x onerror=alert(1)>,=HYPERLINK("http://x")\n').rows[0]).toEqual(['<img src=x onerror=alert(1)>', '=HYPERLINK("http://x")']);
  });
});

describe('limitTable', () => {
  it('cắt dòng và cột, báo đã cắt', () => {
    const rows = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    expect(limitTable(rows, 2, 2)).toEqual({ rows: [[1, 2], [4, 5]], truncated: true });
    expect(limitTable(rows, 5, 5)).toEqual({ rows, truncated: false });
  });
});

describe('safeHref', () => {
  it('chỉ giữ http, https, mailto tuyệt đối', () => {
    expect(safeHref('https://vrg.example/van-ban')).toBe('https://vrg.example/van-ban');
    expect(safeHref('http://a.vn')).toBe('http://a.vn/');
    expect(safeHref('mailto:a@b.vn')).toBe('mailto:a@b.vn');
  });
  it('chặn javascript:, data:, file:, neo, tương đối và rỗng', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', '#muc-luc', '/v1/files/x', '//evil.test/x', 'vbscript:x', '', null, undefined]) {
      expect(safeHref(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe('stripBom', () => {
  it('bỏ BOM ở đầu, giữ nguyên chỗ khác', () => {
    expect(stripBom('﻿xin chào')).toBe('xin chào');
    expect(stripBom('xin chào')).toBe('xin chào');
  });
});
