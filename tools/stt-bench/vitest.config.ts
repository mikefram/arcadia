import { defineConfig } from 'vitest/config';

// Một số test mở ổ cắm WebSocket cục bộ và chờ hẹn giờ thật; nới hạn để máy CI chậm không làm test đỏ giả.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
