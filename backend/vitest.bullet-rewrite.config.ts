import { defineConfig } from 'vitest/config';

// ACR service/HTTP tests use fixture adapters and need no MongoDB or live model.
export default defineConfig({
  test: {
    include: ['src/__tests__/modules/resume/bulletRewrite.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
