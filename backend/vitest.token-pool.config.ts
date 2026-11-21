import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/modules/sync/tokenPoolManager.test.ts'],
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
