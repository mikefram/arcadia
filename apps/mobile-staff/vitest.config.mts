import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test của app nhân viên chỉ chạy phần logic thuần (hàng đợi ngoại tuyến, phiên, phân nhóm việc…),
 * không nạp React Native. Màn hình kiểm bằng Maestro (.maestro/) và bản web qua Playwright.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
