import { FILE_EXTENSIONS, FILE_MAX_BYTES, type FileView } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { checkClientFile, fileExtension, filesByIds, formatBytes, groupRunFiles, isAllowedExtension, isUploading, orderCompiled, presentedFile, presentedFiles, readyFileIds, uploadName, type FileItem } from '../src/lib/files';

/** Kiểm tệp ở máy khách, định dạng cỡ tệp và gom hồ sơ của lượt chạy (docs/DECISIONS.md, 06/10/2026). */

function view(partial: Partial<FileView> & Pick<FileView, 'id'>): FileView {
  return {
    name: 'tep.pdf',
    mime: 'application/pdf',
    sizeBytes: 1000,
    uploadedBy: null,
    uploadedAt: '2026-10-06T01:00:00.000Z',
    fieldKey: null,
    runId: 'run-1',
    stepId: null,
    stepTitle: null,
    compiled: false,
    renditionOf: null,
    status: 'attached',
    ...partial,
  };
}

describe('kiểm tệp ở máy khách', () => {
  it('nhận mọi phần mở rộng trong danh sách của miền, không phân biệt hoa thường', () => {
    for (const ext of FILE_EXTENSIONS) {
      expect(checkClientFile({ name: `bao-cao.${ext}`, size: 10 }), ext).toBeNull();
      expect(checkClientFile({ name: `BAO-CAO.${ext.toUpperCase()}`, size: 10 }), ext).toBeNull();
    }
  });

  it('chặn tệp chạy được và tệp không có đuôi', () => {
    for (const name of ['setup.exe', 'run.sh', 'a.bat', 'page.html', 'khong-co-duoi', '.pdf', 'tep.']) {
      expect(checkClientFile({ name, size: 10 }), name).toBe('file_type_not_allowed');
      expect(isAllowedExtension(name), name).toBe(false);
    }
  });

  it('chặn tệp rỗng và tệp quá cỡ, đúng ở ranh giới 20 MB', () => {
    expect(checkClientFile({ name: 'a.pdf', size: 0 })).toBe('file_empty');
    expect(checkClientFile({ name: 'a.pdf', size: FILE_MAX_BYTES })).toBeNull();
    expect(checkClientFile({ name: 'a.pdf', size: FILE_MAX_BYTES + 1 })).toBe('file_too_large');
  });

  it('loại tệp được xét trước cỡ: tệp .exe rỗng báo sai loại', () => {
    expect(checkClientFile({ name: 'a.exe', size: 0 })).toBe('file_type_not_allowed');
  });

  it('lấy phần mở rộng từ tên có đường dẫn hoặc nhiều dấu chấm', () => {
    expect(fileExtension('C:\\Van ban\\Cong van 12.v2.DOCX')).toBe('docx');
    expect(fileExtension('/tmp/a.b/c')).toBe('');
  });
});

