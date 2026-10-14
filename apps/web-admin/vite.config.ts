import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Máy chủ API khi phát triển (pnpm dev chạy api ở cổng 3100). */
const apiTarget = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      // SSE (SPEC 10.8): không nén, không đệm, không cắt kết nối khi im lặng giữa hai lần ping.
      '/v1/stream': {
        target: apiTarget,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        headers: { 'Accept-Encoding': 'identity' },
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        },
      },
      '/v1': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: { port: 5273, strictPort: true },
  build: { target: 'es2023', sourcemap: true },
});
