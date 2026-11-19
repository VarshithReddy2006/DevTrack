import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'tests/**', 'src/__tests__/integration/**', 'src/__tests__/modules/resume/scoreDifferential.test.ts', 'src/__tests__/modules/resume/bulletRewrite.test.ts', 'src/__tests__/modules/interview/rubricEvaluator.test.ts', 'src/__tests__/modules/interview/interviewEvaluation.test.ts'],
    passWithNoTests: true,
    setupFiles: ['./src/__tests__/vitest.setup.ts'],
    hookTimeout: 60000,
    testTimeout: 30000,
    fileParallelism: false,
  },
});
