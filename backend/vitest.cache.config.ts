import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/shared/cache/cacheManager.test.ts'] },
});
