// Platform sync sweep and mission schedules as BullMQ repeatables (replacing node-cron).
// BullMQ and every service the worker touches are fakes: no Redis, Mongo or timers involved.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AddOpts = { jobId?: string; repeat?: { pattern?: string; every?: number }; deduplication?: { id: string; ttl: number } };

const fx = vi.hoisted(() => {
  const state = {
    // Redis-side state shared by every fake Queue, like the real keys would be.
    schedulers: new Map<string, { pattern?: string; every?: number; template: unknown }>(),
    repeatables: new Map<string, { name: string; data: unknown; opts: AddOpts }>(),
    dedup: new Set<string>(),
    enqueued: [] as { name: string; data: unknown; opts: AddOpts }[],
    removedSchedulers: [] as string[],
    processor: undefined as undefined | ((job: unknown) => Promise<unknown>),
    env: { SYNC_ENABLED: true, SYNC_INTERVAL_MINUTES: 15, SYNC_COOLDOWN_MS: 300_000, NODE_ENV: 'test' },
    runScheduledSync: vi.fn(async () => undefined),
    runScheduledMissionSweep: vi.fn(async () => undefined),
  };
  return state;
});

vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, data: unknown, opts: Record<string, unknown> = {}) {
      const o = opts as AddOpts;
      if (o.repeat) {
        // BullMQ derives the repeat key from name + jobId + pattern/every, so re-adding is a no-op.
        fx.repeatables.set(`${name}:${o.jobId}:${o.repeat.pattern ?? o.repeat.every}`, { name, data, opts: o });
        return;
      }
      if (o.deduplication) {
        if (fx.dedup.has(o.deduplication.id)) return;
        fx.dedup.add(o.deduplication.id);
      }
      fx.enqueued.push({ name, data, opts: o });
    }
    async upsertJobScheduler(id: string, repeat: { pattern?: string; every?: number }, template: unknown) {
      fx.schedulers.set(id, { ...repeat, template });
    }
    async removeJobScheduler(id: string) {
      fx.removedSchedulers.push(id);
      return fx.schedulers.delete(id);
    }
    async removeRepeatable() { return true; }
    async close() {}
  },
  Worker: class {},
}));
vi.mock('../../shared/jobs/dlq.service.js', () => ({
  createDlqWorker: (_queue: string, processor: (job: unknown) => Promise<unknown>) => {
    fx.processor = processor;
    return { on: vi.fn(), close: vi.fn(async () => undefined) };
  },
  dlqService: { cleanupDlq: vi.fn() },
  DLQ_QUEUE_NAMES: [],
}));
vi.mock('../../config/env.js', () => ({ env: fx.env }));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../shared/redis/index.js', () => ({ getRedisClient: () => ({ status: 'ready' }) }));
vi.mock('../../shared/redis/syncLock.service.js', () => ({ cleanupStaleLocks: vi.fn() }));
vi.mock('../../shared/scheduler/missionScheduler.js', () => ({ runScheduledMissionSweep: fx.runScheduledMissionSweep }));
vi.mock('../../shared/syncScheduler.js', () => ({ runScheduledSync: fx.runScheduledSync }));
vi.mock('../../db/models/index.js', () => ({ User: {}, UserAnalytics: {}, UserStreakLog: {} }));
vi.mock('../../modules/activity/focusEngine.service.js', () => ({ focusEngine: { reapStaleSessions: vi.fn() } }));
vi.mock('../../modules/profile/antiGaming.worker.js', () => ({ AntiGamingWorker: { startAuditJob: vi.fn() } }));
vi.mock('../../shared/jobs/queueFactory.js', () => ({ getNotificationQueue: vi.fn() }));
vi.mock('../../modules/daily-challenge/daily-challenge.service.js', () => ({ seedDailyChallengeWindow: vi.fn() }));
vi.mock('../../modules/daily-challenge/daily-challenge.time.js', () => ({
  localDateString: vi.fn(), localDayBounds: vi.fn(), resolveTimezone: vi.fn(),
}));

import {
  PLATFORM_SYNC_SCHEDULER_ID, scheduleMaintenanceTasks, startMaintenanceWorker, stopMaintenanceWorker,
} from '../../shared/jobs/maintenanceWorker.js';

const SYNC_ID = 'maintenance-platform-sync-sweep';

beforeEach(() => {
  fx.schedulers.clear();
  fx.repeatables.clear();
  fx.dedup.clear();
  fx.enqueued.length = 0;
  fx.removedSchedulers.length = 0;
  fx.processor = undefined;
  Object.assign(fx.env, { SYNC_ENABLED: true, SYNC_INTERVAL_MINUTES: 15 });
  fx.runScheduledSync.mockClear();
  fx.runScheduledMissionSweep.mockClear();
});
afterEach(() => stopMaintenanceWorker());

