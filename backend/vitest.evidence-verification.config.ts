import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['src/modules/readiness/verification/*.test.ts', 'src/workers/worker-runtime.test.ts', 'tests/evidence-verification.integration.test.ts'],
  hookTimeout: 60000, testTimeout: 30000, fileParallelism: false,
} });
