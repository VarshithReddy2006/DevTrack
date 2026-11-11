import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ ready: true, consumers: new Map<string, unknown[]>(), failed: new Set<string>() }));
vi.mock('../../shared/redis/index.js', () => ({ getRedisClient: () => ({ status: state.ready ? 'ready' : 'end' }) }));
vi.mock('../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: (name: string) => ({
  getWorkers: async () => state.consumers.get(name) || [],
  getJobCounts: async () => { if (state.failed.has(name)) throw new Error('Redis unavailable'); return { waiting: 3, completed: 2 }; },
}) }));
import { getRegisteredWorkerStatuses } from '../../shared/jobs/workers.js';
import { workerDefinitions } from '../../workers/worker-runtime.js';
beforeEach(() => { state.ready = true; state.consumers.clear(); state.failed.clear(); });
afterEach(() => vi.unstubAllEnvs());
it('reports remote consumers even when in-process workers are disabled', async () => {
  vi.stubEnv('ENABLE_WORKERS', 'false');
  state.consumers.set('resume-ats', [{ id: 'remote-worker' }]);
  const statuses = await getRegisteredWorkerStatuses();
  expect(statuses).toHaveLength(workerDefinitions.length);
  expect(statuses.find(s => s.name === 'resume-ats')).toMatchObject({ status: 'healthy', consumers: 1, waiting: 3 });
  expect(statuses.find(s => s.name === 'readiness-dsa')).toMatchObject({ status: 'missing-consumer', consumers: 0 });
  expect(new Set(statuses.map(s => s.name)).size).toBe(statuses.length);
});
it('reports unavailable queues without claiming empty healthy queues', async () => {
  state.failed.add('readiness-dsa');
  const statuses = await getRegisteredWorkerStatuses();
  expect(statuses.find(s => s.name === 'readiness-dsa')).toMatchObject({ status: 'unavailable', waiting: null });
  state.ready = false;
  expect((await getRegisteredWorkerStatuses()).every(s => s.status === 'unavailable')).toBe(true);
});
