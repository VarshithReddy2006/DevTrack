import { defineConfig } from 'vitest/config';

// SLO engine tests are pure in-memory calculations and do not require MongoDB or Redis.
export default defineConfig({
  test: {
    include: ['src/__tests__/shared/observability/sloEngine.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

