import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Mỗi tệp test tạo tổ chức riêng nên chạy song song được (SPEC 13.1).
    pool: 'forks',
  },
});
