import { FORM_LIMITS, type FileView, type FormField, type PersonRef } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import {
  asFormFields,
  attachedFileIds,
  buildPersonIndex,
  describeValue,
  displayValue,
  fieldCodeText,
  fieldErrorsFromProblem,
  hasInput,
  hasUploading,
  needsFileUpload,
  personIdsIn,
  proposalInputs,
  toPayload,
  validateFields,
  type FieldValues,
} from '../src/features/runs/field-values';
import { codeMessage, errorMessage } from '../src/lib/errors';
import type { FileItem } from '../src/lib/files';
import { ApiError } from '@mihato/api-client';

const person = (id: string, fullName: string, givenName: string, honorific: PersonRef['honorific'] = null): PersonRef => ({ id, fullName, givenName, honorific });
const picked = (id: string, fullName = 'Nguyễn Thu Lan', givenName = 'Lan') => person(id, fullName, givenName, 'chi');
const item = (localId: string, status: FileItem['status'], id: string | null = null): FileItem => ({ localId, id, name: `${localId}.pdf`, sizeBytes: 100, status });

const FIELDS: FormField[] = [
  { key: 'title', label: 'Trích yếu', type: 'text', required: true },
  { key: 'body', label: 'Nội dung', type: 'longtext' },
  { key: 'due', label: 'Hạn trả lời', type: 'date' },
  { key: 'amount', label: 'Số tiền', type: 'money' },
  { key: 'owner', label: 'Người chủ trì', type: 'user', required: true },
  { key: 'units', label: 'Đơn vị phối hợp', type: 'users' },
  { key: 'scan', label: 'Bản quét', type: 'file', required: true },
  { key: 'extra', label: 'Phụ lục', type: 'file', multiple: true },
  { key: 'no', label: 'Số văn bản', type: 'autonumber', required: true, register: 'VBDEN' },
];

describe('validateFields với các loại ô mới', () => {
  it('ô bắt buộc để trống: báo lỗi; ô số văn bản (autonumber) không bao giờ bắt buộc nhập', () => {
    const errors = validateFields(FIELDS, {});
    expect(Object.keys(errors).sort()).toEqual(['owner', 'scan', 'title']);
  });

  it('ô tệp bắt buộc cần ít nhất một tệp đã tải xong; tệp lỗi không tính', () => {
    const base: FieldValues = { title: 'x', owner: picked('u1') };
    expect(validateFields(FIELDS, { ...base, scan: [item('a', 'error')] }).scan).toBeTruthy();
    expect(validateFields(FIELDS, { ...base, scan: [item('a', 'done', 'id-a')] }).scan).toBeUndefined();
  });

  it('còn tệp đang tải thì báo "đang tải", kể cả ô không bắt buộc', () => {
    const base: FieldValues = { title: 'x', owner: picked('u1'), scan: [item('a', 'done', 'id-a')] };
    const errors = validateFields(FIELDS, { ...base, extra: [item('b', 'uploading')] });
    expect(errors.extra).toContain('Đang tải');
    expect(hasUploading(FIELDS, { ...base, extra: [item('b', 'uploading')] })).toBe(true);
    expect(hasUploading(FIELDS, base)).toBe(false);
  });

  it('ô một tệp không nhận hai tệp; ô nhiều tệp nhận tới giới hạn của miền', () => {
    const base: FieldValues = { title: 'x', owner: picked('u1') };
    const two = [item('a', 'done', 'a'), item('b', 'done', 'b')];
    expect(validateFields(FIELDS, { ...base, scan: two }).scan).toContain('1');
    const many = Array.from({ length: FORM_LIMITS.files + 1 }, (_, i) => item(`m${i}`, 'done', `id${i}`));
    expect(validateFields(FIELDS, { ...base, scan: [item('a', 'done', 'a')], extra: many }).extra).toContain(String(FORM_LIMITS.files));
  });

  it('ô nhiều người và ô nhiều dòng có giới hạn', () => {
    const base: FieldValues = { title: 'x', owner: picked('u1'), scan: [item('a', 'done', 'a')] };
    const crowd = Array.from({ length: FORM_LIMITS.users + 1 }, (_, i) => picked(`u${i}`));
    expect(validateFields(FIELDS, { ...base, units: crowd }).units).toContain(String(FORM_LIMITS.users));
    expect(validateFields(FIELDS, { ...base, body: 'a'.repeat(FORM_LIMITS.longtext + 1) }).body).toBeTruthy();
    expect(validateFields(FIELDS, { ...base, body: 'a'.repeat(FORM_LIMITS.longtext) }).body).toBeUndefined();
    expect(validateFields(FIELDS, { ...base, title: 'a'.repeat(FORM_LIMITS.text + 1) }).title).toBeTruthy();
  });

  it('kiểm kiểu số tiền và ngày như trước', () => {
    const base: FieldValues = { title: 'x', owner: picked('u1'), scan: [item('a', 'done', 'a')] };
    expect(validateFields(FIELDS, { ...base, amount: '12,5' }).amount).toBeTruthy();
    expect(validateFields(FIELDS, { ...base, due: '06/10/2026' }).due).toBeTruthy();
    expect(validateFields(FIELDS, { ...base, amount: '20000000', due: '2026-10-06' })).toEqual({});
  });
});

