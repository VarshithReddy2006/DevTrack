import { createWorkerRuntime, workerDefinitions } from '../../workers/worker-runtime.js';
import { getRedisClient } from '../redis/index.js';

let runtime: ReturnType<typeof createWorkerRuntime> | undefined;

/** API and compatibility callers share one managed registry per process. */
export async function startAllWorkers(): Promise<void> {
  if (process.env.ENABLE_WORKERS === 'false') return;
  if (getRedisClient().status !== 'ready') throw new Error('Redis must be ready before workers start');
  runtime ??= createWorkerRuntime('all', {
    validate: async () => {}, connect: async () => {}, disconnect: async () => {},
  });
  try { await runtime.start(); }
  catch (error) { await stopAllWorkers().catch(() => undefined); throw error; }
}

export async function stopAllWorkers(): Promise<void> {
  const current = runtime;
  if (!current) return;
  try { await current.stop(); }
  finally { if (runtime === current) runtime = undefined; }
}

export async function getRegisteredWorkerStatuses() {
  const { getOrCreateQueue } = await import('./queueFactory.js');
  return Promise.all(workerDefinitions.map(async ({ role, queueName }) => {
    const name = queueName!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (getRedisClient().status !== 'ready') throw new Error('Redis unavailable');
      const queue = getOrCreateQueue(name);
      const [counts, consumers] = await Promise.race([
        Promise.all([queue.getJobCounts(), queue.getWorkers()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Queue health timed out')), 1000); }),
      ]);
      return { name, role, status: consumers.length ? 'healthy' : 'missing-consumer', consumers: consumers.length,
        active: counts.active ?? 0, waiting: counts.waiting ?? 0, failed: counts.failed ?? 0,
        completed: counts.completed ?? 0, delayed: counts.delayed ?? 0 };
    } catch (error) {
      return { name, role, status: 'unavailable', consumers: 0,
        error: error instanceof Error ? error.message : String(error),
        active: null, waiting: null, failed: null, completed: null, delayed: null };
    } finally { clearTimeout(timer); }
  }));
}
