import { expect, it, vi } from 'vitest';
import { runDailyAuditCheckpoint } from '../../../modules/audit/auditCheckpoint.service.js';
import { scheduleMaintenanceTasks, startMaintenanceWorker, stopMaintenanceWorker } from '../../../shared/jobs/maintenanceWorker.js';

const queue = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(undefined),
  removeRepeatable: vi.fn().mockResolvedValue(true),
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  process: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = queue.add;
    removeRepeatable = queue.removeRepeatable;
    upsertJobScheduler = queue.upsertJobScheduler;
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

vi.mock('../../../modules/audit/auditCheckpoint.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../modules/audit/auditCheckpoint.service.js')>(),
  runDailyAuditCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

it('schedules the checkpoint after midnight UTC and passes the scheduled time to it', async () => {
  const scheduledAt = new Date('2026-11-21T00:30:00Z');
  try {
    startMaintenanceWorker();
    await scheduleMaintenanceTasks();
    expect(queue.add).toHaveBeenCalledWith(
      'seal-audit-checkpoint',
      { task: 'seal_audit_checkpoint' },
      expect.objectContaining({ repeat: { pattern: '30 0 * * *', tz: 'UTC' }, jobId: 'maintenance-seal-audit-checkpoint', attempts: 3 }),
    );
    const processor = queue.process.mock.lastCall?.[0];
    await processor({
      id: 'test-checkpoint',
      data: { task: 'seal_audit_checkpoint' },
      timestamp: scheduledAt.getTime() + 5 * 60_000,
      opts: { prevMillis: scheduledAt.getTime() },
    });
    expect(runDailyAuditCheckpoint).toHaveBeenCalledExactlyOnceWith(scheduledAt);
  } finally {
    await stopMaintenanceWorker();
  }
});
