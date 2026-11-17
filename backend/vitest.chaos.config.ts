import { defineConfig } from 'vitest/config';

// Chaos suite. tests/** is excluded from the default config, so these files run
// through `npm run test:chaos`. The default unit setup (global ioredis/BullMQ
// mocks, shared in-memory Mongo) is deliberately not loaded: each scenario brings
// its own fakes so it controls time and failures itself.
//
// refreshStorm and sseReconnectStorm talk to a running API (TEST_API_BASE), so
// they only join the run when that variable is set.
const needsLiveServer = [
  'tests/chaos/refreshStorm.test.ts',
  'tests/chaos/sseReconnectStorm.test.ts',
];

export default defineConfig({
  test: {
    include: ['tests/chaos/**/*.test.ts'],
    exclude: ['dist/**', ...(process.env.TEST_API_BASE ? [] : needsLiveServer)],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 120000,
    testTimeout: 30000,
  },
});
