import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/modules/notifications/notification.persistence.test.ts',
      'src/__tests__/integration/notification-acknowledgement.test.ts',
    ],
    setupFiles: ['./src/__tests__/vitest.setup.ts'],
    hookTimeout: 60000,
    testTimeout: 30000,
    fileParallelism: false,
  },
});
