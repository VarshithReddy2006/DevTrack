import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { FocusSessionCompletedV1 } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { recordActivity } from '../streak.service.js';

export const focusStreakConsumer: ConsumerDefinition<FocusSessionCompletedV1> = {
  name: 'streak.focusSessionCompleted',
  pool: 'xp',
  queue: QueueNames.DOMAIN_FOCUS_STREAK,
  dedup: 'natural',
  async handle({ userId, payload }) {
    await recordActivity({
      userId,
      streakType: 'focus',
      source: `focus_session:${payload.sessionId}`,
      activityDate: new Date(payload.completedAt),
      timezone: payload.timezone,
    }, { trustedCompletion: true });
  },
};
