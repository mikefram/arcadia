import { defineConfig } from '@playwright/test';

/**
 * Test E2E của web quản trị (SPEC 9.7), chạy trên API thật với dữ liệu mẫu.
 * Không tự khởi động máy chủ: trước khi chạy cần `pnpm dev` (api :3100, web-admin :5273) và `pnpm db:seed`.
 *   pnpm --filter @mihato/web-admin e2e
 *   WEB_URL=http://localhost:5274 npx playwright test e2e/designer.spec.ts   (web chạy ở cổng khác)
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:5273',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