describe('platform sync sweep schedule', () => {
  it('registers one job scheduler with a stable id and the configured interval', async () => {
    await scheduleMaintenanceTasks();

    expect(PLATFORM_SYNC_SCHEDULER_ID).toBe(SYNC_ID);
    expect([...fx.schedulers.keys()]).toEqual([SYNC_ID]);
    expect(fx.schedulers.get(SYNC_ID)).toMatchObject({
      pattern: '*/15 * * * *',
      template: { name: 'platform-sync-sweep', data: { task: 'platform_sync_sweep' } },
    });
  });

  it('keeps a single schedule and a single startup sweep when several instances register', async () => {
    for (let instance = 0; instance < 4; instance++) await scheduleMaintenanceTasks();

    expect(fx.schedulers.size).toBe(1);
    const startup = fx.enqueued.filter(job => job.name === 'platform-sync-sweep-startup');
    expect(startup).toHaveLength(1);
    expect(startup[0].opts).toMatchObject({
      delay: 10_000,
      deduplication: { id: 'maintenance-platform-sync-startup', ttl: 15 * 60 * 1000 },
    });
    // The pre-existing repeatables are keyed by stable ids too, so they do not multiply either.
    const before = fx.repeatables.size;
    await scheduleMaintenanceTasks();
    expect(fx.repeatables.size).toBe(before);
  });

  it('replaces the schedule in place when the interval changes between deploys', async () => {
    await scheduleMaintenanceTasks();
    fx.env.SYNC_INTERVAL_MINUTES = 5;
    await scheduleMaintenanceTasks();

    expect(fx.schedulers.size).toBe(1);
    expect(fx.schedulers.get(SYNC_ID)?.pattern).toBe('*/5 * * * *');
  });

  it('removes the schedule and enqueues nothing when SYNC_ENABLED is false', async () => {
    await scheduleMaintenanceTasks();
    fx.env.SYNC_ENABLED = false;
    await scheduleMaintenanceTasks();

    expect(fx.schedulers.size).toBe(0);
    expect(fx.removedSchedulers).toEqual([SYNC_ID]);
    expect(fx.enqueued.filter(job => job.name.startsWith('platform-sync-sweep'))).toHaveLength(1); // the first, enabled run only
  });
});

describe('mission schedules', () => {
  it('keeps the daily and weekly missions as stable-id repeatables at 00:05 UTC', async () => {
    await scheduleMaintenanceTasks();

    const repeatables = [...fx.repeatables.values()];
    expect(repeatables.find(r => r.opts.jobId === 'maintenance-daily-missions')).toMatchObject({
      data: { task: 'generate_daily_missions' }, opts: { repeat: { pattern: '5 0 * * *' } },
    });
    expect(repeatables.find(r => r.opts.jobId === 'maintenance-weekly-missions')).toMatchObject({
      data: { task: 'generate_weekly_missions' }, opts: { repeat: { pattern: '5 0 * * 1' } },
    });
  });
});

describe('maintenance worker dispatch', () => {
  async function run(task: string) {
    startMaintenanceWorker();
    await fx.processor!({ id: 'job-1', data: { task }, opts: {}, timestamp: Date.now() });
  }

  it('runs the platform sync sweep once per platform_sync_sweep job', async () => {
    await run('platform_sync_sweep');
    expect(fx.runScheduledSync).toHaveBeenCalledOnce();
    expect(fx.runScheduledMissionSweep).not.toHaveBeenCalled();
  });

  it.each([['generate_daily_missions', 'daily'], ['generate_weekly_missions', 'weekly']])(
    'runs the %s sweep through the shared mission lock path',
    async (task, period) => {
      await run(task);
      expect(fx.runScheduledMissionSweep).toHaveBeenCalledExactlyOnceWith(period);
      expect(fx.runScheduledSync).not.toHaveBeenCalled();
    },
  );

  it('does not start any sweep for an unknown task', async () => {
    await run('not_a_task');
    expect(fx.runScheduledSync).not.toHaveBeenCalled();
    expect(fx.runScheduledMissionSweep).not.toHaveBeenCalled();
  });
});

describe('node-cron removal', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(entry => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sources(path);
      return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('is neither a dependency nor imported by any backend source file', () => {
    const root = join(__dirname, '..', '..', '..');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(name => name.includes('node-cron'))).toEqual([]);
    const offenders = sources(join(root, 'src')).filter(file => /from\s+['"]node-cron['"]|require\(['"]node-cron['"]\)/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