describe('toPayload', () => {
  const values: FieldValues = {
    title: '  Công văn số 12  ',
    body: '  Dòng một\nDòng hai  ',
    due: '2026-10-20',
    amount: '20000000',
    owner: picked('u-owner'),
    units: [picked('u1'), picked('u2')],
    scan: [item('a', 'done', 'file-a'), item('x', 'error'), item('y', 'uploading')],
    extra: [item('b', 'done', 'file-b'), item('c', 'done', 'file-c')],
    no: 'tự gõ',
  };

  it('đổi từng loại ô sang kiểu máy chủ nhận', () => {
    expect(toPayload(FIELDS, values)).toEqual({
      title: 'Công văn số 12',
      body: 'Dòng một\nDòng hai',
      due: '2026-10-20',
      amount: 20000000,
      owner: 'u-owner',
      units: ['u1', 'u2'],
      scan: ['file-a'],
      extra: ['file-b', 'file-c'],
    });
  });

  it('không gửi ô số văn bản (máy chủ cấp), ô trống, hay ô tệp chưa có tệp nào xong', () => {
    const out = toPayload(FIELDS, { title: 'x', units: [], scan: [item('x', 'error')] });
    expect(out).toEqual({ title: 'x' });
  });

  it('gom id tệp của mọi ô tệp, không trùng, để gửi ở fileIds', () => {
    expect(attachedFileIds(FIELDS, { ...values, extra: [item('b', 'done', 'file-a'), item('c', 'done', 'file-c')] })).toEqual(['file-a', 'file-c']);
  });
});

describe('hasInput và đề xuất "Trình"', () => {
  it('ô tệp có tệp lỗi vẫn tính là đã thao tác (để hiện lỗi ngay)', () => {
    const scan = FIELDS.find((f) => f.key === 'scan')!;
    expect(hasInput(scan, [item('x', 'error')])).toBe(true);
    expect(hasInput(scan, [])).toBe(false);
    expect(hasInput(scan, undefined)).toBe(false);
  });

  it('đề xuất bỏ ô tệp và ô số văn bản, nối nhiều người bằng dấu phẩy', () => {
    const payload = toPayload(FIELDS, { title: 'x', owner: picked('u1'), units: [picked('u2'), picked('u3')], scan: [item('a', 'done', 'file-a')] });
    expect(proposalInputs(FIELDS, payload)).toEqual([
      { key: 'title', value: 'x' },
      { key: 'owner', value: 'u1' },
      { key: 'units', value: 'u2,u3' },
    ]);
  });

  it('mẫu có ô tệp bắt buộc thì không trình qua đề xuất được', () => {
    expect(needsFileUpload(FIELDS)).toBe(true);
    expect(needsFileUpload(FIELDS.filter((f) => f.key !== 'scan'))).toBe(false);
  });
});

describe('asFormFields', () => {
  it('giữ loại ô mới, multiple, hint, register; kiểu lạ thì coi là chữ', () => {
    const out = asFormFields([
      { key: 'a', label: 'A', type: 'longtext', hint: 'Gợi ý' },
      { key: 'b', label: 'B', type: 'file', multiple: true },
      { key: 'c', label: 'C', type: 'autonumber', register: 'VBDI' },
      { key: 'd', label: 'D', type: 'users' },
      { key: 'e', label: 'E', type: 'lạ' },
    ]);
    expect(out.map((f) => f.type)).toEqual(['longtext', 'file', 'autonumber', 'users', 'text']);
    expect(out[0]?.hint).toBe('Gợi ý');
    expect(out[1]?.multiple).toBe(true);
    expect(out[2]?.register).toBe('VBDI');
    expect(out[3]?.multiple).toBeUndefined();
  });
});

