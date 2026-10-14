import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/** Vitest chỉ chạy test đơn vị; kịch bản Playwright ở e2e/ chạy bằng `pnpm --filter @mihato/web-admin e2e`. */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
  }),
);
