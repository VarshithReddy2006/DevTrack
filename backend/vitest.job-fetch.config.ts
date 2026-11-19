import { defineConfig } from 'vitest/config';

// Browser/queue fixtures plus an owned temporary MongoDB: no shared database or Redis.
export default defineConfig({
  test: {
    include: ['src/modules/job-targets/safe-fetch.test.ts', 'src/modules/job-targets/workers/headlessScraper.test.ts',
      'src/modules/job-targets/workers/jobTargetFetch.test.ts', 'src/workers/worker-runtime.test.ts',
      'tests/job-target-fetch.integration.test.ts', 'tests/headless-scraper.browser.test.ts'],
    testTimeout: 20000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
