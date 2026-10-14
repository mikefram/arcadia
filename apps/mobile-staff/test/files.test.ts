import { ApiError, FILE_EXTENSIONS, FILE_MAX_BYTES, FORM_LIMITS, type FormField } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import {
  buildUploadBody,
  checkClientFile,
  fileExtension,
  fileFieldState,
  fileProblemText,
  fileRulesText,
  formatBytes,
  isAllowedExtension,
  isRetryable,
  maxFilesOf,
  patchItem,
  planPick,
  problemCodeOf,
  readyFileIds,
  removeItem,
  uploadName,
  type FileItem,
} from '../src/features/files';
import { buildResult, webOnlyRequired } from '../src/features/result-form';

const item = (over: Partial<FileItem> = {}): FileItem => ({ localId: 'a', id: null, name: 'cv.pdf', sizeBytes: 1000, status: 'uploading', problem: null, ...over });

describe('tệp: kiểm ở máy khách trước khi tải lên', () => {
  it('đuôi tệp lấy theo tên, không phân biệt hoa thường, bỏ đường dẫn', () => {
    expect(fileExtension('Công văn 12.PDF')).toBe('pdf');
    expect(fileExtension('/storage/emulated/0/Download/bao-cao.docx')).toBe('docx');
    expect(fileExtension('C:\\tai-lieu\\anh.JPeg')).toBe('jpeg');
    expect(fileExtension('khongduoi')).toBe('');
    expect(fileExtension('.bashrc')).toBe('');
    expect(fileExtension('ketthuc.')).toBe('');
  });

  it('chỉ nhận đúng các đuôi trong hợp đồng; tệp chạy được bị chặn', () => {
    for (const ext of FILE_EXTENSIONS) expect(isAllowedExtension(`tep.${ext}`)).toBe(true);
    for (const bad of ['setup.exe', 'run.sh', 'a.apk', 'a.js', 'a.html', 'a.svg', 'a']) expect(isAllowedExtension(bad)).toBe(false);
  });

  it('báo tệp sai đuôi, tệp rỗng, tệp quá 20 MB; đúng 20 MB vẫn nhận', () => {
    expect(checkClientFile({ name: 'a.pdf', size: 1 })).toBeNull();
    expect(checkClientFile({ name: 'a.pdf', size: FILE_MAX_BYTES })).toBeNull();
    expect(checkClientFile({ name: 'a.pdf', size: FILE_MAX_BYTES + 1 })).toBe('file_too_large');
    expect(checkClientFile({ name: 'a.pdf', size: 0 })).toBe('file_empty');
    expect(checkClientFile({ name: 'a.exe', size: 10 })).toBe('file_type_not_allowed');
    // đuôi sai được báo trước, kể cả khi tệp rỗng
    expect(checkClientFile({ name: 'a.exe', size: 0 })).toBe('file_type_not_allowed');
  });

  it('tên gửi lên bỏ đường dẫn, chuẩn hoá NFC, cắt tên quá 255 ký tự nhưng giữ đuôi', () => {
    expect(uploadName('/data/user/0/tep/Báo cáo.pdf')).toBe('Báo cáo.pdf');
    // "ế" dạng tổ hợp (e + dấu mũ + dấu sắc) được gộp về dạng dựng sẵn
    expect(uploadName('Tie\u0302\u0301n.pdf')).toBe('Tiến.pdf');
    const long = `${'a'.repeat(300)}.docx`;
    const cut = uploadName(long);
    expect(cut).toHaveLength(255);
    expect(cut.endsWith('.docx')).toBe(true);
  });

  it('câu hướng dẫn nêu đúng cỡ tối đa và các loại nhận', () => {
    const text = fileRulesText();
    expect(text).toContain('20 MB');
    for (const ext of FILE_EXTENSIONS) expect(text).toContain(ext);
    expect(text).not.toMatch(/[{}]/);
  });

  it('cỡ tệp viết theo kiểu Việt Nam: dấu phẩy thập phân, tối đa một chữ số lẻ', () => {
    expect(formatBytes(0)).toBe('0 byte');
    expect(formatBytes(850)).toBe('850 byte');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(12.5 * 1024)).toBe('12,5 KB');
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3,2 MB');
    expect(formatBytes(FILE_MAX_BYTES)).toBe('20 MB');
  });
});

