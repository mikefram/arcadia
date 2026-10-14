import { describe, expect, it } from 'vitest';
import { ExpoPush } from '../src/push';

/** Audit ai-4: Expo treo thì lời gọi phải trả về trong vài giây, không giữ giao dịch của worker vô hạn. */
describe('ExpoPush: hạn chờ', () => {
  const hanging: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('hết giờ', 'TimeoutError')));
    });

  it('gửi: kết nối treo thì trả về lỗi tạm để effect thử lại theo backoff', async () => {
    const push = new ExpoPush({ fetch: hanging, timeoutMs: 50 });
    const started = Date.now();
    const tickets = await push.sendBatch([{ to: 'ExponentPushToken[x]', title: 't', body: '', data: {}, channelId: 'work', priority: 'normal' }]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ ok: false, error: 'transient' });
  });

  it('hỏi biên nhận: kết nối treo thì ném lỗi (nơi gọi bắt và thử lại ở phút sau)', async () => {
    const push = new ExpoPush({ fetch: hanging, timeoutMs: 50 });
    await expect(push.getReceipts(['id-1'])).rejects.toBeTruthy();
  });
});
