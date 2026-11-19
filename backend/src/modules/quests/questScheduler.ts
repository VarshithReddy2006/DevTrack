import type { Queue } from 'bullmq';
import type { SystemMaintenanceJobData } from '../../shared/jobs/types.js';

export async function scheduleQuestGeneration(queue: Pick<Queue<SystemMaintenanceJobData>, 'add'>) {
  for (const [name, pattern] of [['daily', '0 0 * * *'], ['weekly', '0 0 * * 0']]) {
    await queue.add('generate-quests-' + name, { task: 'generate_quests' }, {
      repeat: { pattern, tz: 'UTC' }, jobId: 'quests-' + name,
      attempts: 5, backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 5 }, removeOnFail: { count: 10 },
    });
  }
  await queue.add('generate-quests-startup', { task: 'generate_quests' }, {
    deduplication: { id: 'quests-startup', ttl: 60_000 },
    attempts: 5, backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 5 }, removeOnFail: { count: 10 },
  });
}