describe('hiện lại giá trị đã lưu', () => {
  const file = (id: string, name: string): FileView => ({
    id,
    name,
    mime: 'application/pdf',
    sizeBytes: 10,
    uploadedBy: null,
    uploadedAt: '2026-10-06T01:00:00.000Z',
    fieldKey: 'scan',
    runId: 'r',
    stepId: null,
    stepTitle: null,
    compiled: false,
    renditionOf: null,
    status: 'attached',
  });
  const people = buildPersonIndex([person('u1', 'Nguyễn Thu Lan', 'Lan', 'chi'), person('u2', 'Trần Văn Hùng', 'Hùng', 'anh'), null, undefined]);

  it('ngày hiện dd/mm/yyyy, tiền hiện có chữ đồng', () => {
    expect(displayValue({ type: 'date' }, '2026-10-06')).toBe('06/10/2026');
    expect(displayValue({ type: 'money' }, 20000000)).toBe('20.000.000 đồng');
  });

  it('một người và nhiều người hiện tên có xưng hô; id không tra được hiện "Một người"', () => {
    expect(displayValue({ type: 'user' }, 'u1', { people })).toBe('chị Nguyễn Thu Lan');
    expect(displayValue({ type: 'users' }, ['u1', 'u2', 'u-la'], { people })).toBe('chị Nguyễn Thu Lan, anh Trần Văn Hùng, Một người');
    expect(describeValue({ type: 'users' }, ['u1', 'u2'], { people })).toEqual({ kind: 'list', items: ['chị Nguyễn Thu Lan', 'anh Trần Văn Hùng'] });
  });

  it('tệp tra theo id; id không thấy được đếm riêng', () => {
    const files = [file('f1', 'chi-thi.pdf'), file('f2', 'phu-luc.pdf')];
    const d = describeValue({ type: 'file' }, ['f2', 'f-la', 'f1'], { files });
    expect(d).toMatchObject({ kind: 'files', missing: 1 });
    expect(d.kind === 'files' && d.files.map((f) => f.name)).toEqual(['phu-luc.pdf', 'chi-thi.pdf']);
    expect(displayValue({ type: 'file' }, ['f1'], { files })).toBe('chi-thi.pdf');
  });

  it('ô nhiều dòng giữ xuống dòng, ô chữ thì không', () => {
    expect(describeValue({ type: 'longtext' }, 'một\nhai')).toEqual({ kind: 'text', text: 'một\nhai', multiline: true });
    expect(describeValue({ type: 'text' }, 'một')).toEqual({ kind: 'text', text: 'một', multiline: false });
  });

  it('giá trị rỗng, mảng rỗng đều là "chưa điền"', () => {
    for (const v of [null, undefined, '', []]) expect(describeValue({ type: 'file' }, v)).toEqual({ kind: 'empty' });
    expect(displayValue({ type: 'text' }, '')).toBe('Chưa điền');
  });

  it('ô chọn hiện nhãn của mục', () => {
    expect(displayValue({ type: 'select', options: [{ value: 'mat', label: 'Mật' }] }, 'mat')).toBe('Mật');
  });

  it('tìm id người cần tra tên trong các ô chọn người', () => {
    expect(personIdsIn(FIELDS, { owner: 'u1', units: ['u1', 'u2'], title: 'x' }).sort()).toEqual(['u1', 'u2']);
  });
});

describe('lỗi 422 từng ô của máy chủ', () => {
  const text = (code: string) => fieldCodeText(code, codeMessage);

  it('khớp theo khoá ô trần hoặc đoạn cuối của đường dẫn', () => {
    const out = fieldErrorsFromProblem(
      FIELDS,
      [
        { path: 'scan', code: 'file_too_large' },
        { path: 'body.inputs.title', code: 'required' },
        { path: 'body.khong-co-o-nay', code: 'invalid_type' },
      ],
      text,
    );
    expect(Object.keys(out).sort()).toEqual(['scan', 'title']);
    expect(out.scan).toContain('Tệp lớn hơn');
    expect(out.title).toBe('Xin điền ô này.');
  });

  it('mã chưa có câu riêng thì dùng câu chung, không lộ mã', () => {
    const out = fieldErrorsFromProblem(FIELDS, [{ path: 'title', code: 'ma_la_hoac' }], text);
    expect(out.title).not.toContain('ma_la_hoac');
    expect(out.title).toBeTruthy();
  });

  it('errorMessage nói rõ mã con của tệp và của việc tổng hợp', () => {
    const tooBig = new ApiError('input_invalid', { errors: [{ path: 'body.data', code: 'file_too_large' }] });
    expect(errorMessage(tooBig)).toContain('Tệp lớn hơn');
    const compile = new ApiError('input_invalid', { errors: [{ path: 'body', code: 'compile_required' }] });
    expect(errorMessage(compile)).toContain('xuất tệp tổng hợp');
    const plain = new ApiError('input_invalid', { errors: [{ path: 'body.x', code: 'required' }] });
    expect(errorMessage(plain)).toBe(codeMessage('input_invalid'));
  });

  it('mọi mã lỗi tệp mới của máy chủ đều có câu tiếng Việt riêng', () => {
    for (const code of ['file_unavailable', 'file_type_not_allowed', 'file_content_mismatch', 'file_too_large', 'invalid_base64', 'file_empty', 'compile_required', 'register_unknown']) {
      const err = new ApiError('input_invalid', { errors: [{ path: 'body', code }] });
      expect(errorMessage(err), code).not.toBe(codeMessage('input_invalid'));
    }
  });
});
