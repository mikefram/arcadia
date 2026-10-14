/**
 * Đồng hồ của máy chủ. Test điều khiển đồng hồ giả thay vì sleep (SPEC 13.1); khi đồng hồ giả bật,
 * mỗi giao dịch đặt `app.now` để các view trong CSDL dùng cùng thời điểm.
 */
let fakeNow: Date | null = null;

export const clock = {
  now(): Date {
    return fakeNow ? new Date(fakeNow.getTime()) : new Date();
  },
  /** ISO của đồng hồ giả, hoặc null khi dùng đồng hồ thật */
  fakeIso(): string | null {
    return fakeNow ? fakeNow.toISOString() : null;
  },
};

/** Chỉ dùng trong test và script seed. Không bao giờ gọi ở production. */
export function setFakeNow(value: Date | string | null): void {
  if (value !== null && process.env.NODE_ENV === 'production') throw new Error('Không dùng đồng hồ giả ở production');
  fakeNow = value === null ? null : new Date(value);
}

export function advanceFakeNow(ms: number): void {
  if (!fakeNow) throw new Error('Đồng hồ giả chưa bật');
  fakeNow = new Date(fakeNow.getTime() + ms);
}
