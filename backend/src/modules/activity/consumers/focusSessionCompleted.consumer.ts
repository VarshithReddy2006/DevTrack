import { cacheManager } from '../../../shared/cache/cacheManager.js';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { FocusSessionCompletedV1 } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { createActivity } from '../activity.service.js';

export const focusActivityConsumer: ConsumerDefinition<FocusSessionCompletedV1> = {
  name: 'activity.focusSessionCompleted',
  pool: 'xp',
  queue: QueueNames.DOMAIN_FOCUS_ACTIVITY,
  dedup: 'inbox',
  retainInbox: true,
  async handle({ userId, payload }, session) {
    if (!session) throw new Error('Focus activity requires an inbox transaction');
    await createActivity(userId, {
      type: 'focus_session',
      title: 'Focus Session Completed',
      description: `Completed a ${payload.plannedDurationMinutes} minute focus session.`,
      platform: 'devtrack',
      url: null,
      tags: [],
      occurredAt: payload.completedAt,
      metadata: { sessionId: payload.sessionId, duration: payload.plannedDurationMinutes, mode: payload.mode },
    }, session);
  },
  async afterCommit({ userId }) {
    await cacheManager.invalidateDashboard(userId);
  },
};
