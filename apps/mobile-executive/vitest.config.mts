import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test của app Chủ tịch chỉ chạy phần logic thuần (lớp WebSocket với máy chủ giả, máy trạng thái trợ lý,
 * ghép âm thanh, đếm ngược hoàn tác, phiên, bộ ký, số đo của thành phần senior, lint tự viết),
 * không nạp React Native. Màn hình kiểm bằng Maestro (.maestro/) và bản web qua Playwright.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@senior': fileURLToPath(new URL('./components/senior', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
