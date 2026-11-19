import { defineConfig } from 'vitest/config';

// These suites own their MongoDB fixture; do not load the global database setup twice.
export default defineConfig({
  test: {
    include: ['src/__tests__/modules/interview/rubricEvaluator.test.ts', 'src/__tests__/modules/interview/interviewEvaluation.test.ts'],
    fileParallelism: false, hookTimeout: 60000, testTimeout: 30000,
  },
});
