import { ApiError } from '@mihato/domain';
import { describe, expect, it } from 'vitest';
import { OfflineQueue, QUEUE_STORAGE_KEY, classifySendError, noteOf, type QueueItem, type QueueStorage } from '../src/offline/queue';

/** Kho lưu trong bộ nhớ thay cho AsyncStorage: sống qua các lần "mở lại app" trong cùng một test. */
function memoryStorage(): QueueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
}

/**
 * Máy chủ giả, theo đúng quy ước chống lặp ở SPEC 10.1: cùng Idempotency-Key thì chỉ có hiệu lực một lần,
 * lần gửi lại trả đúng phản hồi cũ. `online = false` thì lời gọi mạng ném TypeError như `fetch`.
 */
function fakeServer() {
  const state = {
    online: true,
    /** mọi yêu cầu máy chủ nhận được, kể cả gửi lại */
    requests: [] as { key: string; stepId: string; kind: string }[],
    /** sự kiện có hiệu lực: mỗi Idempotency-Key một lần */
    applied: new Map<string, { stepId: string; kind: string }>(),
    /** việc không còn nhận thao tác: stepId → lỗi máy chủ trả */
    conflicts: new Map<string, ApiError>(),
    /** rơi mạng sau khi máy chủ đã áp sự kiện, trước khi app nhận phản hồi */
    dropResponseOnce: false,
  };
  const send = async (item: QueueItem): Promise<void> => {
    if (!state.online) throw new TypeError('Network request failed');
    state.requests.push({ key: item.eventId, stepId: item.stepId, kind: item.action.kind });
    if (!state.applied.has(item.eventId)) {
      const conflict = state.conflicts.get(item.stepId);
      if (conflict) throw conflict;
      state.applied.set(item.eventId, { stepId: item.stepId, kind: item.action.kind });
    }
    if (state.dropResponseOnce) {
      state.dropResponseOnce = false;
      throw new TypeError('Network request failed');
    }
  };
  return { state, send };
}

const STEP_A = '0199a000-0000-7000-8000-00000000000a';
const STEP_B = '0199a000-0000-7000-8000-00000000000b';

