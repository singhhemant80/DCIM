import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests live next to the code (src/**\/*.test.ts) and need no services.
 * E2E tests (test/**\/*.e2e.test.ts) boot the real Nest application against a
 * real PostgreSQL + Redis. They share one database, so files run serially.
 * The test database URL comes from TEST_DATABASE_URL (default below) and is
 * wiped at the start of every e2e file — never point it at real data.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    },
  },
});
