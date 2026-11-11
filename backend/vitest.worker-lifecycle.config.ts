import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/workers/worker-runtime.test.ts', 'src/worker-entrypoint.test.ts', 'src/__tests__/worker-lifecycle/*.test.ts'], testTimeout: 30000, fileParallelism: false } });
