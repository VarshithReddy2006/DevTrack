import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/modules/platform-sync/adapters/*.test.ts', 'src/shared/jobs/platformSyncWorker.test.ts'],
    coverage: {
      provider: 'v8', reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage/adapters',
      include: ['src/modules/platform-sync/adapters/*.ts'],
      exclude: ['**/*.test.ts', '**/types.ts'],
      thresholds: { perFile: true, lines: 86, statements: 86, functions: 86 },
    },
  },
});
