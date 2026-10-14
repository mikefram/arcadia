import { defineConfig } from 'vitest/config';

/**
 * Test thuộc tính đọc số mẫu từ FC_NUM_RUNS (mặc định 100; chạy đêm 10.000, xem `test:nightly`).
 * Thời gian chờ của mỗi test tăng theo số mẫu để lượt chạy đêm không bị cắt giữa chừng.
 */
const numRuns = Number(process.env['FC_NUM_RUNS'] ?? 100);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: Math.max(30_000, numRuns * 100),
  },
});