describe('tệp: thân của POST /v1/files', () => {
  it('dựng đúng { name, data }; nội dung base64 trơn', () => {
    expect(buildUploadBody('/tmp/a/Công văn.pdf', 'JVBERi0xLjQ=')).toEqual({ name: 'Công văn.pdf', data: 'JVBERi0xLjQ=' });
  });

  it('bỏ tiền tố data URL nếu có', () => {
    expect(buildUploadBody('a.png', 'data:image/png;base64,iVBORw0KGgo=')).toEqual({ name: 'a.png', data: 'iVBORw0KGgo=' });
  });

  it('không dựng thân sai hợp đồng: nội dung rỗng hoặc tên rỗng', () => {
    expect(() => buildUploadBody('a.pdf', '')).toThrow();
    expect(() => buildUploadBody('', 'JVBERi0xLjQ=')).toThrow();
  });
});

describe('tệp: kế hoạch khi chọn tệp cho một ô', () => {
  let n = 0;
  const makeId = () => `id-${(n += 1)}`;
  const multi: Pick<FormField, 'multiple'> = { multiple: true };
  const single: Pick<FormField, 'multiple'> = {};

  it('số tệp tối đa: 1 với ô một tệp, 20 với ô nhiều tệp', () => {
    expect(maxFilesOf(single)).toBe(1);
    expect(maxFilesOf(multi)).toBe(FORM_LIMITS.files);
  });

  it('ô nhiều tệp giữ các tệp đang có và thêm tệp mới, mỗi tệp hợp lệ được tải lên', () => {
    const existing = [item({ localId: 'e1', id: 'f1', status: 'done' })];
    const plan = planPick(existing, [{ name: 'a.pdf', size: 10 }, { name: 'b.docx', size: 20 }], multi, makeId);
    expect(plan.items.map((i) => [i.localId, i.status, i.name])).toEqual([
      ['e1', 'done', 'cv.pdf'],
      ['id-1', 'uploading', 'a.pdf'],
      ['id-2', 'uploading', 'b.docx'],
    ]);
    expect(plan.uploads).toEqual([
      { index: 0, localId: 'id-1' },
      { index: 1, localId: 'id-2' },
    ]);
    expect(plan.discard).toEqual([]);
  });

  it('tệp sai đuôi, rỗng, quá cỡ vào danh sách ở dạng lỗi và không được tải lên; tệp hợp lệ đi cùng vẫn tải', () => {
    const plan = planPick([], [{ name: 'a.exe', size: 5 }, { name: 'b.pdf', size: 0 }, { name: 'c.pdf', size: FILE_MAX_BYTES + 1 }, { name: 'd.pdf', size: 5 }], multi, makeId);
    expect(plan.items.map((i) => [i.name, i.status, i.problem])).toEqual([
      ['a.exe', 'error', 'file_type_not_allowed'],
      ['b.pdf', 'error', 'file_empty'],
      ['c.pdf', 'error', 'file_too_large'],
      ['d.pdf', 'uploading', null],
    ]);
    expect(plan.uploads.map((u) => u.index)).toEqual([3]);
  });

  it('quá 20 tệp thì các tệp thừa báo too_many; tệp lỗi không chiếm chỗ', () => {
    const full = Array.from({ length: FORM_LIMITS.files - 1 }, (_, i) => item({ localId: `x${i}`, id: `f${i}`, status: 'done' }));
    const withBad = [...full, item({ localId: 'bad', status: 'error', problem: 'file_empty' })];
    const plan = planPick(withBad, [{ name: 'a.pdf', size: 1 }, { name: 'b.pdf', size: 1 }], multi, makeId);
    // còn đúng một chỗ: tệp thứ nhất lên, tệp thứ hai thừa
    expect(plan.items.slice(-2).map((i) => [i.name, i.status, i.problem])).toEqual([
      ['a.pdf', 'uploading', null],
      ['b.pdf', 'error', 'too_many'],
    ]);
    expect(plan.uploads).toHaveLength(1);
  });

  it('ô một tệp: tệp mới thay tệp cũ, tệp cũ được đưa vào danh sách bỏ; chỉ nhận tệp đầu khi chọn nhiều', () => {
    const old = [item({ localId: 'old', id: 'f1', status: 'done' }), item({ localId: 'bad', status: 'error', problem: 'file_empty' })];
    const plan = planPick(old, [{ name: 'moi.pdf', size: 5 }, { name: 'thua.pdf', size: 5 }], single, makeId);
    expect(plan.items.map((i) => [i.name, i.status])).toEqual([['moi.pdf', 'uploading']]);
    expect(plan.discard.map((i) => i.localId)).toEqual(['old', 'bad']);
    expect(plan.uploads).toHaveLength(1);
  });

  it('thay đổi danh sách không sửa danh sách cũ', () => {
    const list = [item({ localId: 'a' }), item({ localId: 'b' })];
    expect(patchItem(list, 'a', { status: 'done', id: 'f' })[0]).toMatchObject({ status: 'done', id: 'f' });
    expect(list[0]?.status).toBe('uploading');
    expect(removeItem(list, 'a').map((i) => i.localId)).toEqual(['b']);
  });
});