function setup() {
  const storage = memoryStorage();
  const server = fakeServer();
  let n = 0;
  const open = () =>
    new OfflineQueue({
      storage,
      send: server.send,
      isOnline: () => server.state.online,
      newId: () => `0199b000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
      now: () => new Date('2026-10-15T03:00:00Z'),
    });
  return { storage, server, open, queue: open() };
}

const complete = (stepId: string, note?: string) => ({ stepId, stepTitle: `Việc ${stepId.slice(-1)}`, runTitle: 'Đón đoàn tháng 10', action: { kind: 'complete' as const, note } });

describe('hàng đợi ngoại tuyến (SPEC 8.4, 8.6 điều 3)', () => {
  it('tắt mạng, báo hoàn thành hai việc, bật mạng: gửi đúng hai lần với đúng eventId; gửi lại không tạo thêm', async () => {
    const { server, queue } = setup();

    server.state.online = false;
    const first = await queue.submit(complete(STEP_A, 'Đã gửi chương trình cho các bên'));
    const second = await queue.submit(complete(STEP_B));

    // Mất mạng: cả hai nằm lại trên máy, hiện chip "Chờ gửi"; máy chủ chưa nhận gì.
    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    expect(first.eventId).not.toBe(second.eventId);
    expect(queue.getSnapshot().map((i) => i.status)).toEqual(['pending', 'pending']);
    expect(server.state.requests).toHaveLength(0);

    server.state.online = true;
    await queue.flush();

    // Có mạng: gửi đúng hai lần, theo thứ tự xếp hàng, Idempotency-Key chính là eventId sinh trên máy.
    expect(server.state.requests).toEqual([
      { key: first.eventId, stepId: STEP_A, kind: 'complete' },
      { key: second.eventId, stepId: STEP_B, kind: 'complete' },
    ]);
    expect([...server.state.applied.keys()]).toEqual([first.eventId, second.eventId]);
    expect(queue.getSnapshot()).toEqual([]);

    // Gửi lại (app trở lại nền trước, có mạng lại, hẹn giờ…): không tạo thêm yêu cầu nào.
    await queue.flush();
    await Promise.all([queue.flush(), queue.flush()]);
    expect(server.state.requests).toHaveLength(2);
    expect(server.state.applied.size).toBe(2);
  });

  it('rơi mạng sau khi máy chủ đã nhận: gửi lại cùng eventId, hai việc vẫn xong đúng một lần', async () => {
    const { server, queue } = setup();
    server.state.dropResponseOnce = true;

    const a = await queue.submit(complete(STEP_A));
    // App không nhận được phản hồi nên vẫn coi là chờ gửi; thứ tự được giữ, việc B chưa được gửi.
    expect(a.status).toBe('queued');
    const b = await queue.submit(complete(STEP_B));
    expect(b.status).toBe('sent');

    expect(server.state.requests.map((r) => r.key)).toEqual([a.eventId, a.eventId, b.eventId]);
    // Máy chủ nhận ba yêu cầu nhưng chỉ áp hai sự kiện: mỗi việc xong đúng một lần.
    expect(server.state.applied.size).toBe(2);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it('lỗi 409 state_conflict: không âm thầm bỏ thao tác, giữ ghi chú đã nhập, báo trạng thái hiện tại', async () => {
    const { server, queue } = setup();
    server.state.online = false;
    const a = await queue.submit(complete(STEP_A, 'Đã bàn giao hồ sơ cho anh Tuấn'));
    const b = await queue.submit(complete(STEP_B, 'Xong'));

    // Trong lúc mất mạng, việc A đã được giao lại cho người khác.
    server.state.conflicts.set(STEP_A, new ApiError('state_conflict', { status: 409, currentState: 'cancelled' }));
    server.state.online = true;
    await queue.flush();

    const left = queue.getSnapshot();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ eventId: a.eventId, status: 'rejected', lastErrorCode: 'state_conflict', conflictState: 'cancelled' });
    expect(noteOf(left[0]!.action)).toBe('Đã bàn giao hồ sơ cho anh Tuấn');
    // Việc B không bị chặn bởi việc A.
    expect(server.state.applied.has(b.eventId)).toBe(true);

    // Thao tác bị từ chối không được gửi lại, và còn nguyên cho tới khi người dùng bấm "Đã rõ".
    const before = server.state.requests.length;
    await queue.flush();
    expect(server.state.requests).toHaveLength(before);
    expect(queue.getSnapshot()).toHaveLength(1);

    await queue.dismiss(a.eventId);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it('đang có mạng mà máy chủ từ chối: submit trả rejected kèm mã lỗi để màn hình giữ nguyên ghi chú', async () => {
    const { server, queue } = setup();
    server.state.conflicts.set(STEP_A, new ApiError('state_conflict', { status: 409, currentState: 'done' }));
    const outcome = await queue.submit(complete(STEP_A, 'Ghi chú của tôi'));
    expect(outcome).toEqual({ status: 'rejected', eventId: outcome.eventId, code: 'state_conflict', conflictState: 'done' });
    expect(noteOf(queue.getSnapshot()[0]!.action)).toBe('Ghi chú của tôi');
  });

  it('404 và 403 cũng là từ chối vì tình huống đã đổi', async () => {
    const { server, queue } = setup();
    server.state.conflicts.set(STEP_A, new ApiError('not_found', { status: 404 }));
    server.state.conflicts.set(STEP_B, new ApiError('forbidden', { status: 403 }));
    expect((await queue.submit(complete(STEP_A))).status).toBe('rejected');
    expect((await queue.submit(complete(STEP_B))).status).toBe('rejected');
    expect(queue.getSnapshot().map((i) => i.lastErrorCode)).toEqual(['not_found', 'forbidden']);
  });

  it('tắt app khi còn thao tác chờ: mở lại vẫn còn, gửi với đúng eventId cũ', async () => {
    const { server, storage, open, queue } = setup();
    server.state.online = false;
    const a = await queue.submit({ stepId: STEP_A, stepTitle: 'Việc a', runTitle: 'Lượt', action: { kind: 'accept' } });
    const b = await queue.submit({ stepId: STEP_A, stepTitle: 'Việc a', runTitle: 'Lượt', action: { kind: 'block', reasonCode: 'missing_info', note: 'Thiếu danh sách khách' } });
    expect(JSON.parse(storage.data.get(QUEUE_STORAGE_KEY) ?? '[]')).toHaveLength(2);

    // "Mở lại app": một hàng đợi mới đọc lại từ cùng kho lưu.
    const reopened = open();
    await reopened.load();
    expect(reopened.getSnapshot().map((i) => i.eventId)).toEqual([a.eventId, b.eventId]);

    server.state.online = true;
    await reopened.flush();
    expect(server.state.requests).toEqual([
      { key: a.eventId, stepId: STEP_A, kind: 'accept' },
      { key: b.eventId, stepId: STEP_A, kind: 'block' },
    ]);
    expect(JSON.parse(storage.data.get(QUEUE_STORAGE_KEY) ?? 'null')).toEqual([]);
  });

  it('lỗi tạm (máy chủ 503) giữ nguyên thứ tự: dừng ở thao tác đầu, lần sau gửi tiếp', async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    let failing = true;
    const queue = new OfflineQueue({
      storage,
      send: async (item) => {
        if (failing) throw new ApiError('internal_error', { status: 503 });
        sent.push(item.stepId);
      },
    });
    expect((await queue.submit(complete(STEP_A))).status).toBe('queued');
    expect((await queue.submit(complete(STEP_B))).status).toBe('queued');
    expect(queue.getSnapshot().map((i) => i.attempts)).toEqual([2, 0]);
    failing = false;
    await queue.flush();
    expect(sent).toEqual([STEP_A, STEP_B]);
  });

  it('xoá sạch khi phiên trên máy kết thúc', async () => {
    const { server, storage, queue } = setup();
    server.state.online = false;
    await queue.submit(complete(STEP_A, 'ghi chú'));
    await queue.clear();
    expect(queue.getSnapshot()).toEqual([]);
    expect(storage.data.get(QUEUE_STORAGE_KEY)).toBe('[]');
  });

  it('báo cho người nghe mỗi khi hàng đợi đổi', async () => {
    const { server, queue } = setup();
    let calls = 0;
    const off = queue.subscribe(() => calls++);
    server.state.online = false;
    await queue.submit(complete(STEP_A));
    expect(calls).toBeGreaterThan(0);
    off();
    const seen = calls;
    await queue.clear();
    expect(calls).toBe(seen);
  });
});

describe('classifySendError', () => {
  it('lỗi mạng và lỗi tạm thì thử lại', () => {
    expect(classifySendError(new TypeError('Network request failed'))).toEqual({ verdict: 'retry', code: 'network' });
    expect(classifySendError(new ApiError('internal_error', { status: 500 })).verdict).toBe('retry');
    expect(classifySendError(new ApiError('rate_limited', { status: 429 })).verdict).toBe('retry');
    expect(classifySendError(new ApiError('request_in_progress', { status: 409 })).verdict).toBe('retry');
    expect(classifySendError(new ApiError('token_expired', { status: 401 })).verdict).toBe('retry');
    expect(classifySendError(new ApiError('app_update_required', { status: 426 })).verdict).toBe('retry');
  });

  it('tình huống đã đổi thì từ chối, kèm trạng thái hiện tại nếu có', () => {
    expect(classifySendError(new ApiError('state_conflict', { status: 409, currentState: 'done' }))).toEqual({ verdict: 'reject', code: 'state_conflict', conflictState: 'done' });
    expect(classifySendError(new ApiError('not_found', { status: 404 }))).toEqual({ verdict: 'reject', code: 'not_found', conflictState: null });
    expect(classifySendError(new ApiError('forbidden', { status: 403 })).verdict).toBe('reject');
    expect(classifySendError(new ApiError('input_invalid', { status: 422 })).verdict).toBe('reject');
  });
});
