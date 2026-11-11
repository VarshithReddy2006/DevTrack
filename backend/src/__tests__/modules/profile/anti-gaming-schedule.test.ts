import { expect, it, vi } from 'vitest';
import { AntiGamingWorker } from '../../../modules/profile/antiGaming.worker.js';
import { scheduleMaintenanceTasks, startMaintenanceWorker, stopMaintenanceWorker } from '../../../shared/jobs/maintenanceWorker.js';

const queue = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  process: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = queue.add;
    close = queue.close;
  },
  Worker: class {
    constructor(_name: string, processor: unknown) {
      queue.process(processor);
    }
    on = queue.on;
    close = queue.close;
  },
}));

it('registers and dispatches a daily UTC audit using the original scheduled time', async () => {
  const audit = vi.spyOn(AntiGamingWorker, 'startAuditJob').mockResolvedValue(undefined);
  const scheduledAt = new Date('2026-11-11T03:00:00Z');
  try {
    startMaintenanceWorker();
    await scheduleMaintenanceTasks();
    expect(queue.add).toHaveBeenCalledWith(
      'audit-public-profiles',
      { task: 'audit_public_profiles' },
      expect.objectContaining({ repeat: { pattern: '0 3 * * *', tz: 'UTC' }, attempts: 3 })
    );
    const processor = queue.process.mock.lastCall?.[0];
    expect(processor).toBeTypeOf('function');
    await processor({
      id: 'test-audit',
      data: { task: 'audit_public_profiles' },
      timestamp: scheduledAt.getTime() - 60_000,
      opts: { prevMillis: scheduledAt.getTime() },
    });
    expect(audit).toHaveBeenCalledExactlyOnceWith(scheduledAt);
  } finally {
    await stopMaintenanceWorker();
    audit.mockRestore();
  }
});
