import type { FileView } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { openErrorText, FileOpenError } from '../src/features/file-download';
import { fileKind, fileMetaText, fileOriginText, groupFilesForStep, isFileId, localFileName, shareMimeType } from '../src/features/file-list';

const LAN = { id: '0199d000-0000-7000-8000-000000000001', fullName: 'Nguyễn Thu Lan', givenName: 'Lan', honorific: 'chi' as const };
const RUN = '0199e000-0000-7000-8000-00000000aaaa';
const STEP_A = '0199e000-0000-7000-8000-0000000000a1';
const STEP_B = '0199e000-0000-7000-8000-0000000000b1';

let seq = 0;
function file(over: Partial<FileView> = {}): FileView {
  seq += 1;
  return {
    id: `0199f000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    name: 'Chi thi so 03.pdf',
    mime: 'application/pdf',
    sizeBytes: 1_258_291,
    uploadedBy: LAN,
    uploadedAt: '2026-10-15T03:00:00Z',
    fieldKey: 'tep',
    runId: RUN,
    stepId: null,
    stepTitle: null,
    compiled: false,
    renditionOf: null,
    status: 'attached',
    ...over,
  };
}

describe('xem tệp: loại, cỡ và nguồn gốc', () => {
  it('loại tệp theo đuôi, bằng chữ để biết nên mở bằng gì', () => {
    expect(fileKind('a.PDF')).toBe('pdf');
    expect(['a.doc', 'a.docx', 'a.odt', 'a.rtf'].map(fileKind)).toEqual(['document', 'document', 'document', 'document']);
    expect(['a.xls', 'a.xlsx', 'a.ods', 'a.csv'].map(fileKind)).toEqual(['sheet', 'sheet', 'sheet', 'sheet']);
    expect(['a.ppt', 'a.pptx'].map(fileKind)).toEqual(['slides', 'slides']);
    expect(['a.png', 'a.jpg', 'a.jpeg', 'a.gif'].map(fileKind)).toEqual(['image', 'image', 'image', 'image']);
    expect([fileKind('a.txt'), fileKind('a.zip'), fileKind('khongduoi')]).toEqual(['text', 'archive', 'other']);
  });

  it('dòng loại và cỡ', () => {
    expect(fileMetaText({ name: 'Chi thi.pdf', sizeBytes: 1_258_291 })).toBe('PDF, 1,2 MB');
    expect(fileMetaText({ name: 'bao-cao.docx', sizeBytes: 20_480 })).toBe('Văn bản, 20 KB');
    expect(fileMetaText({ name: 'scan.jpg', sizeBytes: 900 })).toBe('Ảnh, 900 byte');
  });

  it('dòng nguồn gốc: ai tải lên lúc nào (giờ Việt Nam); tệp tổng hợp do máy chủ dựng thì ghi rõ là tệp tổng hợp', () => {
    expect(fileOriginText(file({ uploadedAt: '2026-10-15T03:00:00Z' }))).toBe('chị Nguyễn Thu Lan tải lên, Thứ Năm 15/10/2026, 10:00');
    expect(fileOriginText(file({ uploadedBy: null, compiled: true, uploadedAt: '2026-10-15T03:00:00Z' }))).toBe('Tệp tổng hợp, Thứ Năm 15/10/2026, 10:00');
    expect(fileOriginText(file({ uploadedBy: null }))).toBe('Thứ Năm 15/10/2026, 10:00');
    // bản PDF dựng cùng tệp Word tổng hợp
    expect(fileOriginText(file({ uploadedBy: null, compiled: true, renditionOf: file().id }))).toBe('Bản PDF của tệp tổng hợp, Thứ Năm 15/10/2026, 10:00');
  });
});

describe('xem tệp: gom tệp của lượt chạy quanh một việc', () => {
  it('chia thành tệp của việc này, tài liệu khởi chạy lượt, và tệp ở các việc khác; gộp hai nguồn không trùng', () => {
    const own1 = file({ stepId: STEP_A, stepTitle: 'Thực hiện chỉ thị', uploadedAt: '2026-10-15T04:00:00Z' });
    const own2 = file({ stepId: STEP_A, stepTitle: 'Thực hiện chỉ thị', uploadedAt: '2026-10-15T05:00:00Z' });
    const initial = file({ stepId: null });
    const other = file({ stepId: STEP_B, stepTitle: 'Tiếp nhận chỉ thị' });
    // chi tiết việc có own1 và own2; tệp của lượt có đủ bốn tệp (own1 trùng)
    const groups = groupFilesForStep(STEP_A, [own1, own2], [other, initial, own1]);
    expect(groups.own.map((f) => f.id)).toEqual([own2.id, own1.id]);
    expect(groups.initial.map((f) => f.id)).toEqual([initial.id]);
    expect(groups.other).toEqual([{ stepId: STEP_B, stepTitle: 'Tiếp nhận chỉ thị', files: [other] }]);
    expect(groups.total).toBe(4);
  });

  it('chưa tải được lượt chạy thì vẫn thấy tệp của chính việc (có sẵn trong chi tiết việc); không có gì thì rỗng', () => {
    const own = file({ stepId: STEP_A });
    expect(groupFilesForStep(STEP_A, [own], undefined)).toMatchObject({ own: [own], initial: [], other: [], total: 1 });
    expect(groupFilesForStep(STEP_A, undefined, undefined)).toEqual({ own: [], initial: [], other: [], total: 0 });
  });

  it('các việc khác xếp việc có tệp mới nhất lên trước, mỗi việc một nhóm', () => {
    const olderB = file({ stepId: STEP_B, stepTitle: 'B', uploadedAt: '2026-10-10T03:00:00Z' });
    const newerC = file({ stepId: '0199e000-0000-7000-8000-0000000000c1', stepTitle: 'C', uploadedAt: '2026-10-14T03:00:00Z' });
    const groups = groupFilesForStep(STEP_A, [], [olderB, newerC]);
    expect(groups.other.map((g) => g.stepTitle)).toEqual(['C', 'B']);
  });
});

describe('mở tệp: tên tệp tạm và loại nội dung', () => {
  it('tên tệp tạm bỏ đường dẫn và ký tự hệ điều hành không nhận, giữ chữ có dấu và đuôi', () => {
    expect(localFileName('Chỉ thị số 03.pdf')).toBe('Chỉ thị số 03.pdf');
    expect(localFileName('../../etc/passwd')).toBe('passwd');
    expect(localFileName('a:b*c?d"e<f>g|h#i%j.pdf')).toBe('abcdefghij.pdf');
    expect(localFileName('   ')).toBe('tep');
    expect(localFileName('..')).toBe('tep');
    const long = localFileName(`${'x'.repeat(300)}.docx`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.docx')).toBe(true);
  });

  it('loại nội dung cho hộp chia sẻ bỏ phần tham số; loại lạ thì dùng loại chung', () => {
    expect(shareMimeType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(shareMimeType('application/pdf')).toBe('application/pdf');
    expect(shareMimeType('')).toBe('application/octet-stream');
    expect(shareMimeType('không phải loại')).toBe('application/octet-stream');
  });

  it('chỉ id đúng dạng UUID mới được ghép vào đường dẫn tệp tạm', () => {
    expect(isFileId('0199f000-0000-7000-8000-000000000001')).toBe(true);
    expect(isFileId('../..')).toBe(false);
    expect(isFileId('')).toBe(false);
  });

  it('câu lỗi khi mở tệp: cần mạng, máy không mở được, không lưu được; lỗi máy chủ dùng bảng lỗi của app', () => {
    expect(openErrorText(new FileOpenError('need_network'))).toContain('mạng');
    expect(openErrorText(new FileOpenError('share_unavailable'))).toContain('chưa có cách mở');
    expect(openErrorText(new FileOpenError('save_failed'))).toContain('bộ nhớ');
    expect(openErrorText(new TypeError('Network request failed'))).toContain('Không kết nối được');
    expect(openErrorText(new Error('lỗi lạ của hệ điều hành'))).not.toContain('lỗi lạ');
  });
});
