import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// The SPA and API are served from one origin (Vite proxy in development,
// nginx in production) so session cookies stay first-party and CORS is unused.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@crapplet/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  build: { sourcemap: true, target: 'es2022' },
  test: { globals: true, environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false },
});
