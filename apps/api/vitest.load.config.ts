import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Load tests (test/load/*.load.ts): run on demand only, never with the normal suite. */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/load/**/*.load.ts'],
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    env: { NODE_ENV: 'test', LOGIN_RATE_LIMIT_PER_MINUTE: '100000' },
  },
});
