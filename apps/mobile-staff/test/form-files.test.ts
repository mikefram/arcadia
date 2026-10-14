import { ApiError, type FileUpload } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { FormFilesController, type FormFilesDeps, type PickedFile, type UploadedFile } from '../src/features/form-files';

/** Một lời hứa mà test tự quyết lúc nào xong, để điều khiển thứ tự các bước tải lên. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

type UploadCall = { body: FileUpload; key: string; signal: AbortSignal; result: ReturnType<typeof deferred<UploadedFile>> };

function setup() {
  let seq = 0;
  const uploads: UploadCall[] = [];
  const discarded: string[] = [];
  const deps: FormFilesDeps = {
    upload: (body, o) => {
      const result = deferred<UploadedFile>();
      uploads.push({ body, key: o.idempotencyKey, signal: o.signal, result });
      return result.promise;
    },
    discard: async (id) => {
      discarded.push(id);
    },
    newId: () => `id-${(seq += 1)}`,
  };
  const controller = new FormFilesController(deps);
  return { controller, uploads, discarded };
}

function picked(name: string, sizeBytes = 100, data = 'QUJD'): PickedFile & { reads: number; disposed: number } {
  const p = {
    name,
    sizeBytes,
    reads: 0,
    disposed: 0,
    readBase64: async () => {
      p.reads += 1;
      return data;
    },
    dispose: () => {
      p.disposed += 1;
    },
  };
  return p;
}

const field = { key: 'tep', multiple: true } as const;
const one = { key: 'tep' } as const;

describe('FormFilesController: chọn và tải tệp lên', () => {
  it('chọn tệp hợp lệ: hiện đang tải, gửi đúng thân và khoá chống lặp, xong thì có id và trả bản sao tạm', async () => {
    const { controller, uploads } = setup();
    const file = picked('Công văn.pdf', 2048);
    controller.add(field, [file]);
    expect(controller.getSnapshot().tep).toMatchObject([{ name: 'Công văn.pdf', sizeBytes: 2048, status: 'uploading', id: null }]);
    await tick();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.body).toEqual({ name: 'Công văn.pdf', data: 'QUJD' });
    // khoá chống lặp của lần tải đầu chính là khoá cục bộ của tệp
    const localId = controller.getSnapshot().tep?.[0]?.localId;
    expect(uploads[0]?.key).toBe(localId);

    uploads[0]?.result.resolve({ id: 'srv-1', name: 'Công văn.pdf', sizeBytes: 2048 });
    await tick();
    expect(controller.getSnapshot().tep).toMatchObject([{ status: 'done', id: 'srv-1', problem: null }]);
    expect(controller.readyIds('tep')).toEqual(['srv-1']);
    expect(file.disposed).toBe(1);
  });

  it('tệp sai đuôi, rỗng hay quá cỡ không được đọc hay tải lên; bản sao tạm được trả ngay', async () => {
    const { controller, uploads } = setup();
    const bad = picked('setup.exe', 100);
    const empty = picked('trong.pdf', 0);
    const huge = picked('lon.pdf', 21 * 1024 * 1024);
    controller.add(field, [bad, empty, huge]);
    await tick();
    expect(uploads).toHaveLength(0);
    expect([bad, empty, huge].map((f) => f.reads)).toEqual([0, 0, 0]);
    expect([bad, empty, huge].map((f) => f.disposed)).toEqual([1, 1, 1]);
    expect(controller.getSnapshot().tep?.map((i) => [i.status, i.problem])).toEqual([
      ['error', 'file_type_not_allowed'],
      ['error', 'file_empty'],
      ['error', 'file_too_large'],
    ]);
    expect(controller.readyIds('tep')).toEqual([]);
  });

  it('báo cho người nghe mỗi khi danh sách đổi', async () => {
    const { controller, uploads } = setup();
    let calls = 0;
    const off = controller.subscribe(() => (calls += 1));
    controller.add(field, [picked('a.pdf')]);
    const afterAdd = calls;
    expect(afterAdd).toBeGreaterThan(0);
    await tick();
    uploads[0]?.result.resolve({ id: 'srv', name: 'a.pdf', sizeBytes: 100 });
    await tick();
    expect(calls).toBeGreaterThan(afterAdd);
    off();
    controller.add(field, [picked('b.pdf')]);
    const frozen = calls;
    controller.add(field, [picked('c.pdf')]);
    expect(calls).toBe(frozen);
  });
});

describe('FormFilesController: lỗi và thử lại', () => {
  it('mất mạng: tệp báo lỗi mạng; thử lại giữ nguyên khoá chống lặp (máy chủ đã nhận thì trả đúng tệp đó, không tạo bản thứ hai)', async () => {
    const { controller, uploads } = setup();
    controller.add(field, [picked('a.pdf')]);
    await tick();
    uploads[0]?.result.reject(new TypeError('Network request failed'));
    await tick();
    const item = controller.getSnapshot().tep?.[0];
    expect(item).toMatchObject({ status: 'error', problem: 'network' });

    controller.retry('tep', item!.localId);
    expect(controller.getSnapshot().tep?.[0]).toMatchObject({ status: 'uploading', problem: null });
    await tick();
    expect(uploads).toHaveLength(2);
    expect(uploads[1]?.key).toBe(uploads[0]?.key);
    uploads[1]?.result.resolve({ id: 'srv', name: 'a.pdf', sizeBytes: 100 });
    await tick();
    expect(controller.readyIds('tep')).toEqual(['srv']);
  });

  it('máy chủ đã trả lỗi: phản hồi được lưu theo khoá nên thử lại phải dùng khoá mới', async () => {
    const { controller, uploads } = setup();
    controller.add(field, [picked('a.pdf')]);
    await tick();
    uploads[0]?.result.reject(new ApiError('rate_limited', { status: 429 }));
    await tick();
    const item = controller.getSnapshot().tep?.[0];
    expect(item).toMatchObject({ status: 'error', problem: 'rate_limited' });
    controller.retry('tep', item!.localId);
    await tick();
    expect(uploads[1]?.key).not.toBe(uploads[0]?.key);
  });

  it('lỗi do chính tệp (nội dung không khớp đuôi) không thử lại được; chỉ gỡ được', async () => {
    const { controller, uploads } = setup();
    controller.add(field, [picked('gia.pdf')]);
    await tick();
    uploads[0]?.result.reject(new ApiError('input_invalid', { status: 422, errors: [{ path: 'body.data', code: 'file_content_mismatch' }] }));
    await tick();
    const item = controller.getSnapshot().tep?.[0];
    expect(item).toMatchObject({ status: 'error', problem: 'file_content_mismatch' });
    controller.retry('tep', item!.localId);
    await tick();
    expect(uploads).toHaveLength(1);
    expect(controller.getSnapshot().tep?.[0]?.status).toBe('error');
    controller.remove('tep', item!.localId);
    expect(controller.getSnapshot().tep).toEqual([]);
  });

  it('không đọc được tệp trong máy: báo read_failed và cho thử lại, lần sau đọc lại', async () => {
    const { controller, uploads } = setup();
    let fail = true;
    const file: PickedFile = {
      name: 'a.pdf',
      sizeBytes: 100,
      readBase64: async () => {
        if (fail) throw new Error('boom');
        return 'QUJD';
      },
      dispose: () => undefined,
    };
    controller.add(field, [file]);
    await tick();
    expect(controller.getSnapshot().tep?.[0]).toMatchObject({ status: 'error', problem: 'read_failed' });
    expect(uploads).toHaveLength(0);
    fail = false;
    controller.retry('tep', controller.getSnapshot().tep![0]!.localId);
    await tick();
    expect(uploads).toHaveLength(1);
  });
});

describe('FormFilesController: gỡ và thay tệp', () => {
  it('gỡ tệp đã tải xong thì gỡ luôn tệp chờ gắn ở máy chủ', async () => {
    const { controller, uploads, discarded } = setup();
    controller.add(field, [picked('a.pdf')]);
    await tick();
    uploads[0]?.result.resolve({ id: 'srv-1', name: 'a.pdf', sizeBytes: 100 });
    await tick();
    controller.remove('tep', controller.getSnapshot().tep![0]!.localId);
    expect(controller.getSnapshot().tep).toEqual([]);
    expect(discarded).toEqual(['srv-1']);
  });

  it('gỡ tệp đang tải: dừng việc tải; nếu máy chủ vẫn kịp nhận thì xoá tệp vừa lên', async () => {
    const { controller, uploads, discarded } = setup();
    const file = picked('a.pdf');
    controller.add(field, [file]);
    await tick();
    controller.remove('tep', controller.getSnapshot().tep![0]!.localId);
    expect(uploads[0]?.signal.aborted).toBe(true);
    expect(file.disposed).toBeGreaterThan(0);
    // máy chủ đã nhận xong ngay trước lúc dừng
    uploads[0]?.result.resolve({ id: 'srv-late', name: 'a.pdf', sizeBytes: 100 });
    await tick();
    expect(discarded).toEqual(['srv-late']);
    expect(controller.getSnapshot().tep).toEqual([]);
  });

  it('gỡ tệp chưa kịp đọc xong thì không tải lên', async () => {
    const { controller, uploads } = setup();
    const gate = deferred<string>();
    const slow: PickedFile = { name: 'a.pdf', sizeBytes: 100, readBase64: () => gate.promise, dispose: () => undefined };
    controller.add(field, [slow]);
    controller.remove('tep', controller.getSnapshot().tep![0]!.localId);
    gate.resolve('QUJD');
    await tick();
    expect(uploads).toHaveLength(0);
  });

  it('ô một tệp: chọn tệp khác thay tệp cũ và gỡ tệp cũ khỏi máy chủ', async () => {
    const { controller, uploads, discarded } = setup();
    controller.add(one, [picked('cu.pdf')]);
    await tick();
    uploads[0]?.result.resolve({ id: 'srv-old', name: 'cu.pdf', sizeBytes: 100 });
    await tick();
    controller.add(one, [picked('moi.pdf')]);
    expect(controller.getSnapshot().tep?.map((i) => i.name)).toEqual(['moi.pdf']);
    expect(discarded).toEqual(['srv-old']);
    await tick();
    uploads[1]?.result.resolve({ id: 'srv-new', name: 'moi.pdf', sizeBytes: 100 });
    await tick();
    expect(controller.readyIds('tep')).toEqual(['srv-new']);
  });

  it('ô nhiều tệp: các lần chọn cộng dồn; các ô khác nhau không lẫn vào nhau', async () => {
    const { controller, uploads } = setup();
    controller.add(field, [picked('a.pdf')]);
    controller.add(field, [picked('b.pdf')]);
    controller.add({ key: 'phu', multiple: true }, [picked('c.pdf')]);
    await tick();
    uploads[0]?.result.resolve({ id: 'A', name: 'a.pdf', sizeBytes: 100 });
    uploads[1]?.result.resolve({ id: 'B', name: 'b.pdf', sizeBytes: 100 });
    uploads[2]?.result.resolve({ id: 'C', name: 'c.pdf', sizeBytes: 100 });
    await tick();
    expect(controller.readyIds('tep')).toEqual(['A', 'B']);
    expect(controller.readyIds('phu')).toEqual(['C']);
  });
});

describe('FormFilesController: rời màn hình', () => {
  it('dừng các lần tải dở và trả bản sao tạm, nhưng KHÔNG xoá tệp đã tải xong (thao tác xếp hàng ngoại tuyến còn cần)', async () => {
    const { controller, uploads, discarded } = setup();
    const doneFile = picked('xong.pdf');
    const runningFile = picked('dang.pdf');
    controller.add(field, [doneFile]);
    await tick();
    uploads[0]?.result.resolve({ id: 'srv-done', name: 'xong.pdf', sizeBytes: 100 });
    await tick();
    controller.add(field, [runningFile]);
    await tick();
    controller.dispose();
    expect(uploads[1]?.signal.aborted).toBe(true);
    expect(runningFile.disposed).toBeGreaterThan(0);
    expect(discarded).toEqual([]);
    // tệp đã xong vẫn nằm trong danh sách và còn id
    expect(controller.readyIds('tep')).toEqual(['srv-done']);
  });
});