describe('tên tệp gửi lên', () => {
  it('giữ nguyên tên ngắn, bỏ đường dẫn', () => {
    expect(uploadName('C:\\x\\Công văn 12.docx')).toBe('Công văn 12.docx');
  });

  it('tên quá 255 ký tự thì cắt phần đầu nhưng giữ đuôi', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const out = uploadName(long);
    expect(out.length).toBe(255);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('định dạng cỡ tệp', () => {
  it('byte, KB, MB theo kiểu Việt Nam (dấu phẩy thập phân)', () => {
    expect(formatBytes(850)).toBe('850 byte');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3,2 MB');
    expect(formatBytes(FILE_MAX_BYTES)).toBe('20 MB');
  });
});

describe('trạng thái các tệp đang soạn', () => {
  const items: FileItem[] = [
    { localId: 'a', id: 'id-a', name: 'a.pdf', sizeBytes: 1, status: 'done' },
    { localId: 'b', id: null, name: 'b.pdf', sizeBytes: 1, status: 'uploading' },
    { localId: 'c', id: null, name: 'c.exe', sizeBytes: 1, status: 'error', error: 'sai loại' },
  ];

  it('chỉ lấy id của tệp đã tải xong', () => {
    expect(readyFileIds(items)).toEqual(['id-a']);
  });

  it('nhận ra còn tệp đang tải', () => {
    expect(isUploading(items)).toBe(true);
    expect(isUploading(items.filter((i) => i.status !== 'uploading'))).toBe(false);
  });
});

describe('gom hồ sơ của lượt chạy', () => {
  const files = [
    view({ id: 'f1', name: 'chi-thi.pdf', uploadedAt: '2026-10-01T01:00:00.000Z', fieldKey: 'attachments' }),
    view({ id: 'f2', name: 'ban-nhap-1.docx', uploadedAt: '2026-10-03T01:00:00.000Z', stepId: 's-soan', stepTitle: 'Soạn văn bản', fieldKey: '__compiled', compiled: true }),
    view({ id: 'f3', name: 'ban-nhap-2.docx', uploadedAt: '2026-10-04T01:00:00.000Z', stepId: 's-soan', stepTitle: 'Soạn văn bản', fieldKey: '__compiled', compiled: true }),
    view({ id: 'f4', name: 'noi-dung-phong-a.docx', uploadedAt: '2026-10-02T01:00:00.000Z', stepId: 's-gop', stepTitle: 'Các phòng góp nội dung' }),
    view({ id: 'f5', name: 'noi-dung-phong-b.docx', uploadedAt: '2026-10-02T05:00:00.000Z', stepId: 's-gop', stepTitle: 'Các phòng góp nội dung' }),
    view({ id: 'f6', name: 'phu-luc.xlsx', uploadedAt: '2026-10-05T01:00:00.000Z', stepId: 's-soan', stepTitle: 'Soạn văn bản' }),
  ];

  it('bản trình duyệt là tệp tổng hợp mới nhất; bản cũ hơn xếp riêng, mới nhất trước', () => {
    const g = groupRunFiles(files);
    expect(g.presented?.id).toBe('f3');
    expect(g.earlierCompiled.map((f) => f.id)).toEqual(['f2']);
    expect(presentedFile(files)?.id).toBe('f3');
  });

  it('tài liệu khởi chạy là tệp không thuộc việc nào và không phải tệp tổng hợp', () => {
    expect(groupRunFiles(files).initial.map((f) => f.id)).toEqual(['f1']);
  });

  it('tệp theo từng việc: không lặp tệp tổng hợp, nhóm có tệp mới nhất ở trên, tệp mới nhất trước', () => {
    const g = groupRunFiles(files);
    expect(g.byStep.map((s) => s.stepId)).toEqual(['s-soan', 's-gop']);
    expect(g.byStep[0]?.files.map((f) => f.id)).toEqual(['f6']);
    expect(g.byStep[1]?.files.map((f) => f.id)).toEqual(['f5', 'f4']);
    expect(g.byStep[1]?.stepTitle).toBe('Các phòng góp nội dung');
  });

  it('chưa có tệp tổng hợp thì không có bản trình duyệt', () => {
    const g = groupRunFiles(files.filter((f) => !f.compiled));
    expect(g.presented).toBeNull();
    expect(g.earlierCompiled).toEqual([]);
  });

  it('không có tệp thì mọi nhóm đều rỗng', () => {
    expect(groupRunFiles([])).toEqual({ presented: null, presentedExtras: [], earlierCompiled: [], initial: [], extra: [], byStep: [] });
  });

  it('tài liệu đính thêm sau khi khởi chạy có nhóm riêng, không lẫn vào tài liệu khởi chạy', () => {
    const files = [
      view({ id: 'f1', fieldKey: 'tep', stepId: null, uploadedAt: '2026-10-12T01:00:00.000Z' }),
      view({ id: 'x1', fieldKey: '__extra', stepId: null, uploadedAt: '2026-10-12T02:00:00.000Z' }),
      view({ id: 'x2', fieldKey: '__extra', stepId: null, uploadedAt: '2026-10-12T03:00:00.000Z' }),
    ];
    const g = groupRunFiles(files);
    expect(g.initial.map((f) => f.id)).toEqual(['f1']);
    expect(g.extra.map((f) => f.id)).toEqual(['x2', 'x1']);
    expect(g.byStep).toEqual([]);
  });

  it('cùng thời điểm tải thì xếp theo id, id lớn hơn (mới hơn) trước', () => {
    const same = [view({ id: 'a1', compiled: true }), view({ id: 'a2', compiled: true })];
    expect(groupRunFiles(same).presented?.id).toBe('a2');
  });

  describe('mỗi lần xuất ra một tệp Word và một bản PDF', () => {
    // Hai tệp của một lần xuất cùng thời điểm; PDF dựng sau nên id lớn hơn (UUID v7 tăng theo thời gian).
    const pair = (n: number, at: string) => [
      view({ id: `w${n}`, name: `bao-cao-${n}.docx`, uploadedAt: at, stepId: 's-soan', stepTitle: 'Soạn văn bản', fieldKey: '__compiled', compiled: true }),
      view({ id: `w${n}p`, name: `bao-cao-${n}.pdf`, uploadedAt: at, stepId: 's-soan', stepTitle: 'Soạn văn bản', fieldKey: '__compiled', compiled: true, renditionOf: `w${n}` }),
    ];
    const exports = [...pair(1, '2026-10-03T01:00:00.000Z'), ...pair(2, '2026-10-04T01:00:00.000Z'), view({ id: 'f1', name: 'chi-thi.pdf' })];

    it('xếp theo lần xuất, mới nhất trước; trong mỗi lần Word đứng trước PDF', () => {
      expect(orderCompiled(exports).map((f) => f.id)).toEqual(['w2', 'w2p', 'w1', 'w1p']);
      expect(orderCompiled([...exports].reverse()).map((f) => f.id)).toEqual(['w2', 'w2p', 'w1', 'w1p']);
    });

    it('bản trình duyệt là tệp Word mới nhất, bản PDF của nó đi kèm; lần xuất cũ vẫn đủ cặp', () => {
      const g = groupRunFiles(exports);
      expect(g.presented?.id).toBe('w2');
      expect(g.presentedExtras.map((f) => f.id)).toEqual(['w2p']);
      expect(g.earlierCompiled.map((f) => f.id)).toEqual(['w1', 'w1p']);
      expect(presentedFile(exports)?.id).toBe('w2');
      expect(presentedFiles(exports).map((f) => f.id)).toEqual(['w2', 'w2p']);
    });

    it('bản PDF không lọt vào tệp theo từng việc hay tài liệu khởi chạy', () => {
      const g = groupRunFiles(exports);
      expect(g.initial.map((f) => f.id)).toEqual(['f1']);
      expect(g.byStep).toEqual([]);
    });

    it('PDF mà tệp Word của nó không còn trong danh sách vẫn hiện như một tệp tổng hợp riêng', () => {
      const lone = exports.filter((f) => f.id === 'w2p');
      expect(orderCompiled(lone).map((f) => f.id)).toEqual(['w2p']);
      expect(groupRunFiles(lone).presented?.id).toBe('w2p');
    });

    it('chưa có tệp tổng hợp thì không có gì để trình duyệt', () => {
      expect(presentedFiles([view({ id: 'x' })])).toEqual([]);
    });
  });

  it('tra tệp theo id giữ thứ tự và đếm id không thấy', () => {
    const { found, missing } = filesByIds(files, ['f5', 'khong-co', 'f1']);
    expect(found.map((f) => f.id)).toEqual(['f5', 'f1']);
    expect(missing).toBe(1);
  });
});
