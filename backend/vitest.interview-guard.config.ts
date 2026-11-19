import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/modules/interview/interviewGuard.test.ts', 'src/__tests__/modules/interview/interviewGuard.worker.test.ts'],
    fileParallelism: false, hookTimeout: 60000, testTimeout: 30000,
  },
});
