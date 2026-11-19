import { defineConfig } from 'vitest/config';

// Stateless scoring and real JWT verification must work without a database.
export default defineConfig({
  test: {
    include: ['src/__tests__/modules/resume/scoreDifferential.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