describe('tệp: trạng thái của các ô tệp trong biểu mẫu', () => {
  const fields: FormField[] = [
    { key: 'tep', label: 'Tài liệu', type: 'file', multiple: true, required: true },
    { key: 'phu', label: 'Phụ lục', type: 'file' },
    { key: 'ghi', label: 'Ghi chú', type: 'text' },
  ];

  it('chỉ lấy id tệp đã tải xong, đúng thứ tự, không trùng', () => {
    const items = [item({ localId: '1', id: 'a', status: 'done' }), item({ localId: '2', id: null, status: 'uploading' }), item({ localId: '3', id: 'b', status: 'done' }), item({ localId: '4', id: 'a', status: 'done' }), item({ localId: '5', status: 'error', problem: 'network' })];
    expect(readyFileIds(items)).toEqual(['a', 'b']);
  });

  it('nhận ra ô nào còn tệp đang tải, ô nào còn tệp lỗi chưa gỡ', () => {
    expect(fileFieldState(fields, {})).toEqual({ uploading: [], failed: [] });
    expect(fileFieldState(fields, { tep: [item({ status: 'uploading' })], phu: [item({ status: 'error', problem: 'network' })] })).toEqual({ uploading: ['tep'], failed: ['phu'] });
    // vừa tải vừa có tệp lỗi thì báo "đang tải" trước
    expect(fileFieldState(fields, { tep: [item({ status: 'uploading' }), item({ localId: 'b', status: 'error', problem: 'network' })] })).toEqual({ uploading: ['tep'], failed: [] });
  });

  it('ô tệp bắt buộc mà chưa có tệp nào tải xong thì báo thiếu như mọi ô khác', () => {
    expect(buildResult(fields, {})).toEqual({ result: undefined, missing: ['tep'], invalid: [] });
    expect(buildResult(fields, {}, { tep: [item({ status: 'uploading' })] }).missing).toEqual(['tep']);
    expect(buildResult(fields, {}, { tep: [item({ status: 'error', problem: 'network' })] }).missing).toEqual(['tep']);
  });

  it('giá trị ô tệp là mảng id tệp đã tải xong, kể cả ô một tệp; ô tệp không bắt buộc để trống thì không gửi', () => {
    const files = { tep: [item({ localId: '1', id: 'a', status: 'done' }), item({ localId: '2', id: 'b', status: 'done' })], phu: [item({ localId: '3', id: 'c', status: 'done' })] };
    expect(buildResult(fields, { ghi: 'Đã đủ' }, files)).toEqual({ result: { tep: ['a', 'b'], phu: ['c'], ghi: 'Đã đủ' }, missing: [], invalid: [] });
    expect(buildResult(fields, {}, { tep: [item({ id: 'a', status: 'done' })] })).toEqual({ result: { tep: ['a'] }, missing: [], invalid: [] });
  });

  it('chỉ ô chọn nhiều người còn phải làm trên web; ô tệp bắt buộc thì không còn bị chặn', () => {
    const withUsers: FormField[] = [...fields, { key: 'nguoi', label: 'Phối hợp', type: 'users', required: true }, { key: 'so', label: 'Số', type: 'autonumber', register: 'VBDI' }];
    expect(webOnlyRequired(withUsers)).toEqual(['nguoi']);
    expect(webOnlyRequired(fields)).toEqual([]);
    // ô chọn nhiều người và ô cấp số không đi vào kết quả gửi từ app
    expect(buildResult(withUsers, { nguoi: 'x', so: 'y' }, { tep: [item({ id: 'a', status: 'done' })] }).result).toEqual({ tep: ['a'] });
  });

  it('chỉ thử lại được lỗi mạng hay máy chủ; lỗi do chính tệp thì phải gỡ rồi chọn tệp khác', () => {
    expect(isRetryable(item({ status: 'error', problem: 'network' }))).toBe(true);
    expect(isRetryable(item({ status: 'error', problem: 'internal_error' }))).toBe(true);
    expect(isRetryable(item({ status: 'error', problem: 'read_failed' }))).toBe(true);
    for (const code of ['file_empty', 'file_too_large', 'file_type_not_allowed', 'file_content_mismatch', 'invalid_base64', 'too_many']) {
      expect(isRetryable(item({ status: 'error', problem: code }))).toBe(false);
    }
    expect(isRetryable(item({ status: 'done' }))).toBe(false);
  });
});

describe('tệp: lỗi bằng chữ', () => {
  it('mã con của máy chủ trong errors[] được ưu tiên hơn mã chung input_invalid', () => {
    const err = new ApiError('input_invalid', { status: 422, errors: [{ path: 'body.data', code: 'file_content_mismatch' }] });
    expect(problemCodeOf(err)).toBe('file_content_mismatch');
    expect(problemCodeOf(new ApiError('input_invalid', { status: 422, errors: [{ path: 'body.x', code: 'lạ' }] }))).toBe('input_invalid');
    expect(problemCodeOf(new ApiError('rate_limited', { status: 429 }))).toBe('rate_limited');
    expect(problemCodeOf(new ApiError('input_invalid', { status: 422, errors: [{ path: 'body.data', code: 'too_many_pending_files' }] }))).toBe('too_many_pending_files');
  });

  it('không tới được máy chủ (fetch ném TypeError) là lỗi mạng', () => {
    expect(problemCodeOf(new TypeError('Network request failed'))).toBe('network');
  });

  it('mỗi mã lỗi của tệp có câu tiếng Việt, điền đúng số, không còn biến chưa điền', () => {
    const codes = ['file_empty', 'file_too_large', 'file_type_not_allowed', 'file_content_mismatch', 'invalid_base64', 'too_many_pending_files', 'file_unavailable', 'too_many', 'read_failed', 'network'];
    for (const code of codes) {
      const text = fileProblemText(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[{}]/);
    }
    expect(fileProblemText('file_too_large')).toContain('20 MB');
    expect(fileProblemText('too_many', 1)).toContain('1 tệp');
    expect(fileProblemText('too_many')).toContain('20 tệp');
  });

  it('mã chung của API dùng câu trong bảng lỗi của app; mã lạ hoặc rỗng dùng câu chung của tệp', () => {
    expect(fileProblemText('rate_limited')).toContain('quá nhiều yêu cầu');
    expect(fileProblemText('forbidden')).toContain('quyền');
    expect(fileProblemText('khong-co-ma-nay')).toBe(fileProblemText(null));
    expect(fileProblemText(null)).toContain('thử lại');
  });
});
